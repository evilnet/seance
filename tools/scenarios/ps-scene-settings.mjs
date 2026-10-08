// The ps theme's own settings (Settings → Appearance, shown under the theme
// select while ps is the theme): Scene animation (off, sparse, once a
// second, 24 frames a second, the browser's own rate), Pause the scene when
// the window isn't in use, and Combine messages from the same person.
//
//   NODE_ENV=production corepack yarn build && python3 -m http.server -d public 8006 &
//   node tools/browser-drive.mjs tools/scenarios/ps-scene-settings.mjs
//
// Needs the dev ircd (a second user says two lines). Pins a clear noon on
// 25 September with a Date shim, so the scene is the same every run. Each
// level is read off the main thread's style recalculations a second (CDP
// Performance.getMetrics) over a few seconds: off and sparse ≈ 0, once a
// second ≈ 1, 24 ≈ 24, 60 = the browser's own, more than 24 here.

const IRCD = process.env.SEANCE_IRC_URL ?? "ws://127.0.0.1:8067/";
const PORT = process.env.SEANCE_PORT ?? "8006";
const RUN = Math.random().toString(36).slice(2, 6);
const CHANNEL = `#set${RUN}`;
const NICK = `set${RUN}`;
const AT = Date.UTC(2026, 8, 25, 12, 30);
const ircd = new URL(IRCD);

export const url =
	`http://localhost:${PORT}/?host=${ircd.hostname}&port=${ircd.port}&tls=false&nick=${NICK}` +
	`&join=${encodeURIComponent(CHANNEL)}`;
export const sceneRest = true;

function speaker(nick) {
	const ws = new WebSocket(IRCD, ["text.ircv3.net"]);
	let onJoin = () => {};
	ws.onopen = () => {
		ws.send(`NICK ${nick}`);
		ws.send(`USER ${nick} 0 * :${nick}`);
	};
	ws.onmessage = (ev) => {
		const line = String(ev.data);
		if (line.startsWith("PING")) return ws.send(`PONG${line.slice(4)}`);
		const p = (line.startsWith("@") ? line.slice(line.indexOf(" ") + 1) : line).split(" ");
		if (p[1] === "001") ws.send(`JOIN ${CHANNEL}`);
		else if (p[1] === "JOIN" && p[0].startsWith(`:${nick}`)) onJoin();
	};
	return {
		joined: new Promise((r) => (onJoin = r)),
		say: (t) => ws.send(`PRIVMSG ${CHANNEL} :${t}`),
		quit: () => ws.send("QUIT"),
	};
}

/**
 * Style recalculations a second on the main thread, over `ms`. The composer
 * is blurred first: a focused text field restyles about twice a second under
 * every theme (measured 2.2 against 0.0 blurred), which is not the scene's.
 */
async function styles(page, ms) {
	await page.evaluate(`document.activeElement && document.activeElement.blur()`);
	const read = async () => {
		const {metrics} = await page.send("Performance.getMetrics");
		const get = (n) => metrics.find((m) => m.name === n).value;
		return {n: get("RecalcStyleCount"), at: get("Timestamp")};
	};
	const a = await read();
	await page.sleep(ms);
	const b = await read();
	return (b.n - a.n) / (b.at - a.at);
}

const SETTING = (name) => `document.querySelector('#settings [name="${name}"]')`;

async function openAppearance(page) {
	await page.evaluate(`location.hash = "#/settings/appearance"`);
	await page.waitFor(`document.querySelector("#theme-select")`, {label: "Appearance"});
}

async function closeSettings(page) {
	await page.click("#settings .settings-modal-done");
	await page.waitFor(`!document.querySelector("#theme-select")`, {label: "settings closed"});
}

async function setLevel(page, level) {
	await openAppearance(page);
	await page.click(`#settings input[name="psAnimation"][value="${level}"]`);
	await closeSettings(page);
	await page.sleep(1500);
}

/** The SVG clocks' sum, in seconds: what the scene's SMIL has advanced to. */
const SVG_TIME = `[...document.querySelectorAll("#theme-scene svg")].filter((v) => !v.closest(".ps-off")).reduce((t, v) => t + v.getCurrentTime(), 0)`;

