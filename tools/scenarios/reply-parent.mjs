// A reply whose parent is not loaded fetches it: the quote reads the parent
// instead of "(unknown message)", and no row is added for it.
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/reply-parent.mjs
//
// A second user says two parents, then enough lines to push them off the first
// history page, and replies to both, one far enough up to be off screen. The
// page connects only then, so the replies are loaded and the parents are not.
// Only the quote on screen may ask; scrolling to the other one asks for it. The
// dev ircd's image has no fake lag for users, so the burst goes through.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // dev ircd's self-signed cert

const IRCD = process.env.SEANCE_IRC_WS ?? "wss://localhost:8443/";
const CHANNEL = "#seance";
const RUN = Date.now().toString(36);
const PUSHED_OFF_PAGE = 120;
const BELOW_THE_FAR_REPLY = 35;
const FAR_PARENT = `the far parent ${RUN}`;
const FAR_REPLY = `the far reply ${RUN}`;
const PARENT = `the parent ${RUN}`;
const REPLY = `the reply ${RUN}`;

export const url =
	"http://localhost:8000/?host=localhost&port=8443&tls=true&nick=parentwatch&join=%23seance";

/** Say the lines; resolves with the socket still open. */
function talk() {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(IRCD, ["text.ircv3.net"]);
		const say = (text, tags = "") => ws.send(`${tags}PRIVMSG ${CHANNEL} :${text}`);
		const filler = (count) => {
			for (let i = 0; i < count; i++) {
				say(`filler ${i} ${RUN}`);
			}
		};
		let farId;

		ws.onerror = (e) => reject(new Error(String(e.message ?? e)));
		ws.onopen = () => {
			ws.send("CAP REQ :echo-message message-tags");
			ws.send("CAP END");
			ws.send(`NICK parenttalk${RUN.slice(-4)}`);
			ws.send("USER parenttalk 0 * :seance reply parent");
		};
		ws.onmessage = (ev) => {
			const line = String(ev.data).trimEnd();
			const msgid = () => line.match(/msgid=([^; ]+)/)[1];

			if (line.startsWith("PING")) {
				ws.send(`PONG${line.slice(4)}`);
			} else if (/ 001 /.test(line)) {
				ws.send(`JOIN ${CHANNEL}`);
			} else if (/ 366 /.test(line)) {
				say(FAR_PARENT);
			} else if (line.endsWith(FAR_PARENT)) {
				farId = msgid();
				say(PARENT);
			} else if (line.endsWith(` :${PARENT}`)) {
				filler(PUSHED_OFF_PAGE);
				say(FAR_REPLY, `@+draft/reply=${farId} `);
				filler(BELOW_THE_FAR_REPLY);
				say(REPLY, `@+draft/reply=${msgid()} `);
			} else if (line.endsWith(REPLY) && !line.endsWith(FAR_REPLY)) {
				resolve(ws);
			}
		};
		setTimeout(() => reject(new Error("the talker never finished")), 60000);
	});
}

export default async function run(page) {
	const talker = await talk();

	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="${CHANNEL}"]')`, {
		timeout: 30000,
		label: `${CHANNEL} in the sidebar`,
	});
	await page.click(`.channel-list-item[data-name="${CHANNEL}"]`);

	const ROW = `Array.from(document.querySelectorAll("#chat .msg")).find((m) => m.textContent.includes(${JSON.stringify(
		REPLY
	)}))`;
	await page.waitFor(`${ROW} !== undefined`, {timeout: 20000, label: "the reply"});

	const rowsHolding = (text) =>
		`Array.from(document.querySelectorAll("#chat .msg .content")).filter((c) => !c.querySelector(".msg-reply-quote") && c.textContent.includes(${JSON.stringify(
			text
		)})).length`;

	await page.waitFor(`${ROW}.querySelector(".msg-reply-nick") !== null`, {
		timeout: 15000,
		label: "the quote to fill in",
	});

	const quote = await page.evaluate(
		`${ROW}.querySelector(".msg-reply-text").textContent.replace(/\\s+/g, " ").trim()`
	);
	const nick = await page.evaluate(`${ROW}.querySelector(".msg-reply-nick").textContent`);

	await page.check(`the quote reads the parent ("${quote}")`, quote === PARENT);
	await page.check(`the quote names its sender (${nick})`, nick.startsWith("parenttalk"));
	await page.check(
		"no row was added for the parent",
		(await page.evaluate(rowsHolding(PARENT))) === 0
	);
	await page.check(
		"the quote is not marked unknown",
		await page.evaluate(
			`!${ROW}.querySelector(".msg-reply-quote").classList.contains("unknown")`
		)
	);
	await page.screenshot("reply-parent", {selector: "#chat", pad: 0});

	const FAR = `Array.from(document.querySelectorAll("#chat .msg")).find((m) => m.textContent.includes(${JSON.stringify(
		FAR_REPLY
	)}))`;
	await page.check(
		"the quote off screen has not asked",
		await page.evaluate(
			`${FAR}.querySelector(".msg-reply-quote").classList.contains("unknown")`
		)
	);
	await page.evaluate(`${FAR}.scrollIntoView({block: "center"})`);
	await page.waitFor(`${FAR}.querySelector(".msg-reply-nick") !== null`, {
		timeout: 15000,
		label: "the far quote to fill in once on screen",
	});
	const far = await page.evaluate(
		`${FAR}.querySelector(".msg-reply-text").textContent.replace(/\\s+/g, " ").trim()`
	);
	await page.check(`scrolled to, it reads its parent ("${far}")`, far === FAR_PARENT);

	talker.send("QUIT :done");
}
