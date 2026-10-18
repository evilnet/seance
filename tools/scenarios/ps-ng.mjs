// The ps theme's NG scene in a real browser (docs/projects/ps-ng.md, plans 1
// to 4): classic's markup with classic's own CSS animations running group by
// group (`psng-m-<group>` on #theme-scene, the tier from the host state, in
// phase by `--psng-t`). NG is the only renderer, its chunk `js/scene-ps.js`.
// The run connects to #seance, says one line of its own, leaves
// `thelounge.state.psngGroups` unset (every group a tier allows) and the
// `psAnimation` setting at Full (Auto follows the device since plan 3; one
// check covers it), and then:
//
// - picks ps through the store and waits for NG (`psng` on #theme-scene);
// - at a pinned 21 June noon, NG freshly mounted: NG has `psng` and its
//   adopted sheet; the FULL census (below); #sidebar's backdrop-filter (the
//   open drawer's, on a phone) is not "none" (NG never touches the glass's
//   blur); then Calm (below);
// - the setting at Still: the STILL census (below), plus every SVG clock
//   paused and nothing moving between two samples 300 ms apart (plan 1's
//   census, now the still tier's); back at Full, animations run again;
// - at a hot noon (1 July 12:30, `heat`): NG never sets `ps-hot`, and its
//   ground is drawn — pixels of the grass bbox equal to `--ps-grass` within
//   10 per channel;
// - the FULL census and Calm again, each moment on a fresh mount, at 21 June
//   23:00 (the stars and fireflies running), a storm day (19 July 12:00: the
//   weather running) and the dusk with skeins (14 May 20:45: the skeins
//   running; the brief's 21 June 20:45 has no skeins — `birdsAt` gives none
//   all that evening, migration is spring and autumn — and 14 May is the
//   nearest clear day that has them, 24 minutes after its sunset);
// - the still states, each the STILL census: reduced motion toggled live
//   through the emulated media off → on → off — setting it must bring
//   `data-reduce-motion` and clearing it must take it away, each a check of
//   its own, within 3 s — moving before and after, and after it goes off the
//   clouds' phase as below (the move out of still at the moment the media
//   was cleared); then the rests that freeze: a hidden page and a query
//   (`/query`, `data-view="query"`), each cloud held where it stood and,
//   shown again or back in #seance, going on from there, then moving
//   ("moving" is animations on the scene, frames from NG's chunk and at least
//   one in-flight layer displayed); at noon, before the hidden page, while it
//   is frozen and once shown again, each lark shows the state its clock puts
//   it in (plan 4: from its `--ld`, `--ldl` and `--psng-t`, sampled 1 % or
//   more from a stop, its state box at opacity > 0 and the other two at 0;
//   frozen, the state it had before);
// - the phase: NG mounted at noon with the setting at Still, 30 s of real
//   time, then Full: `--psng-t` equals the pinned clock's seconds since the
//   mount day's midnight at the moment of the switch (± 3 s), and for each
//   cloud the computed `animation-delay` is `--cdl − --psng-t` (± 1 ms; read
//   from `effect.getTiming()`, since the serialised style rounds to six
//   significant figures, 31 ms at noon) and its measured `translateX` (the
//   computed matrix) is where that phase puts it, within 2 % of its path. The
//   Date shim pins the clock but not the document timeline, so the expected
//   place is from the animation's own `currentTime` t: progress =
//   ((--psng-t − --cdl) + t) mod D over D, D the computed `animation-duration`
//   (`--cd`, or 0.4 × it on a windy day), and
//   ps-drift's path puts it at (W + w + 0.5rem) × progress − w − 0.25rem
//   (W the scene's width, the cqw container; w the cloud's own width), the
//   error taken round the loop's seam;
// - switching the theme from ps to coffee while NG moves: no `psng*` class on
//   #theme-scene, no `--psng-t` (inline or computed), no NG adopted sheet, no
//   `.ps-fire`, no frame request from NG's chunk over 1 s; then back to ps,
//   NG mounted and moving;
// - Auto: calm on a touch phone, full on a desktop (also resized to a phone's
//   size without touch), calm on a low battery;
// - shoots NG in motion (Full) at 21 June 12:00, 14 May 20:45 (the dusk with
//   skeins, above), 21 June 23:30, 19 October 12:00 (rain) and 19 July 12:00
//   (storm) (`desktop-0621-1200.png`), and lays each viewport's shots out on
//   one contact sheet (one column; `contact-desktop.png`); then at 21 June
//   noon pauses the larks at points of their flights — the chute (66 %), the
//   closed drop (84 %) and the flutter (30 %) — checks each shows that state
//   and shoots each lark close (`desktop-lark0-66.png`);
// - last, boots cold with ps stored and the clock at 23:00 on a clear night
//   (25 September): the first frame NG's root is in already carries the
//   night's `--ps-sky-top` (read within 300 ms of the mount), the sky's pixel
//   at the top centre of the scene shot alone matches it within 6 per channel
//   and is not the daylight fallback, and from the load to 10 s after the
//   mount NG's chunk (`js/scene-ps.js`) is fetched and no `scene-ps-ng.js`.
//
// The FULL census: the root carries all nine `psng-m-*` classes and no
// `psng-calm`; every animation under #theme-scene is a known group's (by its
// animationName; `psng-pose2` under .ps-daybirds is the larks' flutter) and a group
// whose class is on; every one's keyframes (`effect.getKeyframes()`) touch
// only `transform` and `opacity`; every animated element's untransformed box
// is at most the viewport (± 1 px): an HTML element's offsetWidth/Height (the
// layout box, which no transform changes), an SVG element's bounding rect (its
// transformed box: a stricter bound, none of NG's SVG animations scales up);
// static elements larger than the viewport (the Milky Way) do not count; no
// SMIL element is left; no animated element sits inside an `<svg>` (plan 4:
// WebKit runs those on the main thread); the groups the moment is about are running; and, where
// the sun is up, NG's chunk requests animation frames (the fire, at 24 a
// second) — the positive control for the zero counts below.
// Calm (plan 5): the root carries `psng-calm` and the clouds' class alone, the
// set of group:animationName pairs running is exactly the full set at the same
// moment and mount narrowed to the clouds, nothing falls (rain, snow, seeds and
// flash out of the page), and NG's chunk requests no frame over 1 s.
// The STILL census: `getAnimations({subtree: true})` is empty, no group
// class, no SMIL, NG's chunk requests no animation frame over 1 s, and every
// in-flight layer in the page (.ps-skeins, .ps-daybirds, .ps-rain, .ps-snow,
// .ps-seeds, .ps-flash, .ps-smoke) computes `display: none`, with at least one
// of them found so the check is never vacuous. Frame requests are counted
// by an init script wrapping `requestAnimationFrame`, and `setTimeout` under
// 100 ms (the fire's wake-ups), that counts a call whose stack names
// `scene-ps.js` (NG's chunk), so Vue's never count.
//
//   NODE_ENV=production npx webpack && python3 -m http.server -d public 8041 &
//   SEANCE_HTTP_PORT=8041 node tools/browser-drive.mjs tools/scenarios/ps-ng.mjs \
//     --out=tmp/ps-ng-shots/plan2
//   (and again with --mobile --width=390 --height=844, and as a landscape
//   phone with --mobile --width=932 --height=430)
//
// The clock is a Date shim in UTC (theme-ps.mjs's CLOCK_SHIM), with one
// addition: `sessionStorage["psng.clock"]` presets it for the next document,
// since a cold start reads the time before any scenario code can run. Needs
// the dev ircd (SEANCE_IRC_PORT, default 8067).

