// The ps theme's NG scene in a real browser (docs/projects/ps-ng.md, plan 1):
// classic's markup, still — no animation object, no SMIL clock, no stepper —
// beside classic, in one build, switched by the `psRenderer` setting. The
// run connects to #seance, says one line of its own, and then:
//
// - with the preview flag (`thelounge.state.psngPreview` = "1") set, opens
//   Settings → Appearance, picks ps, and finds the "Scene renderer" radio
//   pair; NG (preview) mounts NG (`psng` on #theme-scene), Classic puts
//   classic back (desktop only: on the phone layout the settings footer is
//   in the drawer, and the pair has nothing phone-specific to show);
// - switches between the renderers at a pinned 21 June noon: NG has `psng`
//   and its adopted sheet; the animation census finds no animation on the
//   scene, no SMIL element and every SVG clock paused; `#sidebar`'s
//   backdrop-filter (the open drawer's, on a phone) is the string classic
//   computes at the same minute (NG never touches the glass); and back on classic nothing of NG is left —
//   no `psng`, no NG sheet — while classic's SMIL is back and its clocks
//   move between two samples 300 ms apart;
// - at a hot noon (1 July 12:30, `heat`): classic sets `ps-hot`, NG never
//   does, and NG's ground is drawn — pixels of the grass bbox equal to
//   `--ps-grass` within 10 per channel;
// - under reduced motion (`data-reduce-motion`, through the emulated media
//   feature), NG's scene shot alone (#viewport hidden) equals the one
//   without it within 2 per channel over 95 % of the pixels;
// - shoots classic and NG at 21 June 12:00, 20:45 and 23:30, 19 October
//   12:00 (rain) and 14 January 12:00 (snow; the brief's 15 January is a
//   clear day in the engine, so its snowy neighbour stands in), named so the
//   pairs sort together (`desktop-0621-1200-classic.png` / `-ng.png`), and
//   lays each viewport's pairs out on one contact sheet (classic left, NG
//   right; `contact-desktop.png`);
// - last, boots cold with ps and NG stored and the clock at 23:00 on a clear
//   night (25 September): the first frame NG's root is in already carries
//   the night's `--ps-sky-top` (read within 300 ms of the mount), the sky's
//   pixel at the top centre of the scene shot alone matches it within 6 per
//   channel and is not the daylight fallback, and from the load to 10 s after
//   the mount nothing fetches classic's chunk (`js/scene-ps.js`).
//
//   NODE_ENV=production npx webpack && python3 -m http.server -d public 8041 &
//   SEANCE_HTTP_PORT=8041 node tools/browser-drive.mjs tools/scenarios/ps-ng.mjs \
//     --out=tmp/ps-ng-shots
//   (and again with --mobile --width=390 --height=844)
//
// The clock is a Date shim in UTC (theme-ps.mjs's CLOCK_SHIM), with one
// addition: `sessionStorage["psng.clock"]` presets it for the next document,
// since a cold start reads the time before any scenario code can run. Needs
// the dev ircd (SEANCE_IRC_PORT, default 8067).

import {writeFileSync} from "node:fs";
import {join} from "node:path";
import {pathToFileURL} from "node:url";

const RUN = Date.now().toString(36);
const NICK = `ng${RUN}`;
const BASE = `http://localhost:${process.env.SEANCE_HTTP_PORT ?? "8021"}/`;
const PORT = process.env.SEANCE_IRC_PORT ?? "8067";

export const url = `${BASE}?host=127.0.0.1&port=${PORT}&tls=false&nick=${NICK}&join=%23seance`;

/** The daylight fallback's sky top (ps.css, `#theme-scene`), #3f8fe6. */
const FALLBACK_SKY = [63, 143, 230];

/** Every SMIL element classic's markup carries and NG removes. */
const SMIL = "animate, animateMotion, animateTransform, set";

