// `/who` end to end in a real browser: the reply renders as one table
// (`client/components/MessageTypes/who.vue`) in the channel, with a row per
// user, the status pills and the account column only when the server sent
// one (WHOX `a` field; the dev ircd has no services, so everyone is `0` and
// the column stays away). Screenshots under three themes.
//
//   corepack yarn build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/who-list.mjs
//   node tools/browser-drive.mjs tools/scenarios/who-list.mjs --mobile --width=390 --height=844

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // dev ircd's self-signed cert

const IRCD = process.env.SEANCE_IRC_WS ?? "wss://localhost:8443/";
const CHANNEL = "#seance";
const THEMES = ["coffee", "creama", "day"];
const MOBILE = process.argv.includes("--mobile");

export const url =
	"http://localhost:8000/?host=localhost&port=8443&tls=true&nick=whowatch&join=%23seance";

/** A second user on the dev ircd, away and voiced, so the table has pills. */
function extra(nick) {
	const ws = new WebSocket(IRCD, ["text.ircv3.net"]);
	let onJoin = () => {};
	const send = (line) => ws.send(line);

	ws.onopen = () => {
		send(`NICK ${nick}`);
		send(`USER ${nick} 0 * :Who Watcher's Friend`);
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
			send("AWAY :lunch");
		} else if (params[1] === "JOIN" && params[0].includes(nick)) {
			// First into an empty channel, so it is the op; voice itself too.
			send(`MODE ${CHANNEL} +v ${nick}`);
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
		quit: () => send("QUIT :done"),
	};
}

const TABLE = `document.querySelector("#chat .msg[data-type='who'] table.who-list")`;
const ROWS = `Array.from(document.querySelectorAll("#chat .msg[data-type='who'] table.who-list tbody tr")).map((tr) => ({
	nick: tr.querySelector(".who-nick")?.textContent.trim(),
	flags: Array.from(tr.querySelectorAll(".who-flag")).map((f) => f.textContent.trim()),
	host: tr.querySelector(".who-host")?.textContent.trim(),
	realname: tr.querySelector(".who-realname")?.textContent.trim(),
}))`;
const HEADERS = `Array.from(document.querySelectorAll("#chat .msg[data-type='who'] th")).map((th) => th.textContent.trim())`;

async function setTheme(page, name) {
	await page.click(`#footer button.settings`);
	await page.waitFor(`!!document.querySelector(".settings-menu button.appearance")`, {
		label: "settings open",
	});
	await page.click(`.settings-menu button.appearance`);
	await page.waitFor(`!!document.querySelector("#theme-select")`, {label: "the theme select"});
	await page.evaluate(
		`(() => {
			const el = document.querySelector("#theme-select");
			el.value = ${JSON.stringify(name)};
			el.dispatchEvent(new Event("change", {bubbles: true}));
		})()`
	);
	await page.sleep(500);
	// Settings is a modal over the whole app; Done returns to the channel it covered.
	await page.click(".settings-modal-done");
	await page.waitFor(`document.querySelector("#input")`, {label: "back in the channel"});
	await page.sleep(300);
}

export default async function run(page) {
	const friend = extra("whofriend");
	await friend.joined;

	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="${CHANNEL}"]')`, {
		label: "the channel row",
		timeout: 20000,
	});
	await page.click(`.channel-list-item[data-name="${CHANNEL}"]`);
	await page.waitFor(`document.querySelector("#input")`, {label: "the input box"});
	await page.sleep(2500); // the join burst and the catch-up

	await page.fill("#input", "/who");
	await page.evaluate(`document.querySelector("#form").requestSubmit()`);
	await page.waitFor(`!!${TABLE}`, {label: "the who table", timeout: 15000});
	await page.sleep(300);

	const headers = await page.evaluate(HEADERS);
	page.check(
		`headers are Nick, Status, User@host, Real name (no Account without services): ${headers.join(
			"|"
		)}`,
		headers.join("|") === "Nick|Status|User@host|Real name"
	);

	const rows = await page.evaluate(ROWS);
	const me = rows.find((r) => r.nick.endsWith("whowatch"));
	const them = rows.find((r) => r.nick.endsWith("whofriend"));
	page.check(`both users listed (${rows.length} rows)`, !!me && !!them);
	page.check(
		`the friend is away and voiced: ${JSON.stringify(them?.flags)}`,
		!!them && them.flags.includes("away") && them.flags.includes("+")
	);
	page.check(
		`the friend's real name: ${them?.realname}`,
		them?.realname === "Who Watcher's Friend"
	);
	page.check(`the friend's user@host has an @: ${them?.host}`, !!them && /@/.test(them.host));

	// The table may scroll inside its own box on a phone; the pane never does.
	const pane = await page.evaluate(
		`(() => { const el = document.querySelector("#chat .messages"); return {scroll: el.scrollWidth, client: el.clientWidth}; })()`
	);
	page.check(
		`the pane does not scroll sideways (${pane.scroll} <= ${pane.client})`,
		pane.scroll <= pane.client
	);

	if (!MOBILE) {
		// A desktop pane holds the table without a scrollbar of its own.
		const box = await page.evaluate(
			`(() => { const el = document.querySelector("#chat .msg[data-type='who'] .who-scroll"); return {scroll: el.scrollWidth, client: el.clientWidth}; })()`
		);
		page.check(
			`the table needs no scrollbar on a desktop pane (${box.scroll} <= ${box.client})`,
			box.scroll <= box.client
		);
	}

	await page.screenshot("1-who-coffee", {selector: "#chat"});

	// The footer's settings button is behind the sidebar on a phone.
	for (const name of MOBILE ? [] : THEMES.slice(1)) {
		await setTheme(page, name);
		page.check(
			`${name}: the table survived the theme switch`,
			await page.evaluate(`!!${TABLE}`)
		);
		await page.screenshot(`2-who-${name}`, {selector: "#chat"});
	}

	// An empty result is one error line, no table.
	await page.fill("#input", "/who nosuchnick_zz");
	await page.evaluate(`document.querySelector("#form").requestSubmit()`);
	await page.waitFor(
		`Array.from(document.querySelectorAll("#chat .msg[data-type='error']")).some((el) => el.textContent.includes("No one matched WHO nosuchnick_zz"))`,
		{label: "the empty-result line", timeout: 15000}
	);
	page.check(
		"still one table",
		(await page.evaluate(`document.querySelectorAll("#chat .msg[data-type='who']").length`)) ===
			1
	);

	friend.quit();
	page.check("no console errors", page.consoleErrors.length === 0);
}