import {writeFileSync} from "node:fs";
import {join} from "node:path";
import {pathToFileURL} from "node:url";

const PHONE_LAYOUT_QUERY =
	"(max-width: 768px), (max-height: 500px) and (hover: none) and (pointer: coarse)";
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
 * every SVG clock, sampled twice 300 ms apart.
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

/** Counts the animation frames NG's chunk asks for (see the header). */
const NG_FRAME_COUNTER = `(() => {
	const raf = window.requestAnimationFrame.bind(window);
	window.__ngFrames = 0;
	window.requestAnimationFrame = (fn) => {
		if (/scene-ps\\.js/.test(new Error().stack || "")) window.__ngFrames++;
		return raf(fn);
	};
	// The fire wakes on a timer (flame.ts), one per frame of its own: a short timer from NG's chunk counts too.
	const after = window.setTimeout.bind(window);
	window.setTimeout = (fn, ms, ...rest) => {
		if (ms < 100 && /scene-ps\\.js/.test(new Error().stack || "")) window.__ngFrames++;
		return after(fn, ms, ...rest);
	};
})()`;

/** NG's frame requests over the next second. */
const NG_FRAMES = `new Promise((r) => {
	const a = window.__ngFrames;
	setTimeout(() => r(window.__ngFrames - a), 1000);
})`;

/** Each animation's group, by its animationName (groups.ts, styles.ts and classic's ps.css). */
const GROUP_OF = {
	"ps-drift": "clouds",
	"ps-twinkle": "stars",
	"ps-ffdrift": "fireflies",
	"ps-ffblink": "fireflies",
	"ps-smoke-rise": "smoke",
	"ps-sway": "grass",
	"psng-rain-fall": "weather",
	"ps-flake": "weather",
	"ps-seed": "weather",
	"ps-flash": "weather",
	"ps-shimmer": "weather",
	"ps-skein-fly": "skeins",
	"ps-skein-west": "skeins",
	"ps-skein-sway": "skeins",
	"psng-pose4": "skeins",
	"psng-pose2": "daybirds",
	"ps-buzz-drift": "daybirds",
	"psng-buzz-orbit": "daybirds",
	"psng-buzz-flap": "daybirds",
	"ps-lark-fly": "daybirds",
	"psng-lark-fl-h": "daybirds",
	"psng-lark-ch-h": "daybirds",
	"psng-lark-cl-h": "daybirds",
	"ps-spin": "sun",
};
const ALL_GROUPS = [...new Set(Object.values(GROUP_OF))];
const CALM_GROUPS = ["clouds"];

