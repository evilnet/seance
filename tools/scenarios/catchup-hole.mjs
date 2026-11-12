// A reconnect's catch-up places a line missed between two held lines among
// them by server time, not below the newer one (history.ts `placeByTime`,
// #292), with a fractional row id the DOM side reads like any other.
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   node tools/browser-drive.mjs tools/scenarios/catchup-hole.mjs
//
// No ircd needed: lib/tiny-ircd.mjs is scripted to answer CHATHISTORY.
//
// The page joins #hole and holds two lines; while the socket is cut, the
// catch-up's page brings a line stamped between them and one after both.
//
// Claims:
//   1. #hole reads held one, hole, held two, after;
//   2. the hole's row id lies strictly between its neighbours' ids;
//   3. the unread marker is shown, with the hole and "after" below it (the
//      held lines are below it too: the IRC side's marker does not follow
//      lines read while the channel is open, on develop as well);
//   4. scrolling to the top and back marks nothing wrongly and throws nothing;
//   5. no console errors.

import {startTinyIrcd} from "./lib/tiny-ircd.mjs";

const PORT = process.env.SEANCE_PORT ?? "8000";
const IRCD_PORT = 9874;
const NICK = `hole${Date.now().toString(36).slice(-5)}`;
const CHAN = "#hole";

export const url = `http://localhost:${PORT}/?host=127.0.0.1&port=${IRCD_PORT}&tls=false&nick=${NICK}&join=${encodeURIComponent(
	CHAN
)}`;
export const allowWsFrameErrors = /after close/;

const T0 = Date.now();
const at = (minutes) => new Date(T0 + minutes * 60_000).toISOString();
const say = (time, msgid, text) =>
	`@time=${time};msgid=${msgid} :bob!b@tiny PRIVMSG ${CHAN} :${text}`;

// Stamped once the join is in: held lines said live while the channel is
// open (read), a hole stamped between them, and a line newer than both.
let T1 = 0;
const sec = (s) => new Date(T1 + s * 1000).toISOString();
const held = () => [say(sec(1), "h1", "held one"), say(sec(3), "h2", "held two")];
const hole = () => say(sec(2), "x", "hole");
const after = () => say(sec(5), "a", "after");

let joins = 0;
let liveSend = () => {};
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
		liveSend = send;
		send(`@time=${new Date().toISOString()};msgid=j${joins} :${nick}!u@tiny JOIN ${CHAN}`);
		send(`:tiny.test 353 ${nick} = ${CHAN} :${nick} bob`);
		send(`:tiny.test 366 ${nick} ${CHAN} :End of /NAMES list.`);
		return true;
	}

	if (cmd === "CHATHISTORY" && args[0] === "LATEST") {
		if (joins === 1) {
			chathistory(send, [], true);
		} else {
			const [h1, h2] = held();
			chathistory(send, [h1, hole(), h2, after()]);
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
		// Said live while #hole is open: read.
		T1 = Date.now();
		for (const line of held()) liveSend(line);
		await page.waitFor(`${texts}.includes("held two")`, {label: "held lines shown"});
		await page.sleep(300);

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
		await caughtUp;
		await page.sleep(500);
		await page.click(row);
		await page.waitFor(`${texts}.includes("after")`, {label: "catch-up shown"});

		// 1
		const order = await page.evaluate(texts);
		page.check(
			`1. time order (${order.join(" | ")})`,
			JSON.stringify(order) === JSON.stringify(["held one", "hole", "held two", "after"])
		);

		// 2
		const ids = await page.evaluate(
			`[...document.querySelectorAll("#chat .messages .msg[data-type=message]")].map((el) => [el.querySelector(".content")?.textContent.trim(), el.dataset.id ?? el.id])`
		);
		const num = (s) => Number(String(s).replace(/^msg-/, ""));
		const idOf = (text) => num(ids.find((r) => r[0] === text)?.[1]);
		const [a, b, c] = ["held one", "hole", "held two"].map(idOf);
		page.check(`2. hole id between its neighbours (${JSON.stringify(ids)})`, a < b && b < c);

		// 3
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
			`3. marker shown, the hole and "after" below it (${JSON.stringify(below)})`,
			Array.isArray(below) && below.includes("hole") && below.includes("after")
		);
		await page.screenshot("catchup-hole");

		// 4
		await page.evaluate(
			`document.querySelector("#chat .messages")?.closest(".chat")?.scrollTo?.(0, 0)`
		);
		await page.sleep(300);
		await page.evaluate(
			`(() => { const el = document.querySelector("#chat .chat"); if (el) el.scrollTop = el.scrollHeight; })()`
		);
		await page.sleep(500);
		page.check("4. scrolling throws nothing", page.consoleErrors.length === 0);

		// 5
		page.check("5. no console errors", page.consoleErrors.length === 0);
	} finally {
		await ircd.close();
	}
}
