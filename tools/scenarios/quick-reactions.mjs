// Quick reactions on a touch device: a long press opens the toolbar, whose
// first three buttons are the newest single-emoji reactions used (or the
// defaults) — one tap reacts, no picker. An action taken from the toolbar
// closes it, as every native menu closes on a choice. And the catalog chunk
// is prefetched once a conversation is open, so the picker has it when opened.
//
//   corepack yarn build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/quick-reactions.mjs --mobile
//
// `--mobile` is required (the toolbar opens on a long press only where
// `(hover: none) and (pointer: coarse)` matches). The desktop toolbar's
// quick buttons are checked in message-actions-toolbar.mjs; the picker
// itself in reaction-picker.mjs. A second user posts the lines to react to.

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
const NICK = `qrbar${stamp}`;
const TALKER = `qrtalk${stamp}`;

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
	await page.evaluate(`window.localStorage.removeItem("thelounge.reactions.recent")`);

	await page.check(
		"the browser is emulating a touch device (pass --mobile)",
		await page.evaluate(`window.matchMedia("(hover: none) and (pointer: coarse)").matches`)
	);

	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="${CHANNEL}"]')`, {
		timeout: 30000,
		label: `${CHANNEL} in the sidebar`,
	});
	// A tap, as on a phone: a mouse click would tell the app a mouse is in
	// use (helpers/inputModality.ts) and give it the hover toolbar.
	await tap(page, `.channel-list-item[data-name="${CHANNEL}"] .name`);

	const token = `qr-${Date.now().toString(36)}`;
	const talker = speaker(TALKER);
	await talker.joined;

	for (const n of [1, 2]) {
		talker.say(`line ${n} of ${token}`);
	}

	await page.waitFor(
		`Array.from(document.querySelectorAll("#chat .msg .content")).filter((c) => c.textContent.includes(${JSON.stringify(
			token
		)})).length === 2`,
		{timeout: 15000, label: "two messages to react to"}
	);
	await page.sleep(400);

	const [first, second] = JSON.parse(
		await page.evaluate(
			`JSON.stringify(Array.from(document.querySelectorAll("#chat .msg")).filter((m) => m.textContent.includes(${JSON.stringify(
				token
			)})).map((m) => m.id))`
		)
	).map((id) => `#${id}`);

	const openIds = async () => JSON.parse(await page.evaluate(`JSON.stringify(${OPEN})`));
	const quickOf = async (msg) =>
		JSON.parse(
			await page.evaluate(
				`JSON.stringify(Array.from(document.querySelectorAll(${JSON.stringify(
					`${msg} .msg-action-quick`
				)})).map((b) => b.textContent.trim()))`
			)
		);
	const badgesOf = async (msg) =>
		JSON.parse(
			await page.evaluate(
				`JSON.stringify(Array.from(document.querySelectorAll(${JSON.stringify(
					`${msg} .msg-reaction:not(.msg-reaction-add) .msg-reaction-text`
				)})).map((b) => b.textContent.trim()))`
			)
		);
	const catalogFetched = () =>
		page.evaluate(
			`performance.getEntriesByType("resource").some((e) => e.name.includes("emoji-catalog"))`
		);

	// 1. Opening the conversation prefetched the catalog chunk at idle
	//    (helpers/emoji.ts `prefetchEmojiCatalog`, from Chat.vue), so the
	//    first picker opens on a grid. The long press preloads it too, for a
	//    page whose prefetch has not fired yet; that path is not separable
	//    here, since the prefetch always wins the race in a quiet browser.
	await page.waitFor(
		`performance.getEntriesByType("resource").some((e) => e.name.includes("emoji-catalog"))`,
		{timeout: 12000, label: "the catalog chunk to be prefetched"}
	);
	await page.check(
		"the conversation prefetched the emoji catalog before any toolbar opened",
		await catalogFetched()
	);

	// 2. A long press opens the toolbar with the three defaults leading it,
	//    and the press fetched the catalog.
	await longPress(page, `${first} .content`);
	const quick = await quickOf(first);
	await page.check(
		`the toolbar leads with three quick reactions (${quick.join(" ")})`,
		(await openIds()).length === 1 && quick.join(" ") === "👍 ❤️ 😂"
	);
	await page.screenshot("1-toolbar-quick", {selector: first, pad: 60});

	// 3. One tap on ❤️ reacts, closes the toolbar, and opens no picker.
	await tap(page, `${first} .msg-action-quick:nth-child(2)`);
	await page.waitFor(
		`document.querySelectorAll(${JSON.stringify(
			`${first} .msg-reaction:not(.msg-reaction-add)`
		)}).length === 1`,
		{timeout: 5000, label: "the reaction badge"}
	);
	await page.check(
		`the reaction arrived as a badge (${JSON.stringify(await badgesOf(first))})`,
		(await badgesOf(first))[0] === "❤️"
	);
	await page.check("the toolbar closed on the tap", (await openIds()).length === 0);
	await page.check("no picker opened", (await page.count("body > .reaction-picker")) === 0);
	await page.screenshot("2-reacted", {selector: first, pad: 60});

	// 4. Reopened, ❤️ leads the row now and reads as pressed; the other row's
	//    toolbar shows the same order — one list for every toolbar.
	await longPress(page, `${first} .content`);
	const again = await quickOf(first);
	const pressed = await page.evaluate(
		`document.querySelector(${JSON.stringify(
			`${first} .msg-action-quick`
		)}).getAttribute("aria-pressed")`
	);
	await page.check(
		`the used reaction leads and is pressed (${again.join(" ")}, aria-pressed=${pressed})`,
		again.join(" ") === "❤️ 👍 😂" && pressed === "true"
	);
	await tap(page, `${first} .msg-action-quick:nth-child(1)`);
	await page.waitFor(
		`document.querySelectorAll(${JSON.stringify(
			`${first} .msg-reaction:not(.msg-reaction-add)`
		)}).length === 0`,
		{timeout: 5000, label: "the badge to go"}
	);
	await page.check(
		"tapping it again takes the reaction off",
		(await badgesOf(first)).length === 0
	);

	await longPress(page, `${second} .content`);
	await page.check(
		`the other message's toolbar has the same order (${(await quickOf(second)).join(" ")})`,
		(await quickOf(second)).join(" ") === "❤️ 👍 😂"
	);

	// 5. Reply closes the toolbar and puts the caret in the composer with
	//    the quote above it.
	await tap(page, `${second} .msg-action-reply`);
	await page.sleep(200);
	await page.check("Reply closes the toolbar", (await openIds()).length === 0);
	await page.check(
		"the composer is replying to that message",
		(await page.count("#form .compose-bar")) === 1
	);
	await page.screenshot("3-reply", {selector: "#form", pad: 40});

	talker.quit();
	page.check("no console errors", page.consoleErrors.length === 0);
}
