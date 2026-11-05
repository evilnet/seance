// A chat left for a page that does not show it (Settings, Connect, ...) is no
// longer being read: a line there counts as unread and a mention reaches the
// inbox. Going back reads it. In the chat itself nothing is counted.
//
//   tools/nefarious-dev/run.sh -d
//   pnpm build && python3 -m http.server -d public 8000 &
//   node tools/browser-drive.mjs tools/scenarios/left-chat-unread.mjs --no-ws

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const BASE = process.env.SEANCE_HTTP ?? "http://localhost:8000/";
const CHANNEL = "#seance";
const NICK = "left" + Math.floor(Math.random() * 1000);

export const url = `${BASE}?host=localhost&port=8443&tls=true&nick=${NICK}&join=%23seance`;

function secondUser() {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket("wss://localhost:8443/", ["text.ircv3.net"]);

		ws.onopen = () => {
			ws.send(`NICK ${NICK}b`);
			ws.send("USER a 0 * :a");
		};

		ws.onerror = () => reject(new Error("second user's connection failed"));

		ws.onmessage = (event) => {
			const line = String(event.data);

			if (line.startsWith("PING")) {
				ws.send(line.replace("PING", "PONG"));
			}

			if (/ 001 /.test(line)) {
				ws.send(`JOIN ${CHANNEL}`);
				setTimeout(
					() =>
						resolve({
							say: (text) => ws.send(`PRIVMSG ${CHANNEL} :${text}`),
							close: () => ws.close(),
						}),
					2500
				);
			}
		};
	});
}

const row = `document.querySelector('.channel-list-item[data-name="${CHANNEL}"]')`;

export default async function run(page) {
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(`document.querySelector("#connect form button[type=submit]").click()`);
	await page.waitFor(row, {timeout: 20000, what: "joined"});
	await page.sleep(800);
	await page.evaluate(`${row}.click()`);
	await page.sleep(500);

	const label = () => page.evaluate(`${row}.getAttribute("aria-label")`);
	const other = await secondUser();

	other.say(`${NICK}: while you look`);
	await page.sleep(1500);
	page.check(`read in the chat: no unread (${await label()})`, !/unread/.test(await label()));

	for (const hash of ["#/settings/appearance", "#/connect"]) {
		await page.evaluate(`${row}.click()`);
		await page.sleep(500);
		await page.evaluate(`location.hash = ${JSON.stringify(hash)}`);
		await page.sleep(500);

		other.say(`${NICK}: while you are away on ${hash}`);
		await page.sleep(2500);
		const away = await label();
		page.check(`on ${hash}: a mention is unread (${away})`, /1 mention/.test(away));

		await page.evaluate(`${row}.click()`);
		await page.sleep(800);
		const back = await label();
		page.check(`back in the chat: read (${back})`, !/unread|mention/.test(back));
	}

	other.close();

	const errors = page.consoleErrors.map((e) => `${e.type}: ${e.text}`);
	page.check(
		`no console errors${errors.length ? ` (${errors.join(" | ")})` : ""}`,
		errors.length === 0
	);
}
