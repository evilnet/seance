// The ps theme's private conversations: inside the yurt (docs/projects/ps-yurt.md,
// plan 1 task 9; plan 2 task 5, the room's motion; plan 3 task 3, the stove's fire). No ircd needed: lib/tiny-ircd.mjs registers the client and
// echoes `/join #plains`, and `/query wren` opens a private conversation
// (commands/msg.ts), which is all the scene needs to show the room. `SEANCE_PORT`
// serves the app from another port.
//
//   NODE_ENV=production pnpm build && python3 -m http.server -d public 8000 &
//   node tools/browser-drive.mjs tools/scenarios/ps-yurt.mjs
//   node tools/browser-drive.mjs tools/scenarios/ps-yurt.mjs --mobile --width=390 --height=844
//   node tools/browser-drive.mjs tools/scenarios/ps-yurt.mjs --mobile --width=932 --height=430
//   node tools/browser-drive.mjs tools/scenarios/ps-yurt.mjs --width=2560 --height=1080
//
// Every load is a first visit (the init script clears the profile's storage but
// for the ps theme) on a pinned clock (`yurtAt`, ms since the epoch, GMT). Checks:
// 1. In a channel the room is not shown; in the query `.ps-indoor` shows,
//    `.ps-frost` (the plains) is out of the render tree, and the room's svg covers
//    `#theme-scene`, the stove's middle within 2 % of the scene's.
// 2. For one day of each of the six weathers (engine.ts `weatherFor`, noon): the
//    windows' weather (`.ps-yt-weather[data-weather]`) is the plains' (`#theme-scene`
//    `data-weather`).
// 3. At 12:00 the room's shade is 0 and at 21:00 at least 0.7, and the wall's
//    painted colour (its gradient stop) differs between them.
// 4. The animation census in a query (the page holds the focus, as scene-rest.mjs's):
//    a. full, at a clear noon: every running CSS animation is inside .ps-indoor, none
//       in .ps-frost and none under an <svg>, its keyframes touch only transform and
//       opacity, its name is one the room uses; the drift runs, and by day (the stove
//       out, §16) none of the fire's licks, core or sparks, the glow's flicker or the
//       steam, the fire, its glow and the steam are out of the render tree, and the
//       stove's lower third is the same in two frames 300 ms apart;
//    b. rain runs psng-rain-fall, snow ps-flake, a storm ps-flash, a clear 21:00
//       ps-twinkle;
//    c. calm (psAnimation; a phone's auto) at a clear 21:00: only the two flickers run,
//       four of them on the fire's tongues and core (the user, 2026-11-16), and nothing
//       dances, no spark rises and no window cloud drifts (ps-yurt.md §11.2, §11.3, §16);
//    d. still (reduced motion emulated): nothing runs, and plan 1's still fire and
//       clouds show while the moving ones are out; the still fire burns at 21:00
//       (opacity at least 0.95) and is out at noon (0), the embers showing;
//    e. a hidden page freezes the room (psng-frozen, nothing runs, every moving cloud
//       held 1 s), and shown again it moves;
//    f. every moving pane lies inside its window's frame (the crown's inside the
//       crown), and at 21:00 the moving fire inside the stove, within 2 % of its middle,
//       every spark inside the fire's box;
//    g. at a clear 21:00 the three licks, the core, the sparks' rise, the glow's flicker
//       and the steam run, and the stove's door changes between two frames 300 ms apart
//       at full and at calm; the back pane changes between two frames 500 ms apart at a
//       clear noon;
//    h. the drops in each pane on a rainy noon are logged (a phone run's are half).
// 5. In the query the canvas (`--canvas-bg-color`) is the roof's painted colour
//    (its top stop, within 2/255 a channel) and differs from the channel's, the
//    words are light (`data-ps-text`), and by day the five glass tints are set.
// 6. Screenshots: noon, 18:00 and 21:00 in clear, rain and snow weather; a stormy noon.
import {startTinyIrcd} from "./lib/tiny-ircd.mjs";

const PORT = process.env.SEANCE_PORT ?? "8000";
const IRCD_PORT = 9877;
const BASE = `http://localhost:${PORT}/?host=127.0.0.1&port=${IRCD_PORT}&tls=false&nick=yurt`;
export const url = BASE;

