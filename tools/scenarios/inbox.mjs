// The inbox (docs/projects/inbox.md): unread mentions grouped by
// conversation, a count on the @ button, a mention leaving the list once its
// conversation is read, and the list surviving a reload with its channels.
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/inbox.mjs
//   node tools/browser-drive.mjs tools/scenarios/inbox.mjs --mobile --width=390 --height=844
//   SEANCE_THEME=morning node tools/browser-drive.mjs tools/scenarios/inbox.mjs
//
// The page sits in #seance while a second user mentions it there and in a
// second channel and writes to it in private; then, after a reload, the page
// opens a mention that 60 later lines have pushed out of the first history
// page in the main window at that line, and the private conversation at its newest line.

import {clickBackdrop} from "./lib/backdrop.mjs";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // dev ircd's self-signed cert

const IRCD = process.env.SEANCE_IRC_WS ?? "wss://localhost:8443/";
const RUN = Date.now().toString(36).slice(-5);
const NICK = `inbx${RUN}`;
const TALKER = `tlk${RUN}`;
const HOME = "#seance";
const OTHER = `#inbox${RUN}`;
const BASE = process.env.SEANCE_URL ?? "http://localhost:8000/";

export const url = `${BASE}?host=localhost&port=8443&tls=true&nick=${NICK}&join=${encodeURIComponent(
	`${HOME},${OTHER}`
)}`;

const BADGE = "#chat button.mentions .mentions-badge";
const POPUP = ".mentions-popup";
const ROW = (name) => `.channel-list-item[data-name="${name}"]`;

/** A second user in both channels. */
function speaker(nick) {
	const ws = new WebSocket(IRCD, ["text.ircv3.net"]);
	let joins = 0;
	let onJoined = () => {};
	let onDrained = () => {};

	ws.onopen = () => {
		ws.send("CAP REQ :message-tags");
		ws.send("CAP END");
		ws.send(`NICK ${nick}`);
		ws.send(`USER ${nick} 0 * :seance inbox`);
	};

	ws.onmessage = (ev) => {
		const line = String(ev.data);

		if (line.startsWith("PING")) {
			ws.send(`PONG${line.slice(4)}`);
			return;
		}

		const params = (line.startsWith("@") ? line.slice(line.indexOf(" ") + 1) : line).split(" ");

		if (params[1] === "PONG" && line.endsWith(":drained")) {
			onDrained();
		} else if (params[1] === "001") {
			ws.send("OPER seanceop seance");
			ws.send(`JOIN ${HOME},${OTHER}`);
		} else if (params[1] === "JOIN" && params[0].includes(nick) && ++joins === 2) {
			onJoined();
		}
	};

	return {
		joined: new Promise((resolve, reject) => {
			onJoined = resolve;
			setTimeout(() => reject(new Error(`${nick} never joined`)), 20000);
		}),
		say: (target, text) => ws.send(`PRIVMSG ${target} :${text}`),
		raw: (line) => ws.send(line),
		// The server paces a sender, oper or not, and answers in order: the
		// PONG means everything said so far has reached the channel.
		drained: () =>
			new Promise((resolve) => {
				onDrained = resolve;
				ws.send("PING :drained");
			}),
		quit: () => ws.send("QUIT :done"),
	};
}

/** A real tap at the element's centre: what a finger sends, not a mouse click. */
async function tap(page, selector) {
	const r = JSON.parse(
		await page.evaluate(
			`JSON.stringify(document.querySelector(${JSON.stringify(
				selector
			)})?.getBoundingClientRect() ?? null)`
		)
	);

	if (!r || (r.width === 0 && r.height === 0)) {
		throw new Error(`no visible element for ${selector}`);
	}

	const touchPoints = [
		{x: r.x + r.width / 2, y: r.y + r.height / 2, radiusX: 12, radiusY: 12, force: 1},
	];
	await page.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints});
	await page.sleep(60);
	await page.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
	await page.sleep(250);
}

/** A real key press; `vk` is what Mousetrap and keybinds.ts read as `which`. */
async function key(page, name, code, vk, modifiers = 0) {
	const event = {key: name, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers};
	// With text, or Chrome sends no keypress and a button does not activate.
	await page.send("Input.dispatchKeyEvent", {
		type: name === "Enter" ? "keyDown" : "rawKeyDown",
		...(name === "Enter" ? {text: "\r"} : {}),
		...event,
	});
	await page.send("Input.dispatchKeyEvent", {type: "keyUp", ...event});
	await page.sleep(120);
}

const arrowDown = (page) => key(page, "ArrowDown", "ArrowDown", 40);
const altM = (page) => key(page, "µ", "KeyM", 77, 1);

