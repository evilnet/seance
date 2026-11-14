// The ps theme's private conversations: inside the yurt (docs/projects/ps-yurt.md,
// plan 1 task 9). No ircd needed: lib/tiny-ircd.mjs registers the client and
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
// 4. In the query no CSS animation runs in the scene.
// 5. In the query the canvas (`--canvas-bg-color`) is the roof's painted colour
//    (its top stop, within 2/255 a channel) and differs from the channel's, the
//    words are light (`data-ps-text`), and by day the five glass tints are set.
// 6. Screenshots: noon, 18:00 and 21:00 in clear, rain and snow weather.
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
const INIT = `try { const s = localStorage; s.clear(); s.setItem("settings", JSON.stringify({theme: "ps"})); } catch (e) {}
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
async function visit(page, ms) {
	await page.goto(`${BASE}&yurtAt=${ms}`, {waitForSelector: "#connect form"});
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
	await page.addInitScript(INIT);

	// 1, 4, 5: a clear noon.
	const noon = await visit(page, at(WEATHER_DAYS.clear));
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
	page.check(`no CSS animation runs in the query (${noon.query.anims})`, noon.query.anims === 0);
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
	await page.screenshot("yurt-noon-clear");

	// 2: each weather's noon, windows and plains alike.
	for (const [weather, day] of Object.entries(WEATHER_DAYS)) {
		const {query} = await visit(page, at(day));
		page.check(
			`${weather}: the windows show the plains' weather (${query.windows} = ${query.weather})`,
			query.weather === weather && query.windows === weather
		);

		if (weather === "rain" || weather === "snow") {
			await page.screenshot(`yurt-noon-${weather}`);
		}
	}

	// 3, 6: the hour, by the room's shade and the wall's colour.
	const night = await visit(page, at(WEATHER_DAYS.clear, 21));
	page.check(
		`at 12:00 the room's shade is 0 (${noon.query.shade}), at 21:00 at least 0.7 (${night.query.shade})`,
		noon.query.shade === 0 && night.query.shade >= 0.7
	);
	page.check(
		`the wall's colour follows the hour (${noon.query.wall} → ${night.query.wall})`,
		!!noon.query.wall && noon.query.wall !== night.query.wall
	);
	await page.screenshot("yurt-21-clear");
	await visit(page, at(WEATHER_DAYS.clear, 18));
	await page.screenshot("yurt-18-clear");
	await visit(page, at(WEATHER_DAYS.snow, 21));
	await page.screenshot("yurt-21-snow");
}