/** One noon of each weather (engine.ts weatherFor), GMT. */
const WEATHER_DAYS = {
	snow: [2026, 0, 1],
	clear: [2026, 0, 2],
	wind: [2026, 0, 20],
	rain: [2026, 2, 29],
	heat: [2026, 5, 22],
	storm: [2026, 6, 19],
};

const at = ([y, m, d], h = 12, min = 0) => Date.UTC(y, m, d, h, min);

/** A first visit under ps, on the clock the URL's yurtAt names. */
const INIT = `try { const s = localStorage; s.clear(); const mo = new URLSearchParams(location.search).get("yurtMotion"); s.setItem("settings", JSON.stringify(mo ? {theme: "ps", psAnimation: mo} : {theme: "ps"})); } catch (e) {}
(() => { const q = new URLSearchParams(location.search).get("yurtAt"); if (!q) return;
const R = Date, off = Number(q) - R.now(); function S(...a){ if (!new.target) return R(); return a.length ? new R(...a) : new R(R.now() + off); }
S.prototype = R.prototype; S.now = () => R.now() + off; S.UTC = R.UTC; S.parse = R.parse; window.Date = S; })();`;

const STATE = `(() => {
	const s = document.querySelector("#theme-scene");
	const room = s.querySelector(":scope > .ps-indoor");
	const frost = s.querySelector(":scope > .ps-frost");
	const svg = room?.querySelector("svg");
	const stove = room?.querySelector(".ps-yt-p-stove");
	const wall = room?.querySelector(".ps-yt-stop.ps-yt-c-wallA");
	const roof = room?.querySelector(".ps-yt-stop.ps-yt-c-roofA");
	const slot = room?.querySelector(".ps-yt-weather");
	const html = document.documentElement;
	const rgb = (c) => {
		if (!c) return null;
		const k = document.createElement("canvas").getContext("2d");
		k.fillStyle = "#000";
		k.fillStyle = c;
		k.fillRect(0, 0, 1, 1);
		return [...k.getImageData(0, 0, 1, 1).data.slice(0, 3)];
	};
	const canvas = html.style.getPropertyValue("--canvas-bg-color").trim();
	const roofColour = roof ? getComputedStyle(roof).stopColor : null;
	const sr = s.getBoundingClientRect(), vr = svg?.getBoundingClientRect(), st = stove?.getBoundingClientRect();
	return {
		private: s.classList.contains("ps-private"),
		room: !!room,
		roomShown: !!room && getComputedStyle(room).display !== "none",
		plainsShown: !!frost && getComputedStyle(frost).display !== "none",
		covers: !!vr && vr.left <= sr.left + 0.5 && vr.top <= sr.top + 0.5 && vr.right >= sr.right - 0.5 && vr.bottom >= sr.bottom - 0.5,
		stoveOff: st ? Math.abs(st.left + st.width / 2 - (sr.left + sr.width / 2)) / sr.width : null,
		weather: s.dataset.weather,
		windows: slot?.dataset.weather ?? null,
		shade: Number(s.style.getPropertyValue("--ps-in-shade")),
		wall: wall ? getComputedStyle(wall).stopColor : null,
		roof: roofColour,
		roofOff: roofColour && canvas ? Math.max(...rgb(canvas).map((v, i) => Math.abs(v - rgb(roofColour)[i]))) : null,
		anims: s.getAnimations({subtree: true}).filter((a) => "animationName" in a).length,
		canvas,
		text: html.dataset.psText,
		light: html.dataset.psLight,
		tints: ["header", "composer", "side", "float", "card"].filter((t) => html.style.getPropertyValue("--ps-g-tint-" + t)).length,
	};
})()`;

