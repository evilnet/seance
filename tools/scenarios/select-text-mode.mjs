// "Select text" in the message action toolbar: on a touch device the
// scrollback is `user-select: none` (the long press opens the toolbar
// instead), and this mode lifts that so the platform's own long press can
// select — across messages — until the Done pill puts it away.
//
//   corepack yarn build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/select-text-mode.mjs --mobile
//
// `SEANCE_IRC_URL` and `SEANCE_IRC_CHANNEL` point it at another network, as
// in tools/scenarios/message-actions-single.mjs, which this follows: it
// joins the channel twice (the app and a second user), says two lines and
// quits, so pick a channel where that is welcome.
//
// `--mobile` is required: the toolbar, the Select text button and the
// `user-select` rule all live behind `(hover: none) and (pointer: coarse)`,
// and the scenario refuses to pass vacuously on a desktop viewport.

const IRCD = process.env.SEANCE_IRC_URL ?? "wss://localhost:8443/";
const CHANNEL = process.env.SEANCE_IRC_CHANNEL ?? "#seance";
const PORT = process.env.SEANCE_PORT ?? "8000";

const ircd = new URL(IRCD);

if (ircd.hostname === "localhost" || ircd.hostname === "127.0.0.1") {
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // dev ircd's self-signed cert
}

const stamp = Math.random().toString(36).slice(2, 6);
const NICK = `selbar${stamp}`;
const TALKER = `seltalk${stamp}`;

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
		ws.send(`USER ${nick} 0 * :seance select text`);
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
	const token = `sel-${Date.now().toString(36)}`;
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
	const inMode = async () => (await page.count("#chat .chat.select-text")) === 1;

	// 0. The baseline this mode exists to lift.
	await page.check("message text starts unselectable", (await userSelectOf(first)) === "none");
	await page.check("the mode is off to begin with", !(await inMode()));
	await page.check("no Done pill yet", (await page.count(".select-text-done")) === 0);

	// 1. The toolbar offers Select text on touch.
	await longPress(page, `${first} .content`);
	await page.check(
		`a long press opens the toolbar (${JSON.stringify(await openIds())})`,
		(await openIds()).join() === first.slice(1)
	);
	await page.check(
		"the toolbar offers Select text",
		(await page.count(`${first} .msg-action-select`)) === 1
	);
	await page.screenshot("1-toolbar-with-select");

	// 2. Tapping it enters the mode: toolbar away, text selectable, pill up.
	await tap(page, `${first} .msg-action-select`);
	await page.check("entering the mode puts the toolbar away", (await openIds()).length === 0);
	await page.check(
		"no toolbar is painted in the mode (a :focus-within leftover would be)",
		(await page.evaluate(
			`Array.from(document.querySelectorAll("#chat .msg-actions")).every((el) => el.getClientRects().length === 0)`
		)) === true
	);
	await page.check("the scrollback carries select-text", await inMode());
	await page.check(
		"message text is selectable in the mode",
		(await userSelectOf(first)) === "text"
	);
	await page.check(
		"the other message is selectable too — a selection may span rows",
		(await userSelectOf(second)) === "text"
	);

	const pill = await page.rect(".select-text-done");
	await page.check(
		`the Done pill is on screen (${JSON.stringify(pill)})`,
		pill && pill.width > 0 && pill.height > 0
	);
	await page.screenshot("2-in-select-mode");

	// 3. The long press stands down while the mode is on: it belongs to the
	//    platform's selection now.
	await longPress(page, `${second} .content`);
	await page.check(
		`a long press opens no toolbar in the mode (${JSON.stringify(await openIds())})`,
		(await openIds()).length === 0
	);

	// 4. Done puts everything back.
	await tap(page, ".select-text-done");
	await page.check("Done leaves the mode", !(await inMode()));
	await page.check("the pill goes with it", (await page.count(".select-text-done")) === 0);
	await page.check("message text is unselectable again", (await userSelectOf(first)) === "none");

	// 5. And the long press is the toolbar's again.
	await longPress(page, `${second} .content`);
	await page.check(
		`after Done a long press opens the toolbar again (${JSON.stringify(await openIds())})`,
		(await openIds()).join() === second.slice(1)
	);
	await page.screenshot("3-back-to-toolbar");

	await page.check("no console errors", page.consoleErrors.length === 0);

	talker.quit();
}
