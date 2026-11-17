// Every window's lines are kept on the device and are there at once after a
// reload, before or without a connection; the reconnect then merges the
// server's history in by msgid and says where it could not
// (irc/conversationStore.ts, docs/projects/conversation-store.md).
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   node tools/browser-drive.mjs tools/scenarios/conversation-store.mjs
//
// No ircd needed: lib/tiny-ircd.mjs is scripted to answer CHATHISTORY.
//
// The page joins #store, sees 130 channel lines and a private message, and
// is reloaded while the server refuses the socket. The server then comes
// back with newer lines its history pages do not join up with.
//
// Claims:
//   1. the lines reach IndexedDB, channel and private alike;
//   2. reloaded with the socket refused, the channel shows its newest 100
//      lines and the private chat its line, each once;
//   3. still offline, "show older" brings the 30 older lines from the device;
//   4. the server back, its newer lines follow the kept ones, the JOIN adds
//      no "joined" row, and a divider marks the gap the catch-up left;
//   5. the divider's control loads the missing line into place and the
//      divider goes;
//   6. another reload shows the same, the loaded line included, no divider;
//   7. the setting off empties IndexedDB, and a reload restores nothing;
//   8. no console errors.

import {KEPT, chathistory, coldLoad} from "./lib/kept.mjs";
import {startTinyIrcd} from "./lib/tiny-ircd.mjs";

const PORT = process.env.SEANCE_PORT ?? "8000";
const IRCD_PORT = 9879;
const NICK = `keep${Date.now().toString(36).slice(-5)}`;
const CHAN = "#store";

export const url = `http://localhost:${PORT}/?host=127.0.0.1&port=${IRCD_PORT}&tls=false&nick=${NICK}&join=${encodeURIComponent(
	CHAN
)}`;
export const allowWsFrameErrors = /after close|ERR_CONNECTION_REFUSED/;

const T0 = Date.now() - 3_600_000;
const at = (seconds) => new Date(T0 + seconds * 1000).toISOString();
const say = (seconds, msgid, text, target = CHAN) =>
	`@time=${at(seconds)};msgid=${msgid} :bob!b@tiny PRIVMSG ${target} :${text}`;

let joins = 0;
let liveSend = () => {};
let caughtUp = () => {};
const walked = new Promise((resolve) => {
	caughtUp = resolve;
});

function script(line, {send, nick}) {
	const [cmd, ...args] = line.replace(/^@\S+ /, "").split(" ");

	if (cmd === "JOIN") {
		joins++;
		liveSend = send;
		send(`@time=${at(joins === 1 ? 0 : 1900)};msgid=j${joins} :${nick}!u@tiny JOIN ${CHAN}`);
		send(`:tiny.test 353 ${nick} = ${CHAN} :${nick} bob`);
		send(`:tiny.test 366 ${nick} ${CHAN} :End of /NAMES list.`);
		return true;
	}

	if (cmd === "CHATHISTORY" && args[0] === "LATEST") {
		if (joins === 1) {
			chathistory(send, CHAN, [], true);
		} else {
			// Newer than everything kept, and not reaching it.
			chathistory(send, CHAN, [say(2002, "n2", "new two"), say(2003, "n3", "new three")]);
		}

		return true;
	}

	if (cmd === "CHATHISTORY" && args[0] === "BEFORE") {
		if (args[2] === "msgid=n2" && args[3] !== undefined && !script.filling) {
			// The walk's next page: the server's scan cut it to nothing.
			script.filling = true;
			chathistory(send, CHAN, []);
			caughtUp();
		} else if (args[2] === "msgid=n2") {
			// The divider's control: the missing line, and one the page holds.
			chathistory(send, CHAN, [say(130, "m130", "line 130"), say(2001, "n1", "new one")]);
		} else {
			chathistory(send, CHAN, [], true);
		}

		return true;
	}

	return cmd === "MODE" || cmd === "WHO";
}

