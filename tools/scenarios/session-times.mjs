// Messenger's session times in a real browser (docs/resources/themes.md
// § Looks, style.css § Session times): the time, centred, over the first
// line of each stretch of conversation (a quiet half hour starts a new one,
// helpers/messageSessions.ts), and nowhere else; joins and parts in a pause
// neither start nor continue one; Classic and Workspace show none. Then a
// phone: the markers there, the swipe still showing every row's time, and
// ps, which paints its own over the scene.
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   node tools/browser-drive.mjs tools/scenarios/session-times.mjs
//
// No ircd: lib/tiny-ircd.mjs sends the conversation below when the page
// joins. `SEANCE_PORT` serves the app from another port.

import {startTinyIrcd} from "./lib/tiny-ircd.mjs";

const PORT = process.env.SEANCE_PORT ?? "8000";
const IRCD_PORT = 9884;
const NICK = "seer";
const CHANNEL = "#sessions";
const DAY = "2026-11-24";

export const url = `http://localhost:${PORT}/?host=127.0.0.1&port=${IRCD_PORT}&tls=false&nick=${NICK}&join=${encodeURIComponent(
	CHANNEL
)}`;

const STORE = `document.querySelector("[data-v-app]").__vue_app__.config.globalProperties.$store`;
const update = (name, value) =>
	`${STORE}.dispatch("settings/update", {name: ${JSON.stringify(name)}, value: ${JSON.stringify(
		value
	)}})`;

const at = (hhmm, day = DAY) => `${day}T${hhmm}:00.000Z`;
const from = (nick) => `:${nick}!${nick}@sessions.test`;
let n = 0;
const say = (hhmm, nick, text, day) =>
	`@time=${at(hhmm, day)};msgid=s${++n} ${from(nick)} PRIVMSG ${CHANNEL} :${text}`;

/** [the line, whether a session time stands over it]. */
const LINES = [
	[`@time=${at("08:58")};msgid=s0 ${from(NICK)} JOIN ${CHANNEL}`, false],
	[`:tiny.test 353 ${NICK} = ${CHANNEL} :@${NICK} alice bob`, false],
	[`:tiny.test 366 ${NICK} ${CHANNEL} :End of /NAMES list.`, false],
	[say("09:00", "alice", "morning! coffee first"), true],
	[say("09:01", "bob", "same here"), false],
	[say("09:12", "alice", "ok, back, where were we"), false],
	[say("09:35", "bob", "the release notes"), false],
	// A long pause with comings and goings in it.
	[`@time=${at("10:00")};msgid=j1 ${from("carol")} JOIN ${CHANNEL}`, false],
	[`@time=${at("10:20")};msgid=j2 ${from("carol")} PART ${CHANNEL}`, false],
	[say("10:40", "alice", "lunch was good"), true],
	[say("10:41", "alice", "anyone around?"), false],
	[say("13:05", "bob", "I am now"), true],
	[say("09:30", "alice", "a new day", "2026-11-25"), true],
];

