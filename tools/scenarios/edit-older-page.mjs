// An edit shown before its original: the original arrives later, in an older
// page of history loaded with the list scrolled up, and the edit then takes
// its place (IrcClient.settleLateOriginal, helpers/heldPages.ts: the store
// holds a page back while the list moves, and the edit waits for it).
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/edit-older-page.mjs
//
// A helper joins a fresh channel and stays (the channel's history lives
// while someone is in it), says an original line, 55 filler lines, then an
// edit of the original tagged +evilnet.github.io/edit. The page joins: the first page
// of history (50 lines) holds the edit and not its original. Scrolled to the
// top, "load more" brings the original in; only the edit may be left
// showing, where the original was, marked (edited). `SEANCE_PORT` serves
// the app from another port.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const PORT = process.env.SEANCE_PORT ?? "8000";
const RUN = Date.now().toString(36).slice(-5);
const CHANNEL = `#olderpage${RUN}`;
const FILLER = 55;

export const url = `http://localhost:${PORT}/?host=localhost&port=8443&tls=true&nick=older${RUN}&join=${encodeURIComponent(
	CHANNEL
)}`;

async function helper() {
	const ws = new WebSocket("ws://127.0.0.1:8067/", "text.ircv3.net");
	const lines = [];
	ws.addEventListener("message", (e) => {
		for (const l of String(e.data).split("\r\n").filter(Boolean)) {
			if (l.startsWith("PING")) ws.send(l.replace("PING", "PONG"));
			lines.push(l);
		}
	});
	await new Promise((r) => ws.addEventListener("open", r));
	ws.send("CAP REQ :message-tags echo-message server-time");
	ws.send("CAP END");
	ws.send(`NICK hp${RUN}`);
	ws.send("USER h 0 * :h");
	await new Promise((r) => setTimeout(r, 1500));
	ws.send(`JOIN ${CHANNEL}`);
	await new Promise((r) => setTimeout(r, 500));
	ws.send(`PRIVMSG ${CHANNEL} :original ${RUN} with a typo`);
	await new Promise((r) => setTimeout(r, 500));
	const echo = lines.find((l) => l.includes(`original ${RUN}`));
	const msgid = /msgid=([^; ]+)/.exec(echo ?? "")?.[1];

	for (let i = 0; i < FILLER; i++) {
		ws.send(`PRIVMSG ${CHANNEL} :filler ${i}`);
		await new Promise((r) => setTimeout(r, 30));
	}

	await new Promise((r) => setTimeout(r, 500));
	ws.send(`@+evilnet.github.io/edit=${msgid} PRIVMSG ${CHANNEL} :edited ${RUN}, typo fixed`);
	await new Promise((r) => setTimeout(r, 800));
	return {ws, msgid};
}

const ROWS = `Array.from(document.querySelectorAll("#chat .msg[data-type='message'] .content")).map((el) => el.textContent.trim())`;

export default async function run(page) {
	const {ws, msgid} = await helper();
	await page.check(`the helper's original has a msgid (${msgid})`, !!msgid);

	try {
		await page.goto(page.url, {waitForSelector: "#connect form"});
		await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
		await page.waitFor(`document.querySelector('.channel-list-item[data-name="${CHANNEL}"]')`, {
			timeout: 30000,
			label: "the channel in the sidebar",
		});
		await page.evaluate(
			`document.querySelector('.channel-list-item[data-name="${CHANNEL}"]').click()`
		);
		await page.waitFor(`(${ROWS}).some((t) => t.startsWith("edited ${RUN}"))`, {
			timeout: 15000,
			label: "the first page, with the edit",
		});
		let rows = await page.evaluate(ROWS);
		await page.check(
			`the first page holds the edit and not its original (${rows.length} rows)`,
			!rows.some((t) => t.startsWith(`original ${RUN}`))
		);

		// Scroll to the top: "load more" brings the older page, with the list
		// scrolled up, which is when the store holds the page back.
		await page.evaluate(`document.querySelector("#chat .chat").scrollTop = 0`);
		await page.sleep(300);
		await page.evaluate(`document.querySelector("#chat .show-more button")?.click()`);
		await page.waitFor(
			`document.querySelectorAll("#chat .msg[data-type='message']").length > ${rows.length}`,
			{
				timeout: 15000,
				label: "the older page",
			}
		);
		await page.sleep(800);

		rows = await page.evaluate(ROWS);
		const originals = rows.filter((t) => t.startsWith(`original ${RUN}`));
		const edits = rows.filter((t) => t.startsWith(`edited ${RUN}`));
		await page.check(
			`the original is not shown beside its edit (${originals.length})`,
			originals.length === 0
		);
		await page.check(
			`the edit is shown once, marked edited (${JSON.stringify(edits)})`,
			edits.length === 1 && edits[0].includes("(edited)")
		);
		const at = rows.findIndex((t) => t.startsWith(`edited ${RUN}`));
		const firstFiller = rows.findIndex((t) => t === "filler 0");
		await page.check(
			`…standing where the original was, before the filler (${at} < ${firstFiller})`,
			at !== -1 && firstFiller !== -1 && at < firstFiller
		);
		await page.screenshot("older-page");
		await page.check("no console errors", page.consoleErrors.length === 0);
	} finally {
		ws.close();
	}
}
