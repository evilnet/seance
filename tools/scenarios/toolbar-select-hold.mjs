// A second long press selects: on a touch device the scrollback is
// `user-select: none` (the long press opens the message action toolbar
// instead), but the message whose toolbar is open is selectable again, so a
// long press there is the platform's own — a native selection. The moment a
// selection exists the toolbar stands down and the whole scrollback turns
// selectable, so the handles can cross messages; a tap collapses the
// selection and puts everything back.
//
//   corepack yarn build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/toolbar-select-hold.mjs --mobile
//
// `SEANCE_IRC_URL` and `SEANCE_IRC_CHANNEL` point it at another network, as
// in tools/scenarios/message-actions-single.mjs, which this follows: it
// joins the channel twice (the app and a second user), says two lines and
// quits, so pick a channel where that is welcome.
//
// `--mobile` is required: everything here lives behind `(hover: none) and
// (pointer: coarse)`, and the scenario refuses to pass vacuously on a
// desktop viewport. Emulation cannot make Chromium's native long-press word
// selection happen, so after checking the selectability contract the
// selection itself is made programmatically — `selectionchange` fires for
// that exactly as it does for the real gesture. The gesture end to end
// needs a real device.

const IRCD = process.env.SEANCE_IRC_URL ?? "wss://localhost:8443/";
const CHANNEL = process.env.SEANCE_IRC_CHANNEL ?? "#seance";
const PORT = process.env.SEANCE_PORT ?? "8000";

const ircd = new URL(IRCD);

if (ircd.hostname === "localhost" || ircd.hostname === "127.0.0.1") {
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // dev ircd's self-signed cert
}

const stamp = Math.random().toString(36).slice(2, 6);
const NICK = `holbar${stamp}`;
const TALKER = `holtalk${stamp}`;

const HOST = ircd.hostname + ircd.pathname.replace(/\/$/, "");
const IRC_PORT = ircd.port || (ircd.protocol === "wss:" ? "443" : "80");

export const url =
	`http://localhost:${PORT}/?host=${encodeURIComponent(HOST)}&port=${IRC_PORT}` +
	`&tls=${ircd.protocol === "wss:"}&nick=${NICK}&join=${encodeURIComponent(CHANNEL)}`;

/** The ids of every message currently showing a long-press-opened toolbar. */
const OPEN = `Array.from(document.querySelectorAll("#chat .msg.actions-open")).map((m) => m.id)`;

/** A second user on the same network, so there are messages to press. */
function speaker(nick) {
	const ws = new WebSocket(IRCD, ["text.ircv3.net"]);
	let onJoin = () => {};

	ws.onopen = () => {
		ws.send(`NICK ${nick}`);
		ws.send(`USER ${nick} 0 * :seance select hold`);
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
		notice: (text) => ws.send(`NOTICE ${CHANNEL} :${text}`),
		quit: () => ws.send("QUIT :done"),
	};
}

/** How long the finger stays down: past Message.vue's 500 ms threshold. */
const HOLD_MS = 700;

