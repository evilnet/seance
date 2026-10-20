// Who plays an alert's sound on the web — in a real browser.
//
//   npx webpack && python3 -m http.server -d public 8005 &
//   node tools/browser-drive.mjs tools/scenarios/notification-sound.mjs
//
// Needs an ircd on ws://127.0.0.1:8067/ (no SASL, no webpush).
//
// Why (helpers/notificationSound.ts alertSound): a system notification
// carries its own sound, which the OS plays as an alert sound. A page's
// <audio> ping is media playback: on a Mac it takes the output, so AirPods
// hop over to the Mac for every ping, and on iOS it stops Music. So the
// page plays the ping only when there is no notification to carry it.
//
// Claims:
//   1. with notifications allowed, a PM shows a notification that is not
//      silent and the page plays nothing;
//   2. with the sound setting off, the notification is silent and the page
//      plays nothing;
//   3. without the permission, the page plays the ping and shows nothing;
//   4. no console errors.

const ORIGIN = process.env.SEANCE_URL ?? "http://127.0.0.1:8005";
const IRCD = process.env.SEANCE_IRC_WS ?? "ws://127.0.0.1:8067/";
const RUN = Date.now().toString(36);
const BOT = `nsbot${RUN.slice(-5)}`;
const NICK = `nspage${RUN.slice(-4)}`;
const UUID = "ns-" + Math.random().toString(36).slice(2, 10);

export const url = `${ORIGIN}/`;

const SAVED_NETWORK = {
	uuid: UUID,
	name: "Notification sound",
	host: "127.0.0.1",
	port: 8067,
	tls: false,
	nick: NICK,
	join: "",
	autoconnect: true,
};

/** Count the page's media plays: the ping is the only <audio> it plays. */
const COUNT_PLAYS = `(() => {
	window.__plays = 0;
	const play = HTMLMediaElement.prototype.play;
	HTMLMediaElement.prototype.play = function () {
		window.__plays++;
		return play.call(this);
	};
})();`;

/** Connect as the bot, PM `target` once, and leave once it is echoed. */
function sendPm(target, text) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(IRCD, ["text.ircv3.net"]);
		const send = (line) => ws.send(line);
		const fail = (why) => {
			reject(new Error(why));
			ws.close();
		};

		ws.onopen = () => {
			send("CAP LS 302");
			send(`NICK ${BOT}`);
			send(`USER ${BOT} 0 * :seance notification sound check`);
		};

		ws.onmessage = (ev) => {
			const line = String(ev.data);

			if (line.startsWith("PING")) {
				ws.send(`PONG${line.slice(4)}`);
				return;
			}

			const rest = line.startsWith("@") ? line.slice(line.indexOf(" ") + 1) : line;
			const params = rest.split(" ");

			if (params[1] === "CAP" && params[3] === "LS" && params[4] !== "*") {
				send("CAP REQ :message-tags server-time echo-message");
			} else if (params[1] === "CAP" && (params[3] === "ACK" || params[3] === "NAK")) {
				send("CAP END");
			} else if (params[1] === "001") {
				send(`PRIVMSG ${target} :${text}`);
			} else if (params[0].startsWith(`:${BOT}!`) && params[1] === "PRIVMSG") {
				send("QUIT :done");
				setTimeout(() => {
					ws.close();
					resolve();
				}, 200);
			} else if (/^4\d\d$/.test(params[1] ?? "") && params[1] !== "422") {
				fail(`the ircd answered ${line}`);
			}
		};

		ws.onerror = (e) => fail(`websocket error: ${e.message ?? e}`);
		setTimeout(() => fail("the bot timed out"), 20000);
	});
}

/** Every visible notification of every registration, with its silent flag. */
const NOTIFICATIONS = `(async () => {
	const out = [];
	for (const reg of await navigator.serviceWorker.getRegistrations()) {
		for (const n of await reg.getNotifications()) {
			out.push({tag: n.tag, body: n.body, silent: n.silent});
		}
	}
	return JSON.stringify(out);
})()`;

const SET_SOUND = (on) => `document.querySelector("#app").__vue_app__.config.globalProperties.$store
	.dispatch("settings/update", {name: "notification", value: ${on}, sync: true})
	.then(() => "ok")`;

export default async function run(page) {
	await page.grantPermissions(["notifications"], ORIGIN);
	await page.addInitScript(COUNT_PLAYS);
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(
		`localStorage.setItem("thelounge.networks", JSON.stringify([${JSON.stringify(
			SAVED_NETWORK
		)}]))`
	);
	await page.goto(page.url);
	await page.waitFor(
		`[...document.querySelectorAll(".lobby-nick")].some((e) => e.textContent.includes(${JSON.stringify(
			NICK
		)}))`,
		{label: "the page registered", timeout: 30000}
	);
	await page.waitFor(
		`navigator.serviceWorker.controller !== null || navigator.serviceWorker.ready.then(() => true)`,
		{label: "the service worker", timeout: 10000}
	);
	await page.sleep(1000);

	/** PM the page and wait for a notification with `text` (or none). */
	async function ping(text, expectNotification) {
		const before = Number(await page.evaluate("window.__plays"));
		await sendPm(NICK, text);
		let found;
		const deadline = Date.now() + (expectNotification ? 8000 : 3000);

		while (Date.now() < deadline) {
			const list = JSON.parse(await page.evaluate(NOTIFICATIONS));
			found = list.find((n) => n.body?.includes(text));

			if (found) {
				break;
			}

			await page.sleep(200);
		}

		await page.sleep(300);
		const plays = Number(await page.evaluate("window.__plays")) - before;
		return {found, plays};
	}

	// --- 1. allowed, sound on -------------------------------------------
	const one = await ping(`sound on ${RUN}`, true);
	page.check(`1. a notification is shown (${JSON.stringify(one.found)})`, Boolean(one.found));
	page.check(`1. it is not silent (silent=${one.found?.silent})`, one.found?.silent === false);
	page.check(`1. the page plays nothing (${one.plays} plays)`, one.plays === 0);

	// --- 2. allowed, sound off ------------------------------------------
	await page.evaluate(SET_SOUND(false));
	const two = await ping(`sound off ${RUN}`, true);
	page.check(`2. a notification is shown (${JSON.stringify(two.found)})`, Boolean(two.found));
	page.check(`2. it is silent (silent=${two.found?.silent})`, two.found?.silent === true);
	page.check(`2. the page plays nothing (${two.plays} plays)`, two.plays === 0);

	// --- 3. no permission ------------------------------------------------
	await page.evaluate(SET_SOUND(true));
	await page.evaluate(
		`Object.defineProperty(Notification, "permission", {configurable: true, get: () => "denied"}), "ok"`
	);
	const three = await ping(`no permission ${RUN}`, false);
	page.check(`3. no notification (${JSON.stringify(three.found)})`, !three.found);
	page.check(`3. the page plays the ping (${three.plays} plays)`, three.plays === 1);

	page.check(
		`4. no console errors (${page.consoleErrors.join(" | ")})`,
		page.consoleErrors.length === 0
	);
}