const CLOCK_SHIM = `(() => {
	const RealDate = Date;
	const realNow = RealDate.now.bind(RealDate);
	const preset = sessionStorage.getItem("psng.clock");
	let offset = preset ? Number(preset) - realNow() : 0;
	function ShimDate(...a) {
		if (!new.target) return RealDate();
		return a.length ? new RealDate(...a) : new RealDate(realNow() + offset);
	}
	ShimDate.prototype = RealDate.prototype;
	ShimDate.now = () => realNow() + offset;
	ShimDate.UTC = RealDate.UTC;
	ShimDate.parse = RealDate.parse;
	window.Date = ShimDate;
	window.__setClock = (ms) => { offset = ms === null ? 0 : ms - realNow(); };
})()`;

/**
 * The page's own record of NG's mount: when `psng` lands on #theme-scene
 * (a MutationObserver, which runs once the synchronous mount is done) and the
 * first animation frame after it, with the `--ps-sky-top` and display that
 * frame has. Also the helpers the pixel checks run in the page: a PNG
 * (base64) to ImageData, and a CSS colour to [r, g, b].
 */
const PAGE_HELPERS = `(() => {
	performance.setResourceTimingBufferSize(10000);
	window.__psngBoot = null;
	const mo = new MutationObserver(() => {
		const s = document.getElementById("theme-scene");
		if (!s || !s.classList.contains("psng") || window.__psngBoot) return;
		const boot = (window.__psngBoot = {mountAt: performance.now(), frameAt: null});
		mo.disconnect();
		requestAnimationFrame(() => {
			const cs = getComputedStyle(s);
			boot.frameAt = performance.now();
			boot.skyTop = cs.getPropertyValue("--ps-sky-top").trim();
			boot.display = cs.display;
		});
	});
	mo.observe(document, {subtree: true, attributes: true, attributeFilter: ["class"]});
	window.__png = async (b64) => {
		const img = new Image();
		img.src = "data:image/png;base64," + b64;
		await img.decode();
		const c = document.createElement("canvas");
		c.width = img.width;
		c.height = img.height;
		const x = c.getContext("2d");
		x.drawImage(img, 0, 0);
		return x.getImageData(0, 0, c.width, c.height);
	};
	window.__rgb = (css) => {
		const x = document.createElement("canvas").getContext("2d");
		x.fillStyle = "#000";
		x.fillStyle = css;
		x.fillRect(0, 0, 1, 1);
		return [...x.getImageData(0, 0, 1, 1).data.slice(0, 3)];
	};
})()`;

const PREVIEW_FLAG = `try { localStorage.setItem("thelounge.state.psngPreview", "1"); } catch (e) {}`;

const STORE = `document.querySelector("[data-v-app]").__vue_app__.config.globalProperties.$store`;

/** Make the page believe it was hidden or shown, and tell it (theme-ps.mjs). */
const VISIBILITY = (state) => `(() => {
	Object.defineProperty(document, "visibilityState", {configurable: true, get: () => ${JSON.stringify(
		state
	)}});
	Object.defineProperty(document, "hidden", {configurable: true, get: () => ${state === "hidden"}});
	document.dispatchEvent(new Event("visibilitychange"));
})()`;

/** What the scene is, in one read. */
const SCENE = `(() => {
	const s = document.getElementById("theme-scene");
	const ngSheet = document.adoptedStyleSheets.some((sh) =>
		[...sh.cssRules].some((r) => r.cssText.includes("#theme-scene.psng"))
	);
	return {
		psng: s.classList.contains("psng"),
		hot: s.classList.contains("ps-hot"),
		children: s.children.length,
		weather: s.dataset.weather ?? null,
		ngSheet,
		animations: s.getAnimations({subtree: true}).length,
		smil: s.querySelectorAll(${JSON.stringify(SMIL)}).length,
		svgs: s.querySelectorAll("svg").length,
		svgsRunning: [...s.querySelectorAll("svg")].filter((v) => !v.animationsPaused()).length,
		skyTop: getComputedStyle(s).getPropertyValue("--ps-sky-top").trim(),
		grass: getComputedStyle(s).getPropertyValue("--ps-grass").trim(),
	};
})()`;

/**
 * Whether anything in the scene moves: every animation's currentTime and
 * every SVG clock, sampled twice 300 ms apart (a stepped scene's
 * animations read paused, so playState says nothing).
 */
