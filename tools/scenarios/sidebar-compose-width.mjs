// The sidebar keeps its width while the composer grows a row: the reply bar
// (Reply on a message) and the "alice is typing…" strip. Before #275 the
// chat grew from its content, and in a window too narrow for that content
// beside the sidebar the overflow came out of the sidebar: at 900px it went
// from 220px to 159px on Reply and to 147px once someone was typing.
//
// No ircd needed: lib/tiny-ircd.mjs offers message-tags, answers the JOIN
// with lines that carry msgids, and sends the typing notice when asked.
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   node tools/browser-drive.mjs tools/scenarios/sidebar-compose-width.mjs
//
// `SEANCE_PORT` serves the app from another port.

import {startTinyIrcd} from "./lib/tiny-ircd.mjs";

const PORT = process.env.SEANCE_PORT ?? "8000";
const IRCD_PORT = 9881;
const CHANNEL = "#width";
const LONG = "a long line that goes on ".repeat(30);

export const url = `http://localhost:${PORT}/?host=127.0.0.1&port=${IRCD_PORT}&tls=false&nick=wide&join=${encodeURIComponent(
	CHANNEL
)}`;

const SIDEBAR_WIDTH = `document.querySelector("#sidebar").getBoundingClientRect().width`;

export default async function run(page) {
	let push = () => {};
	const ircd = startTinyIrcd({
		port: IRCD_PORT,
		caps: "message-tags",
		onLine(line, {send, nick}) {
			push = send;

			if (!line.startsWith("JOIN ")) {
				return false;
			}

			send(`:${nick}!u@tiny JOIN ${CHANNEL}`);
			send(`:tiny.test 353 ${nick} = ${CHANNEL} :${nick} alice`);
			send(`:tiny.test 366 ${nick} ${CHANNEL} :End of /NAMES list.`);

			for (let i = 1; i <= 5; i++) {
				send(`@msgid=line${i} :alice!a@tiny PRIVMSG ${CHANNEL} :line ${i} ${LONG}`);
			}

			return true;
		},
	});

	try {
		for (const width of [900, 1280]) {
			await page.send("Emulation.setDeviceMetricsOverride", {
				width,
				height: 800,
				deviceScaleFactor: 1,
				mobile: false,
			});
			await page.goto(page.url, {waitForSelector: "body"});
			await page.evaluate(`localStorage.clear()`);
			await page.goto(page.url, {waitForSelector: "#connect form"});
			await page.click('#connect button[type="submit"]');
			await page.waitFor(`document.querySelectorAll("#chat .msg").length >= 5`, {
				timeout: 20000,
				label: "scrollback",
			});
			await page.sleep(800);
			const before = await page.evaluate(SIDEBAR_WIDTH);

			await page.hover("#chat .msg:last-child");
			await page.sleep(300);
			await page.click("#chat .msg:last-child .msg-action-reply");
			await page.waitFor(`document.querySelector("#form .compose-bar")`, {
				label: "reply bar",
			});
			await page.sleep(400);
			const replying = await page.evaluate(SIDEBAR_WIDTH);
			await page.screenshot(`replying-${width}`);
			page.check(
				`${width}px: the sidebar keeps its width with the reply bar up (${before} → ${replying})`,
				replying === before
			);

			push(`@+typing=active :alice!a@tiny TAGMSG ${CHANNEL}`);
			await page.waitFor(
				`document.querySelector("#form .typing-indicator")?.textContent.trim()`,
				{label: "typing"}
			);
			await page.sleep(400);
			const typing = await page.evaluate(SIDEBAR_WIDTH);
			await page.screenshot(`typing-${width}`);
			page.check(
				`${width}px: the sidebar keeps its width while alice types (${before} → ${typing})`,
				typing === before
			);
		}

		page.check("no console errors", page.consoleErrors.length === 0);
	} finally {
		await ircd.close();
	}
}
