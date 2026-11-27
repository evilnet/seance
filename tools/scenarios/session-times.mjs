// Messenger's session times in a real browser (docs/resources/themes.md
// § Looks, style.css § Session times): the time, centred, over the first
// line of each stretch of conversation (a quiet half hour starts a new one,
// helpers/messageSessions.ts), and nowhere else; joins and parts in a pause
// neither start nor continue one; Classic and Workspace show none. Then a
// phone: the markers there, the swipe still showing every row's time, and
// ps, which lays out its own rows and draws none. On the way: a keyboard's
// focus shows a row's time; an action's toolbar comes up from anywhere on
// its line; a session time's full date opens over the bubble under it; a
// line that arrives late with an earlier time does not turn the session
// clock back; and a trackpad swipe in a private conversation moves no row,
// left to right and right to left.
//
// Run it once more with `--touch-laptop` (a browser that calls its
// touchscreen the primary input but has a trackpad too): there it checks
// only that the trackpad's swipe still shows the times.
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
	[say("10:42", "alice", "notes at https://example.invalid/notes"), false],
	[say("10:43", "bob", "\x01ACTION waves from the doorway\x01"), false],
	[
		say(
			"13:05",
			"bob",
			`I am now, ${"and this line runs on across the middle of the pane ".repeat(3)}`
		),
		true,
	],
	[say("09:30", "alice", "a new day", "2026-11-25"), true],
	// Delayed: said before the line above, sent after it. The next line is
	// 28 minutes after the newest, so no new stretch.
	[say("09:28", "bob", "a line that arrives late", "2026-11-25"), false],
	[say("09:58", "alice", "still the same stretch", "2026-11-25"), false],
];

/** A private conversation: its first line wraps at a narrow pane. */
const QUERY = [
	`@time=${at("11:00")};msgid=q1 ${from(
		"alice"
	)} PRIVMSG ${NICK} :I sent these exact words so that this first bubble wraps over a few lines at a narrow pane.`,
	`@time=${at("11:01")};msgid=q2 ${from("alice")} PRIVMSG ${NICK} :and a later one`,
	`@time=${at("11:02")};msgid=q3 ${from(
		NICK
	)} PRIVMSG alice :mine, at the far side, long enough to wrap there as well when the pane is narrow`,
];

