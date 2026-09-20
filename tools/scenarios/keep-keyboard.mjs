// With the keyboard up, a tap on the scrollback keeps it up: iOS blurs the
// composer from the mouse events it synthesises after a tap, and
// MessageList.vue cancels them at touchend (never at touchstart, so scrolling,
// the long press and the platform's selection stay its own). A press on the
// row whose toolbar is open is the exception: iOS starts no selection in the
// scrollback while the composer holds the keyboard, so that press drops the
// keyboard, keeps the toolbar, and the next long press selects (phone-verified
// 2026-09-20). A scroll drops the keyboard on touchmove as before.
//
//   corepack yarn build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/keep-keyboard.mjs --mobile
//
// `SEANCE_IRC_URL` and `SEANCE_IRC_CHANNEL` point it at another network. It
// joins the channel twice (the app and a second user), says three lines and
// quits. `--mobile` is required. Chromium proves the focus contract only; the
// iOS gesture itself needs the phone.

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
const NICK = `kbtap${stamp}`;
const TALKER = `kbtalk${stamp}`;

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
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="${CHANNEL}"]')`, {
		timeout: 30000,
		label: `${CHANNEL} in the sidebar`,
	});
	await page.click(`.channel-list-item[data-name="${CHANNEL}"]`);
	const token = `kb-${Date.now().toString(36)}`;
	const talker = speaker(TALKER);
	await talker.joined;
	for (const n of [1, 2, 3]) talker.say(`line ${n} of ${token}`);
	await page.waitFor(
		`Array.from(document.querySelectorAll("#chat .msg .content")).filter((c) => c.textContent.includes(${JSON.stringify(
			token
		)})).length === 3`,
		{timeout: 15000, label: "three messages"}
	);
	await page.sleep(400);
	const ids = JSON.parse(
		await page.evaluate(
			`JSON.stringify(Array.from(document.querySelectorAll("#chat .msg")).filter((m) => m.textContent.includes(${JSON.stringify(
				token
			)})).map((m) => m.id))`
		)
	).map((id) => `#${id}`);
	const [first, second] = ids;
	const ACTIVE = `document.activeElement && document.activeElement.id`;
	const openIds = async () => JSON.parse(await page.evaluate(`JSON.stringify(${OPEN})`));

	await page.evaluate(`document.querySelector("#input").focus()`);
	await page.check("composer focused", (await page.evaluate(ACTIVE)) === "input");

	await tap(page, `${first} .content`);
	await page.check(
		"a tap on the scrollback keeps the composer focused",
		(await page.evaluate(ACTIVE)) === "input"
	);

	await longPress(page, `${first} .content`);
	await page.check(
		"long press opens the toolbar with the caret kept",
		JSON.stringify(await openIds()) === JSON.stringify([first.slice(1)])
	);
	await page.check(
		"composer still focused after the long press",
		(await page.evaluate(ACTIVE)) === "input"
	);

	await tap(page, `${second} .content`);
	await page.check("a tap elsewhere closes it", (await openIds()).length === 0);
	await page.check("and keeps the caret", (await page.evaluate(ACTIVE)) === "input");

	await longPress(page, `${first} .content`);
	await tap(page, `${first} .content`);
	await page.check("a press on the open row keeps the toolbar", (await openIds()).length === 1);
	await page.check("and drops the keyboard", (await page.evaluate(ACTIVE)) !== "input");
	await page.evaluate(`document.querySelector("#input").focus()`);
	await tap(page, `${second} .content`);
	await page.check("a tap elsewhere then closes it", (await openIds()).length === 0);

	await longPress(page, `${first} .content`);
	await page.check("toolbar open again", (await openIds()).length === 1);
	const hasReact = await page.evaluate(
		`!!document.querySelector("${first} .msg-actions button")`
	);
	await page.check("toolbar has buttons", hasReact);
	await drag(page, `${second} .content`);
	await page.check(
		"a drag (scroll) drops the keyboard as before",
		(await page.evaluate(ACTIVE)) !== "input"
	);
	await page.evaluate(`document.querySelector("#input").blur()`);
	await tap(page, `${second} .content`);
	await page.check(
		"with nothing focused a tap still closes via click",
		(await openIds()).length === 0
	);
	talker.quit();
	await page.check("no console errors", page.consoleErrors.length === 0);
}