/** Every animation under the scene: its group:name, the keyframes' properties, the boxes over the viewport. */
const CENSUS = `(() => {
	const s = document.getElementById("theme-scene");
	const G = ${JSON.stringify(GROUP_OF)};
	const KEYS = new Set(["offset", "computedOffset", "easing", "composite"]);
	const anims = s.getAnimations({subtree: true});
	const keys = {}, props = new Set(), over = [], unknown = new Set(), insvg = new Set();
	for (const a of anims) {
		const n = a.animationName ?? "(script)";
		const el = a.effect.target;
		const g = n === "psng-pose2" && el.closest(".ps-daybirds") ? "daybirds" : G[n];
		if (!g) unknown.add(n);
		if (el.parentElement && el.parentElement.closest("svg")) insvg.add(n + " on " + (el.getAttribute("class") || el.tagName));
		keys[(g ?? "?") + ":" + n] = (keys[(g ?? "?") + ":" + n] || 0) + 1;
		for (const k of a.effect.getKeyframes()) for (const p of Object.keys(k)) if (!KEYS.has(p)) props.add(p);
		const r = el.getBoundingClientRect();
		const html = el instanceof HTMLElement;
		const w = html ? el.offsetWidth : r.width, h = html ? el.offsetHeight : r.height;
		if (w > innerWidth + 1 || h > innerHeight + 1)
			over.push((el.getAttribute("class") || el.tagName) + " " + Math.round(w) + "x" + Math.round(h));
	}
	return {
		anims: anims.length,
		keys,
		props: [...props],
		over: [...new Set(over)],
		unknown: [...unknown],
		insvg: [...insvg],
		vp: innerWidth + "x" + innerHeight,
		classes: [...s.classList].filter((c) => /^psng-(m-|calm)/.test(c)).sort(),
		smil: s.querySelectorAll(${JSON.stringify(SMIL)}).length,
	};
})()`;

/** The clouds' phase (see the header): what --psng-t predicts against what the transform shows. */
const PHASE = `(() => {
	const s = document.getElementById("theme-scene");
	const secs = (v) => (v.trim().endsWith("ms") ? parseFloat(v) / 1000 : parseFloat(v));
	const t = parseFloat(s.style.getPropertyValue("--psng-t"));
	const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
	const W = s.clientWidth;
	return {t, clouds: [...s.querySelectorAll(".ps-cloud")].flatMap((c) => {
		const a = c.getAnimations().find((x) => x.animationName === "ps-drift");
		if (!a) return [];
		const cs = getComputedStyle(c);
		const cdl = secs(cs.getPropertyValue("--cdl"));
		// The computed timing, not the serialised style: that rounds to six significant figures (31 ms at noon).
		const {duration: D, delay} = a.effect.getTiming();
		const p = ((((t - cdl) * 1000 + a.currentTime) % D) + D) % D / D;
		const w = c.offsetWidth;
		const span = W + w + 0.5 * rem;
		const want = span * p - w - 0.25 * rem;
		const got = new DOMMatrixReadOnly(cs.transform).m41;
		const e = Math.abs(got - want) / span;
		return [{delayOff: Math.abs(delay - (cdl - t) * 1000), p: +p.toFixed(4), err: +Math.min(e, 1 - e).toFixed(4)}];
	})};
})()`;

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

