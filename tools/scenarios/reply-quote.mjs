// The reply quote renders the parent's formatting — bold stays bold, a code
// span monospace — with the markers and control codes gone, and so does the
// composer's "Replying to" bar.
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/reply-quote.mjs
//
// A second user says a line full of markdown and mIRC codes; the page replies
// to it through the toolbar's reply button. The bar and the `.msg-reply-text`
// of the reply must read as the plain line, carry neither `**` nor a control
// byte, and hold the same `irc-*` styled spans the parent row does.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // dev ircd's self-signed cert

const IRCD = process.env.SEANCE_IRC_WS ?? "wss://localhost:8443/";
const CHANNEL = "#seance";
const TALKER = "quotetalk";
const RUN = Date.now().toString(36);

export const url =
	"http://localhost:8000/?host=localhost&port=8443&tls=true&nick=quotewatch&join=%23seance";

/** What the talker says: IRC bold, markdown strong, code, a colour, strike. */
const PARENT = `\x02bold\x02 **strong** \`code\` \x0304red\x03 ~~gone~~ ${RUN}`;
const PLAIN = `bold strong code red gone ${RUN}`;
/** The styled runs a rendering of PARENT holds: `<text>:<classes>` each. */
const EXPECTED_STYLES =
	"bold:irc-bold strong:irc-bold code:irc-monospace red:irc-fg4 gone:irc-strikethrough";

/** JS for the styled runs under the element `root` (a JS expression). */
const STYLES = (root) =>
	`Array.from((${root}).querySelectorAll("span[class*='irc-']")).map((el) => el.textContent.trim() + ":" + el.className).join(" ")`;

/** A second user on the same network. */
function speaker(nick) {
	const ws = new WebSocket(IRCD, ["text.ircv3.net"]);
	let onJoin = () => {};

	ws.onopen = () => {
		ws.send(`NICK ${nick}`);
		ws.send(`USER ${nick} 0 * :seance reply quote`);
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

export default async function run(page) {
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="${CHANNEL}"]')`, {
		timeout: 30000,
		label: `${CHANNEL} in the sidebar`,
	});
	await page.click(`.channel-list-item[data-name="${CHANNEL}"]`);
	await page.waitFor(`document.querySelector("#input")`, {label: "the input box"});
	await page.sleep(2500); // let the join burst and the catch-up settle

	const talker = speaker(TALKER);
	await talker.joined;
	talker.say(PARENT);

	const PARENT_ROW = `Array.from(document.querySelectorAll("#chat .msg")).find((m) => m.querySelector(".content")?.textContent.includes(${JSON.stringify(
		RUN
	)}))`;
	await page.waitFor(`${PARENT_ROW} !== undefined`, {timeout: 10000, label: "the parent line"});
	await page.sleep(300);
	const parentId = await page.evaluate(`${PARENT_ROW}.id`);

	// The parent itself renders the formatting (bold, code…), so its visible
	// text is already the plain one: that is what the quote must repeat.
	const parentText = await page.evaluate(
		`document.querySelector("#${parentId} .content").textContent.replace(/\\s+/g, " ").trim()`
	);
	await page.check(`the parent renders as "${parentText}"`, parentText === PLAIN);

	// Reply through the toolbar, then send.
	await page.hover(`#${parentId} .content`);
	await page.sleep(100);
	await page.click(`#${parentId} .msg-action-reply`);
	await page.waitFor(`document.querySelector("#form .compose-bar")`, {label: "the reply bar"});
	const barText = await page.evaluate(
		`document.querySelector("#form .compose-bar-preview").textContent.replace(/\\s+/g, " ").trim()`
	);
	await page.check(`the compose bar previews the plain text ("${barText}")`, barText === PLAIN);
	const barStyles = await page.evaluate(
		STYLES(`document.querySelector("#form .compose-bar-preview")`)
	);
	await page.check(
		`the compose bar keeps the styles (${barStyles})`,
		barStyles === EXPECTED_STYLES
	);
	await page.screenshot("1-compose-bar", {selector: "#form", pad: 20});
	await page.fill("#input", `a reply ${RUN}`);
	await page.evaluate(`document.querySelector("#form").requestSubmit()`);

	const QUOTE = `Array.from(document.querySelectorAll("#chat .msg:not(.pending) .msg-reply-quote")).find((q) => q.closest(".msg").textContent.includes("a reply ${RUN}"))`;
	await page.waitFor(`${QUOTE} !== undefined`, {timeout: 10000, label: "the echoed reply"});
	const quoteText = await page.evaluate(
		`${QUOTE}.querySelector(".msg-reply-text").textContent.replace(/\\s+/g, " ").trim()`
	);
	const quoteNick = await page.evaluate(`${QUOTE}.querySelector(".msg-reply-nick").textContent`);

	await page.check(`the quote names the parent's nick (${quoteNick})`, quoteNick === TALKER);
	await page.check(`the quote is the parent's plain text ("${quoteText}")`, quoteText === PLAIN);
	await page.check(
		"no markdown marker or control byte survives in the quote",
		!/[*`~\x02\x03\x1d\x1f\x0f]/.test(quoteText)
	);
	const quoteStyles = await page.evaluate(STYLES(`${QUOTE}.querySelector(".msg-reply-text")`));
	await page.check(
		`the quote keeps the styles (${quoteStyles})`,
		quoteStyles === EXPECTED_STYLES
	);
	const title = await page.evaluate(`${QUOTE}.getAttribute("title")`);
	await page.check("the tooltip carries the same plain text", title === PLAIN);

	const replyId = await page.evaluate(`${QUOTE}.closest(".msg").id`);
	await page.screenshot("2-reply-quote", {selector: `#${replyId}`, pad: 40});

	talker.quit();
	await page.check("no console errors", page.consoleErrors.length === 0);
}
