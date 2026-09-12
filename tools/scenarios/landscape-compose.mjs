// Compose mode: in a band as short as a landscape phone's keyboard leaves,
// the channel header goes while the composer has the caret, and comes back
// when it loses it (style.css `@container viewport (max-height: 18rem)`).
//
//   corepack yarn build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/landscape-compose.mjs --mobile
//
// `SEANCE_IRC_URL` and `SEANCE_IRC_CHANNEL` point it at another network.
//
// Chromium cannot raise a keyboard, so the scenario does what iOS does: it
// shrinks the viewport to what the keyboard leaves (926x180) with the caret
// in the composer, and grows it back. `--mobile` is required — the app only
// sizes itself from the visual viewport on a touch device. A second user on
// the same WebSocket starts typing, so the strip has something to show.
const IRCD = process.env.SEANCE_IRC_URL ?? "wss://localhost:8443/";
const ircdUrl = new URL(IRCD);
if (ircdUrl.hostname === "localhost" || ircdUrl.hostname === "127.0.0.1") {
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // dev ircd's self-signed cert
}
const CHANNEL = process.env.SEANCE_IRC_CHANNEL ?? "#seance";
const PORT = process.env.SEANCE_PORT ?? "8000";
const ircd = new URL(IRCD);
const stamp = Math.random().toString(36).slice(2, 6);
const NICK = `land${stamp}`;
const TYPIST = `landty${stamp}`;
const HOST = ircd.hostname + ircd.pathname.replace(/\/$/, "");
const IRC_PORT = ircd.port || (ircd.protocol === "wss:" ? "443" : "80");

export const url =
	`http://localhost:${PORT}/?host=${encodeURIComponent(HOST)}&port=${IRC_PORT}` +
	`&tls=${ircd.protocol === "wss:"}&nick=${NICK}&join=${encodeURIComponent(CHANNEL)}`;

const HEADER_SHOWN = `getComputedStyle(document.querySelector("#chat .header")).display !== "none"`;
const FOCUSED = `document.activeElement === document.querySelector("#input")`;

/** A second user on the network who can start and stop typing. */
function typist(nick) {
	const ws = new WebSocket(IRCD, ["text.ircv3.net"]);
	let onJoin = () => {};

	ws.onopen = () => {
		ws.send("CAP REQ :message-tags");
		ws.send("CAP END");
		ws.send(`NICK ${nick}`);
		ws.send(`USER ${nick} 0 * :seance landscape typist`);
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
		typing: (state) => ws.send(`@+typing=${state} TAGMSG ${CHANNEL}`),
		quit: () => ws.send("QUIT :done"),
	};
}

const TYPING_STRIP = `document.querySelector("#form .typing-indicator")`;

/** A phone in landscape: 926x428, and 926x180 once the keyboard and Safari's form bar are up. */
const LANDSCAPE = {width: 926, height: 428};
const KEYBOARD_UP = {width: 926, height: 180};

export default async function run(page) {
	const resize = async ({width, height}) => {
		await page.send("Emulation.setDeviceMetricsOverride", {
			width,
			height,
			deviceScaleFactor: 1,
			mobile: true,
		});
		// The app re-reads the visual viewport on a settle schedule (viewport.ts).
		await page.sleep(700);
	};

	await resize(LANDSCAPE);
	await page.goto(page.url, {waitForSelector: "#connect form"});
	page.check(
		"the browser is emulating a touch device (pass --mobile)",
		await page.evaluate(`matchMedia("(hover: none) and (pointer: coarse)").matches`)
	);

	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="${CHANNEL}"]')`, {
		timeout: 30000,
		label: `${CHANNEL} in the sidebar`,
	});
	await page.click(`.channel-list-item[data-name="${CHANNEL}"]`);
	await page.waitFor(`document.querySelector("#chat .header")`, {label: "the channel header"});

	// Landscape, no keyboard: the header stays, caret or not.
	page.check("428px tall, no caret: header shown", await page.evaluate(HEADER_SHOWN));
	await page.evaluate(`document.querySelector("#input").focus()`);
	page.check("the composer has the caret", await page.evaluate(FOCUSED));
	page.check(
		"428px tall, caret in the composer: header shown",
		await page.evaluate(HEADER_SHOWN)
	);
	await page.screenshot("landscape-compose-no-keyboard");

	// The keyboard comes up.
	await resize(KEYBOARD_UP);
	page.check(
		"180px tall, caret in the composer: header hidden",
		!(await page.evaluate(HEADER_SHOWN))
	);
	const messages = await page.rect("#chat .chat-view .messages, #chat .chat");
	const form = await page.rect("#form");
	// With the header (3rem) it would start 48px or more down.
	page.check(
		`the scrollback starts at the top of the band (y=${messages?.y})`,
		messages !== null && messages.y < 16
	);
	page.check(
		`the composer is inside the band (bottom=${form?.y + form?.height})`,
		form.y + form.height <= 180
	);
	await page.screenshot("landscape-compose-keyboard");

	// Someone starts typing: the strip joins the composer's row instead of
	// taking one, so the scrollback keeps its height.
	const before = await page.rect("#chat .chat");
	const other = typist(TYPIST);
	await other.joined;
	other.typing("active");
	await page.waitFor(`${TYPING_STRIP}?.textContent.includes("is typing")`, {
		label: "the typing strip shows the typist",
	});
	await page.sleep(300);
	const strip = await page.rect("#form .typing-indicator");
	const input = await page.rect("#form #input");
	const upload = await page.rect("#form #upload");
	const after = await page.rect("#chat .chat");
	page.check(
		`the typing strip sits on the composer's row (strip y=${strip.y}, input y=${input.y})`,
		Math.abs(strip.y + strip.height / 2 - (input.y + input.height / 2)) < input.height
	);
	page.check(
		`between the text and the paperclip (input right=${input.x + input.width}, strip x=${
			strip.x
		}, paperclip x=${upload.x})`,
		strip.x >= input.x + input.width - 1 && strip.x + strip.width <= upload.x + 1
	);
	page.check(
		`the scrollback keeps its height (${before.height} → ${after.height})`,
		after.height === before.height
	);
	await page.screenshot("landscape-compose-typing");
	other.typing("done");
	other.quit();

	// Done on the keyboard: the caret leaves, the header returns at once.
	await page.evaluate(`document.querySelector("#input").blur()`);
	page.check("180px tall, no caret: header shown", await page.evaluate(HEADER_SHOWN));

	await resize(LANDSCAPE);
	page.check("428px tall again: header shown", await page.evaluate(HEADER_SHOWN));

	// The sidebar still slides over the chat: the container query must not
	// have changed the stacking inside #viewport.
	await page.click("#viewport .lt");
	await page.sleep(300);
	const onTop = await page.evaluate(
		`(() => { const el = document.elementFromPoint(40, 200); return !!el && !!el.closest("#sidebar"); })()`
	);
	page.check("the sidebar opens over the chat", onTop);
	await page.screenshot("landscape-compose-sidebar");
}