export default async function run(page) {
	await page.send("Performance.enable");
	await page.send("Emulation.setTimezoneOverride", {timezoneId: "Etc/GMT"});
	await page.send("Emulation.setFocusEmulationEnabled", {enabled: true});
	await page.addInitScript(`try { localStorage.setItem("settings", JSON.stringify({theme: "ps"})); } catch (e) {}
		(() => { const R = Date, off = ${AT} - R.now(); function S(...a){ if (!new.target) return R(); return a.length ? new R(...a) : new R(R.now() + off); }
		S.prototype = R.prototype; S.now = () => R.now() + off; S.UTC = R.UTC; S.parse = R.parse; window.Date = S; })();`);
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="${CHANNEL}"]')`, {
		timeout: 30000,
	});
	await page.click(`.channel-list-item[data-name="${CHANNEL}"]`);

	// The section is there under ps, with its defaults.
	await openAppearance(page);
	const defaults = await page.evaluate(`JSON.stringify({
		level: document.querySelector('#settings [name="psAnimation"]:checked')?.value,
		pause: ${SETTING("psPauseWhenAway")}?.checked,
		group: ${SETTING("psGroupMessages")}?.checked,
		levels: [...document.querySelectorAll('#settings [name="psAnimation"]')].map((i) => i.value),
	})`);
	const d = JSON.parse(defaults);
	page.check(
		`under ps, Appearance has the theme's settings: Scene animation ${d.levels.join("/")} at ${
			d.level
		}, pause when away ${d.pause}, combine ${d.group}`,
		d.levels.join() === "off,sparse,1s,24,60" &&
			d.level === "24" &&
			d.pause === true &&
			d.group === true
	);
	await page.evaluate(`document.querySelector("#theme-select").scrollIntoView({block: "start"})`);
	await page.sleep(200);
	await page.screenshot("ps-settings-section");
	await closeSettings(page);

	// Each level, by the restyles it costs.
	const rates = {};
	for (const level of ["off", "1s", "24", "60"]) {
		await setLevel(page, level);
		rates[level] = await styles(page, 4000);
	}
	page.check(
		`off: the scene is still (${rates.off.toFixed(1)} restyles a second)`,
		rates.off < 1
	);
	page.check(
		`once a second: about one restyle a second (${rates["1s"].toFixed(1)})`,
		rates["1s"] > 0.5 && rates["1s"] < 2.5
	);
	page.check(
		`24: about 24 a second (${rates["24"].toFixed(1)})`,
		rates["24"] > 18 && rates["24"] < 30
	);
	page.check(
		`60: the browser's own rate, more than 24 (${rates["60"].toFixed(1)})`,
		rates["60"] > 30
	);

	// Sparse: still in between, and up to date on coming back.
	await setLevel(page, "sparse");
	const sparse = await styles(page, 4000);
	page.check(
		`sparse: still between its steps (${sparse.toFixed(1)} restyles a second)`,
		sparse < 1
	);
	await page.evaluate(`window.dispatchEvent(new Event("blur"))`);
	await page.sleep(16000); // rests
	const before = await page.evaluate(SVG_TIME);
	await page.evaluate(`window.dispatchEvent(new Event("focus"))`);
	await page.sleep(200);
	const after = await page.evaluate(SVG_TIME);
	page.check(
		`sparse: coming back moves the scene on at once (the SVG clocks ${before.toFixed(
			1
		)} → ${after.toFixed(1)} s)`,
		after - before > 10
	);

	// Pause when away, off: a window without the focus keeps moving.
	await setLevel(page, "24");
	await openAppearance(page);
	await page.click(`#settings input[name="psPauseWhenAway"]`);
	await closeSettings(page);
	await page.evaluate(`window.dispatchEvent(new Event("blur"))`);
	await page.sleep(16000);
	const away = await styles(page, 3000);
	page.check(
		`pause when away off: a window without the focus still moves (${away.toFixed(
			1
		)} restyles a second)`,
		away > 12
	);
	await page.evaluate(`window.dispatchEvent(new Event("focus"))`);

	// Combine messages: on, the second of two lines is a continuation; off, it is not.
	const peer = speaker(`peer${RUN}`);
	await peer.joined;
	peer.say(`one of two ${RUN}`);
	peer.say(`two of two ${RUN}`);
	const SECOND = `[...document.querySelectorAll("#chat .msg")].find((m) => m.textContent.includes("two of two ${RUN}"))`;
	await page.waitFor(`${SECOND} !== undefined`, {label: "the two lines"});
	await page.sleep(300);
	const grouped = await page.evaluate(
		`${SECOND}.classList.contains("previous-source") && getComputedStyle(${SECOND}.querySelector(".from")).display`
	);
	page.check(`combine on: the second line shows no nick (${grouped})`, grouped === "none");
	await openAppearance(page);
	await page.click(`#settings input[name="psGroupMessages"]`);
	await closeSettings(page);
	await page.sleep(300);
	const apart = await page.evaluate(
		`${SECOND}.classList.contains("previous-source") + " " + getComputedStyle(${SECOND}.querySelector(".from")).display`
	);
	page.check(
		`combine off: every line shows its nick and time (${apart})`,
		apart === "false block"
	);
	await page.screenshot("ps-settings-combine-off");
	peer.quit();

	// Under another theme the section is not there.
	await openAppearance(page);
	await page.evaluate(
		`(() => { const s = document.querySelector("#theme-select"); s.value = "coffee"; s.dispatchEvent(new Event("change", {bubbles: true})); })()`
	);
	await page.sleep(500);
	page.check(
		"under coffee, Appearance has no ps settings",
		!(await page.evaluate(`!!${SETTING("psAnimation")} || !!${SETTING("psGroupMessages")}`))
	);
}
