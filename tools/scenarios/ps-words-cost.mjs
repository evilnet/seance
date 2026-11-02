// What the Words over the plains treatments cost with the scene in motion
// (docs/projects/ps-words.md §6, ps-theme.md §10.1 "Plan 6"): the frame
// intervals a requestAnimationFrame loop sees and the share of the window the
// main thread spent in long tasks (PerformanceObserver "longtask"), over ten
// seconds each, for the outline (today's words, the control), bubbles (the
// default) and the glass column (the one with a backdrop blur over the whole
// message list), on the desktop layout and on the phone layout. Scene
// animation is set to Full so the clouds, the grass and the birds move.
//
//   NODE_ENV=production pnpm build && python3 -m http.server -d public 8021 &
//   node tools/browser-drive.mjs tools/scenarios/ps-words-cost.mjs --chrome=…
//
// Needs the dev ircd (8067). Prints a table; the only checks are that each
// sample stands (ten seconds, at least a hundred frames). Headless, software
// composited and on a shared host: the figures compare the treatments with
// each other on the same run, nothing more (§10.1's caveats).

const BASE = `http://localhost:${process.env.SEANCE_HTTP_PORT ?? "8021"}/`;
const PORT = process.env.SEANCE_IRC_PORT ?? "8067";
const RUN = Math.random().toString(36).slice(2, 6);
const NICK = `cost${RUN}`;
const AT = Date.UTC(2026, 8, 25, 12, 30);
const WINDOW_MS = 10000;
const WORDS = ["outline", "bubbles", "glass"];
const LAYOUTS = [
	{name: "desktop", width: 1280, height: 900, mobile: false},
	{name: "phone", width: 390, height: 844, mobile: true},
];

export const url = `${BASE}?host=127.0.0.1&port=${PORT}&tls=false&nick=${NICK}&join=%23seance`;

const CLOCK_SHIM = `(() => {
	const R = Date, off = ${AT} - R.now();
	function S(...a) { if (!new.target) return R(); return a.length ? new R(...a) : new R(R.now() + off); }
	S.prototype = R.prototype; S.now = () => R.now() + off; S.UTC = R.UTC; S.parse = R.parse; window.Date = S;
})()`;

/** Ten seconds of frames and long tasks, in the page. */
const SAMPLE = `new Promise((resolve) => {
	const frames = [];
	const longs = [];
	const po = new PerformanceObserver((list) => {
		for (const e of list.getEntries()) longs.push(e.duration);
	});
	po.observe({type: "longtask", buffered: false});
	let last = null, start = null;
	function tick(t) {
		if (start === null) { start = t; last = t; requestAnimationFrame(tick); return; }
		frames.push(t - last);
		last = t;
		if (t - start < ${WINDOW_MS}) { requestAnimationFrame(tick); return; }
		po.disconnect();
		resolve({
			frames,
			span: t - start,
			longMs: longs.reduce((a, b) => a + b, 0),
			longCount: longs.length,
			animations: document.getAnimations().length,
			words: document.documentElement.dataset.psWords ?? null,
		});
	}
	requestAnimationFrame(tick);
})`;

const pct = (list, q) => {
	const s = [...list].sort((a, b) => a - b);
	return s.length ? s[Math.floor(q * (s.length - 1))] : null;
};
const f1 = (v) => (v === null ? "  –" : v.toFixed(1).padStart(5));

async function openAppearance(page) {
	await page.evaluate(`location.hash = "#/settings/appearance"`);
	await page.waitFor(`document.querySelector("#theme-select")`, {label: "Appearance"});
}

async function closeSettings(page) {
	await page.click("#settings .settings-modal-done");
	await page.waitFor(`!document.querySelector("#theme-select")`, {label: "settings closed"});
}

async function choose(page, name, value) {
	await openAppearance(page);
	await page.click(`#settings input[name="${name}"][value="${value}"]`);
	await closeSettings(page);
}

export default async function run(page) {
	await page.send("Emulation.setTimezoneOverride", {timezoneId: "Etc/GMT"});
	await page.addInitScript(
		`try { localStorage.setItem("settings", JSON.stringify({theme: "ps", psAnimation: "full", psPauseWhenAway: false})); } catch (e) {}\n${CLOCK_SHIM}`
	);
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="#seance"]')`, {
		timeout: 30000,
		label: "#seance in the sidebar",
	});
	await page.click(`.channel-list-item[data-name="#seance"]`);
	await page.waitFor(`document.querySelector("#input")`, {label: "the input box"});
	await page.waitFor(`document.querySelector("#theme-scene.psng")`, {label: "the scene"});
	await page.sleep(2000);

	const rows = [];

	for (const layout of LAYOUTS) {
		await page.send("Emulation.setDeviceMetricsOverride", {
			width: layout.width,
			height: layout.height,
			deviceScaleFactor: 1,
			mobile: layout.mobile,
		});
		await page.send("Emulation.setTouchEmulationEnabled", {enabled: layout.mobile});
		await page.sleep(1500);

		for (const words of WORDS) {
			await choose(page, "psWords", words);
			await page.sleep(2500);
			const m = await page.evaluate(SAMPLE);
			const row = {
				layout: layout.name,
				words,
				frames: m.frames.length,
				mean: m.frames.reduce((a, b) => a + b, 0) / m.frames.length,
				p95: pct(m.frames, 0.95),
				max: Math.max(...m.frames),
				longShare: (100 * m.longMs) / m.span,
				longCount: m.longCount,
				animations: m.animations,
			};
			rows.push(row);
			page.check(
				`${layout.name}, ${words}: the sample stands (${m.words}, ${(m.span / 1000).toFixed(
					1
				)} s, ${m.frames.length} frames, ${m.animations} animations running)`,
				m.words === words && m.span >= WINDOW_MS && m.frames.length >= 100
			);
		}
	}

	console.log("\nlayout   words     frames  mean   p95    max    long-task share  long tasks");

	for (const r of rows) {
		console.log(
			`${r.layout.padEnd(8)} ${r.words.padEnd(9)} ${String(r.frames).padStart(5)}  ${f1(
				r.mean
			)}  ${f1(r.p95)}  ${f1(r.max)}  ${f1(r.longShare)} %         ${r.longCount}`
		);
	}

	await choose(page, "psWords", "bubbles");
}
