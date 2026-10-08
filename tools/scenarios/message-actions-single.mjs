// On a touch device the message action toolbar opens on a long press, one
// message at a time, and a tap puts it away.
//
//   corepack yarn build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/message-actions-single.mjs --mobile
//
// `SEANCE_IRC_URL` and `SEANCE_IRC_CHANNEL` point it at another network:
//
//   SEANCE_IRC_URL=wss://irc.example.org:9998/ws SEANCE_IRC_CHANNEL='#textual' \
//     node tools/browser-drive.mjs tools/scenarios/message-actions-single.mjs --mobile
//
// It joins the channel twice (the app and a second user), says three lines
// and quits, so pick a channel where that is welcome.
//
// `--mobile` is required: the toolbar only opens on a long press where
// `(hover: none) and (pointer: coarse)` matches, and the scenario refuses to
// pass vacuously on a desktop viewport. The pointer-device behaviour (hover,
// drag, the jump arrow) is tools/scenarios/message-actions-toolbar.mjs. Nothing in `yarn test` mounts a
// component, which is why this exists. The second user is driven over the
// same WebSocket the app uses, as tools/scenarios/reaction-picker.mjs does.

const IRCD = process.env.SEANCE_IRC_URL ?? "wss://localhost:8443/";
const CHANNEL = process.env.SEANCE_IRC_CHANNEL ?? "#seance";
const PORT = process.env.SEANCE_PORT ?? "8000";

const ircd = new URL(IRCD);

if (ircd.hostname === "localhost" || ircd.hostname === "127.0.0.1") {
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // dev ircd's self-signed cert
}

// Two nicks per run, because a network that still holds the last run's
// connection would answer the reused one with 433 and the app has no second
// guess to make.
const stamp = Math.random().toString(36).slice(2, 6);
const NICK = `tapbar${stamp}`;
const TALKER = `taptalk${stamp}`;

// `host` carries a path when the ircd's WebSocket lives under one
// (`irc.example.org/wockets/secure`); see the comment on it in js/irc/types.ts.
const HOST = ircd.hostname + ircd.pathname.replace(/\/$/, "");
const IRC_PORT = ircd.port || (ircd.protocol === "wss:" ? "443" : "80");

export const url =
	`http://localhost:${PORT}/?host=${encodeURIComponent(HOST)}&port=${IRC_PORT}` +
	`&tls=${ircd.protocol === "wss:"}&nick=${NICK}&join=${encodeURIComponent(CHANNEL)}`;

/** The ids of every message currently showing a long-press-opened toolbar. */
const OPEN = `Array.from(document.querySelectorAll("#chat .msg.actions-open")).map((m) => m.id)`;

/** A second user on the same network, so there are messages to tap. */
function speaker(nick) {
	const ws = new WebSocket(IRCD, ["text.ircv3.net"]);
	let onJoin = () => {};

	ws.onopen = () => {
		ws.send(`NICK ${nick}`);
		ws.send(`USER ${nick} 0 * :seance tap toolbar`);
	};

	ws.onmessage = (ev) => {
		const line = String(ev.data);

		if (line.startsWith("PING")) {
			ws.send(`PONG${line.slice(4)}`);
			return;
		}

		const params = (line.startsWith("@") ? line.slice(line.indexOf(" ") + 1) : line).split(" ");

		if (params[1] === "001") {
			ws.send(`JOIN ${CHANNEL}`);
		} else if (params[1] === "JOIN" && params[0].includes(nick)) {
			onJoin();
		} else if (params[1] === "433") {
			ws.send(`NICK ${nick}${Math.floor(Math.random() * 1000)}`);
		}
	};

	return {
		joined: new Promise((resolve, reject) => {
			onJoin = resolve;
			ws.onerror = (e) => reject(new Error(String(e.message ?? e)));
			setTimeout(() => reject(new Error(`${nick} never joined ${CHANNEL}`)), 20000);
		}),
		say: (text) => ws.send(`PRIVMSG ${CHANNEL} :${text}`),
		quit: () => ws.send("QUIT :done"),
	};
}

/** How long the finger stays down: past Message.vue's 500 ms threshold. */
const HOLD_MS = 700;

/** Where a finger lands on a row: on the first glyphs of the text itself.
 * On a phone the row is inline flow, the text wraps, and a point a third of
 * the way into the content's bounding box can be the nick on the line above
 * it — a tap on the nick is a whois. */
async function fingerAt(page, selector) {
	const r = JSON.parse(
		await page.evaluate(
			`(() => {
				const el = document.querySelector(${JSON.stringify(selector)});
				if (!el) return "null";
				const range = document.createRange();
				range.selectNodeContents(el);
				const box = range.getClientRects()[0] ?? el.getBoundingClientRect();
				return JSON.stringify({x: box.x, y: box.y, width: box.width, height: box.height});
			})()`
		)
	);

	if (!r || (r.width === 0 && r.height === 0)) {
		throw new Error(`no visible element for ${selector}`);
	}

	const at = {x: r.x + Math.min(r.width / 2, 40), y: r.y + r.height / 2};
	return [{x: at.x, y: at.y, radiusX: 12, radiusY: 12, force: 1}];
}

/** A real tap: what a finger sends, not a synthesised mouse click. */
async function tap(page, selector) {
	const touch = await fingerAt(page, selector);
	await page.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: touch});
	await page.sleep(60);
	await page.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
	await page.sleep(250);
}

/** A long press: the finger stays down, still, past the threshold. */
async function longPress(page, selector) {
	const touch = await fingerAt(page, selector);
	await page.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: touch});
	await page.sleep(HOLD_MS);
	await page.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
	await page.sleep(250);
}

