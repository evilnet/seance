// The message toolbar on a laptop with a touchscreen whose browser calls the
// touchscreen its primary input: `(hover: none) and (pointer: coarse)`, with
// a trackpad there too. The trackpad's hover must show the toolbar and its
// clicks must react and reply; a finger's long press must open it, with Copy
// text, which the mouse's toolbar does not have. What decides is the last
// pointer (helpers/inputModality.ts, `data-input` on <html>), not the
// device's primary input.
//
//   NODE_ENV=production corepack yarn build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/touch-laptop-toolbar.mjs --touch-laptop
//
// `SEANCE_IRC_URL`, `SEANCE_IRC_CHANNEL` and `SEANCE_PORT` as in
// message-actions-toolbar.mjs.

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
const NICK = `hovbar${stamp}`;
const TALKER = `hovtalk${stamp}`;

// `host` carries a path when the ircd's WebSocket lives under one
// (`irc.example.org/wockets/secure`); see the comment on it in js/irc/types.ts.
const HOST = ircd.hostname + ircd.pathname.replace(/\/$/, "");
const IRC_PORT = ircd.port || (ircd.protocol === "wss:" ? "443" : "80");

export const url =
	`http://localhost:${PORT}/?host=${encodeURIComponent(HOST)}&port=${IRC_PORT}` +
	`&tls=${ircd.protocol === "wss:"}&nick=${NICK}&join=${encodeURIComponent(CHANNEL)}`;

/** The ids of every message currently showing a tap-opened toolbar. */
const OPEN = `Array.from(document.querySelectorAll("#chat .msg.actions-open")).map((m) => m.id)`;