const item = (name) => `.channel-list-item[data-name="${name}"]`;
const TEXTS = `[...document.querySelectorAll("#chat .messages .msg[data-type=message] .content")].map((el) => el.textContent.trim())`;
export default async function run(page) {
	const start = () =>
		startTinyIrcd({
			port: IRCD_PORT,
			caps: "batch server-time message-tags draft/chathistory",
			isupport: "CHATHISTORY=100 MSGREFTYPES=timestamp,msgid",
			onLine: script,
		});
	let ircd = start();

	try {
		await page.goto(page.url, {waitForSelector: "#connect form"});
		await page.click('#connect input[name="autoconnect"]');
		await page.evaluate(
			`document.querySelector("#connect button[type=submit]").scrollIntoView({block: "center"})`
		);
		await page.click("#connect button[type=submit]");
		await page.waitFor(`document.querySelector('${item(CHAN)}')`, {label: "joined"});
		await page.sleep(500);

		for (let i = 1; i <= 129; i++) {
			liveSend(say(i, `m${i}`, `line ${i}`));
		}

		liveSend(say(131, "m131", "line 131"));
		liveSend(say(132, "p1", "a private line", NICK));
		await page.waitFor(`${TEXTS}.includes("line 131")`, {label: "the channel lines shown"});
		await page.waitFor(`document.querySelector('${item("bob")}')`, {label: "the query window"});
		await page.sleep(800); // past the write throttle

		// 1
		const kept = await page.evaluate(KEPT);
		page.check(
			`1. the lines are in IndexedDB (${Object.entries(kept ?? {})
				.map(([k, v]) => `${k}: ${v.length}`)
				.join(", ")})`,
			(kept?.[CHAN]?.filter((t) => /^line \d+$/.test(t ?? "")).length ?? 0) === 130 &&
				(kept?.bob ?? []).includes("a private line")
		);

		// 2: the server is gone when the page comes back.
		await ircd.close();
		await coldLoad(page, `document.querySelector('${item(CHAN)}')`);
		await page.click(item(CHAN));
		await page.waitFor(`${TEXTS}.includes("line 131")`, {
			timeout: 5000,
			label: "the channel's lines, with no connection",
		});
		let texts = await page.evaluate(TEXTS);
		page.check(
			`2. offline, the channel shows its newest 100 lines once each (${texts.length}, from "${texts[0]}")`,
			texts.length === 100 && texts[0] === "line 31" && new Set(texts).size === 100
		);
		await page.click(item("bob"));
		await page.waitFor(`${TEXTS}.includes("a private line")`, {
			timeout: 5000,
			label: "the private line, with no connection",
		});
		page.check(
			"2. and the private chat its line",
			(await page.evaluate(TEXTS)).filter((t) => t === "a private line").length === 1
		);
		await page.screenshot("1-offline-restore");

		// 3
		await page.click(item(CHAN));
		await page.waitFor(`${TEXTS}.includes("line 131")`, {label: "the channel open"});
		await page.evaluate(`document.querySelector("#chat .chat")?.scrollTo(0, 0)`);
		await page.sleep(300);
		await page.evaluate(`document.querySelector("#chat .show-more button")?.click()`);
		await page.waitFor(`${TEXTS}.includes("line 1")`, {
			timeout: 5000,
			label: "older lines from the device",
		});
		texts = await page.evaluate(TEXTS);
		page.check(
			`3. offline, show older brings the older lines from the device (${texts.length}, from "${texts[0]}")`,
			texts.length === 130 && texts[0] === "line 1" && new Set(texts).size === 130
		);

		// 4: the server is back.
		ircd = start();
		await walked;
		await page.waitFor(`${TEXTS}.includes("new three")`, {
			timeout: 30000,
			label: "the catch-up's lines",
		});
		await page.sleep(500);
		texts = await page.evaluate(TEXTS);
		const tail = texts.slice(-3);
		const joinRows = await page.evaluate(
			`document.querySelectorAll("#chat .messages .msg[data-type=join]").length`
		);
		const divider = await page.evaluate(`(() => {
			const el = document.querySelector("#chat .gap-marker");
			if (!el) return null;
			let next = el.nextElementSibling;
			while (next && !next.matches(".msg")) next = next.nextElementSibling;
			return {text: el.querySelector(".gap-marker-text")?.textContent.trim(), before: next?.querySelector(".content")?.textContent.trim()};
		})()`);
		page.check(
			`4. the new lines follow the kept ones (${tail.join(" | ")})`,
			JSON.stringify(tail) === JSON.stringify(["line 131", "new two", "new three"])
		);
		page.check(
			`4. the JOIN added no row beyond the first page's own (${joinRows})`,
			joinRows <= 1
		);
		page.check(
			`4. a divider marks the gap, above the first new line (${JSON.stringify(divider)})`,
			divider?.before === "new two" && !!divider?.text
		);
		await page.evaluate(
			`document.querySelector("#chat .gap-marker")?.scrollIntoView({block: "center"})`
		);
		await page.sleep(300);
		await page.screenshot("2-gap-marker");

		// 5
		await page.click("#chat .gap-marker .gap-marker-load");
		await page.waitFor(`${TEXTS}.includes("new one")`, {
			timeout: 10000,
			label: "the missing line",
		});
		await page.sleep(300);
		texts = await page.evaluate(TEXTS);
		page.check(
			`5. the missing lines are in place (${texts.slice(-5).join(" | ")})`,
			JSON.stringify(texts.slice(-5)) ===
				JSON.stringify(["line 130", "line 131", "new one", "new two", "new three"])
		);
		page.check(
			"5. and the divider is gone",
			(await page.evaluate(`document.querySelectorAll("#chat .gap-marker").length`)) === 0
		);
		await page.screenshot("3-gap-filled");
		await page.sleep(800);

		// 6
		await ircd.close();
		await coldLoad(page, `document.querySelector('${item(CHAN)}')`);
		await page.click(item(CHAN));
		await page.waitFor(`${TEXTS}.includes("new three")`, {
			timeout: 5000,
			label: "the lines after the second reload",
		});
		texts = await page.evaluate(TEXTS);
		page.check(
			`6. reloaded again: the same lines, in order (${texts.slice(-4).join(" | ")})`,
			JSON.stringify(texts.slice(-4)) ===
				JSON.stringify(["line 131", "new one", "new two", "new three"]) &&
				new Set(texts).size === texts.length
		);
		page.check(
			"6. and no divider",
			(await page.evaluate(`document.querySelectorAll("#chat .gap-marker").length`)) === 0
		);

		// 7
		await page.evaluate(`location.hash = "#/settings"`);
		await page.waitFor(`!!document.querySelector('input[name="keepPrivateConversations"]')`, {
			timeout: 10000,
			label: "the setting in Settings",
		});
		page.check(
			"7. the setting is on by default",
			await page.evaluate(
				`document.querySelector('input[name="keepPrivateConversations"]').checked`
			)
		);
		await page.evaluate(
			`(() => { const el = document.querySelector('input[name="keepPrivateConversations"]'); el.scrollIntoView({block: "center"}); el.click(); })()`
		);
		await page.sleep(800);
		const after = await page.evaluate(KEPT);
		page.check(
			`7. switched off, IndexedDB is empty (${JSON.stringify(Object.keys(after ?? {}))})`,
			Object.keys(after ?? {}).length === 0
		);
		await page.click(".settings-modal-done");
		await coldLoad(page, `document.querySelector('${item(CHAN)}')`);
		await page.click(item(CHAN));
		await page.sleep(800);
		page.check(
			"7. and a reload restores nothing",
			(await page.evaluate(TEXTS)).length === 0 && (await page.count(item("bob"))) === 0
		);

		// 8
		page.check(
			`8. no console errors (${page.consoleErrors.join(" | ")})`,
			page.consoleErrors.length === 0
		);
	} finally {
		await ircd.close();
	}
}
