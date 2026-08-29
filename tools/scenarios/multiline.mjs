// A multi-line message, end to end in a real browser.
//
//   corepack yarn build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/multiline.mjs
//
// `yarn test` proves the IRC layer sends one `draft/multiline` batch and
// turns the echo back into one message, but nothing in it renders a message.
// The claim here is the half the suite cannot see: three lines typed into the
// composer become ONE message bubble in the log, laid out over three lines —
// not three bubbles, and not one line with the newlines collapsed away.
//
// A second user says a multiline message too, so the receiving path is
// checked on a message this browser did not send.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // dev ircd's self-signed cert

const IRCD = "wss://localhost:8443/";
// A channel of its own, so nothing in the log is left over from another run.
const CHANNEL = `#mline${Math.floor(1000 + Math.random() * 9000)}`;

export const url =
	"http://localhost:8000/?host=localhost&port=8443&tls=true&nick=mlwatch&join=" +
	encodeURIComponent(CHANNEL);

/** The text of every message bubble in the log, newlines and all. */
const TEXTS = `Array.from(document.querySelectorAll('#chat .msg[data-type="message"] .content'))
	.map((el) => el.textContent)`;
/** Rendered height of the message bubble at `i` (a wrapped message is taller). */
const HEIGHT = (i) =>
	`document.querySelectorAll('#chat .msg[data-type="message"] .content')[${i}]
		.getBoundingClientRect().height`;

/** A second user on the dev ircd, talking in multiline batches. */
function speaker(nick, channel) {
	const ws = new WebSocket(IRCD, ["text.ircv3.net"]);
	let onJoin = () => {};
	const send = (line) => ws.send(line);

	ws.onopen = () => {
		send("CAP LS 302");
		send("CAP REQ :batch message-tags server-time draft/multiline");
		send("CAP END");
		send(`NICK ${nick}`);
		send(`USER ${nick} 0 * :seance multiline`);
	};

	ws.onmessage = (ev) => {
		const line = String(ev.data);

		if (line.startsWith("PING")) {
			send(`PONG${line.slice(4)}`);
			return;
		}

		const params = (line.startsWith("@") ? line.slice(line.indexOf(" ") + 1) : line).split(" ");

		if (params[1] === "001") {
			send(`JOIN ${channel}`);
		} else if (params[1] === "JOIN" && params[0].includes(nick)) {
			onJoin();
		} else if (params[1] === "433") {
			send(`NICK ${nick}${Math.floor(Math.random() * 1000)}`);
		}
	};

	return {
		joined: new Promise((resolve, reject) => {
			onJoin = resolve;
			ws.onerror = (e) => reject(new Error(String(e.message ?? e)));
			setTimeout(() => reject(new Error(`${nick} never joined ${channel}`)), 20000);
		}),
		sayLines: (lines) => {
			send(`BATCH +sc1 draft/multiline ${channel}`);

			for (const line of lines) {
				send(`@batch=sc1 PRIVMSG ${channel} :${line}`);
			}

			send("BATCH -sc1");
		},
		quit: () => send("QUIT :done"),
	};
}

export default async function run(page) {
	// `--url=` may point at another build; the channel is whatever it joins.
	const channel = new URL(page.url).searchParams.get("join") ?? CHANNEL;

	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="${channel}"]')`, {
		timeout: 30000,
		label: `${channel} in the sidebar`,
	});
	await page.click(`.channel-list-item[data-name="${channel}"]`);
	await page.sleep(500);

	// --- sending -----------------------------------------------------------
	await page.fill("#input", "first line\nsecond line\nthird line");
	await page.evaluate(`document.querySelector("#form").requestSubmit()`);
	await page.waitFor(`(${TEXTS}).length >= 1`, {timeout: 10000, label: "our own message"});
	await page.sleep(800); // three separate messages would have arrived by now

	let texts = await page.evaluate(TEXTS);
	page.check(`one bubble, not three (got ${texts.length})`, texts.length === 1);
	page.check(
		`the newlines survived: ${JSON.stringify(texts[0])}`,
		texts[0] === "first line\nsecond line\nthird line"
	);

	const tall = await page.evaluate(HEIGHT(0));
	page.check(`it is laid out over three lines (${tall}px)`, tall > 40);

	// It went out as one batch, not as three PRIVMSGs.
	const sent = page.wsFrames.filter((f) => f.dir === "out").map((f) => f.payloadData ?? "");
	page.check(
		"a draft/multiline BATCH was opened",
		sent.some((f) => /^BATCH \+\S+ draft\/multiline /.test(f))
	);
	page.check(
		"the lines went inside it",
		sent.filter((f) => /^@batch=\S+ PRIVMSG /.test(f)).length === 3
	);
	await page.screenshot("1-sent-multiline");

	// --- receiving ---------------------------------------------------------
	const talker = speaker("mltalk", channel);
	await talker.joined;
	await page.sleep(500);
	talker.sayLines(["a poem", "", "with a blank line"]);
	await page.waitFor(`(${TEXTS}).length >= 2`, {timeout: 10000, label: "the received message"});
	await page.sleep(800);

	texts = await page.evaluate(TEXTS);
	page.check(`the received message is one bubble (got ${texts.length})`, texts.length === 2);
	page.check(
		`its blank line is kept: ${JSON.stringify(texts[1])}`,
		texts[1] === "a poem\n\nwith a blank line"
	);
	await page.screenshot("2-received-multiline");

	talker.quit();
	page.check("no console errors", page.consoleErrors.length === 0);
}