/** NG mounted: `psng` on #theme-scene with its layers in. */
async function waitNg(page) {
	const sel = `document.querySelector("#theme-scene")`;
	await page.waitFor(`${sel}.classList.contains("psng") && ${sel}.children.length > 0`, {
		label: "the NG scene mounted",
	});
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

async function setMotion(page, value) {
	await page.evaluate(
		`${STORE}.dispatch("settings/update", {name: "psAnimation", value: ${JSON.stringify(
			value
		)}})`
	);
	await page.sleep(600);
}

/** A fresh mount on `ms`'s day: the theme to coffee and back, so the phase starts from that day. */
async function mountNgAt(page, ms) {
	await page.evaluate(`${STORE}.dispatch("settings/update", {name: "theme", value: "coffee"})`);
	await page.waitFor(`!document.getElementById("theme-scene").classList.contains("psng")`, {
		label: "NG gone with coffee",
	});
	await page.evaluate(`window.__setClock(${ms})`);
	await page.evaluate(`${STORE}.dispatch("settings/update", {name: "theme", value: "ps"})`);
	await waitNg(page);
	return at(page, ms);
}

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

/** The FULL census (header); `groups` are the ones the moment is about, `sun` whether the fire must run. */
async function fullCensus(page, label, groups, sun) {
	const c = await page.evaluate(CENSUS);
	const frames = await page.evaluate(NG_FRAMES);
	const running = [...new Set(Object.keys(c.keys).map((k) => k.split(":")[0]))];
	console.log(`  ${label}: ${JSON.stringify(c.keys)}`);
	page.check(
		`${label}: full — all nine group classes, no psng-calm (${c.classes.join(" ")})`,
		sameSet(
			c.classes,
			ALL_GROUPS.map((g) => `psng-m-${g}`)
		)
	);
	page.check(
		`${label}: full — ${c.anims} animations, every one a known group's (unknown: ${
			c.unknown.join(", ") || "none"
		}), the moment's ${groups.join(", ")} among them`,
		c.anims > 0 && c.unknown.length === 0 && groups.every((g) => running.includes(g))
	);
	page.check(
		`${label}: full — keyframes touch only transform and opacity (else: ${
			c.props.join(", ") || "none"
		})`,
		c.props.every((p) => p === "transform" || p === "opacity")
	);
	page.check(
		`${label}: full — every animated element within the viewport ${c.vp} ± 1 px (over: ${
			c.over.slice(0, 4).join("; ") || "none"
		}), no SMIL (${c.smil})`,
		c.over.length === 0 && c.smil === 0
	);

	page.check(
		`${label}: full — no animation runs on an element inside an <svg> (${
			c.insvg.slice(0, 4).join("; ") || "none"
		})`,
		c.insvg.length === 0
	);

	if (sun) {
		page.check(
			`${label}: full — the sun's fire asks for frames (${frames} in 1 s)`,
			frames > 0
		);
	}

	return c;
}

/** Calm (header), against the full census `full` taken at the same moment on the same mount. */
async function calmCensus(page, label, full) {
	await setMotion(page, "calm");
	const c = await page.evaluate(CENSUS);
	const frames = await page.evaluate(NG_FRAMES);
	const want = [
		...new Set(Object.keys(full.keys).filter((k) => CALM_GROUPS.includes(k.split(":")[0]))),
	].sort();
	const got = Object.keys(c.keys).sort();
	page.check(
		`${label}: calm — psng-calm and the clouds' class (${c.classes.join(" ")})`,
		sameSet(c.classes, ["psng-calm", ...CALM_GROUPS.map((g) => `psng-m-${g}`)])
	);
	page.check(
		`${label}: calm — exactly calm's animations at this moment [${got.join(
			", "
		)}] = [${want.join(", ")}]`,
		got.length > 0 && sameSet(got, want)
	);
	page.check(
		`${label}: calm — keyframes only transform/opacity, nothing over the viewport, no frame from NG in 1 s (${frames})`,
		c.props.every((p) => p === "transform" || p === "opacity") &&
			c.over.length === 0 &&
			frames === 0
	);
	const falling =
		await page.evaluate(`[".ps-rain", ".ps-snow", ".ps-seeds", ".ps-flash"].filter((sel) =>
		[...document.querySelectorAll("#theme-scene " + sel)].some((el) => getComputedStyle(el).display !== "none"))`);
	page.check(
		`${label}: calm — nothing falls: rain, snow, seeds and flash out of the page (${
			falling.join(" ") || "none in"
		})`,
		falling.length === 0
	);
	await setMotion(page, "full");
}

/** What exists only in flight: out of the page while NG is still (styles.ts). */
const IN_FLIGHT = [
	".ps-skeins",
	".ps-daybirds",
	".ps-rain",
	".ps-snow",
	".ps-seeds",
	".ps-flash",
	".ps-smoke",
];

/** Of the in-flight layers in the page: how many, and which compute a display other than none. */
const FLIGHT = `(() => {
	const s = document.getElementById("theme-scene");
	const found = ${JSON.stringify(
		IN_FLIGHT
	)}.flatMap((q) => [...s.querySelectorAll(q)].map((el) => [q, el]));
	return {
		found: found.length,
		names: [...new Set(found.map(([q]) => q))],
		shown: [...new Set(found.filter(([, el]) => getComputedStyle(el).display !== "none").map(([q]) => q))],
	};
})()`;

/** The STILL census (header). */
async function stillCensus(page, label) {
	const c = await page.evaluate(CENSUS);
	const f = await page.evaluate(FLIGHT);
	const frames = await page.evaluate(NG_FRAMES);
	page.check(
		`${label}: still — no animation on NG's scene (${c.anims}), no group class (${
			c.classes.join(" ") || "none"
		}), no SMIL (${c.smil}), no frame from NG in 1 s (${frames})`,
		c.anims === 0 && c.classes.length === 0 && c.smil === 0 && frames === 0
	);
	page.check(
		`${label}: still — every in-flight layer out of the page: ${f.found} found (${f.names.join(
			" "
		)}), displayed: ${f.shown.join(" ") || "none"}`,
		f.found > 0 && f.shown.length === 0
	);
}

/** Each cloud's translateX on screen, in px (the DOMMatrix's e). */
const CLOUD_X = `[...document.querySelectorAll("#theme-scene .ps-cloud")].map((el) => new DOMMatrix(getComputedStyle(el).transform).e)`;

/**
 * A rest that ends on its own (a hidden page, a query) freezes NG where it stands (scene.ts freeze):
 * no animation, no frame from NG, its group classes kept with psng-frozen, an in-flight layer still
 * in the page, and every cloud where it was the moment before (`before`, CLOUD_X), within 2 px.
 */
async function frozenCensus(page, label, before) {
	const c = await page.evaluate(CENSUS);
	const f = await page.evaluate(FLIGHT);
	// CSS animations only (no transition runs in NG's scene).
	const anims = await page.evaluate(
		`document.getElementById("theme-scene").getAnimations({subtree: true}).filter((a) => a instanceof CSSAnimation).length`
	);
	const frames = await page.evaluate(NG_FRAMES);
	const frozen = await page.evaluate(
		`document.getElementById("theme-scene").classList.contains("psng-frozen")`
	);
	const x = await page.evaluate(CLOUD_X);
	const worst = Math.max(...x.map((v, i) => Math.abs(v - before[i])));
	page.check(
		`${label}: frozen — psng-frozen ${frozen}, no animation (${anims}), group classes kept (${
			c.classes.length
		}), no frame from NG in 1 s (${frames}), in-flight layers displayed: ${
			f.shown.join(" ") || "none"
		}`,
		frozen && anims === 0 && c.classes.length > 0 && frames === 0 && f.shown.length > 0
	);
	page.check(
		`${label}: frozen — ${x.length} clouds where they stood (worst ${worst.toFixed(1)} px off)`,
		x.length > 0 && x.length === before.length && worst <= 2
	);
	return x;
}

/**
 * Each lark's state (poses.ts larkStates): from its --ld, --ldl and the scene's --psng-t, where its
 * flight stands (the state box's own animation gives only the time since it started), and so which of
 * the flutter, the chute and the closed box shows, as classic's stops (0, 63, 69, 73, 80, 82.5 %) say.
 * Each lark's three box opacities too, for comparing a frozen lark with itself.
 */
const LARKS = `(() => {
	const s = document.getElementById("theme-scene");
	const secs = (v) => (v.trim().endsWith("ms") ? parseFloat(v) / 1000 : parseFloat(v));
	const t = parseFloat(s.style.getPropertyValue("--psng-t"));
	const STOPS = [0, 63, 69, 73, 80, 82.5], STATE = ["fl", "ch", "fl", "ch", "fl", "cl"];
	return [...s.querySelectorAll(".ps-lark")].map((l) => {
		const cs = getComputedStyle(l);
		const ld = secs(cs.getPropertyValue("--ld")), ldl = secs(cs.getPropertyValue("--ldl"));
		const box = (k) => l.querySelector(".psng-lark-" + k);
		const op = Object.fromEntries(["fl", "ch", "cl"].map((k) => [k, box(k) ? parseFloat(getComputedStyle(box(k)).opacity) : -1]));
		const a = box("fl") && box("fl").getAnimations().find((x) => x.animationName === "psng-lark-fl-h");
		if (!a || a.currentTime === null) return {op, running: false};
		const pct = ((((a.currentTime / 1000 + t - ldl) % ld) + ld) % ld) / ld * 100;
		const i = STOPS.findLastIndex((x) => x <= pct);
		const dist = Math.min(...[...STOPS, 100].map((x) => Math.abs(pct - x)));
		return {op, running: true, pct, state: STATE[i], dist};
	});
})()`;

const shows = (op, state) =>
	["fl", "ch", "cl"].every((k) => (k === state ? op[k] > 0 : op[k] === 0));

/** Running larks show the state their clock puts them in (sampled 1 % or more from a stop); returns the sample. */
async function larkCheck(page, label) {
	const larks = await page.evaluate(LARKS);
	const sampled = larks.filter((l) => l.running && l.dist >= 1);
	const wrong = sampled.filter((l) => !shows(l.op, l.state));
	page.check(
		`${label}: each lark shows the state its clock puts it in — ${sampled
			.map((l) => `${l.state} at ${l.pct.toFixed(1)} %`)
			.join(", ")} (${larks.length - sampled.length} of ${
			larks.length
		} near a stop or not running; wrong: ${
			wrong.map((l) => JSON.stringify(l.op)).join(" ") || "none"
		})`,
		larks.length === 3 && sampled.length > 0 && wrong.length === 0
	);
	return larks;
}

/** Frozen larks hold the state they had the moment before (`before`, from larkCheck). */
async function larkHeld(page, label, before) {
	const larks = await page.evaluate(LARKS);
	const sampled = before.map((b, i) => [b, larks[i]]).filter(([b]) => b.running && b.dist >= 1);
	const wrong = sampled.filter(([b, l]) => !shows(l.op, b.state));
	page.check(
		`${label}: each lark holds the state it froze in (${sampled
			.map(([b]) => b.state)
			.join(", ")}; wrong: ${
			wrong.map(([, l]) => JSON.stringify(l.op)).join(" ") || "none"
		})`,
		sampled.length > 0 && wrong.length === 0
	);
}

/** Thawed: every cloud goes on from where it was held (`held`), within 4 px, not from where the clock is. */
async function thawCheck(page, label, held) {
	const x = await page.evaluate(CLOUD_X);
	const worst = Math.max(...x.map((v, i) => Math.abs(v - held[i])));
	page.check(
		`${label}: thawed — ${
			x.length
		} clouds go on from where they were held (worst ${worst.toFixed(1)} px off)`,
		x.length > 0 && worst <= 4
	);
}

/** Moving again: animations on the scene, the fire's frames, and an in-flight layer back in the page. */
async function moving(page, label) {
	const c = await page.evaluate(CENSUS);
	const f = await page.evaluate(FLIGHT);
	const frames = await page.evaluate(NG_FRAMES);
	page.check(
		`${label}: moving again — ${
			c.anims
		} animations, ${frames} frames from NG in 1 s, in-flight layers displayed: ${
			f.shown.join(" ") || "none"
		}`,
		c.anims > 0 && frames > 0 && f.shown.length > 0
	);
}

/** The clouds' phase (header) after a move out of still at `switchedAt` (the pinned clock), NG mounted on 21 June. */
async function phaseCheck(page, label, switchedAt) {
	const phase = await page.evaluate(PHASE);
	const wantT = (switchedAt - Date.UTC(2026, 5, 21)) / 1000;
	console.log(`  ${label}: ${JSON.stringify(phase)}`);
	page.check(
		`${label}: --psng-t ${phase.t}s is the clock's ${wantT.toFixed(
			1
		)} s since the mount day's midnight at the switch (± 3 s)`,
		Math.abs(phase.t - wantT) <= 3
	);
	page.check(
		`${label}: ${
			phase.clouds.length
		} clouds, each animation-delay = --cdl − --psng-t (worst ${Math.max(
			...phase.clouds.map((c) => c.delayOff)
		).toFixed(
			3
		)} ms off) and translateX where (--psng-t − --cdl + currentTime) mod D puts it (worst ${(
			Math.max(...phase.clouds.map((c) => c.err)) * 100
		).toFixed(2)} % of its path)`,
		phase.clouds.length > 0 && phase.clouds.every((c) => c.delayOff <= 1 && c.err <= 0.02)
	);
}

const MOMENTS = [
	["0621-1200", instant(6, 21, 12, 0), "clear"],
	["0514-2045-skeins", instant(5, 14, 20, 45), "clear"],
	["0621-2330", instant(6, 21, 23, 30), "clear"],
	["1019-1200-rain", instant(10, 19, 12, 0), "rain"],
	["0719-1200-storm", instant(7, 19, 12, 0), "storm"],
];

// A discharging battery at 0.5 whose level a check moves, firing `levelchange`.
const FAKE_BATTERY = `(() => {
	const b = new EventTarget();
	b.charging = false;
	b.level = 0.5;
	window.__fakeBattery = {set(l) { b.level = l; b.dispatchEvent(new Event("levelchange")); }};
	navigator.getBattery = () => Promise.resolve(b);
})()`;

export default async function run(page) {
	const vp = page.flags.has("--mobile") ? "mobile" : "desktop";
	await page.send("Emulation.setTimezoneOverride", {timezoneId: "Etc/GMT"});
	await page.addInitScript(CLOCK_SHIM);
	await page.addInitScript(PAGE_HELPERS);
	await page.addInitScript(NG_FRAME_COUNTER);
	await page.addInitScript(FAKE_BATTERY);

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
	await sendLine(page, `hello from the moving plains ${RUN}`);
	await page.waitFor(`!document.querySelector("#chat .msg.pending")`, {label: "our own line"});

	// Auto follows the device (plan 3): every census below is of Full's groups,
	// so the setting is Full until the Auto check.
	await setMotion(page, "full");

	// ---- ps: NG

	await page.evaluate(`${STORE}.dispatch("settings/update", {name: "theme", value: "ps"})`);
	await waitNg(page);

	// ---- census and glass at a pinned noon, NG fresh

	const noon = instant(6, 21, 12, 0);
	const ng = await mountNgAt(page, noon);
	page.check(
		`mount: NG has psng and its adopted sheet (psng ${ng.psng}, sheet ${ng.ngSheet}, ${ng.children} layers)`,
		ng.psng && ng.ngSheet && ng.children > 0
	);
	const noonFull = await fullCensus(
		page,
		"0621 12:00",
		["clouds", "grass", "daybirds", "sun"],
		true
	);
	const ngBackdrop = await sidebarBackdrop(page, vp === "mobile");
	page.check(
		`census: #sidebar's backdrop-filter${
			vp === "mobile" ? " (the drawer open)" : ""
		} is the glass's blur ("${ngBackdrop}")`,
		ngBackdrop !== "none" && ngBackdrop !== ""
	);
	await calmCensus(page, "0621 12:00", noonFull);

	// ---- the setting at Still: plan 1's census, now the still tier's

	await setMotion(page, "still");
	await stillCensus(page, "setting Still");
	const still = await page.evaluate(SCENE);
	const ngMoves = await page.evaluate(MOVES);
	page.check(
		`setting Still: every SVG clock paused (${still.svgsRunning} of ${still.svgs} running), nothing moves in 300 ms (${ngMoves.moved} of ${ngMoves.clocks} clocks)`,
		still.svgs > 0 && still.svgsRunning === 0 && ngMoves.moved === 0
	);
	await setMotion(page, "full");
	await moving(page, "setting Full");

	// ---- hot noon: no ps-hot, NG's ground drawn

	const hotAt = instant(7, 1, 12, 30);
	const hot = await at(page, hotAt);
	page.check(
		`hot noon: 1 July 12:30 is ${hot.weather} and NG never sets ps-hot (${hot.hot})`,
		hot.weather === "heat" && !hot.hot
	);
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

	// ---- full and calm at night, on a storm day and at the dusk with skeins

	for (const [label, ms, weather, groups, sun] of [
		[
			"0621 23:00",
			instant(6, 21, 23, 0),
			"clear",
			["clouds", "stars", "fireflies", "smoke", "grass"],
			false,
		],
		["0719 12:00 storm", instant(7, 19, 12, 0), "storm", ["clouds", "weather", "grass"], false],
		["0514 20:45 dusk", instant(5, 14, 20, 45), "clear", ["clouds", "skeins"], false],
	]) {
		const s = await mountNgAt(page, ms);
		page.check(
			`${label}: the day's weather is ${weather} (${s.weather})`,
			s.weather === weather
		);
		const full = await fullCensus(page, label, groups, sun);
		await calmCensus(page, label, full);
	}

	// ---- the still states: reduced motion off → on → off, a hidden page, a query

	await mountNgAt(page, noon);
	await moving(page, "reduced motion off");
	await page.send("Emulation.setEmulatedMedia", {
		features: [{name: "prefers-reduced-motion", value: "reduce"}],
	});
	const REDUCED = `document.documentElement.hasAttribute("data-reduce-motion")`;
	const reduced = await page
		.waitFor(REDUCED, {label: "data-reduce-motion", timeout: 3000})
		.then(() => true)
		.catch(() => false);
	page.check(`reduced motion: the emulated media reaches data-reduce-motion`, reduced);
	await page.sleep(600);
	await stillCensus(page, "reduced motion on");
	const offAt = await page.evaluate(`Date.now()`);
	await page.send("Emulation.setEmulatedMedia", {features: []});
	const unreduced = await page
		.waitFor(`!${REDUCED}`, {label: "reduced motion off", timeout: 3000})
		.then(() => true)
		.catch(() => false);
	page.check(`reduced motion: clearing the emulated media clears data-reduce-motion`, unreduced);
	await page.sleep(600);
	await phaseCheck(page, "phase after reduced motion", offAt);
	await moving(page, "reduced motion off again");

	const larksBefore = await larkCheck(page, "noon, before a hidden page");
	let before = await page.evaluate(CLOUD_X);
	await page.evaluate(VISIBILITY("hidden"));
	await page.sleep(300);
	let held = await frozenCensus(page, "a hidden page", before);
	await larkHeld(page, "a hidden page", larksBefore);
	await page.sleep(3000); // a rest long enough that the clock would have moved them on
	await page.evaluate(VISIBILITY("visible"));
	await thawCheck(page, "shown again", held);
	await page.sleep(600);
	await moving(page, "shown again");
	await larkCheck(page, "noon, shown again");

	before = await page.evaluate(CLOUD_X);
	await sendLine(page, `/query ${NICK}q`);
	const VIEW = (v) => `document.getElementById("theme-scene").dataset.view === "${v}"`;
	await page.waitFor(VIEW("query"), {label: "the query open"});
	held = await page.evaluate(CLOUD_X);
	await page.sleep(600);
	await frozenCensus(page, "a query", held);
	await page.evaluate(
		`document.querySelector('.channel-list-item[data-name="#seance"]').click()`
	);
	await page.waitFor(VIEW("channel"), {label: "back in #seance"});
	await page.sleep(600);
	await moving(page, "back in #seance");

	// ---- the phase: still for 30 s, then Full

	await setMotion(page, "still");
	await mountNgAt(page, noon);
	await stillCensus(page, "phase: Still at noon");
	await page.sleep(30000);
	const switchedAt = await page.evaluate(`Date.now()`);
	await setMotion(page, "full");
	await phaseCheck(page, "phase", switchedAt);
	await setMotion(page, "full");

	// ---- the theme to coffee while NG moves, then back to ps

	const beforeCoffee = await page.evaluate(CENSUS);
	await page.evaluate(`${STORE}.dispatch("settings/update", {name: "theme", value: "coffee"})`);
	await page.waitFor(`!document.getElementById("theme-scene").classList.contains("psng")`, {
		label: "NG gone with coffee",
	});
	await page.sleep(600);
	const coffee = await page.evaluate(`(() => {
		const s = document.getElementById("theme-scene");
		return {
			classes: [...s.classList].filter((c) => c.startsWith("psng")),
			t: s.style.getPropertyValue("--psng-t") + getComputedStyle(s).getPropertyValue("--psng-t").trim(),
			sheet: document.adoptedStyleSheets.some((sh) =>
				[...sh.cssRules].some((r) => r.cssText.includes("#theme-scene.psng"))
			),
			fire: !!document.querySelector(".ps-fire"),
		};
	})()`);
	const coffeeFrames = await page.evaluate(NG_FRAMES);
	page.check(
		`theme to coffee while NG moved (${
			beforeCoffee.anims
		} animations): no psng class [${coffee.classes.join(" ")}], no --psng-t "${
			coffee.t
		}", NG sheet ${coffee.sheet}, fire canvas ${
			coffee.fire
		}, ${coffeeFrames} frames from NG in 1 s`,
		beforeCoffee.anims > 0 &&
			coffee.classes.length === 0 &&
			coffee.t === "" &&
			!coffee.sheet &&
			!coffee.fire &&
			coffeeFrames === 0
	);
	await page.evaluate(`${STORE}.dispatch("settings/update", {name: "theme", value: "ps"})`);
	await waitNg(page);
	await at(page, noon);
	await moving(page, "theme back to ps");

	// ---- Auto follows the device: calm on a touch phone, full elsewhere

	await setMotion(page, "auto");
	await mountNgAt(page, noon);
	const calmClass = () =>
		page.evaluate(`document.getElementById("theme-scene").classList.contains("psng-calm")`);
	page.check(
		`Auto on ${vp === "mobile" ? "a touch phone" : "a desktop viewport"}: ${
			vp === "mobile" ? "psng-calm" : "no psng-calm"
		}`,
		(await calmClass()) === (vp === "mobile")
	);

	if (vp === "desktop") {
		await page.send("Emulation.setDeviceMetricsOverride", {
			width: 390,
			height: 844,
			deviceScaleFactor: 1,
			mobile: false,
		});
		await page.sleep(600);
		const narrow = await page.evaluate(
			`({layout: matchMedia(${JSON.stringify(
				PHONE_LAYOUT_QUERY
			)}).matches, coarse: matchMedia("(pointer: coarse)").matches})`
		);
		page.check(
			`Auto on a desktop resized to 390 x 844, no touch (phone layout ${narrow.layout}, coarse ${narrow.coarse}): no psng-calm`,
			narrow.layout && !narrow.coarse && !(await calmClass())
		);
		await page.send("Emulation.setDeviceMetricsOverride", {
			width: 1280,
			height: 900,
			deviceScaleFactor: 1,
			mobile: false,
		});
		await page.sleep(600);
	}

	if (vp === "desktop") {
		// Low power from the battery: a discharging 0.5 changes nothing, 0.1 takes Auto down to calm.
		const setLevel = (l) => page.evaluate(`window.__fakeBattery.set(${l})`);
		page.check(
			"battery 0.5, discharging: Auto stays full (no psng-calm)",
			!(await calmClass())
		);
		await setLevel(0.1);
		await page.sleep(500);
		page.check("battery 0.1: psng-calm within 500 ms", await calmClass());
		await setLevel(0.5);
		await page.sleep(500);
		page.check("battery back to 0.5: psng-calm gone", !(await calmClass()));
	}

	await setMotion(page, "full");

	// ---- the shots (no hostname in frame: the join and quit lines carry it)

	await page.evaluate(`(() => {
		const st = document.createElement("style");
		st.textContent = ".hostmask { display: none !important; }";
		document.head.append(st);
	})()`);
	const names = [];

	for (const [name, ms, weather] of MOMENTS) {
		const s = await at(page, ms, 2000);
		page.check(
			`shot ${vp}-${name}: the day's weather is ${weather} (${s.weather})`,
			s.weather === weather
		);
		// Our own line in frame: the drawer's round trip can leave the log scrolled up.
		await page.evaluate(`(() => {
			const c = document.querySelector("#chat .chat");
			c.scrollTop = c.scrollHeight;
		})()`);
		await page.sleep(300);
		await page.screenshot(`${vp}-${name}`);
		names.push(name);
	}

	// ---- the larks paused at points of their flights: the first in its chute (66 %), the second
	// closed (84 %), the third fluttering (30 %); each showing that state, and a close shot of each

	const LARK_AT = [66, 84, 30];
	const LARK_SEEK = `(() => {
		const pct = ${JSON.stringify(LARK_AT)};
		return [...document.querySelectorAll("#theme-scene .ps-lark")].map((l, i) => {
			const ld = parseFloat(getComputedStyle(l).getPropertyValue("--ld")) * 1000;
			for (const a of l.getAnimations({subtree: true})) {
				if (!/^psng-lark-/.test(a.animationName)) continue;
				const d = a.effect.getTiming().delay;
				a.pause();
				a.currentTime = ((((pct[i] / 100) * ld + d) % ld) + ld) % ld;
			}
			const op = (el) => parseFloat(getComputedStyle(el).opacity);
			const shown = ["fl", "ch", "cl"].filter((k) => op(l.querySelector(".psng-lark-" + k)) > 0);
			const bird = l.querySelector(".ps-lark-bird").getBoundingClientRect().toJSON();
			return {shown, bird};
		});
	})()`;
	await at(page, noon, 2000);
	await page.evaluate(LARK_SEEK);
	await page.sleep(300);
	const larks = await page.evaluate(LARK_SEEK);
	await page.evaluate(HIDE_CHROME);
	await page.sleep(150);

	for (const [i, l] of larks.entries()) {
		const rem = 16;
		const shot = await page.send("Page.captureScreenshot", {
			format: "png",
			clip: {
				x: l.bird.x - 1.5 * rem,
				y: l.bird.y - 1.5 * rem,
				width: l.bird.width + 3 * rem,
				height: l.bird.height + 3 * rem,
				scale: 6,
			},
		});
		writeFileSync(
			join(page.outDir, `${vp}-lark${i}-${LARK_AT[i]}.png`),
			Buffer.from(shot.data, "base64")
		);
	}

	await page.evaluate(SHOW_CHROME);

	for (const [i, want] of ["ch", "cl", "fl"].entries()) {
		const shown = larks[i]?.shown ?? [];
		page.check(
			`lark ${i} at ${LARK_AT[i]} %: shows ${shown.join("+") || "nothing"} (want ${want})`,
			shown.join() === want
		);
	}

	// ---- last: a cold start at night with ps stored

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
	await page.screenshot(`${vp}-cold-0925-2300`);

	const wait = 10000 - (shotAt - boot.mountAt);

	if (wait > 0) {
		await page.sleep(wait);
	}

	const chunks = await page.evaluate(
		`performance.getEntriesByType("resource").map((e) => e.name).filter((n) => /\\/js\\/scene-ps(-ng)?\\.js(\\?|$)/.test(n))`
	);
	const ngChunk = chunks.filter((n) => /\/js\/scene-ps\.js(\?|$)/.test(n));
	page.check(
		`network: from the load to 10 s after the mount NG's chunk js/scene-ps.js is fetched once and no scene-ps-ng.js (${
			chunks.map((n) => n.replace(/^.*\//, "")).join(", ") || "no scene chunk"
		})`,
		ngChunk.length === 1 && chunks.length === ngChunk.length
	);

	// ---- the contact sheet: one row per moment

	const width = vp === "mobile" ? 300 : 620;
	const rows = names
		.map((n) => `<h2>${n}</h2><figure><img src="${vp}-${n}.png"></figure>`)
		.join("");
	const sheet = join(page.outDir, `contact-${vp}.html`);
	writeFileSync(
		sheet,
		`<!doctype html><meta charset=utf-8><title>ps NG, in motion — ${vp}</title><style>` +
			`body{font:14px system-ui;margin:16px;background:#eee}h2{margin:16px 0 6px;font-size:15px}` +
			`figure{margin:0}img{width:${width}px;display:block}</style>` +
			`<h1>ps NG, in motion — ${vp}</h1>${rows}`
	);
	await page.send("Emulation.setDeviceMetricsOverride", {
		width: width + 40,
		height: 900,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await page.goto(pathToFileURL(sheet).href);
	await page.waitFor(
		`document.readyState === "complete" && document.images.length === ${names.length} && [...document.images].every((i) => i.complete && i.naturalWidth > 0)`,
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