/** Where a finger lands on a row: on the first glyphs of the text itself
 * (a point deeper into the content box can be the nick on the line above). */
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
	await page.click(`.channel-list-item[data-name="${CHANNEL}"]`);

	// The channel has history, so previous runs are on screen too: mark this
	// run's messages and work only on the elements carrying the mark.
	const token = `hold-${Date.now().toString(36)}`;
	const talker = speaker(TALKER);
	await talker.joined;

	talker.say(`first line of ${token}`);
	talker.say(`second line of ${token}`);

	await page.waitFor(
		`Array.from(document.querySelectorAll("#chat .msg .content")).filter((c) => c.textContent.includes(${JSON.stringify(
			token
		)})).length === 2`,
		{timeout: 15000, label: "two messages to press"}
	);
	await page.sleep(400);

	const ids = await page.evaluate(
		`JSON.stringify(Array.from(document.querySelectorAll("#chat .msg")).filter((m) => m.textContent.includes(${JSON.stringify(
			token
		)})).map((m) => m.id))`
	);
	const [first, second] = JSON.parse(ids).map((id) => `#${id}`);

	const openIds = async () => JSON.parse(await page.evaluate(`JSON.stringify(${OPEN})`));
	const userSelectOf = async (sel) =>
		await page.evaluate(
			`getComputedStyle(document.querySelector(${JSON.stringify(sel)})).userSelect`
		);
	const selectionLive = async () => (await page.count("#chat .chat.selection-live")) === 1;

	// 0. The baseline.
	await page.check("message text starts unselectable", (await userSelectOf(first)) === "none");
	await page.check("no live-selection class yet", !(await selectionLive()));

	// 1. The first long press opens the toolbar — but while the finger is
	//    still down the text stays unselectable: selectability is armed on
	//    release (`select-armed`, Message.vue), or the platform's own
	//    long-press detector, firing a beat after ours on the same held
	//    press, would start a selection nobody asked for. Released, that
	//    message alone becomes selectable: the second long press there is
	//    the platform's.
	const hold = await fingerAt(page, `${first} .content`);
	await page.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: hold});
	await page.sleep(HOLD_MS);
	await page.check(
		`the toolbar is open while the finger is still down (${JSON.stringify(await openIds())})`,
		(await openIds()).join() === first.slice(1)
	);
	await page.check(
		"the text is still unselectable under the held finger",
		(await userSelectOf(first)) === "none"
	);
	await page.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
	await page.sleep(250);
	await page.check(
		"released, the open message is selectable now",
		(await userSelectOf(first)) === "text"
	);
	await page.check(
		"the other messages are not (their long press still opens/moves the toolbar)",
		(await userSelectOf(second)) === "none"
	);
	await page.screenshot("1-toolbar-open-selectable");

	// 2. A selection appears — emulation cannot make Chromium's native
	//    long-press word selection happen, so it is made programmatically;
	//    `selectionchange` fires exactly as for the real gesture. The
	//    toolbar stands down, the whole scrollback turns selectable so the
	//    handles can cross messages, and the selection itself survives.
	await page.evaluate(
		`(() => {
			const range = document.createRange();
			range.setStartBefore(document.querySelector(${JSON.stringify(`${first} .content`)}));
			range.setEndAfter(document.querySelector(${JSON.stringify(`${second} .content`)}));
			const sel = getSelection();
			sel.removeAllRanges();
			sel.addRange(range);
		})()`
	);
	await page.sleep(300);

	await page.check("a live selection sets selection-live", await selectionLive());
	await page.check(
		`the toolbar stands down under it (${JSON.stringify(await openIds())})`,
		(await openIds()).length === 0
	);
	await page.check(
		"no toolbar is painted (a :focus-within leftover would be)",
		(await page.evaluate(
			`Array.from(document.querySelectorAll("#chat .msg-actions")).every((el) => el.getClientRects().length === 0)`
		)) === true
	);
	await page.check(
		"the whole scrollback is selectable while the selection lives",
		(await userSelectOf(second)) === "text"
	);

	const copied = await page.evaluate(`getSelection().toString()`);
	await page.check(
		"the selection spans both messages",
		copied.includes(`first line of ${token}`) && copied.includes(`second line of ${token}`)
	);
	await page.screenshot("2-selection-live");

	// 3. Collapsing the selection (what a tap does) puts everything back.
	await page.evaluate(`getSelection().removeAllRanges()`);
	await page.sleep(300);
	await page.check("collapsing the selection clears selection-live", !(await selectionLive()));
	await page.check("message text is unselectable again", (await userSelectOf(first)) === "none");

	// 4. The toolbar behaves as before: a long press opens it, a long press
	//    on another message moves it, a tap closes it.
	await longPress(page, `${first} .content`);
	await longPress(page, `${second} .content`);
	await page.check(
		`a long press on another message still moves the toolbar (${JSON.stringify(
			await openIds()
		)})`,
		(await openIds()).join() === second.slice(1)
	);
	await tap(page, `${second} .content`);
	await page.check("a tap still closes it", (await openIds()).length === 0);
	await page.screenshot("3-toolbar-still-normal");

	// 5. A line with no toolbar — a notice, the topic, a mode change, a
	//    condensed join — has nothing for a long press to open, so it is the
	//    platform's from the first press: selectable at rest, and a long
	//    press on it opens no toolbar and arms nothing. (Before the fix it
	//    "opened" the toolbar it has not got: a silent first press that
	//    armed `select-armed`, and only the second one selected.)
	talker.notice(`a notice in ${token}`);
	await page.waitFor(
		`Array.from(document.querySelectorAll('#chat .msg[data-type="notice"] .content')).some((c) => c.textContent.includes(${JSON.stringify(
			token
		)}))`,
		{timeout: 15000, label: "a notice to press"}
	);
	await page.sleep(400);

	const notice = `#${await page.evaluate(
		`Array.from(document.querySelectorAll('#chat .msg[data-type="notice"]')).find((m) => m.textContent.includes(${JSON.stringify(
			token
		)})).id`
	)}`;
	await page.check("a notice is selectable at rest", (await userSelectOf(notice)) === "text");
	await longPress(page, `${notice} .content`);
	await page.check(
		`a long press on it opens no toolbar (${JSON.stringify(await openIds())})`,
		(await openIds()).length === 0
	);
	await page.check("and arms nothing on it", (await page.count(`${notice}.select-armed`)) === 0);
	await page.check("it is still selectable", (await userSelectOf(notice)) === "text");
	await page.check("a real message still is not", (await userSelectOf(first)) === "none");

	if ((await page.count('#chat .msg[data-type="condensed"]')) > 0) {
		await page.check(
			"a condensed join/part row is selectable too",
			(await userSelectOf('#chat .msg[data-type="condensed"]')) === "text"
		);
	}

	await page.screenshot("4-notice-selectable");

	await page.check("no console errors", page.consoleErrors.length === 0);

	talker.quit();
}