const MOVES = `(async () => {
	const s = document.getElementById("theme-scene");
	const read = () => [
		...s.getAnimations({subtree: true}).map((a) => Number(a.currentTime)),
		...[...s.querySelectorAll("svg")].map((v) => v.getCurrentTime()),
	];
	const a = read();
	await new Promise((r) => setTimeout(r, 300));
	const b = read();
	return {clocks: a.length, moved: b.filter((v, i) => i < a.length && v !== a[i]).length};
})()`;

const HIDE_CHROME = `(() => {
	for (const id of ["viewport", "status-bar-tint"]) {
		const el = document.getElementById(id);
		if (el) el.style.visibility = "hidden";
	}
})()`;
const SHOW_CHROME = HIDE_CHROME.replace(`"hidden"`, `""`);

/** The pinned instant (UTC; the run sets the time zone to Etc/GMT). */
const instant = (month, day, hour, minute) => Date.UTC(2026, month - 1, day, hour, minute, 5);

/** Put the page's clock at `ms`, then hide and show the page so the scene ticks at once. */
async function at(page, ms, settleMs = 1500) {
	await page.evaluate(`window.__setClock(${ms})`);
	await page.evaluate(VISIBILITY("hidden"));
	await page.evaluate(VISIBILITY("visible"));
	await page.sleep(settleMs);
	return page.evaluate(SCENE);
}

/**
 * #sidebar's computed backdrop-filter; on the phone layout with the drawer
 * open, since the closed drawer has none in either renderer (ps.css: only
 * the open drawer keeps the blur there).
 */
async function sidebarBackdrop(page, phone) {
	const read = `getComputedStyle(document.getElementById("sidebar")).backdropFilter`;

	if (!phone) {
		return page.evaluate(read);
	}

	const open = `document.getElementById("viewport").classList.contains("menu-open")`;
	await page.click(`#chat .header .lt`);
	await page.waitFor(open, {label: "the drawer open"});
	await page.sleep(1000);
	const value = await page.evaluate(read);
	await page.evaluate(`document.getElementById("sidebar-overlay").click()`);
	await page.waitFor(`!${open}`, {label: "the drawer closed"});
	await page.sleep(600);
	return value;
}

async function setRenderer(page, value) {
	await page.evaluate(
		`${STORE}.dispatch("settings/update", {name: "psRenderer", value: ${JSON.stringify(
			value
		)}})`
	);
	await waitRenderer(page, value);
}

async function waitRenderer(page, value) {
	const sel = `document.querySelector("#theme-scene")`;
	await page.waitFor(
		value === "ng"
			? `${sel}.classList.contains("psng") && ${sel}.children.length > 0`
			: `!${sel}.classList.contains("psng") && !!${sel}.querySelector(".ps-frost")`,
		{label: `the ${value} scene mounted`}
	);
}

/** #theme-scene alone, as base64 PNG: the chrome hidden, the scene's own box. */
async function sceneShot(page) {
	await page.evaluate(HIDE_CHROME);
	await page.sleep(150);
	const r = await page.evaluate(
		`document.getElementById("theme-scene").getBoundingClientRect().toJSON()`
	);
	const shot = await page.send("Page.captureScreenshot", {
		format: "png",
		clip: {x: r.x, y: r.y, width: r.width, height: r.height, scale: 1},
	});
	await page.evaluate(SHOW_CHROME);
	return {data: shot.data, rect: r};
}

/** The median colour of a 9×5 patch at the top centre of a scene shot. */
const TOP_CENTRE = (b64) => `(async () => {
	const img = await window.__png(${JSON.stringify(b64)});
	const cx = Math.floor(img.width / 2), ch = [[], [], []];
	for (let y = 2; y < 7; y++) for (let x = cx - 4; x <= cx + 4; x++) {
		const i = (y * img.width + x) * 4;
		for (let c = 0; c < 3; c++) ch[c].push(img.data[i + c]);
	}
	return ch.map((v) => v.sort((a, b) => a - b)[v.length >> 1]);
})()`;

