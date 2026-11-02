// A closed query stays closed in this device's other tabs
// (irc/closedQueries.ts, manager.ts's `storage` listener).
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/query-close-sync.mjs
//
// The dev ircd has no accounts, so the account's other devices (the
// `seance/closed` metadata key) are covered by test/irc/closedQueries.ts
// only. Here one page stands in for two tabs: another tab's close is its
// write of `thelounge.state.closedQueries` plus the StorageEvent the browser
// would fire in this one. The checks:
//  - a query a helper's message opened (never looked at) goes when another
//    tab closes that conversation;
//  - one the user opened stays;
//  - a message after the close opens it again;
//  - closing a query here writes its tombstone where the other tabs read it.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // dev ircd's self-signed cert

const IRCD = process.env.SEANCE_IRC_WS ?? "wss://localhost:8443/";
const PORT = process.env.SEANCE_PORT ?? "8000";
const RUN = Date.now().toString(36).slice(-5);
const ME = `qw${RUN}`;
const TALKER = `qt${RUN}`;
const OTHER = `qo${RUN}`;
const KEY = "thelounge.state.closedQueries";

export const url = `http://localhost:${PORT}/?host=localhost&port=8443&tls=true&nick=${ME}&join=%23seance`;

function speaker(nick) {
	const ws = new WebSocket(IRCD, ["text.ircv3.net"]);
	let onReady = () => {};

	ws.onopen = () => {
		ws.send(`NICK ${nick}`);
		ws.send(`USER ${nick} 0 * :seance closed query`);
	};

	ws.onmessage = (ev) => {
		const line = String(ev.data);

		if (line.startsWith("PING")) {
			ws.send(`PONG${line.slice(4)}`);
			return;
		}

		const params = (line.startsWith("@") ? line.slice(line.indexOf(" ") + 1) : line).split(" ");

		if (params[1] === "001") {
			onReady();
		}
	};

	return {
		ready: new Promise((resolve, reject) => {
			onReady = resolve;
			ws.onerror = (e) => reject(new Error(String(e.message ?? e)));
			setTimeout(() => reject(new Error(`${nick} never registered`)), 20000);
		}),
		say: (to, text) => ws.send(`PRIVMSG ${to} :${text}`),
		quit: () => ws.send("QUIT :done"),
	};
}

const ROW = (nick) => `.channel-list-item[data-type="query"][data-name="${nick}"]`;
const HAS = (nick) => `!!document.querySelector('${ROW(nick)}')`;
const STORE = `document.querySelector("[data-v-app]").__vue_app__.config.globalProperties.$store`;

/** Another tab's close of `nick` at `at` (ms), as this tab would hear it. */
const otherTabCloses = (nick, at) => `(() => {
	const uuid = ${STORE}.state.networks[0].uuid;
	const all = JSON.parse(localStorage.getItem(${JSON.stringify(KEY)}) || "{}");
	all[uuid] = [{nick: ${JSON.stringify(
		nick
	)}.toLowerCase(), at: ${at}, when: ${at}}, ...(all[uuid] || [])];
	const value = JSON.stringify(all);
	localStorage.setItem(${JSON.stringify(KEY)}, value);
	window.dispatchEvent(new StorageEvent("storage", {key: ${JSON.stringify(KEY)}, newValue: value}));
})()`;

export default async function run(page) {
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="#seance"]')`, {
		timeout: 30000,
		label: "#seance in the sidebar",
	});
	await page.sleep(1500);

	const talker = speaker(TALKER);
	const other = speaker(OTHER);
	await Promise.all([talker.ready, other.ready]);

	// A query this tab opened by itself, and one the user opens.
	talker.say(ME, `hello ${RUN}`);
	other.say(ME, `hi ${RUN}`);
	await page.waitFor(`${HAS(TALKER)} && ${HAS(OTHER)}`, {
		timeout: 10000,
		label: "both query rows",
	});
	await page.click(ROW(OTHER));
	await page.sleep(500);
	await page.screenshot("1-two-queries", {selector: "#sidebar"});

	// Another tab closes both, a little after their lines.
	const at = Date.now() + 2000;
	await page.evaluate(otherTabCloses(TALKER, at));
	await page.evaluate(otherTabCloses(OTHER, at));
	await page.sleep(500);
	await page.check(
		"the query this tab opened by itself goes",
		!(await page.evaluate(HAS(TALKER)))
	);
	await page.check("the query the user opened stays", await page.evaluate(HAS(OTHER)));
	await page.screenshot("2-after-other-tab", {selector: "#sidebar"});

	// A message after the close opens it again.
	await page.sleep(2500);
	talker.say(ME, `again ${RUN}`);
	await page.waitFor(HAS(TALKER), {timeout: 10000, label: "the query back after a new line"});
	await page.check("a line after the close opens it again", await page.evaluate(HAS(TALKER)));

	// Closing here writes the tombstone the other tabs read.
	await page.click(ROW(TALKER));
	await page.waitFor(`document.querySelector("#input")`, {label: "the input"});
	await page.fill("#input", "/close");
	await page.evaluate(`document.querySelector("#form").requestSubmit()`);
	await page.waitFor(`!${HAS(TALKER)}`, {timeout: 5000, label: "the query closed"});
	const stored = await page.evaluate(
		`JSON.stringify(JSON.parse(localStorage.getItem(${JSON.stringify(
			KEY
		)}) || "{}")[${STORE}.state.networks[0].uuid] || [])`
	);
	await page.check(
		`closing here leaves its tombstone (${stored})`,
		JSON.parse(stored).some((e) => e.nick === TALKER.toLowerCase() && e.at > at)
	);

	talker.quit();
	other.quit();
	await page.check("no console errors", page.consoleErrors.length === 0);
}