export default async function run(page) {
	const ircd = startTinyIrcd({
		port: IRCD_PORT,
		caps: "server-time message-tags",
		onLine(line, ctx) {
			if (line.startsWith("JOIN ")) {
				for (const [out] of LINES) ctx.send(out);
				for (const out of QUERY) ctx.send(out);
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
			`[...document.querySelectorAll("#chat .msg")].some((m) => m.textContent.includes("still the same stretch"))`,
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

		if (page.flags.has("--touch-laptop")) {
			// The browser calls the touchscreen the primary input; the
			// trackpad's swipe still shows the times (trackpadSwipe.ts listens
			// on every machine: a finger sends no wheel events).
			await page.send("Input.dispatchMouseEvent", {type: "mouseMoved", x: 600, y: 450});
			for (let i = 0; i < 8; i++) {
				await page.send("Input.dispatchMouseEvent", {
					type: "mouseWheel",
					x: 600,
					y: 450,
					deltaX: 12,
					deltaY: 0,
				});
				await page.sleep(16);
			}
			await page.sleep(60);
			const hybrid = await page.evaluate(`({
				primaryTouch: matchMedia("(hover: none) and (pointer: coarse)").matches,
				finePointer: matchMedia("(any-pointer: fine)").matches,
				peek: document.querySelector("#chat .chat").classList.contains("time-peek")
			})`);
			page.check(
				`touch-primary laptop: a trackpad swipe shows the times (${JSON.stringify(
					hybrid
				)})`,
				hybrid.primaryTouch && hybrid.finePointer && hybrid.peek
			);
			return;
		}

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
			"Messenger: hovered, a row still shows no time of its own (a swipe does)",
			(await page.evaluate(TIME_SHOWN("same here"))) === "hidden"
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
		// A trackpad's two-finger swipe toward the pane's start (wheel deltaX,
		// trackpadSwipe.ts) slides the conversation aside and shows every
		// row's time, as the finger's does; the other way it does not, and
		// the gesture going quiet puts it back.
		const PEEKING = `({peek: document.querySelector("#chat .chat").classList.contains("time-peek"), shown: [...document.querySelectorAll('#chat .chat .msg[data-type="message"] > .time')].filter((t) => getComputedStyle(t).visibility === "visible").length, wide: document.querySelector("#chat .chat").scrollWidth > document.querySelector("#chat .chat").clientWidth})`;
		const wheel = async (deltaX) => {
			for (let i = 0; i < 8; i++) {
				await page.send("Input.dispatchMouseEvent", {
					type: "mouseWheel",
					x: 600,
					y: 450,
					deltaX,
					deltaY: 0,
				});
				await page.sleep(16);
			}
		};
		await wheel(-12);
		await page.sleep(60);
		const backwards = await page.evaluate(PEEKING);
		await page.sleep(400);
		await wheel(12);
		await page.sleep(60);
		const swiping = await page.evaluate(PEEKING);
		await page.screenshot("1b-messenger-desktop-trackpad-swipe");
		await page.sleep(450);
		const after = await page.evaluate(PEEKING);
		page.check(
			`trackpad: a swipe toward the start shows every row's time, and quiet puts them back (${JSON.stringify(
				{backwards, swiping, after}
			)})`,
			!backwards.peek &&
				swiping.peek &&
				swiping.shown >= 8 &&
				!swiping.wide &&
				!after.peek &&
				after.shown === 0
		);
		await page.send("Input.dispatchMouseEvent", {type: "mouseMoved", x: 5, y: 5});
		await page.sleep(300);

		// A keyboard's focus on a row shows its time, a later line's too.
		const focused = await page.evaluate(`(() => {
			const m = [...document.querySelectorAll('#chat .chat .msg[data-type="message"]')].find((x) => x.textContent.includes("notes at"));
			m.querySelector(".content a").focus({focusVisible: true});
			const got = {later: m.classList.contains("previous-source"), shown: getComputedStyle(m.querySelector(":scope > .time")).visibility};
			document.activeElement.blur();
			return {...got, after: getComputedStyle(m.querySelector(":scope > .time")).visibility};
		})()`);
		page.check(
			`Messenger: a keyboard's focus on a later line shows its time, and leaving takes it away (${JSON.stringify(
				focused
			)})`,
			focused.later && focused.shown === "visible" && focused.after === "hidden"
		);

		// An action with a msgid has a toolbar: the pointer anywhere on its
		// line, not only on its words, brings it up.
		await page.evaluate(
			`[...document.querySelectorAll("#chat .chat .msg")].find((m) => m.textContent.includes("waves from the doorway")).scrollIntoView({block: "center"})`
		);
		await page.sleep(150);
		const beside = await page.evaluate(`(() => {
			const m = [...document.querySelectorAll("#chat .chat .msg")].find((x) => x.textContent.includes("waves from the doorway"));
			const r = m.getBoundingClientRect(), pane = document.querySelector("#chat .chat").getBoundingClientRect();
			return {x: pane.right - 35, y: (r.top + r.bottom) / 2};
		})()`);
		await page.send("Input.dispatchMouseEvent", {type: "mouseMoved", ...beside});
		await page.sleep(150);
		const action = await page.evaluate(`(() => {
			const m = [...document.querySelectorAll("#chat .chat .msg")].find((x) => x.textContent.includes("waves from the doorway"));
			return {type: m.dataset.type, actions: m.classList.contains("has-actions"), hovered: m.matches(":hover"), toolbar: getComputedStyle(m.querySelector(".msg-actions")).display};
		})()`);
		page.check(
			`Messenger: beside an action, past its words, the pointer is on its row and its toolbar is up (${JSON.stringify(
				action
			)})`,
			action.type === "action" &&
				action.actions &&
				action.hovered &&
				action.toolbar === "flex"
		);
		await page.send("Input.dispatchMouseEvent", {type: "mouseMoved", x: 5, y: 5});

		// A session time's tooltip (the full date) opens downward over the
		// bubble under it: nothing paints over it. Raising the marker by hand
		// changes no pixel of it.
		const MARKER = `[...document.querySelectorAll("#chat .chat .session-marker")].find((m) => m.nextElementSibling?.textContent.includes("I am now"))`;
		await page.evaluate(`${MARKER}.scrollIntoView({block: "center"})`);
		await page.sleep(150);
		const tipAt = await page.evaluate(`(() => {
			const t = ${MARKER}.querySelector(".session-marker-text"), r = t.getBoundingClientRect();
			return {x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2, bottom: r.bottom};
		})()`);
		await page.send("Input.dispatchMouseEvent", {type: "mouseMoved", x: tipAt.x, y: tipAt.y});
		await page.sleep(700);
		const tip = await page.evaluate(`(() => {
			const t = ${MARKER}.querySelector(".session-marker-text"), a = getComputedStyle(t, "::after");
			const next = ${MARKER}.nextElementSibling.getBoundingClientRect();
			return {opacity: Number(a.opacity), visibility: a.visibility, under: next.left < ${tipAt.x} && next.right > ${tipAt.x}};
		})()`);
		const clip = {
			x: Math.floor(tipAt.x - 90),
			y: Math.ceil(tipAt.bottom + 6),
			width: 180,
			height: 14,
			scale: 1,
		};
		const shot = async () =>
			(await page.send("Page.captureScreenshot", {format: "png", clip})).data;
		const asIs = await shot();
		await page.evaluate(`${MARKER}.style.zIndex = "5"`);
		const raised = await shot();
		await page.evaluate(`${MARKER}.style.removeProperty("z-index")`);
		await page.screenshot("1c-messenger-session-tooltip");
		page.check(
			`Messenger: a session time's full date opens over the bubble under it (${JSON.stringify(
				{
					...tip,
					same: asIs === raised,
				}
			)})`,
			tip.under && tip.visibility === "visible" && tip.opacity > 0.95 && asIs === raised
		);
		await page.send("Input.dispatchMouseEvent", {type: "mouseMoved", x: 5, y: 5});

		// A private conversation at a narrow pane with the longest clock: a
		// trackpad swipe slides the times in and no row changes size or
		// moves up or down, left to right and right to left (a first line's
		// time takes no room to give back).
		await page.evaluate(update("use12hClock", true));
		await page.evaluate(update("showSeconds", true));
		await page.evaluate(
			`document.querySelector('.channel-list-item[data-name="alice"]').click()`
		);
		await page.waitFor(
			`[...document.querySelectorAll("#chat .chat .msg")].some((m) => m.textContent.includes("exact words"))`,
			{label: "the private conversation"}
		);
		await page.send("Emulation.setDeviceMetricsOverride", {
			width: 390,
			height: 844,
			deviceScaleFactor: 1,
			mobile: false,
		});
		await page.sleep(400);
		const ROWS = `(() => {
			const c = document.querySelector("#chat .chat");
			return {peek: c.classList.contains("time-peek"), wide: c.scrollWidth > c.clientWidth,
				rows: [...c.querySelectorAll(".messages > .msg")].map((m) => { const r = m.getBoundingClientRect(); return [r.width, r.height, r.top].map((v) => Math.round(v * 4) / 4); }),
				shown: [...c.querySelectorAll('.messages > .msg[data-type="message"] > .time')].filter((t) => getComputedStyle(t).visibility === "visible").length};
		})()`;
		for (const dir of ["ltr", "rtl"]) {
			await page.evaluate(`document.documentElement.dir = "${dir}"`);
			await page.sleep(400);
			const y = await page.evaluate(
				`(() => { const r = [...document.querySelectorAll("#chat .chat .msg")].find((m) => m.textContent.includes("exact words")).getBoundingClientRect(); return r.top + 12; })()`
			);
			await page.send("Input.dispatchMouseEvent", {type: "mouseMoved", x: 195, y});
			const rest = await page.evaluate(ROWS);
			for (let i = 0; i < 6; i++) {
				await page.send("Input.dispatchMouseEvent", {
					type: "mouseWheel",
					x: 195,
					y,
					deltaX: dir === "rtl" ? -15 : 15,
					deltaY: 0,
				});
				await page.sleep(16);
			}
			await page.sleep(60);
			const peeking = await page.evaluate(ROWS);
			await page.screenshot(`1d-messenger-query-trackpad-${dir}`);
			page.check(
				`Messenger query, ${dir}: a trackpad swipe shows the times and moves no row (${JSON.stringify(
					{
						rest,
						peeking,
					}
				)})`,
				!rest.peek &&
					peeking.peek &&
					peeking.shown === 3 &&
					!peeking.wide &&
					JSON.stringify(rest.rows) === JSON.stringify(peeking.rows)
			);
			await page.sleep(450);
		}
		await page.evaluate(`document.documentElement.dir = "ltr"`);
		await page.send("Emulation.clearDeviceMetricsOverride");
		await page.evaluate(update("use12hClock", false));
		await page.evaluate(update("showSeconds", false));
		await page.evaluate(
			`document.querySelector('.channel-list-item[data-name="${CHANNEL}"]').click()`
		);
		await page.sleep(400);
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
					`[...document.querySelectorAll("#chat .chat .msg .time")].every((t) => getComputedStyle(t).visibility === "hidden")`
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
			`({peek: document.querySelector("#chat .chat").classList.contains("time-peek"), shown: [...document.querySelectorAll("#chat .chat .msg[data-type=message] .time")].filter((t) => getComputedStyle(t).visibility === "visible").length})`
		);
		await page.screenshot("3-messenger-phone-swipe");
		await page.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
		await page.sleep(150);
		page.check(
			`phone: the swipe still shows every row's time (${JSON.stringify(during)})`,
			during.peek && during.shown >= 8
		);

		// ---- ps lays out its own rows: no look, no session times
		await page.evaluate(update("theme", "ps"));
		await page.sleep(1200);
		page.check("ps: no session times", (await page.count("#chat .chat .session-marker")) === 0);
		await page.screenshot("4-ps-phone");
	} finally {
		await ircd.close();
	}

	page.check("no console errors", page.consoleErrors.length === 0);
}