/** Enter held down: the press, and the auto-repeat a real key goes on to send. */
async function holdEnter(page) {
	const event = {
		key: "Enter",
		code: "Enter",
		windowsVirtualKeyCode: 13,
		nativeVirtualKeyCode: 13,
		text: "\r",
	};
	await page.send("Input.dispatchKeyEvent", {type: "keyDown", ...event});

	for (let i = 0; i < 4; i++) {
		await page.sleep(60);
		await page.send("Input.dispatchKeyEvent", {type: "keyDown", autoRepeat: true, ...event});
	}

	await page.send("Input.dispatchKeyEvent", {type: "keyUp", ...event});
	await page.sleep(200);
}

const rowFocused = `document.activeElement.classList.contains("mentions-entry")`;

const badgeText = `document.querySelector("${BADGE}")?.textContent.trim() ?? ""`;
const groupNames = `Array.from(document.querySelectorAll(".mentions-group-name")).map((e) => e.textContent.trim()).join(",")`;
const entryCount = `document.querySelectorAll(".mentions-entry").length`;
const THEME = process.env.SEANCE_THEME;

export default async function run(page) {
	// --mobile: a finger. Taps, never hovers, and the dismiss button must
	// show without a hover.
	const touch = await page.evaluate(`matchMedia("(pointer: coarse)").matches`);
	const press = (selector) => (touch ? tap(page, selector) : page.click(selector));
	const talker = speaker(TALKER);
	await talker.joined;

	await page.goto(page.url, {waitForSelector: "#connect form"});

	if (THEME) {
		await page.evaluate(
			`localStorage.setItem("settings", JSON.stringify({...JSON.parse(localStorage.getItem("settings") ?? "{}"), theme: ${JSON.stringify(
				THEME
			)}}))`
		);
		await page.goto(page.url, {waitForSelector: "#connect form"});
	}
	// Saved and dialled again on the reload below.
	await page.click('#connect input[name="autoconnect"]');
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector(${JSON.stringify(ROW(OTHER))})`, {
		timeout: 30000,
		label: `${OTHER} in the sidebar`,
	});

	if (
		await page.evaluate(`!document.querySelector(${JSON.stringify(ROW(HOME))})?.offsetParent`)
	) {
		await page.evaluate(`document.querySelector(".lt")?.click()`); // the phone's drawer
		await page.sleep(400);
	}

	await press(ROW(HOME));
	await page.waitFor(`document.querySelector("#input")`, {label: "the input box"});
	await page.sleep(2500); // the join burst and the catch-up

	await page.check("no badge before any mention", (await page.evaluate(badgeText)) === "");

	// Empty state.
	await press("#chat button.mentions");
	await page.waitFor(`document.querySelector("${POPUP}")`, {label: "the popover"});
	await page.sleep(100);

	// On desktop the pane hangs under the @ button, its right edge on the button's.
	if (!(await page.evaluate(`innerWidth <= 768`))) {
		const [pane, button] = JSON.parse(
			await page.evaluate(
				`JSON.stringify([document.querySelector("${POPUP}"), document.querySelector("#chat button.mentions")].map((e) => e.getBoundingClientRect()))`
			)
		);
		await page.check(
			`the pane is under the @ button (pane right ${pane.right}, top ${pane.top}; button right ${button.right}, bottom ${button.bottom})`,
			Math.abs(pane.right - button.right) <= 2 && Math.abs(pane.top - button.bottom) <= 2
		);
	}

	await page.check(
		"the empty state says so",
		await page.evaluate(`!!document.querySelector(".mentions-empty")`)
	);
	await page.screenshot("1-empty", {selector: POPUP, pad: 16});
	// Its own close button: on the phone the pane is the whole screen.
	await press(".mentions-close");
	await page.waitFor(`!document.querySelector("${POPUP}")`, {label: "closed by its ✕"});

	// Mentions: two in the other channel, one in a channel being looked at
	// (read at once: never in the inbox), one plain line.
	// Older lines than one command brings: the lines around a mention page both ways.
	for (let i = 1; i <= 60; i++) {
		talker.say(OTHER, `old line ${i} ${RUN}`);
	}

	await talker.drained();
	talker.say(OTHER, `${NICK}: are you around? the deploy is stuck on step 3 ${RUN}`);
	talker.say(OTHER, `just a line nobody is named in ${RUN}`);
	talker.say(
		OTHER,
		`${NICK} never mind, found it — it was the **cache** again. Long line to see the clamp: lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ${RUN}`
	);
	talker.say(
		OTHER,
		`So here is the long story of what happened with the build last night, from the very start, and then: what do you say, ${NICK}? ${RUN}`
	);
	talker.say(HOME, `${NICK}: hi in the open channel ${RUN}`);
	await talker.drained();
	await page.waitFor(`${badgeText} === "3"`, {timeout: 10000, label: "the badge at 3"});
	await page.sleep(1500);
	await page.check(
		`the badge counts 3 (${await page.evaluate(badgeText)})`,
		(await page.evaluate(badgeText)) === "3"
	);
	await page.check(
		`the title counts the same (${await page.evaluate("document.title")})`,
		(await page.evaluate("document.title")).startsWith("(3) ")
	);

	await page.screenshot("2a-badge", {selector: "#chat .header", pad: 4});
	await press("#chat button.mentions");
	await page.waitFor(`document.querySelector(".mentions-group")`, {label: "a group"});
	await page.sleep(300);
	const groups = await page.evaluate(groupNames);
	await page.check(`one group, the other channel (${groups})`, groups === OTHER);
	await page.check(
		`three entries (${await page.evaluate(entryCount)})`,
		(await page.evaluate(entryCount)) === 3
	);
	const excerpt = await page.evaluate(
		`Array.from(document.querySelectorAll(".mentions-entry .content")).map((e) => e.textContent.trim()).find((t) => t.includes("what do you say")) ?? ""`
	);
	await page.check(
		"entries of the same instant keep the order they were said in",
		await page.evaluate(
			`Array.from(document.querySelectorAll(".mentions-entry .content")).map((e) => e.textContent).findIndex((t) => t.includes("never mind")) === 1`
		)
	);
	await page.check(
		`a long line is cut to just before the mention (${excerpt})`,
		excerpt.startsWith("…") && excerpt.includes(NICK)
	);
	await page.screenshot("2-two-mentions", {selector: POPUP, pad: 16});

	// Why each row is here: the nick is marked.
	const marked = JSON.parse(
		await page.evaluate(
			`JSON.stringify([...CSS.highlights.get("mention")].map((r) => r.toString()))`
		)
	);
	await page.check(
		`the nick is marked in each row, nothing else (${marked})`,
		marked.length === 3 && marked.every((text) => text === NICK)
	);
	// Chrome paints either way; WebKit paints nothing on text directly in a line clamp.
	await page.check(
		"no mark sits directly in the row's line clamp",
		await page.evaluate(
			`[...CSS.highlights.get("mention")].every((r) => getComputedStyle(r.startContainer.parentElement).display !== "-webkit-box")`
		)
	);
	const senders = await page.evaluate(
		`Array.from(document.querySelectorAll(".mentions-entry .from")).map((e) => e.textContent.trim()).join()`
	);
	await page.check(
		`the sender is the nick alone, without an op's @ (${senders})`,
		senders === [TALKER, TALKER, TALKER].join()
	);
	const shownTime = await page.evaluate(
		`document.querySelector(".mentions-entry .time").textContent`
	);
	await page.check(`a clock time (${shownTime})`, /^\d{1,2}:\d{2}/.test(shownTime));

	if (!touch) {
		await page.check(
			"opening it puts the focus in the pane",
			await page.evaluate(
				`document.querySelector("${POPUP}").contains(document.activeElement)`
			)
		);
		await arrowDown(page);
		await arrowDown(page);
		await page.check(
			"the arrows walk the rows",
			(await page.evaluate(`document.activeElement.textContent`)).includes("never mind")
		);
		await page.screenshot("2b-keyboard", {selector: POPUP, pad: 16});
	}

	// Hover a row: the dismiss button shows.
	if (touch) {
		const shown = await page.evaluate(
			`getComputedStyle(document.querySelector(".mentions-entry .msg-dismiss")).opacity`
		);
		await page.check(
			`the dismiss button shows without a hover (opacity ${shown})`,
			shown === "1"
		);
	} else {
		await page.hover(".mentions-entry .content");
	}
	await page.sleep(250);
	await page.screenshot("3-hover", {selector: POPUP, pad: 16});

	// Dismiss one (this device only).
	await press(".mentions-entry .msg-dismiss");
	await page.sleep(300);
	await page.check(
		`two entries left (${await page.evaluate(entryCount)})`,
		(await page.evaluate(entryCount)) === 2
	);
	await page.check(
		`the badge says 2 (${await page.evaluate(badgeText)})`,
		(await page.evaluate(badgeText)) === "2"
	);

	if (!touch) {
		await page.check(
			"a dismiss moves the focus to the next row",
			await page.evaluate(rowFocused)
		);
		await key(page, "Backspace", "Backspace", 8);
		await page.check(
			`Backspace dismisses the focused row (${await page.evaluate(entryCount)})`,
			(await page.evaluate(entryCount)) === 1
		);
		await page.check("the focus moves on to the row left", await page.evaluate(rowFocused));
	}

	// Dismiss all can be taken back; what it took stays out of the badge till then.
	const left = await page.evaluate(entryCount);
	if (touch) {
		await press(".mentions-popup-title .oper-btn");
	} else {
		// Enter on a button in the pane is that button's, not the composer's.
		await page.evaluate(`document.querySelector(".mentions-popup-title .oper-btn").focus()`);
		await key(page, "Enter", "Enter", 13);
	}

	await page.sleep(200);
	await page.check("Dismiss all empties the list", (await page.evaluate(entryCount)) === 0);
	await page.check("and the badge", (await page.evaluate(badgeText)) === "");
	await page.screenshot("3b-undo", {selector: POPUP, pad: 16});
	await press(".mentions-undo button");
	await page.sleep(200);
	await page.check(
		`Undo brings them back (${await page.evaluate(entryCount)} of ${left})`,
		(await page.evaluate(entryCount)) === left
	);
	await page.check("and the badge", (await page.evaluate(badgeText)) === String(left));
	await page.check(
		"the Undo goes once used",
		await page.evaluate(`!document.querySelector(".mentions-undo")`)
	);
	const held = await page.evaluate(`localStorage.getItem("thelounge.mentions.dismissed")`);
	await page.check(
		`an undone dismissal is forgotten, the earlier ones kept (${held})`,
		JSON.parse(held).length === 3 - left
	);
	await clickBackdrop(page, "#mentions-popup-container");

	// A second mention in the channel, for opening one to leave behind.
	talker.say(OTHER, `${NICK}: and another thing ${RUN}`);
	await page.sleep(1500);

	// Three private lines are one entry; then 60 lines push the mentions out
	// of the first history page a reload fetches.
	// Paced: the dev ircd drops a burst of private lines to one target.
	for (const line of ["hey, got a minute?", "it's about the deploy", "ping me back"]) {
		talker.say(NICK, `${line} ${RUN}`);
		await page.sleep(1500);
	}

	for (let i = 1; i <= 60; i++) {
		talker.say(OTHER, `filler line ${i} ${RUN}`);
	}

	await talker.drained();

	const inbox = String(left + 2);
	await page.waitFor(`${badgeText} === "${inbox}"`, {
		timeout: 20000,
		label: `the badge at ${inbox}`,
	});
	await page.sleep(2000);
	await page.check(
		`a private conversation counts once (${await page.evaluate(badgeText)})`,
		(await page.evaluate(badgeText)) === inbox
	);

	// It survives a reload, with its channel resolved.
	await page.goto(BASE, {waitForSelector: "#chat, #connect"});
	await page.waitFor(`${badgeText} === "${inbox}"`, {
		timeout: 30000,
		label: "the badge after a reload",
	});
	await press("#chat button.mentions");
	await page.waitFor(`document.querySelector(".mentions-group-header:not([disabled])")`, {
		timeout: 15000,
		label: "the group, resolved to its channel",
	});
	await page.sleep(500);
	const query = `Array.from(document.querySelectorAll(".mentions-group")).find((g) => g.querySelector(".mentions-group-name")?.textContent.trim() === "${TALKER}")`;
	await page.check(
		"the private conversation is one row showing its newest line",
		await page.evaluate(
			`(() => { const g = ${query}; return !!g && g.querySelectorAll(".mentions-entry").length === 1 && g.textContent.includes("ping me back"); })()`
		)
	);
	await page.check(
		"the private row says how much is unread, and its name once",
		await page.evaluate(
			`(() => { const g = ${query}; return g.querySelector(".mentions-entry .mentions-group-unread")?.textContent.includes("3 unread") && !g.querySelector(".from") && !g.querySelector(".mentions-group-count"); })()`
		)
	);
	await page.screenshot("4-after-reload", {selector: POPUP, pad: 16});

	// Opening an entry takes the channel to it. This one is older than the first
	// page, so the main window shows the lines around it and nothing pages back for it.
	const rowOf = (text) =>
		`Array.from(document.querySelectorAll("#chat .messages .msg")).find((m) => m.textContent.includes(${JSON.stringify(
			text
		)}))`;
	const flashing = (text) => `(${rowOf(text)}?.getAnimations().length ?? 0) > 0`;
	const sent = (pattern) =>
		page.wsFrames.filter((f) => f.dir === "out" && pattern.test(f.payloadData ?? "")).length;
	const ROWS = `#chat .messages .msg`;
	const BAR = ".past-bar";
	const rowCount = () => page.evaluate(`document.querySelectorAll("${ROWS}").length`);
	const leavePast = async () => {
		await press(".past-bar-present");
		await page.waitFor(`!document.querySelector("${BAR}")`, {label: "the present again"});
	};
	const beforeJump = sent(/CHATHISTORY BEFORE /);
	await page.evaluate(
		`Array.from(document.querySelectorAll(".mentions-entry")).find((e) => e.textContent.includes("what do you say")).setAttribute("data-scenario", "target")`
	);
	await press(`.mentions-entry[data-scenario="target"] .content`);
	await page.waitFor(`!document.querySelector("${POPUP}")`, {label: "the popover closed"});
	await page.waitFor(flashing("what do you say"), {
		timeout: 20000,
		label: "the mention flashing in the main window",
	});
	await page.check(
		"an old mention opens in the main window, with a way back",
		(
			await page.evaluate(`document.querySelector("${BAR}")?.textContent`)
		).includes("viewing older messages")
	);
	await page.check(
		"nothing paged back for it, and one command asked for it",
		sent(/CHATHISTORY BEFORE /) === beforeJump &&
			sent(/CHATHISTORY AROUND #\S+ msgid=\S+ 100/) === 1
	);
	await page.check(
		"the mention sits in view",
		await page.evaluate(
			`(() => { const m = ${rowOf(
				"what do you say"
			)}.getBoundingClientRect(); const c = document.querySelector("#chat .chat-view.active .chat, #chat .chat").getBoundingClientRect(); return m.top >= c.top && m.bottom <= c.bottom; })()`
		)
	);
	await page.check(
		"no unread marker and no arrow in the past",
		await page.evaluate(
			`!document.querySelector("#chat .unread-marker") && !document.querySelector(".scroll-down-shown")`
		)
	);
	await page.screenshot("5-at-the-mention");
	await page.check(
		`opening a mention dims only that one (${await page.evaluate(badgeText)})`,
		(await page.evaluate(badgeText)) !== ""
	);

	// A live line goes to the channel underneath, unread.
	const targetMsgid = page.wsFrames
		.filter((f) => f.dir === "out")
		.map((f) => /CHATHISTORY AROUND #\S+ msgid=(\S+) 100/.exec(f.payloadData ?? "")?.[1])
		.find(Boolean);
	talker.say(OTHER, `said since it opened ${RUN}`);
	await talker.drained();
	await page.sleep(500);
	const scroller = `document.querySelector("#chat .chat")`;

	// Reaching an end of what came asks for the next page, and the place holds.
	const count = await rowCount();
	await page.evaluate(`${scroller}.scrollTop = ${scroller}.scrollHeight`);
	await page.waitFor(`!!${rowOf("said since it opened")}`, {
		timeout: 15000,
		label: "later lines on scroll",
	});
	await page.check(
		"scrolling down asked for what comes after",
		sent(/CHATHISTORY AFTER #\S+ msgid=/) >= 1 && (await rowCount()) > count
	);
	await page.sleep(700);

	// Reopen near the top, and scroll up.
	if (await page.evaluate(`!document.querySelector("${BAR}")`)) {
		await press("#chat button.mentions");
		await page.waitFor(`document.querySelector(".mentions-entry")`, {label: "rows again"});
		await page.evaluate(
			`Array.from(document.querySelectorAll(".mentions-entry")).find((e) => e.textContent.includes("what do you say")).setAttribute("data-scenario", "target")`
		);
		await press(`.mentions-entry[data-scenario="target"] .content`);
		await page.waitFor(`document.querySelector("${BAR}")`, {
			timeout: 15000,
			label: "the past view again",
		});
		await page.sleep(700);
	}

	const beforePrepend = await rowCount();
	const firstTop = `document.querySelector("${ROWS}[data-scenario='first']").getBoundingClientRect().top`;
	await page.evaluate(`(() => {
		${scroller}.querySelector(".msg").setAttribute("data-scenario", "first");
		${scroller}.scrollTop = 0;
	})()`);
	const firstId = await page.evaluate(`document.querySelector("${ROWS}").id`);
	await page.waitFor(`document.querySelectorAll("${ROWS}").length > ${beforePrepend}`, {
		timeout: 15000,
		label: "earlier lines on scroll",
	});
	await page.sleep(400);
	const rowTop = `document.getElementById(${JSON.stringify(
		firstId
	)}).getBoundingClientRect().top`;
	await page.check(
		`lines coming in above keep the place (${await page.evaluate(rowTop)})`,
		(await page.evaluate(rowTop)) > -5
	);
	await page.check(
		"the rows already there stay the same elements",
		await page.evaluate(
			`document.getElementById(${JSON.stringify(firstId)}).dataset.scenario === "first"`
		)
	);

	// Send from the past: back to the present, where the line lands.
	if (!touch) {
		await page.evaluate(`document.querySelector("#form").requestSubmit()`);
		await page.sleep(200);
		await page.check(
			"an empty composer stays in the past",
			await page.evaluate(`!!document.querySelector("${BAR}")`)
		);
		await page.evaluate(`(() => {
			const input = document.querySelector("#input");
			input.value = ${JSON.stringify(`sent from the past ${RUN}`)};
			input.dispatchEvent(new Event("input", {bubbles: true}));
			document.querySelector("#form").requestSubmit();
		})()`);
		await page.waitFor(`!document.querySelector("${BAR}")`, {label: "sending left the past"});
		await page.waitFor(`!!${rowOf("sent from the past")}`, {
			timeout: 10000,
			label: "the sent line in the channel",
		});
		await page.check(
			"what was sent is in view at the bottom",
			await page.evaluate(
				`${scroller}.scrollHeight - ${scroller}.scrollTop - ${scroller}.clientHeight < 40`
			)
		);
	}

	if (touch) {
		await leavePast();
	}

	// A quote of the same line, whose parent is not loaded either.
	talker.raw(`@+draft/reply=${targetMsgid} PRIVMSG ${OTHER} :a reply to that ${RUN}`);
	// Background work: it waits for room on the fake-lag clock this walk has used up.
	await page.waitFor(`document.querySelector(".msg-reply-quote .msg-reply-nick")`, {
		timeout: 40000,
		label: "the quote and its parent's text",
	});
	await page.sleep(300);
	await press(".msg-reply-quote");
	await page.waitFor(flashing("what do you say"), {
		timeout: 15000,
		label: "the quote's parent in the main window",
	});
	await page.check(
		"a quote's unloaded parent opens the same way",
		await page.evaluate(`!!document.querySelector("${BAR}")`)
	);
	await page.screenshot("5b-at-the-quote");
	if (touch) {
		await leavePast();
	} else {
		await key(page, "Escape", "Escape", 27);
		await page.waitFor(`!document.querySelector("${BAR}")`, {label: "Escape left the past"});
	}
	await page.check(
		"Jump to present is the bottom of the channel",
		await page.evaluate(
			`${scroller}.scrollHeight - ${scroller}.scrollTop - ${scroller}.clientHeight < 40 && !!${rowOf(
				"a reply to that"
			)}`
		)
	);

	// A parent the server does not know: it says so and nothing moves.
	talker.raw(`@+draft/reply=nosuchmessage PRIVMSG ${OTHER} :a reply to nothing ${RUN}`);
	await page.waitFor(`document.querySelector(".msg-reply-quote.unknown")`, {
		timeout: 15000,
		label: "a quote with no parent",
	});
	await page.sleep(300);
	await press(".msg-reply-quote.unknown");
	await page.waitFor(`document.querySelector("#user-visible-error")`, {
		timeout: 15000,
		label: "the error saying why",
	});
	await page.check(
		"an unknown parent stays in the present",
		await page.evaluate(`!document.querySelector("${BAR}")`)
	);
	await page.evaluate(`document.querySelector("#user-visible-error").click()`);

	// Closed at the bottom, the channel has been read.
	await page.waitFor(`${badgeText} === "1"`, {timeout: 5000, label: "the badge at 1"});
	await page.check(
		"reaching the bottom cleared the channel's mentions, not the private one",
		(await page.evaluate(badgeText)) === "1"
	);

	await press("#chat button.mentions");
	await page.waitFor(`document.querySelector(".mentions-entry")`, {label: "the private row"});

	if (touch) {
		await press(".mentions-entry .content");
	} else {
		await page.sleep(200);
		await arrowDown(page);
		await key(page, "Enter", "Enter", 13);
		await page.waitFor(`!document.querySelector("${POPUP}")`, {label: "Enter opened the row"});
	}
	await page.waitFor(flashing("ping me back"), {
		timeout: 5000,
		label: "the private conversation at its newest line",
	});
	await page.waitFor(`${badgeText} === ""`, {timeout: 5000, label: "the badge gone"});
	await page.check("reading everything cleared it", (await page.evaluate(badgeText)) === "");

	// Read mentions stay, dimmed; a channel with many shows some and offers the rest.
	await press("#chat button.mentions");
	await page.waitFor(`document.querySelector(".mentions-entry")`, {label: "the kept rows"});
	await page.check(
		"read mentions are still in the list, dimmed, with no badge",
		(await page.evaluate(`document.querySelectorAll(".mentions-entry-read").length`)) >= 3 &&
			(await page.evaluate(
				`getComputedStyle(document.querySelector(".mentions-entry-read .content")).opacity`
			)) < 1 &&
			(await page.evaluate(badgeText)) === ""
	);
	await page.screenshot("6a-kept-and-dimmed", {selector: POPUP, pad: 16});
	await clickBackdrop(page, "#mentions-popup-container");
	await page.waitFor(`!document.querySelector("${POPUP}")`, {label: "the pane closed"});
	await page.evaluate(
		`document.querySelector('.channel-list-item[data-name="${HOME}"]').click()`
	);
	await page.sleep(500);

	for (let i = 1; i <= 4; i++) {
		talker.say(OTHER, `${NICK}: one more thing, number ${i} ${RUN}`);
	}

	await talker.drained();
	await page.waitFor(`${badgeText} === "4"`, {timeout: 15000, label: "four new mentions"});
	await press("#chat button.mentions");
	const moreButton = ".mentions-more";
	await page.waitFor(`document.querySelector("${moreButton}")`, {label: "Show more"});
	const shownInGroup = `document.querySelector("${moreButton}").closest(".mentions-group").querySelectorAll(".mentions-entry").length`;
	await page.check(
		`a channel shows three rows and offers the rest (${await page.evaluate(
			`document.querySelector("${moreButton}").textContent.trim()`
		)})`,
		(await page.evaluate(shownInGroup)) === 3
	);
	await page.check(
		"a channel's rows read newest first, the newest on top",
		(await page.evaluate(
			`document.querySelector("${moreButton}").closest(".mentions-group").querySelector(".mentions-entry").textContent.includes("number 4")`
		)) === true
	);
	await page.screenshot("6b-show-more", {selector: POPUP, pad: 16});
	await press(moreButton);
	await page.waitFor(`!document.querySelector("${moreButton}")`, {label: "the rest shown"});
	await page.check(
		"Show more brings the rest",
		(await page.evaluate(
			`[...document.querySelectorAll(".mentions-group")].some((g) => g.querySelectorAll(".mentions-entry").length > 3)`
		)) === true
	);
	await page.check(
		"Show more keeps the newest on top",
		(await page.evaluate(
			`[...document.querySelectorAll(".mentions-group")].find((g) => g.querySelectorAll(".mentions-entry").length > 3).querySelector(".mentions-entry").textContent.includes("number 4")`
		)) === true
	);
	await clickBackdrop(page, "#mentions-popup-container");
	await page.waitFor(`!document.querySelector("${POPUP}")`, {label: "the pane closed again"});

	// From another channel, a mention already loaded but well above the bottom:
	// the list stays on it and nothing is read.
	for (let i = 1; i <= 40; i++) {
		talker.say(OTHER, `line after the mentions ${i} ${RUN}`);
	}

	await talker.drained();
	await page.sleep(500);
	await press("#chat button.mentions");
	await page.waitFor(`document.querySelector(".mentions-entry")`, {label: "the rows"});
	await page.evaluate(
		`Array.from(document.querySelectorAll(".mentions-entry")).find((e) => e.textContent.includes("number 2")).setAttribute("data-scenario", "loaded")`
	);
	await press(`.mentions-entry[data-scenario="loaded"] .content`);
	await page.waitFor(flashing("number 2"), {
		timeout: 10000,
		label: "the loaded mention flashing",
	});
	await page.sleep(800);
	await page.check(
		`a loaded mention from another channel stays in view, nothing read (badge ${await page.evaluate(
			badgeText
		)})`,
		(await page.evaluate(
			`(() => { const m = ${rowOf(
				"number 2"
			)}.getBoundingClientRect(); const c = ${scroller}.getBoundingClientRect(); return m.top >= c.top && m.bottom <= c.bottom; })()`
		)) && Number(await page.evaluate(badgeText)) >= 2
	);
	await page.evaluate(
		`document.querySelector('.channel-list-item[data-name="${HOME}"]').click()`
	);
	await page.sleep(500);
	await page.evaluate(`document.querySelector('${ROW(TALKER)}').click()`);
	await page.sleep(500);

	// Its target was at the bottom already, so the list must still follow.
	talker.say(NICK, `one more ${RUN}`);
	await page.waitFor(`!!${rowOf("one more")}`, {timeout: 10000, label: "a new line"});
	await page.sleep(300);
	await page.check(
		"a jump to the newest line leaves the list following new ones",
		await page.evaluate(
			`${scroller}.scrollHeight - ${scroller}.scrollTop - ${scroller}.offsetHeight <= 30`
		)
	);
	await page.screenshot("6-read", {selector: "#chat .header", pad: 8});

	// Alt+M over Settings: on top, within reach, and Escape closes it alone.
	if (!touch) {
		await page.evaluate(`document.querySelector("#input").focus()`);
		await altM(page);
		await page.waitFor(`document.querySelector("${POPUP}")`, {label: "Alt+M opens it"});
		await page.sleep(100);
		await key(page, "Escape", "Escape", 27);
		await page.waitFor(`!document.querySelector("${POPUP}")`, {label: "Escape closes it"});
		await page.sleep(100);
		await page.check(
			"the focus is back in the composer",
			await page.evaluate(`document.activeElement.id === "input"`)
		);

		// In a narrow window the sidebar is shut, and with it this button: how
		// Settings opens is not what is being checked. The phone layout's pane
		// is under the sidebar, and must still be over Settings.
		await page.evaluate(`document.querySelector("#footer button.settings").click()`);
		await page.waitFor(`document.querySelector("#settings")`, {label: "Settings"});
		await page.sleep(600);
		await altM(page);
		await page.waitFor(`document.querySelector("${POPUP}")`, {label: "Alt+M over Settings"});
		await page.sleep(200);
		await page.check(
			"it opens on top of Settings",
			await page.evaluate(
				`(() => { const r = document.querySelector("${POPUP}").getBoundingClientRect(); return !!document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest("${POPUP}"); })()`
			)
		);
		await page.screenshot("7-over-settings", {pad: 0});
		await key(page, "Escape", "Escape", 27);
		await page.sleep(200);
		await page.check(
			"Escape closes it and leaves Settings open",
			await page.evaluate(
				`!document.querySelector("${POPUP}") && !!document.querySelector("#settings")`
			)
		);
	}

	// Sidebar rows by script: a narrow window and the phone have the drawer shut.
	const openChat = async (name) => {
		await page.evaluate(`document.querySelector(${JSON.stringify(ROW(name))}).click()`);
		await page.sleep(500);
	};
	// A new user: the talker's filler lines are still queued at the server.
	const second = speaker(`scd${RUN}`);
	await second.joined;
	const mentionsAway = async () => {
		second.say(OTHER, `${NICK}: one more`);
		await page.waitFor(`document.querySelector("${BADGE}")`, {label: "a new mention"});
	};
	const setDraft = (text) =>
		page.evaluate(
			`(() => { const i = document.querySelector("#input"); i.focus(); i.value = ${JSON.stringify(
				text
			)}; i.dispatchEvent(new Event("input")); })()`
		);

	if (touch) {
		// A finger opened it, a keyboard dismisses (a tablet's): the focus stays in the pane.
		await openChat(HOME);
		await mentionsAway();
		await press("#chat button.mentions");
		await page.waitFor(`document.querySelector(".mentions-entry")`, {label: "a row"});
		await page.evaluate(`document.querySelector(".mentions-entry").focus()`);
		await key(page, "Backspace", "Backspace", 8);
		await page.check(
			"after a finger, a dismiss by key leaves the focus in the pane",
			await page.evaluate(
				`document.querySelector("${POPUP}").contains(document.activeElement)`
			)
		);
		await page.evaluate(`document.documentElement.setAttribute("data-font-size", "huge")`);
		await page.sleep(200);
		await page.check(
			"at the largest text the pane is no wider than the screen",
			await page.evaluate(
				`document.querySelector("${POPUP}").getBoundingClientRect().right <= innerWidth`
			)
		);
		await page.evaluate(`document.documentElement.removeAttribute("data-font-size")`);
		await key(page, "Escape", "Escape", 27);
	} else {
		// Held Enter on a row: it opens the conversation, and its repeats land in
		// the composer with that conversation's saved draft.
		const DRAFT = "not finished yet";
		await openChat(OTHER);
		await setDraft(DRAFT);
		await page.sleep(100);
		await openChat(HOME);
		await mentionsAway();
		await altM(page);
		await page.waitFor(`document.querySelector("${POPUP}")`, {label: "the pane"});
		await page.sleep(200);
		await arrowDown(page);
		await holdEnter(page);
		await page.waitFor(`!document.querySelector("${POPUP}")`, {label: "the row opened"});
		await page.check(
			"a held Enter on a row does not send the draft waiting there",
			(await page.evaluate(`document.querySelector("#input").value`)) === DRAFT
		);
		await setDraft("");

		// Held Enter on Dismiss all: the focus moves to Undo, then to a row.
		await openChat(HOME);
		await mentionsAway();
		await altM(page);
		await page.waitFor(`document.querySelector(".mentions-entry")`, {label: "a row"});
		await page.sleep(200);
		await page.evaluate(`document.querySelector(".mentions-popup-title .oper-btn").focus()`);
		await holdEnter(page);
		await page.check(
			"a held Enter on Dismiss all presses it once",
			await page.evaluate(
				`!!document.querySelector(".mentions-undo") && document.querySelectorAll(".mentions-entry").length === 0`
			)
		);
		await key(page, "Escape", "Escape", 27);
		await page.sleep(200);

		// Alt+M under a dialog: the pane would take the keys, out of sight.
		await mentionsAway();
		await page.evaluate(
			`document.querySelector(${JSON.stringify(
				ROW(HOME)
			)}).dispatchEvent(new MouseEvent("contextmenu", {bubbles: true, clientX: 50, clientY: 200}))`
		);
		await page.sleep(300);
		await page.evaluate(
			`[...document.querySelectorAll("#context-menu .context-menu-item")].find((e) => /clear history/i.test(e.textContent)).click()`
		);
		await page.waitFor(`document.querySelector('[data-escape-close="confirm"]')`, {
			label: "the confirm dialog",
		});
		await page.sleep(600);
		await altM(page);
		await page.sleep(200);
		await page.check(
			"Alt+M under a dialog opens nothing",
			await page.evaluate(`!document.querySelector("${POPUP}")`)
		);
		await key(page, "Escape", "Escape", 27);
	}

	talker.quit();
	page.check("no console errors", page.consoleErrors.length === 0);
}
