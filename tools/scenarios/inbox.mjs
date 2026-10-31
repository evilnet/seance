// The inbox (docs/projects/inbox.md): unread mentions grouped by
// conversation, a count on the @ button, a mention leaving the list once its
// conversation is read, and the list surviving a reload with its channels.
//
//   corepack yarn build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/inbox.mjs
//   node tools/browser-drive.mjs tools/scenarios/inbox.mjs --mobile --width=390 --height=844
//   SEANCE_THEME=morning node tools/browser-drive.mjs tools/scenarios/inbox.mjs
//
// The page sits in #seance while a second user mentions it there and in a
// second channel and writes to it in private; then, after a reload, the page
// opens the channel from one of its mentions, and the private conversation
// from its one row.

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

	ws.onopen = () => {
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

		if (params[1] === "001") {
			ws.send("OPER seanceop seance"); // no fake lag for the filler lines
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
	await clickBackdrop(page, "#mentions-popup-container");

	// Three private lines are one entry; then 70 lines push the mentions out
	// of the first history page a reload fetches.
	// Paced: the dev ircd drops a burst of private lines to one target.
	for (const line of ["hey, got a minute?", "it's about the deploy", "ping me back"]) {
		talker.say(NICK, `${line} ${RUN}`);
		await page.sleep(1500);
	}

	for (let i = 1; i <= 70; i++) {
		talker.say(OTHER, `filler line ${i} ${RUN}`);
	}

	await page.waitFor(`${badgeText} === "3"`, {timeout: 20000, label: "the badge at 3"});
	await page.sleep(2000);
	await page.check(
		`a private conversation counts once (${await page.evaluate(badgeText)})`,
		(await page.evaluate(badgeText)) === "3"
	);

	// It survives a reload, with its channel resolved.
	await page.goto(BASE, {waitForSelector: "#chat, #connect"});
	await page.waitFor(`${badgeText} === "3"`, {timeout: 30000, label: "the badge after a reload"});
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
	await page.screenshot("4-after-reload", {selector: POPUP, pad: 16});

	// Opening an entry opens its channel.
	await page.evaluate(
		`Array.from(document.querySelectorAll(".mentions-entry")).find((e) => e.textContent.includes("never mind, found it"))?.setAttribute("data-scenario", "target")`
	);
	await press(`.mentions-entry[data-scenario="target"] .content`);
	await page.waitFor(`!document.querySelector("${POPUP}")`, {label: "the popover closed"});
	await page.waitFor(
		`document.querySelector("#chat .header .title")?.textContent.includes("${OTHER}")`,
		{label: `${OTHER} open`}
	);
	await page.screenshot("5-opened", {selector: "#chat", pad: 0});

	await page.waitFor(`${badgeText} === "1"`, {timeout: 5000, label: "the badge at 1"});
	await page.check(
		"reading the channel cleared its mentions, not the private one",
		(await page.evaluate(badgeText)) === "1"
	);

	await press("#chat button.mentions");
	await page.waitFor(`document.querySelector(".mentions-entry")`, {label: "the private row"});
	await press(".mentions-entry .content");
	await page.waitFor(`${badgeText} === ""`, {timeout: 5000, label: "the badge gone"});
	await page.check("reading everything cleared it", (await page.evaluate(badgeText)) === "");
	await page.screenshot("6-read", {selector: "#chat .header", pad: 8});

	talker.quit();
	page.check("no console errors", page.consoleErrors.length === 0);
}