/** A first visit at `ms`: connect, `/join #plains`, then `/query wren`. Returns the channel's state and the query's. */
async function visit(page, ms, extra = "") {
	await page.goto(`${BASE}&yurtAt=${ms}${extra}`, {waitForSelector: "#connect form"});
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-type="lobby"]')`, {
		label: "the lobby",
	});
	await page.click('.channel-list-item[data-type="lobby"]');
	await page.waitFor(`document.querySelector("#input")`, {label: "the composer"});
	await page.fill("#input", "/join #plains");
	await page.evaluate(`document.querySelector("#form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-type="channel"]')`, {
		label: "the channel",
	});
	await page.click('.channel-list-item[data-type="channel"]');
	await page.waitFor(`document.querySelector('.channel-list-item[data-type="channel"].active')`, {
		label: "the channel open",
	});
	const channel = await page.evaluate(STATE);
	await page.fill("#input", "/query wren");
	await page.evaluate(`document.querySelector("#form").requestSubmit()`);
	await page.waitFor(`document.querySelector("#theme-scene.ps-private > .ps-indoor")`, {
		label: "the room",
	});
	await page.sleep(400);
	return {channel, query: await page.evaluate(STATE)};
}

/** The running CSS animations in the scene: name, where the target is, the properties its keyframes touch. */
const CENSUS = `(() => {
	const s = document.getElementById("theme-scene");
	return s.getAnimations({subtree: true}).filter((a) => "animationName" in a && a.playState === "running").map((a) => {
		const t = a.effect.target;
		const props = [...new Set(a.effect.getKeyframes().flatMap((k) => Object.keys(k)).filter((k) => !["offset", "computedOffset", "easing", "composite"].includes(k)))];
		return {name: a.animationName, room: !!t.closest(".ps-indoor"), plains: !!t.closest(".ps-frost"), svg: !!t.closest("svg"), fire: !!t.closest(".ps-ym-fire"), props};
	});
})()`;

/** The fire's dance (plan 3): the three licks, the core and the sparks' rise. */
const FIRE = ["psng-yt-lick-a", "psng-yt-lick-b", "psng-yt-lick-c", "psng-yt-core", "psng-yt-rise"];

/** The room's names (plan 2, plan 3): the drift, the twinkle, the plains' rain, snow and flash, both flickers, the steam, the fire. */
const ROOM_ANIMATIONS = [
	"ps-drift",
	"ps-twinkle",
	"psng-rain-fall",
	"ps-flake",
	"ps-flash",
	"psng-yt-flick",
	"psng-yt-flick-b",
	"ps-smoke-rise",
	...FIRE,
];

/** Calm's hearth at night (the user, 2026-11-16): the fire's tongues and core, the glow and the lamp flicker; nothing dances, no spark rises. */
const CALM_NIGHT = ["psng-yt-flick", "psng-yt-flick-b"];

/** The moving boxes against what they sit on, and the scene's width. */
const BOXES = `(() => {
	const s = document.getElementById("theme-scene");
	const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return {l: b.left, t: b.top, r: b.right, b: b.bottom}; };
	const panes = [...s.querySelectorAll(".ps-ym-pane")].map((p) => {
		const name = p.dataset.pane;
		const frame = s.querySelector(name === "crown" ? ".ps-yt-p-crown" : ".ps-yt-p-window-" + name);
		// rain.ts draws each sheet's drops twice, one tile under the other.
		const rain = p.querySelector(".ps-rain");
		return {name, box: r(p), frame: r(frame), drops: rain ? rain.querySelectorAll("i").length / 2 : 0};
	});
	const sparks = [...s.querySelectorAll(".ps-ym-spark")].map(r);
	return {panes, fire: r(s.querySelector(".ps-ym-fire")), sparks, stove: r(s.querySelector(".ps-yt-stove-over")), width: s.getBoundingClientRect().width};
})()`;

/** Whether `inner` lies inside `outer`, within `slack` px. */
const inside = (inner, outer, slack = 1) =>
	!!inner &&
	!!outer &&
	inner.l >= outer.l - slack &&
	inner.t >= outer.t - slack &&
	inner.r <= outer.r + slack &&
	inner.b <= outer.b + slack;

/** Two captures of `box`, `ms` apart: whether they differ. */
async function changes(page, box, ms) {
	const clip = {x: box.l, y: box.t, width: box.r - box.l, height: box.b - box.t, scale: 1};
	const a = await page.send("Page.captureScreenshot", {format: "png", clip});
	await page.sleep(ms);
	const b = await page.send("Page.captureScreenshot", {format: "png", clip});
	return a.data !== b.data;
}