/** Inside the grass's box: how many pixels equal `css` within `tol` per channel, of how many. */
const MATCHING = (b64, box, css, tol) => `(async () => {
	const img = await window.__png(${JSON.stringify(b64)});
	const want = window.__rgb(${JSON.stringify(css)});
	const b = ${JSON.stringify(box)};
	let hit = 0, all = 0, best = null, bestD = Infinity;
	for (let y = Math.max(0, Math.floor(b.y)); y < Math.min(img.height, b.y + b.height); y++) {
		for (let x = Math.max(0, Math.floor(b.x)); x < Math.min(img.width, b.x + b.width); x++) {
			const i = (y * img.width + x) * 4;
			const px = [img.data[i], img.data[i + 1], img.data[i + 2]];
			const d = Math.max(...px.map((v, c) => Math.abs(v - want[c])));
			all++;
			if (d <= ${tol}) hit++;
			if (d < bestD) { bestD = d; best = px; }
		}
	}
	return {want, hit, all, best, bestD};
})()`;

/** The share of pixels two shots agree on within `tol` per channel. */
const AGREE = (a, b, tol) => `(async () => {
	const p = await window.__png(${JSON.stringify(a)});
	const q = await window.__png(${JSON.stringify(b)});
	if (p.width !== q.width || p.height !== q.height) return {size: false, share: 0, worst: null};
	let same = 0, worst = 0;
	for (let i = 0; i < p.data.length; i += 4) {
		const d = Math.max(...[0, 1, 2].map((c) => Math.abs(p.data[i + c] - q.data[i + c])));
		if (d <= ${tol}) same++;
		worst = Math.max(worst, d);
	}
	return {size: true, share: same / (p.data.length / 4), worst};
})()`;

const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

async function sendLine(page, text) {
	await page.evaluate(
		`(() => {
			const i = document.getElementById("input");
			i.value = ${JSON.stringify(text)};
			i.dispatchEvent(new Event("input", {bubbles: true}));
			document.getElementById("form").requestSubmit();
		})()`
	);
}

/** The radio pair in Settings → Appearance, once, on the desktop. */
async function radioPair(page, vp) {
	await page.click(`#footer button.settings`);
	await page.waitFor(`document.querySelector(".settings-menu button.appearance")`, {
		label: "settings open",
	});
	await page.click(`.settings-menu button.appearance`);
	await page.waitFor(`document.querySelector("#theme-select")`, {label: "the theme select"});
	await page.evaluate(`(() => {
		const el = document.querySelector("#theme-select");
		el.value = "ps";
		el.dispatchEvent(new Event("change", {bubbles: true}));
	})()`);
	await waitRenderer(page, "classic");
	const pair = await page.evaluate(`(() => {
		const h = document.getElementById("label-ps-renderer");
		return {
			heading: h ? h.textContent.trim() : null,
			radios: [...document.querySelectorAll('input[name="psRenderer"]')].map((r) => ({
				value: r.value,
				label: r.closest("label").textContent.trim(),
				checked: r.checked,
			})),
		};
	})()`);
	page.check(
		`settings: with the preview flag the "Scene renderer" pair shows (${JSON.stringify(pair)})`,
		pair.heading === "Scene renderer" &&
			pair.radios.length === 2 &&
			pair.radios[0].label === "Classic" &&
			pair.radios[0].checked &&
			pair.radios[1].label === "NG (preview)"
	);
	await page.evaluate(
		`document.querySelector('#label-ps-renderer').scrollIntoView({block: "center"})`
	);
	await page.click(`input[name="psRenderer"][value="ng"]`);
	await waitRenderer(page, "ng");
	page.check(`settings: picking NG (preview) mounts NG`, (await page.evaluate(SCENE)).psng);
	await page.screenshot(`${vp}-settings-renderer-ng`);
	await page.click(`input[name="psRenderer"][value="classic"]`);
	await waitRenderer(page, "classic");
	const back = await page.evaluate(SCENE);
	page.check(
		`settings: picking Classic puts classic back (psng ${back.psng}, SMIL ${back.smil})`,
		!back.psng && back.smil > 0
	);
	await page.click(`.settings-modal-done`);
	await page.waitFor(`!document.querySelector(".settings-modal-done")`, {
		label: "settings closed",
	});
}