export default async function run(page) {
	const ircd = startTinyIrcd({
		port: IRCD_PORT,
		caps: "server-time message-tags",
		onLine(line, ctx) {
			if (line.startsWith("JOIN ")) {
				for (const [out] of LINES) ctx.send(out);
				return true;
			}

			return line.startsWith("PRIVMSG ");
		},
	});

	const MARKED = `[...document.querySelectorAll("#chat .chat .session-marker")].map((m) => {
		let next = m.nextElementSibling;
		return {label: m.textContent.trim(), next: next?.querySelector(".content")?.textContent ?? null};
	})`;
	const WANTED = LINES.filter(([, marked]) => marked).map(([line]) => line.split(" :").pop());

	try {
		await page.send("Emulation.setTimezoneOverride", {timezoneId: "Etc/UTC"});
		await page.goto(page.url, {waitForSelector: "#connect form"});
		await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
		await page.waitFor(
			`[...document.querySelectorAll("#chat .msg")].some((m) => m.textContent.includes("a new day"))`,
			{label: "the conversation"}
		);
		await page.evaluate(update("use12hClock", false));

		page.check(
			"Classic: no session times",
			(await page.count("#chat .chat .session-marker")) === 0
		);
		await page.evaluate(update("messageLayout", "workspace"));
		await page.sleep(200);
		page.check(
			"Workspace: no session times",
			(await page.count("#chat .chat .session-marker")) === 0
		);

		await page.evaluate(update("messageLayout", "bubbles"));
		await page.sleep(300);
		const marked = await page.evaluate(MARKED);
		page.check(
			`Messenger: a time over each stretch's first line, and only there (${JSON.stringify(
				marked
			)})`,
			JSON.stringify(marked.map((m) => m.next)) === JSON.stringify(WANTED)
		);
		page.check(
			"Messenger: each reads its line's time",
			JSON.stringify(marked.map((m) => m.label)) ===
				JSON.stringify(["09:00", "10:40", "13:05", "09:30"])
		);
		const centred = await page.evaluate(`(() => {
			const pane = document.querySelector("#chat .chat").getBoundingClientRect();
			return [...document.querySelectorAll("#chat .chat .session-marker-text")].every((t) => {
				const r = t.getBoundingClientRect();
				return r.width > 0 && Math.abs((r.left + r.right) / 2 - (pane.left + pane.right) / 2) < 12;
			});
		})()`);
		page.check("Messenger: the times are centred in the pane", centred);
		await page.evaluate(
			`(() => { const c = document.querySelector("#chat .chat"); c.scrollTop = c.scrollHeight; })()`
		);
		await page.sleep(200);
		const TIME_SHOWN = (text) =>
			`getComputedStyle([...document.querySelectorAll('#chat .chat .msg[data-type="message"]')].find((m) => m.textContent.includes(${JSON.stringify(
				text
			)})).querySelector(":scope > .time")).visibility`;
		page.check(
			"Messenger: no row shows a time of its own at rest",
			await page.evaluate(
				`[...document.querySelectorAll('#chat .chat .msg[data-type="message"] > .time')].every((t) => getComputedStyle(t).visibility === "hidden")`
			)
		);
		await page.screenshot("1-messenger-desktop");
		const index = await page.evaluate(
			`[...document.querySelectorAll('#chat .chat .msg[data-type="message"]')].findIndex((m) => m.textContent.includes("same here"))`
		);
		await page.hover('#chat .chat .msg[data-type="message"]', index);
		await page.sleep(150);
		page.check(
			"Messenger: hovered, a run's first line shows its time",
			(await page.evaluate(TIME_SHOWN("same here"))) === "visible"
		);
		await page.screenshot("1a-messenger-desktop-hover");

		// The hover is the row's, not the bubble's: past a short bubble's end
		// and in the slit between a run's lines the time stays up, and the
		// words are still the words under the pointer.
		const sweep = await page.evaluate(`(() => {
			const rows = [...document.querySelectorAll('#chat .chat .msg[data-type="message"]')];
			const box = (t) => rows.find((m) => m.textContent.includes(t)).getBoundingClientRect();
			const a = box("lunch was good"), b = box("anyone around?");
			const pane = document.querySelector("#chat .chat").getBoundingClientRect();
			const at = (x, y) => document.elementFromPoint(x, y)?.closest(".msg")?.textContent ?? null;
			return {
				beside: at(pane.right - 40, (a.top + a.bottom) / 2)?.includes("lunch was good") ?? false,
				slit: at(a.left + 20, (a.bottom + b.top) / 2)?.includes("lunch was good") ?? false,
				words: !!document.elementFromPoint(a.left + 20, a.bottom - 8)?.closest(".content"),
			};
		})()`);
		page.check(
			`Messenger: the hover is the row's, past the bubble and across a run's slit, and the words stay on top (${JSON.stringify(
				sweep
			)})`,
			sweep.beside && sweep.slit && sweep.words
		);
		page.check(
			"Messenger: no sideways scroll with the rows' hover areas",
			await page.evaluate(
				`(() => { const c = document.querySelector("#chat .chat"); return c.scrollWidth <= c.clientWidth; })()`
			)
		);
		await page.send("Input.dispatchMouseEvent", {type: "mouseMoved", x: 5, y: 5});

		// ---- a phone, by finger
		await page.send("Emulation.setDeviceMetricsOverride", {
			width: 390,
			height: 844,
			deviceScaleFactor: 2,
			mobile: true,
		});
		await page.send("Emulation.setTouchEmulationEnabled", {enabled: true, maxTouchPoints: 1});
		await page.evaluate(`document.documentElement.dataset.input = "touch"`);
		await page.sleep(400);
		await page.evaluate(
			`(() => { const c = document.querySelector("#chat .chat"); c.scrollTop = c.scrollHeight; })()`
		);
		await page.sleep(200);
		page.check(
			"phone: the session times stay while row times are hidden",
			(await page.count("#chat .chat .session-marker")) === 4 &&
				(await page.evaluate(
					`[...document.querySelectorAll("#chat .chat .msg .time")].every((t) => getComputedStyle(t).display === "none")`
				))
		);
		page.check(
			"phone: no sideways scroll",
			await page.evaluate(
				`(() => { const c = document.querySelector("#chat .chat"); return c.scrollWidth <= c.clientWidth && document.documentElement.scrollWidth <= innerWidth; })()`
			)
		);
		await page.screenshot("2-messenger-phone");

		const point = (x) => [{x, y: 500, id: 1}];
		await page.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: point(330)});
		for (const x of [300, 240, 180, 100, 40]) {
			await page.send("Input.dispatchTouchEvent", {type: "touchMove", touchPoints: point(x)});
		}
		await page.sleep(150);
		const during = await page.evaluate(
			`({peek: document.querySelector("#chat .chat").classList.contains("time-peek"), shown: [...document.querySelectorAll("#chat .chat .msg[data-type=message] .time")].filter((t) => getComputedStyle(t).display !== "none").length})`
		);
		await page.screenshot("3-messenger-phone-swipe");
		await page.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
		await page.sleep(150);
		page.check(
			`phone: the swipe still shows every row's time (${JSON.stringify(during)})`,
			during.peek && during.shown >= 8
		);

		// ---- ps paints its own
		await page.evaluate(update("theme", "ps"));
		await page.sleep(1200);
		page.check(
			"ps: the session times are there",
			(await page.count("#chat .chat .session-marker")) === 4
		);
		await page.screenshot("4-ps-phone");
	} finally {
		await ircd.close();
	}

	page.check("no console errors", page.consoleErrors.length === 0);
}