const VISIBILITY = (state) => `(() => {
	Object.defineProperty(document, "visibilityState", {configurable: true, get: () => ${JSON.stringify(
		state
	)}});
	Object.defineProperty(document, "hidden", {configurable: true, get: () => ${state === "hidden"}});
	document.dispatchEvent(new Event("visibilitychange"));
})()`;

export default async function run(page) {
	const ircd = startTinyIrcd({port: IRCD_PORT});

	try {
		await checks(page);
	} finally {
		await ircd.close();
	}
}

async function checks(page) {
	await page.send("Emulation.setTimezoneOverride", {timezoneId: "Etc/GMT"});
	await page.send("Emulation.setFocusEmulationEnabled", {enabled: true});
	await page.addInitScript(INIT);

	// A phone's auto is calm (tiers.ts): the checks of full ask for it there.
	const phone = page.flags.has("--mobile");
	const FULL = phone ? "&yurtMotion=full" : "";

	if (phone) {
		await visit(page, at(WEATHER_DAYS.clear, 21));
		await page.sleep(800);
		const auto = await page.evaluate(CENSUS);
		const ran = [...new Set(auto.map((a) => a.name))].sort();
		page.check(
			`4c: a phone's auto is calm at 21:00 — the flames flicker (${
				auto.filter((a) => a.fire).length
			} in the fire), nothing dances, no sparks, the window clouds resting (${ran.join(
				" "
			)})`,
			CALM_NIGHT.every((n) => ran.includes(n)) &&
				ran.every((n) => CALM_NIGHT.includes(n)) &&
				auto.filter((a) => a.fire).length === 4
		);
	}

	// 1, 5: a clear noon.
	const noon = await visit(page, at(WEATHER_DAYS.clear), FULL);
	page.check(
		"in the channel the room is not shown",
		!noon.channel.roomShown && !noon.channel.private
	);
	page.check(
		"in the query the room shows and the plains are out of the render tree",
		noon.query.roomShown && !noon.query.plainsShown
	);
	page.check("the room's svg covers the scene", noon.query.covers);
	page.check(
		`the stove stands in the middle (off by ${(100 * (noon.query.stoveOff ?? 1)).toFixed(
			1
		)} % of the width)`,
		noon.query.stoveOff !== null && noon.query.stoveOff <= 0.02
	);
	page.check(
		`the canvas is the roof's in the query (${noon.query.canvas} ~ ${noon.query.roof}, off by ${noon.query.roofOff}), not the channel's sky (${noon.channel.canvas})`,
		noon.query.roofOff !== null &&
			noon.query.roofOff <= 2 &&
			noon.query.canvas !== noon.channel.canvas
	);
	page.check(
		`the words are light in the query (${noon.query.text})`,
		noon.query.text === "light"
	);
	page.check(
		`by day the five glass tints are set (${noon.query.tints})`,
		noon.query.light === "day" && noon.query.tints === 5
	);

	// 4a: the census at full.
	await page.sleep(800);
	const full = await page.evaluate(CENSUS);
	const names = (c) => [...new Set(c.map((a) => a.name))].sort();
	page.check(
		`4a: full — every running animation is the room's, none on the plains or under an svg, transform and opacity alone (${
			full.length
		}: ${names(full).join(" ")})`,
		full.length > 0 &&
			full.every(
				(a) =>
					a.room &&
					!a.plains &&
					!a.svg &&
					a.props.every((p) => p === "transform" || p === "opacity")
			) &&
			full.every((a) => ROOM_ANIMATIONS.includes(a.name))
	);
	const dayOff = [...FIRE, "psng-yt-flick", "ps-smoke-rise"];
	page.check(
		`4a: full by day — the drift runs, the stove is out: no fire, glow or steam runs (${names(
			full
		).join(" ")})`,
		names(full).includes("ps-drift") && !dayOff.some((n) => names(full).includes(n))
	);
	const outByDay = await page.evaluate(
		`[".ps-ym-fire", ".ps-ym-fireglow", ".ps-ym-steam"].map((q) => getComputedStyle(document.querySelector("#theme-scene " + q)).display)`
	);
	page.check(
		`4a: by day the fire, its glow and the steam are out of the render tree (${outByDay.join(
			" "
		)})`,
		outByDay.every((d) => d === "none")
	);

	// 4f: each moving box on what it sits on.
	const boxes = await page.evaluate(BOXES);
	page.check(
		`4f: every moving pane inside its window's frame (${boxes.panes
			.map((p) => p.name)
			.join(" ")})`,
		boxes.panes.length >= 2 && boxes.panes.every((p) => inside(p.box, p.frame))
	);
	// 4a, 4g: by day nothing moves on the stove; the back pane moves.
	const stove = boxes.stove;
	const lower = {l: stove.l, r: stove.r, t: stove.b - (stove.b - stove.t) / 3, b: stove.b};
	page.check(
		"4a: by day the stove's lower third is the same in two frames 300 ms apart",
		!(await changes(page, lower, 300))
	);
	const back = boxes.panes.find((p) => p.name === "back");
	page.check(
		"4g: the back pane changes between two frames 500 ms apart (a clear noon)",
		await changes(page, back.box, 500)
	);
	await page.screenshot("yurt-noon-clear");

	// 4e: a hidden page freezes the room where it stands; shown again it moves.
	await page.evaluate(VISIBILITY("hidden"));
	await page.sleep(300);
	const CLOUDS = `[...document.querySelectorAll("#theme-scene .ps-ym-cloud")].map((e) => getComputedStyle(e).transform)`;
	const held = await page.evaluate(CLOUDS);
	const frozen = await page.evaluate(
		`document.getElementById("theme-scene").classList.contains("psng-frozen")`
	);
	const asleep = await page.evaluate(CENSUS);
	await page.sleep(1000);
	const later = await page.evaluate(CLOUDS);
	page.check(
		`4e: hidden — frozen (${frozen}), nothing runs (${asleep.length}), ${held.length} moving clouds held 1 s`,
		frozen && asleep.length === 0 && held.length > 0 && held.join() === later.join()
	);
	await page.evaluate(VISIBILITY("visible"));
	await page.sleep(500);
	page.check(
		`4e: shown again — it moves (${(await page.evaluate(CENSUS)).length})`,
		(await page.evaluate(CENSUS)).length > 0
	);

	// 2, 4b, 4h: each weather's noon, windows and plains alike, its own motion.
	const want = {rain: "psng-rain-fall", storm: "ps-flash", snow: "ps-flake"};

	for (const [weather, day] of Object.entries(WEATHER_DAYS)) {
		const {query} = await visit(page, at(day), FULL);
		page.check(
			`${weather}: the windows show the plains' weather (${query.windows} = ${query.weather})`,
			query.weather === weather && query.windows === weather
		);
		await page.sleep(600);

		if (want[weather]) {
			const c = names(await page.evaluate(CENSUS));
			page.check(
				`4b: ${weather} runs ${want[weather]} (${c.join(" ")})`,
				c.includes(want[weather])
			);
		}

		if (weather === "rain") {
			const b = await page.evaluate(BOXES);
			console.log(
				`4h: drops per pane on a rainy noon: ${b.panes
					.map((p) => `${p.name}=${p.drops}`)
					.join(" ")}`
			);
		}

		if (weather === "rain" || weather === "snow" || weather === "storm") {
			await page.screenshot(`yurt-noon-${weather}`);
		}
	}

	// 3, 4b, 6: the hour, by the room's shade and the wall's colour; the night's stars.
	const night = await visit(page, at(WEATHER_DAYS.clear, 21), FULL);
	page.check(
		`at 12:00 the room's shade is 0 (${noon.query.shade}), at 21:00 at least 0.7 (${night.query.shade})`,
		noon.query.shade === 0 && night.query.shade >= 0.7
	);
	page.check(
		`the wall's colour follows the hour (${noon.query.wall} → ${night.query.wall})`,
		!!noon.query.wall && noon.query.wall !== night.query.wall
	);
	await page.sleep(600);
	const nightRuns = names(await page.evaluate(CENSUS));
	page.check(`4b: a clear 21:00 runs ps-twinkle`, nightRuns.includes("ps-twinkle"));
	page.check(
		`4g: a clear 21:00 at full — the licks, the core, the sparks, the glow's flicker and the steam run (${nightRuns.join(
			" "
		)})`,
		[...FIRE, "psng-yt-flick", "ps-smoke-rise"].every((n) => nightRuns.includes(n))
	);
	const lit = await page.evaluate(BOXES);
	const fireMid = lit.fire ? (lit.fire.l + lit.fire.r) / 2 : -1;
	const stoveMid = lit.stove ? (lit.stove.l + lit.stove.r) / 2 : -1;
	page.check(
		`4f: at 21:00 the moving fire inside the stove, ${(
			(Math.abs(fireMid - stoveMid) / lit.width) *
			100
		).toFixed(1)} % of the width from its middle`,
		inside(lit.fire, lit.stove) && Math.abs(fireMid - stoveMid) <= 0.02 * lit.width
	);
	page.check(
		`4f: every spark inside the fire's box (${lit.sparks.length})`,
		lit.sparks.length === 4 && lit.sparks.every((b) => inside(b, lit.fire))
	);
	page.check(
		"4g: the stove's door changes between two frames 300 ms apart (full, 21:00)",
		await changes(page, lit.fire, 300)
	);
	await page.screenshot("yurt-21-clear");
	await visit(page, at(WEATHER_DAYS.clear, 18));
	await page.screenshot("yurt-18-clear");
	await visit(page, at(WEATHER_DAYS.snow, 21));
	await page.screenshot("yurt-21-snow");

	// 4c, 4g: calm, at night.
	await visit(page, at(WEATHER_DAYS.clear, 21), "&yurtMotion=calm");
	await page.sleep(800);
	const calmRuns = await page.evaluate(CENSUS);
	const calm = names(calmRuns);
	const flames = calmRuns.filter((a) => a.fire).length;
	page.check(
		`4c: calm at 21:00 — the tongues and the core flicker (${flames} in the fire) with the glow and the lamp; nothing dances, no spark rises, no window cloud drifts (${calm.join(
			" "
		)})`,
		CALM_NIGHT.every((n) => calm.includes(n)) &&
			calm.every((n) => CALM_NIGHT.includes(n)) &&
			flames === 4
	);
	page.check(
		"4g: the stove's door changes between two frames 300 ms apart (calm, 21:00)",
		await changes(page, (await page.evaluate(BOXES)).fire, 300)
	);

	// 4d: still, under reduced motion.
	await page.send("Emulation.setEmulatedMedia", {
		features: [{name: "prefers-reduced-motion", value: "reduce"}],
	});
	const STILL_FIRE = `(() => { const s = document.getElementById("theme-scene"); const e = s.querySelector(".ps-yt-still-hearth.ps-yt-burn"); const b = s.querySelector(".ps-yt-embers");
		return {opacity: e ? Number(getComputedStyle(e).opacity) : -1, embers: !!b && getComputedStyle(b).display !== "none"}; })()`;
	await visit(page, at(WEATHER_DAYS.clear, 21));
	await page.sleep(800);
	const stillNight = await page.evaluate(CENSUS);
	const burning = await page.evaluate(STILL_FIRE);
	page.check(
		`4d: still at 21:00 — nothing runs (${stillNight.length}), the still fire burns (${burning.opacity})`,
		stillNight.length === 0 && burning.opacity >= 0.95
	);
	await visit(page, at(WEATHER_DAYS.clear));
	await page.sleep(800);
	const still = await page.evaluate(CENSUS);
	const out = await page.evaluate(STILL_FIRE);
	page.check(
		`4d: still at noon — the still fire is out (${out.opacity}), the embers show (${out.embers})`,
		out.opacity === 0 && out.embers
	);
	const shown =
		await page.evaluate(`(() => { const s = document.getElementById("theme-scene"); const on = (q) => { const e = s.querySelector(q); return !!e && getComputedStyle(e).display !== "none"; };
		return {hearth: on(".ps-yt-still-hearth"), clouds: on(".ps-yt-still-clouds"), fire: on(".ps-ym-fire"), cloud: on(".ps-ym-cloud"), steam: on(".ps-ym-steam")}; })()`);
	page.check(
		`4d: still — nothing runs (${
			still.length
		}); the still fire and clouds show, the moving ones are out (${JSON.stringify(shown)})`,
		still.length === 0 &&
			shown.hearth &&
			shown.clouds &&
			!shown.fire &&
			!shown.cloud &&
			!shown.steam
	);
	await page.send("Emulation.setEmulatedMedia", {features: []});
}