/** A finger that moves on: a scroll, never a press. */
async function drag(page, selector) {
	const touch = await fingerAt(page, selector);
	await page.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: touch});
	await page.sleep(200);
	await page.send("Input.dispatchTouchEvent", {
		type: "touchMove",
		touchPoints: [{...touch[0], y: touch[0].y - 40}],
	});
	await page.sleep(HOLD_MS);
	await page.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
	await page.sleep(250);
}

export default async function run(page) {
	await page.goto(page.url, {waitForSelector: "#connect form"});

	const touchDevice = await page.evaluate(
		`window.matchMedia("(hover: none) and (pointer: coarse)").matches`
	);
	await page.check(
		"the browser is emulating a touch device (else nothing here can open; pass --mobile)",
		touchDevice
	);

	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="${CHANNEL}"]')`, {
		timeout: 30000,
		label: `${CHANNEL} in the sidebar`,
	});
	// A tap, as on a phone: a mouse click would tell the app a mouse is in
	// use (helpers/inputModality.ts) and give it the hover toolbar.
	await tap(page, `.channel-list-item[data-name="${CHANNEL}"] .name`);

	// The channel has history, so previous runs are on screen too: mark this
	// run's messages and work only on the elements carrying the mark.
	const token = `tap-${Date.now().toString(36)}`;
	const talker = speaker(TALKER);
	await talker.joined;

	for (const n of [1, 2, 3]) {
		talker.say(`line ${n} of ${token}`);
	}

	await page.waitFor(
		`Array.from(document.querySelectorAll("#chat .msg .content")).filter((c) => c.textContent.includes(${JSON.stringify(
			token
		)})).length === 3`,
		{timeout: 15000, label: "three messages to tap"}
	);
	await page.sleep(400);

	const ids = await page.evaluate(
		`JSON.stringify(Array.from(document.querySelectorAll("#chat .msg")).filter((m) => m.textContent.includes(${JSON.stringify(
			token
		)})).map((m) => m.id))`
	);
	const [first, second, third] = JSON.parse(ids).map((id) => `#${id}`);

	const openIds = async () => JSON.parse(await page.evaluate(`JSON.stringify(${OPEN})`));

	// 0. Message text is not selectable on a touch device: the platform's
	//    long press would otherwise start a selection under ours.
	await page.check(
		"message text is not selectable on touch",
		(await page.evaluate(
			`getComputedStyle(document.querySelector(${JSON.stringify(first)})).userSelect`
		)) === "none"
	);

	// 1. A tap opens nothing — that is what used to happen, and it fired
	//    while scrolling and reading.
	await tap(page, `${first} .content`);
	await page.check(
		`a tap opens no toolbar (${JSON.stringify(await openIds())})`,
		(await openIds()).length === 0
	);

	// A finger that moves is a scroll, however long it stays down.
	await drag(page, `${first} .content`);
	await page.check("a finger that moves opens nothing", (await openIds()).length === 0);

	// 2. A long press opens that message's toolbar, and it is really on
	//    screen — `actions-open` is only a class until the `hover: none` rule
	//    reveals the toolbar it names.
	await longPress(page, `${first} .content`);
	await page.check(
		`a long press opens one toolbar (${JSON.stringify(await openIds())})`,
		(await openIds()).join() === first.slice(1)
	);

	const bar = await page.rect(`${first} .msg-actions`);
	await page.check(
		`the toolbar it names is visible (${JSON.stringify(bar)})`,
		bar && bar.width > 0 && bar.height > 0
	);
	await page.check(
		"the toolbar offers Copy text, since the text cannot be selected",
		(await page.count(`${first} .msg-action-copy-text`)) === 1
	);
	await page.screenshot("1-first-open");

	// 2b. Copy is the end of it: the bar closes on the tap — the next thing
	//     is a paste somewhere else — and the one word it leaves takes no
	//     tap and is gone within the second.
	await page.grantPermissions(["clipboardReadWrite", "clipboardSanitizedWrite"]);
	await tap(page, `${first} .msg-action-copy-text`);
	await page.check("a tap on Copy closes the toolbar", (await openIds()).length === 0);
	await page.check(
		"and leaves a Copied label over the row",
		(await page.evaluate(`document.querySelector("${first} .msg-copied")?.textContent`)) ===
			"Copied"
	);
	await page.check(
		"the label takes no tap",
		(await page.evaluate(
			`getComputedStyle(document.querySelector("${first} .msg-copied")).pointerEvents`
		)) === "none"
	);
	await page.screenshot("2b-copied");
	await page.sleep(1100);
	await page.check(
		"the label is gone within the second",
		(await page.count(`${first} .msg-copied`)) === 0
	);

	// 3. A long press on a second message moves the toolbar rather than
	//    adding one: a phone must never accumulate one per message.
	await longPress(page, `${second} .content`);

	const open = await openIds();
	await page.check(
		`a long press on another message moves the toolbar (${JSON.stringify(open)})`,
		open.length === 1 && open[0] === second.slice(1)
	);
	await page.screenshot("2-moved-to-second");

	// 4. A tap puts it away: on the open message, or anywhere else.
	await tap(page, `${second} .content`);
	await page.check("a tap on the open message closes it", (await openIds()).length === 0);

	// The toolbar floats above its row — over the row before it, on a phone
	// over most of that row's width — so the other message tapped here is
	// the one below, where the tap lands on the message and not on the bar.
	await longPress(page, `${second} .content`);
	await tap(page, `${third} .content`);
	await page.check("a tap on another message closes it too", (await openIds()).length === 0);
	await page.screenshot("3-closed-again");

	talker.quit();
}
