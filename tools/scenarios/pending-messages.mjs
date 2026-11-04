// Pending outgoing messages, end to end in a real browser
// (docs/resources/bus-contract.md §1.9).
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/pending-messages.mjs
//
// Against another rig, point both ends elsewhere:
//   SEANCE_IRC_WS=ws://127.0.0.1:8067/ node tools/browser-drive.mjs \
//     tools/scenarios/pending-messages.mjs \
//     --url='http://127.0.0.1:8001/?host=127.0.0.1&port=8067&tls=false&nick=pendwatch&join=%23seance'
//
// The claims under test are what `pnpm test` cannot see: that a sent
// message shows at once as a faded `.msg.pending` row, that the row stays
// at the bottom while somebody else's message arrives above it, and that
// the server's echo replaces it — same text, once, no longer faded.
//
// A real echo comes back within a few milliseconds, too fast to photograph
// or to interleave anything with, so the page's WebSocket is shimmed before
// the connection is made: the echo frames of the last half of the burst are
// handed to the client {@link HOLD_MS} late. The server is not touched and
// every other frame passes straight through — what is under test is what
// the client does with a slow echo, and a MutationObserver installed before
// the burst records every pending row that appears and disappears, so the
// fast half is seen too.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // dev ircd's self-signed cert

const IRCD = process.env.SEANCE_IRC_WS ?? "wss://localhost:8443/";
const CHANNEL = "#seance";
const RUN = Date.now().toString(36);
const BURST = 8;
/** The first messages of the burst whose echo is not held back. */
const FAST = BURST / 2;
/** How long the held-back echoes wait inside the page. */
const HOLD_MS = 3000;

export const url =
	"http://localhost:8000/?host=localhost&port=8443&tls=true&nick=pendwatch&join=%23seance";

/** Text of message `n` of this run, distinct from any scrollback. */
const text = (n) => `pending ${RUN} #${n}`;

/**
 * Hold back the echo of the slow half of the burst. Installed before the
 * connect form is submitted, so the client's own WebSocket is the shimmed
 * one. Only frames carrying one of *this run's* slow messages are delayed.
 */
const INSTALL_SHIM = `(() => {
	const Native = WebSocket;
	const slow = /PRIVMSG ${CHANNEL} :pending ${RUN} #([5-9]|\\d\\d+)$/;
	window.WebSocket = class extends Native {
		addEventListener(type, listener, ...rest) {
			if (type !== "message") {
				return super.addEventListener(type, listener, ...rest);
			}
			return super.addEventListener(type, (ev) => {
				if (slow.test(String(ev.data))) {
					setTimeout(() => listener(ev), ${HOLD_MS});
				} else {
					listener(ev);
				}
			}, ...rest);
		}
	};
	return true;
})()`;

/** Every `.msg` in the active chat: id, text, pending, opacity. */
const ROWS = `Array.from(document.querySelectorAll("#chat .msg[data-type='message']")).map((el) => ({
	id: el.id,
	text: el.querySelector(".content")?.textContent.trim() ?? "",
	pending: el.classList.contains("pending"),
	opacity: getComputedStyle(el).opacity,
}))`;

/** Rows of this run only (the channel keeps scrollback from earlier runs). */
const OURS = `(${ROWS}).filter((r) => r.text.includes("${RUN}"))`;

/**
 * Watch the chat for pending rows coming and going. Installed once, before
 * the burst; `window.__pendingLog` accumulates one entry per transition.
 */
const INSTALL_OBSERVER = `(() => {
	window.__pendingLog = [];
	const seen = new Map();
	const note = () => {
		for (const el of document.querySelectorAll("#chat .msg.pending")) {
			if (!seen.has(el.id)) {
				seen.set(el.id, el.querySelector(".content")?.textContent.trim() ?? "");
				window.__pendingLog.push({event: "shown", id: el.id, text: seen.get(el.id), opacity: getComputedStyle(el).opacity});
			}
		}
		for (const [id, t] of seen) {
			const el = document.getElementById(id);
			if (!el || !el.classList.contains("pending")) {
				window.__pendingLog.push({event: "gone", id, text: t});
				seen.delete(id);
			}
		}
	};
	new MutationObserver(note).observe(document.querySelector("#chat") ?? document.body, {childList: true, subtree: true, attributes: true, attributeFilter: ["class"]});
	return true;
})()`;

