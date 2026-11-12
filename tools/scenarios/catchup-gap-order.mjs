// A reconnect's catch-up gap shows above a line relayed live while it was
// being fetched, and the unread marker sits above the gap
// (client/js/irc/ids.ts `reserve`, helpers/messageUpdates.ts `insertMessage`).
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   node tools/browser-drive.mjs tools/scenarios/catchup-gap-order.mjs
//   … --mobile --width=390 --height=844
//
// No ircd needed: lib/tiny-ircd.mjs is scripted to answer CHATHISTORY.
//
// The page joins #gap and gets three lines of history, then sits in the
// lobby while the socket is cut. On the redial, the catch-up's LATEST is
// answered only after a live line has gone out to the channel.
//
// Claims:
//   1. #gap reads held lines, then the gap oldest first, then the live line;
//   2. the unread marker sits right above the first line of the gap, with
//      every unread line below it;
//   3. no console errors.

import {startTinyIrcd} from "./lib/tiny-ircd.mjs";

const PORT = process.env.SEANCE_PORT ?? "8000";
const IRCD_PORT = 9873;
const NICK = `gap${Date.now().toString(36).slice(-5)}`;
const CHAN = "#gap";

export const url = `http://localhost:${PORT}/?host=127.0.0.1&port=${IRCD_PORT}&tls=false&nick=${NICK}&join=${encodeURIComponent(
	CHAN
)}`;
export const allowWsFrameErrors = /after close/;

const T0 = Date.now();
const at = (minutes) => new Date(T0 + minutes * 60_000).toISOString();
const say = (time, msgid, text) =>
	`@time=${time};msgid=${msgid} :bob!b@tiny PRIVMSG ${CHAN} :${text}`;

const HELD = [
	say(at(-30), "h1", "held one"),
	say(at(-29), "h2", "held two"),
	say(at(-28), "h3", "held three"),
];
// Said after we joined, while the socket was cut: stamped when the
// catch-up is answered, a moment before the live line. A gap stamped before
// the JOIN would lie under the read point the open channel set, and be read.
const gap = () => {
	const now = Date.now();
	return [
		say(new Date(now - 400).toISOString(), "g1", "gap one"),
		say(new Date(now - 300).toISOString(), "g2", "gap two"),
	];
};
const LIVE = "live during the catch-up";

let joins = 0;
let answered = () => {};
const caughtUp = new Promise((resolve) => {
	answered = resolve;
});

/** A `chathistory` batch; `end` says there is nothing older (draft/chathistory-end). */
function chathistory(send, lines, end = false) {
	send(`${end ? "@draft/chathistory-end " : ""}:tiny.test BATCH +h chathistory ${CHAN}`);

	for (const line of lines) {
		send(`@batch=h;${line.slice(1)}`);
	}

	send(":tiny.test BATCH -h");
}

function script(line, {send, nick}) {
	const [cmd, ...args] = line.replace(/^@\S+ /, "").split(" ");

	if (cmd === "JOIN") {
		joins++;
		send(`@time=${new Date().toISOString()};msgid=j${joins} :${nick}!u@tiny JOIN ${CHAN}`);
		send(`:tiny.test 353 ${nick} = ${CHAN} :${nick} bob`);
		send(`:tiny.test 366 ${nick} ${CHAN} :End of /NAMES list.`);
		return true;
	}

	if (cmd === "CHATHISTORY" && args[0] === "LATEST") {
		if (joins === 1) {
			chathistory(send, HELD, true);
		} else {
			// Said while the catch-up is out: relayed before the page it is in.
			const live = say(new Date().toISOString(), "live", LIVE);
			send(live);
			chathistory(send, [HELD[2], ...gap(), live]);
			answered();
		}

		return true;
	}

	if (cmd === "CHATHISTORY") {
		chathistory(send, [], true); // nothing older than what it was given
		return true;
	}

	return cmd === "MODE" || cmd === "WHO";
}

const texts = `[...document.querySelectorAll("#chat .messages .msg[data-type=message] .content")].map((el) => el.textContent.trim())`;

export default async function run(page) {
	const ircd = startTinyIrcd({
		port: IRCD_PORT,
		caps: "batch server-time message-tags draft/chathistory",
		isupport: "CHATHISTORY=100 MSGREFTYPES=timestamp,msgid",
		onLine: script,
	});

	try {
		await page.goto(page.url, {waitForSelector: "#connect form"});
		await page.evaluate(
			`document.querySelector("#connect button[type=submit]").scrollIntoView({block: "center"})`
		);
		await page.click("#connect button[type=submit]");
		await page.waitFor(`document.querySelector('.channel-list-item[data-name="${CHAN}"]')`, {
			label: "joined",
		});
		await page.waitFor(`${texts}.includes("held three")`, {label: "history shown"});

		// Away in the lobby, so what the catch-up brings is unread.
		await page.click('.channel-list-item[data-type="lobby"] .lobby-title .name');
		await page.waitFor(
			`document.querySelector('.channel-list-item[data-type="lobby"].active')`,
			{
				label: "lobby open",
			}
		);

		ircd.drop();

		const row = `.channel-list-item[data-name="${CHAN}"]`;
		// The catch-up has been answered; a moment for the page to take it in.
		await caughtUp;
		await page.sleep(500);
		await page.click(row);
		await page.waitFor(`${texts}.includes("gap one")`, {label: "gap shown"});

		// 1
		const order = await page.evaluate(texts);
		page.check(
			`1. held, gap, then live (${order.join(" | ")})`,
			JSON.stringify(order) ===
				JSON.stringify(["held one", "held two", "held three", "gap one", "gap two", LIVE])
		);

		// 2
		const below = await page.evaluate(`(() => {
			const marker = document.querySelector("#chat .unread-marker");
			if (!marker) return null;
			const rows = [];
			for (let el = marker.nextElementSibling; el; el = el.nextElementSibling) {
				const text = el.querySelector?.(".content")?.textContent.trim();
				if (el.matches(".msg[data-type=message]") && text) rows.push(text);
			}
			return rows;
		})()`);
		page.check(
			`2. marker above the gap (${JSON.stringify(below)})`,
			JSON.stringify(below) === JSON.stringify(["gap one", "gap two", LIVE])
		);
		await page.screenshot("gap-order");

		// 3
		page.check("3. no console errors", page.consoleErrors.length === 0);
	} finally {
		await ircd.close();
	}
}