/** A second user on the same network, so there are messages to tap. */
function speaker(nick) {
	const ws = new WebSocket(IRCD, ["text.ircv3.net"]);
	let onJoin = () => {};

	ws.onopen = () => {
		ws.send(`NICK ${nick}`);
		ws.send(`USER ${nick} 0 * :seance hover toolbar`);
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

/** The finger on the first line of `selector`'s text. */
async function fingerAt(page, selector) {
	const r = JSON.parse(
		await page.evaluate(
			`(() => {
				const el = document.querySelector(${JSON.stringify(selector)});
				const range = document.createRange();
				range.selectNodeContents(el);
				const box = range.getClientRects()[0] ?? el.getBoundingClientRect();
				return JSON.stringify({x: box.x, y: box.y, width: box.width, height: box.height});
			})()`
		)
	);
	return [{x: r.x + Math.min(20, r.width / 2), y: r.y + r.height / 2}];
}

const INPUT = `document.documentElement.dataset.input`;

export default async function run(page) {
	await page.goto(page.url, {waitForSelector: "#connect form"});

	const media = await page.evaluate(
		`["(hover: none)", "(pointer: coarse)", "(any-hover: hover)", "(any-pointer: fine)"].map((q) => matchMedia(q).matches).join(",")`
	);
	page.check(
		`the browser calls the touchscreen primary, with a mouse there too (hover none, pointer coarse, any-hover hover, any-pointer fine: ${media}; pass --touch-laptop)`,
		media === "true,true,true,true"
	);

	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="${CHANNEL}"]')`, {
		timeout: 30000,
		label: `${CHANNEL} in the sidebar`,
	});
	await page.click(`.channel-list-item[data-name="${CHANNEL}"]`);

	const token = `tl-${Date.now().toString(36)}`;
	const talker = speaker(TALKER);
	await talker.joined;

	for (let n = 1; n <= 3; n++) {
		talker.say(`line ${n} of ${token}`);
	}

	await page.waitFor(
		`Array.from(document.querySelectorAll("#chat .msg .content")).filter((c) => c.textContent.includes(${JSON.stringify(
			token
		)})).length === 3`,
		{timeout: 30000, label: "3 messages on screen"}
	);
	await page.sleep(500);
	const ids = JSON.parse(
		await page.evaluate(
			`JSON.stringify(Array.from(document.querySelectorAll("#chat .msg")).filter((m) => m.textContent.includes(${JSON.stringify(
				token
			)})).map((m) => m.id))`
		)
	);

	// 1. The trackpad: hover shows the toolbar, a click reacts, Reply replies.
	const last = `#${ids[2]}`;
	await page.hover(`${last} .content`);
	await page.sleep(200);
	page.check(
		`a mouse moved: data-input is "pointer" (${await page.evaluate(INPUT)})`,
		(await page.evaluate(INPUT)) === "pointer"
	);
	const bar = await page.rect(`${last} .msg-actions`);
	page.check(
		`hovering a row with the mouse shows its toolbar (${JSON.stringify(bar)})`,
		!!bar && bar.width > 0 && bar.height > 0
	);
	page.check(
		"the mouse's toolbar has no Copy text: the text is selectable",
		(await page.count(`${last} .msg-action-copy-text`)) === 0
	);
	await page.click(`${last} .msg-action-quick`);
	await page.waitFor(`document.querySelector(${JSON.stringify(`${last} .msg-reaction`)})`, {
		timeout: 10000,
		label: "the reaction",
	});
	page.check(
		"a click on a quick reaction reacts",
		(await page.count(`${last} .msg-reaction`)) > 0
	);
	await page.hover(`${last} .content`);
	await page.sleep(200);
	await page.click(`${last} .msg-action-reply`);
	await page.sleep(300);
	page.check(
		"a click on Reply opens the replying bar",
		await page.evaluate(`!!document.querySelector(".compose-bar-nick")`)
	);
	await page.evaluate(`document.querySelector("#input").value = ""`);
	await page.send("Input.dispatchKeyEvent", {
		type: "keyDown",
		key: "Escape",
		code: "Escape",
		windowsVirtualKeyCode: 27,
	});
	await page.send("Input.dispatchKeyEvent", {
		type: "keyUp",
		key: "Escape",
		code: "Escape",
		windowsVirtualKeyCode: 27,
	});

	// 2. The touchscreen: a finger's long press opens the toolbar.
	await page.send("Emulation.setTouchEmulationEnabled", {enabled: true, maxTouchPoints: 5});
	const other = `#${ids[1]}`;
	const finger = await fingerAt(page, `${other} .content`);
	await page.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: finger});
	await page.sleep(800);
	await page.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
	await page.sleep(300);
	page.check(
		`a finger touched: data-input is "touch" (${await page.evaluate(INPUT)})`,
		(await page.evaluate(INPUT)) === "touch"
	);
	page.check(
		"a finger's long press opens the row's toolbar",
		await page.evaluate(
			`document.querySelector(${JSON.stringify(other)}).classList.contains("actions-open")`
		)
	);
	const pressed = await page.rect(`${other} .msg-actions`);
	page.check(`its toolbar shows (${JSON.stringify(pressed)})`, !!pressed && pressed.width > 0);
	page.check(
		"the finger's toolbar offers Copy text, since the text cannot be selected",
		(await page.count(`${other} .msg-action-copy-text`)) === 1
	);
	await page.screenshot("touch-laptop-long-press");

	// 3. Back to the trackpad: hover is trusted again.
	await page.send("Emulation.setTouchEmulationEnabled", {enabled: false});
	// A click elsewhere closes the finger's toolbar, which floats over the row above.
	await page.click(`#${ids[2]} .content`);
	await page.sleep(200);
	page.check(
		"a click elsewhere closes the finger's toolbar",
		!(await page.evaluate(`!!document.querySelector("#chat .msg.actions-open")`))
	);
	await page.hover(`#${ids[0]} .content`);
	await page.sleep(200);
	page.check(
		`the mouse again: data-input is "pointer" (${await page.evaluate(INPUT)})`,
		(await page.evaluate(INPUT)) === "pointer"
	);
	const again = await page.rect(`#${ids[0]} .msg-actions`);
	page.check(
		`and hover shows the toolbar (${JSON.stringify(again)})`,
		!!again && again.width > 0
	);
	page.check(
		"without Copy text again",
		(await page.count(`#${ids[0]} .msg-action-copy-text`)) === 0
	);

	// 4. A pen: its tap is a finger's on an iPad and a mouse's on a Surface, so
	// it changes nothing; a pen that hovers is a mouse.
	await page.send("Emulation.setTouchEmulationEnabled", {enabled: true, maxTouchPoints: 5});
	const tapAt = await fingerAt(page, `#${ids[0]} .content`);
	await page.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: tapAt});
	await page.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
	await page.send("Emulation.setTouchEmulationEnabled", {enabled: false});
	await page.sleep(200);
	page.check(
		`a finger tapped: data-input is "touch" (${await page.evaluate(INPUT)})`,
		(await page.evaluate(INPUT)) === "touch"
	);
	const pen = {...tapAt[0], pointerType: "pen", clickCount: 1, button: "left"};
	await page.send("Input.dispatchMouseEvent", {type: "mousePressed", buttons: 1, ...pen});
	await page.send("Input.dispatchMouseEvent", {type: "mouseReleased", buttons: 0, ...pen});
	await page.sleep(200);
	page.check(
		`a pen's tap changes nothing: data-input is "touch" (${await page.evaluate(INPUT)})`,
		(await page.evaluate(INPUT)) === "touch"
	);
	await page.send("Input.dispatchMouseEvent", {
		type: "mouseMoved",
		buttons: 0,
		x: pen.x + 5,
		y: pen.y,
		pointerType: "pen",
	});
	await page.sleep(200);
	page.check(
		`a pen hovering: data-input is "pointer" (${await page.evaluate(INPUT)})`,
		(await page.evaluate(INPUT)) === "pointer"
	);

	talker.quit();
}