const MOMENTS = [
	["0621-1200", instant(6, 21, 12, 0), "clear"],
	["0621-2045", instant(6, 21, 20, 45), "clear"],
	["0621-2330", instant(6, 21, 23, 30), "clear"],
	["1019-1200-rain", instant(10, 19, 12, 0), "rain"],
	["0114-1200-snow", instant(1, 14, 12, 0), "snow"],
];

export default async function run(page) {
	const vp = page.flags.has("--mobile") ? "mobile" : "desktop";
	await page.send("Emulation.setTimezoneOverride", {timezoneId: "Etc/GMT"});
	await page.addInitScript(CLOCK_SHIM);
	await page.addInitScript(PAGE_HELPERS);
	await page.addInitScript(PREVIEW_FLAG);

	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="#seance"]')`, {
		timeout: 30000,
		label: "#seance in the sidebar",
	});
	await page.evaluate(
		`document.querySelector('.channel-list-item[data-name="#seance"]').click()`
	);
	await page.waitFor(`document.querySelector("#input")`, {label: "the input box"});
	await page.sleep(1000);
	await sendLine(page, `hello from the still plains ${RUN}`);
	await page.waitFor(`!document.querySelector("#chat .msg.pending")`, {label: "our own line"});

	// ---- ps, and the radio pair (desktop) or the store (phone)

	if (vp === "desktop") {
		await radioPair(page, vp);
	} else {
		await page.evaluate(`${STORE}.dispatch("settings/update", {name: "theme", value: "ps"})`);
		await waitRenderer(page, "classic");
		console.log("  (the radio pair is checked on the desktop run)");
	}

	// ---- switch and census at a pinned noon

	const noon = instant(6, 21, 12, 0);
	await at(page, noon);
	const classicBackdrop = await sidebarBackdrop(page, vp === "mobile");
	await setRenderer(page, "ng");
	const ng = await at(page, noon);
	const ngBackdrop = await sidebarBackdrop(page, vp === "mobile");
	page.check(
		`switch: NG has psng and its adopted sheet (psng ${ng.psng}, sheet ${ng.ngSheet}, ${ng.children} layers)`,
		ng.psng && ng.ngSheet && ng.children > 0
	);
	page.check(
		`census: no animation on NG's scene (${ng.animations}), no SMIL element (${ng.smil}), every SVG clock paused (${ng.svgsRunning} of ${ng.svgs} running)`,
		ng.animations === 0 && ng.smil === 0 && ng.svgs > 0 && ng.svgsRunning === 0
	);
	page.check(
		`census: #sidebar's backdrop-filter${
			vp === "mobile" ? " (the drawer open)" : ""
		} is classic's at the same minute (NG "${ngBackdrop}", classic "${classicBackdrop}")`,
		ngBackdrop === classicBackdrop && classicBackdrop !== "none"
	);
	const ngMoves = await page.evaluate(MOVES);
	page.check(
		`census: nothing in NG's scene moves in 300 ms (${ngMoves.moved} of ${ngMoves.clocks} clocks)`,
		ngMoves.moved === 0
	);

	await setRenderer(page, "classic");
	const again = await at(page, noon);
	const moves = await page.evaluate(MOVES);
	page.check(
		`switch: back on classic nothing of NG is left (psng ${again.psng}, NG sheet ${again.ngSheet})`,
		!again.psng && !again.ngSheet
	);
	page.check(
		`switch: classic mounts clean and runs (SMIL ${again.smil}, ${again.animations} animations, ${moves.moved} of ${moves.clocks} clocks moved in 300 ms)`,
		again.smil > 0 && again.animations > 0 && moves.moved > 0
	);

	// ---- hot noon: classic's ps-hot, NG's none, NG's ground drawn

	const hotAt = instant(7, 1, 12, 30);
	const hotClassic = await at(page, hotAt);
	page.check(
		`hot noon: 1 July 12:30 is ${hotClassic.weather} and classic sets ps-hot (${hotClassic.hot})`,
		hotClassic.weather === "heat" && hotClassic.hot
	);
	await setRenderer(page, "ng");
	const hot = await at(page, hotAt);
	page.check(`hot noon: NG never sets ps-hot (${hot.hot})`, !hot.hot);
	const grassBox = await page.evaluate(
		`document.querySelector("#theme-scene .ps-l-grass").getBoundingClientRect().toJSON()`
	);
	const land = await sceneShot(page);
	const box = {
		x: grassBox.x - land.rect.x,
		y: grassBox.y - land.rect.y,
		width: grassBox.width,
		height: grassBox.height,
	};
	const grass = await page.evaluate(MATCHING(land.data, box, hot.grass, 10));
	page.check(
		`hot noon: NG's ground is drawn — ${grass.hit} of ${grass.all} pixels in the grass's box equal --ps-grass ${hot.grass} [${grass.want}] ± 10 (closest [${grass.best}], ${grass.bestD} off)`,
		grass.hit > 0 && grass.hit >= grass.all * 0.01
	);

	// ---- reduced motion: the same still scene

	const calm = instant(6, 21, 12, 0);
	await at(page, calm);
	const before = await sceneShot(page);
	await page.send("Emulation.setEmulatedMedia", {
		features: [{name: "prefers-reduced-motion", value: "reduce"}],
	});
	const REDUCED = `document.documentElement.hasAttribute("data-reduce-motion")`;
	let reduced = await page
		.waitFor(REDUCED, {label: "data-reduce-motion", timeout: 3000})
		.then(() => true)
		.catch(() => false);

	if (!reduced) {
		console.log("  (the emulated media did not reach data-reduce-motion; set it directly)");
		await page.evaluate(`document.documentElement.setAttribute("data-reduce-motion", "")`);
		reduced = true;
	}

	await page.sleep(1000);
	const after = await sceneShot(page);
	const agree = await page.evaluate(AGREE(before.data, after.data, 2));
	page.check(
		`reduced motion: NG's scene equals itself without it — ${(agree.share * 100).toFixed(
			2
		)} % of pixels within 2 (worst ${agree.worst})`,
		reduced && agree.size && agree.share >= 0.95
	);
	await page.send("Emulation.setEmulatedMedia", {features: []});
	await page
		.waitFor(`!document.documentElement.hasAttribute("data-reduce-motion")`, {
			label: "reduced motion off",
		})
		.catch(() =>
			page.evaluate(`document.documentElement.removeAttribute("data-reduce-motion")`)
		);

	// ---- the pairs (no hostname in frame: the join and quit lines carry it)

	await page.evaluate(`(() => {
		const st = document.createElement("style");
		st.textContent = ".hostmask { display: none !important; }";
		document.head.append(st);
	})()`);
	const names = [];

	for (const [name, ms, weather] of MOMENTS) {
		for (const renderer of ["classic", "ng"]) {
			await setRenderer(page, renderer);
			const s = await at(page, ms, 2000);
			page.check(
				`shot ${vp}-${name}-${renderer}: the day's weather is ${weather} (${s.weather})`,
				s.weather === weather
			);
			// Our own line in frame: the drawer's round trip can leave the log scrolled up.
			await page.evaluate(`(() => {
				const c = document.querySelector("#chat .chat");
				c.scrollTop = c.scrollHeight;
			})()`);
			await page.sleep(300);
			await page.screenshot(`${vp}-${name}-${renderer}`);
		}

		names.push(name);
	}

	// ---- last: a cold start at night with NG stored

	await setRenderer(page, "ng");
	const night = instant(9, 25, 23, 0);
	await page.evaluate(`sessionStorage.setItem("psng.clock", "${night}")`);
	await page.evaluate(`window.__beforeReload = true`);
	await page.send("Page.reload");
	await page.waitFor(
		`!window.__beforeReload && window.__psngBoot && window.__psngBoot.frameAt !== null`,
		{
			label: "NG's first frame after the cold start",
		}
	);
	const boot = await page.evaluate(`window.__psngBoot`);
	const cold = await sceneShot(page);
	const shotAt = await page.evaluate(`performance.now()`);
	await page.evaluate(`sessionStorage.removeItem("psng.clock")`);
	const coldState = await page.evaluate(SCENE);
	const skyWant = await page.evaluate(`window.__rgb(${JSON.stringify(boot.skyTop || "#000")})`);
	const skyGot = await page.evaluate(TOP_CENTRE(cold.data));
	const frameDelta = boot.frameAt - boot.mountAt;
	console.log(
		`  cold start: mount at ${boot.mountAt.toFixed(0)} ms, first frame +${frameDelta.toFixed(
			1
		)} ms (display ${boot.display}), scene shot +${(shotAt - boot.mountAt).toFixed(0)} ms`
	);
	page.check(
		`cold start: 25 September 23:00 is ${coldState.weather}`,
		coldState.weather === "clear"
	);
	page.check(
		`cold start: NG's first frame, +${frameDelta.toFixed(
			1
		)} ms after the mount, already has the night's --ps-sky-top (${
			boot.skyTop
		}) and not the fallback's`,
		frameDelta <= 300 && boot.skyTop !== "" && !near(skyWant, FALLBACK_SKY, 6)
	);
	page.check(
		`cold start: the sky at the scene's top centre [${skyGot}] is --ps-sky-top [${skyWant}] ± 6, not the daylight fallback`,
		near(skyGot, skyWant, 6) && !near(skyGot, FALLBACK_SKY, 6)
	);
	await page.screenshot(`${vp}-cold-0925-2300-ng`);

	const wait = 10000 - (shotAt - boot.mountAt);

	if (wait > 0) {
		await page.sleep(wait);
	}

	const chunks = await page.evaluate(
		`performance.getEntriesByType("resource").map((e) => e.name).filter((n) => /\\/js\\/scene-ps(-ng)?\\.js(\\?|$)/.test(n))`
	);
	page.check(
		`network: with NG stored, nothing fetched classic's chunk from the load to 10 s after the mount (${
			chunks.map((n) => n.replace(/^.*\//, "")).join(", ") || "no scene chunk"
		})`,
		chunks.length > 0 && !chunks.some((n) => /\/js\/scene-ps\.js(\?|$)/.test(n))
	);

	// ---- the contact sheet: classic left, NG right, one row per moment

	const width = vp === "mobile" ? 300 : 620;
	const rows = names
		.map(
			(n) =>
				`<h2>${n}</h2><div class="r"><figure><img src="${vp}-${n}-classic.png"><figcaption>classic</figcaption></figure>` +
				`<figure><img src="${vp}-${n}-ng.png"><figcaption>NG</figcaption></figure></div>`
		)
		.join("");
	const sheet = join(page.outDir, `contact-${vp}.html`);
	writeFileSync(
		sheet,
		`<!doctype html><meta charset=utf-8><title>ps NG plan 1 — ${vp}</title><style>` +
			`body{font:14px system-ui;margin:16px;background:#eee}h2{margin:16px 0 6px;font-size:15px}` +
			`.r{display:flex;gap:12px}figure{margin:0}img{width:${width}px;display:block}` +
			`figcaption{font-size:12px}</style><h1>ps NG plan 1 — classic (left) and NG (right), ${vp}</h1>${rows}`
	);
	await page.send("Emulation.setDeviceMetricsOverride", {
		width: width * 2 + 60,
		height: 900,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await page.goto(pathToFileURL(sheet).href);
	await page.waitFor(
		`document.readyState === "complete" && document.images.length === ${
			names.length * 2
		} && [...document.images].every((i) => i.complete && i.naturalWidth > 0)`,
		{
			label: "the contact sheet's images",
		}
	);
	const size = await page.evaluate(
		`({w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight})`
	);
	await page.send("Emulation.setDeviceMetricsOverride", {
		width: size.w,
		height: size.h,
		deviceScaleFactor: 1,
		mobile: false,
	});
	const shot = await page.send("Page.captureScreenshot", {format: "png"});
	const png = join(page.outDir, `contact-${vp}.png`);
	writeFileSync(png, Buffer.from(shot.data, "base64"));
	console.log(`shot ${png}`);
}