/** A second user on the dev ircd, one line at a time. */
function speaker(nick) {
	const ws = new WebSocket(IRCD, ["text.ircv3.net"]);
	let onJoin = () => {};

	const send = (line) => ws.send(line);

	ws.onopen = () => {
		send(`NICK ${nick}`);
		send(`USER ${nick} 0 * :seance pending messages`);
	};

	ws.onmessage = (ev) => {
		const line = String(ev.data);

		if (line.startsWith("PING")) {
			ws.send(`PONG${line.slice(4)}`);
			return;
		}

		const params = (line.startsWith("@") ? line.slice(line.indexOf(" ") + 1) : line).split(" ");

		if (params[1] === "001") {
			send(`JOIN ${CHANNEL}`);
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
			setTimeout(() => reject(new Error(`${nick} never joined ${CHANNEL}`)), 20000);
		}),
		say: (line) => send(`PRIVMSG ${CHANNEL} :${line}`),
		quit: () => send("QUIT :done"),
	};
}

export default async function run(page) {
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(INSTALL_SHIM);
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="${CHANNEL}"]')`, {
		timeout: 30000,
		label: `${CHANNEL} in the sidebar`,
	});
	await page.click(`.channel-list-item[data-name="${CHANNEL}"]`);
	await page.waitFor(`document.querySelector("#input")`, {label: "the input box"});
	await page.sleep(2500); // let the join burst and the catch-up settle

	const talker = speaker("pendtalk");
	await talker.joined;
	await page.sleep(500);

	await page.evaluate(INSTALL_OBSERVER);

	for (let n = 1; n <= BURST; n++) {
		await page.fill("#input", text(n));
		await page.evaluate(`document.querySelector("#form").requestSubmit()`);
	}

	// 1. The fast half has been echoed, the slow half is still a faded
	//    block at the bottom.
	await page.sleep(600);
	let rows = await page.evaluate(OURS);
	const pendingNow = rows.filter((r) => r.pending);
	await page.check(
		`every message of the burst is on screen at once (${rows.length} of ${BURST})`,
		rows.length === BURST
	);
	await page.check(
		`the slow half is still pending (${pendingNow.length} of ${BURST - FAST})`,
		pendingNow.length === BURST - FAST
	);
	await page.check(
		`a pending row is faded (opacity ${pendingNow[0]?.opacity})`,
		pendingNow.length > 0 && Number(pendingNow[0].opacity) < 0.8
	);
	await page.check(
		"the fast half is not faded",
		rows.slice(0, FAST).every((r) => !r.pending && Number(r.opacity) === 1)
	);
	await page.check(
		"the pending rows are the tail of the list",
		rows.every((r, i) => !r.pending || rows.slice(i).every((later) => later.pending))
	);
	await page.screenshot("1-burst-pending", {selector: "#chat"});

	// 2. Somebody else speaks while ours are still waiting: their line goes
	//    in above the pending block, which stays at the bottom.
	const marker = `pendtalk ${RUN} interleaved`;
	talker.say(marker);
	await page.waitFor(`(${ROWS}).some((r) => r.text.includes(${JSON.stringify(marker)}))`, {
		timeout: 5000,
		label: "the other user's line",
	});
	const all = await page.evaluate(OURS);
	const markerAt = all.findIndex((r) => r.text.includes(marker));
	const stillPending = all.filter((r) => r.pending);
	await page.check(
		`the other user's line lands above the pending block (${stillPending.length} still pending)`,
		stillPending.length > 0 && all.slice(markerAt + 1).every((r) => r.pending)
	);
	await page.screenshot("2-interleaved", {selector: "#chat"});

	// 3. The held-back echoes land and every copy is replaced, in place.
	await page.waitFor(`!document.querySelector("#chat .msg.pending")`, {
		timeout: HOLD_MS + 10000,
		label: "the last echo",
	});
	await page.sleep(300);
	rows = await page.evaluate(OURS);
	const texts = rows.map((r) => r.text);
	const expected = Array.from({length: BURST}, (_, i) => text(i + 1));
	await page.check(
		`each message shows exactly once after its echo (${rows.length} rows)`,
		expected.every((t) => texts.filter((x) => x === t).length === 1)
	);
	await page.check(
		"the echoed rows keep the burst's order",
		texts.filter((t) => t.startsWith("pending")).join("|") === expected.join("|")
	);
	await page.check(
		"nothing is faded once echoed",
		rows.every((r) => !r.pending && Number(r.opacity) === 1)
	);
	await page.check(
		"the other user's line sits between the fast and the slow echoes",
		texts.indexOf(marker) === FAST
	);

	const log = await page.evaluate("window.__pendingLog");
	const shown = log.filter((e) => e.event === "shown");
	const gone = log.filter((e) => e.event === "gone");
	await page.check(
		`the observer saw every copy appear (${shown.length}) and go (${gone.length})`,
		shown.length === BURST && gone.length === BURST
	);
	await page.check(
		"every copy shown was faded",
		shown.every((e) => Number(e.opacity) < 0.8)
	);
	await page.screenshot("3-all-echoed", {selector: "#chat"});

	talker.quit();
	await page.check("no console errors", page.consoleErrors.length === 0);
}
