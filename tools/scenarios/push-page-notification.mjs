// A live page's own notification for a push-enabled network lands on that
// network's push worker, in the push's shape — in a real browser.
//
//   npx webpack && python3 -m http.server -d public 8005 &
//   node tools/browser-drive.mjs tools/scenarios/push-page-notification.mjs
//
// Needs an ircd on ws://127.0.0.1:8067/ (no SASL, no webpush needed: the
// subscription is seeded through the faked Push API, lib/fake-push.mjs).
//
// Why (client/js/webpush.ts pushWorkerFor): Chrome counts visible
// notifications per service-worker registration. The server pushes an
// unattended session's messages to every subscribed device, the live page
// included; that page has the message already, so the push worker drops the
// duplicate (push-seen.ts). If the page's own notification sits on the root
// worker, that push leaves nothing visible on its registration, counts as
// silent, and Chrome ends up showing "This site has been updated in the
// background" — on a desktop, where the page keeps running in the
// background. So the page shows it through the push worker instead.
//
// Claims:
//   1. a PM from a bot shows as `push-<nick>` on `push/<uuid>/`, data kind
//      "push", the message's msgid in its messages, Mark read + Reply;
//   2. the root registration shows nothing for it (no second notification);
//   3. opening the query closes it (the server sends no read push for a
//      message it did not push, so the page closes what it put there);
//   4. no console errors.

import {FAKE_PUSH_API} from "./lib/fake-push.mjs";

const ORIGIN = process.env.SEANCE_URL ?? "http://127.0.0.1:8005";
const IRCD = process.env.SEANCE_IRC_WS ?? "ws://127.0.0.1:8067/";
const RUN = Date.now().toString(36);
const BOT = `pnbot${RUN.slice(-5)}`;
const NICK = `pnpage${RUN.slice(-4)}`;
const UUID = "pn-" + Math.random().toString(36).slice(2, 10);
const VAPID = "BPn" + "A".repeat(84);

export const url = `${ORIGIN}/`;

const SAVED_NETWORK = {
	uuid: UUID,
	name: "Page notification",
	host: "127.0.0.1",
	port: 8067,
	tls: false,
	nick: NICK,
	join: "",
	autoconnect: true,
};

/** Connect as the bot, PM `target` once, resolve with the echo's msgid. */
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
			send(`USER ${BOT} 0 * :seance page notification check`);
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
				const msgid = /(?:^@|;)msgid=([^; ]+)/.exec(line)?.[1];
				send("QUIT :done");
				setTimeout(() => {
					ws.close();
					resolve(msgid);
				}, 200);
			} else if (/^4\d\d$/.test(params[1] ?? "") && params[1] !== "422") {
				fail(`the ircd answered ${line}`);
			}
		};

		ws.onerror = (e) => fail(`websocket error: ${e.message ?? e}`);
		setTimeout(() => fail("the bot timed out"), 20000);
	});
}

/** The visible notifications of the registration at `scope`, as JSON. */
const NOTIFICATIONS = (scope) => `(async () => {
	const regs = await navigator.serviceWorker.getRegistrations();
	const reg = regs.find((r) => r.scope === ${JSON.stringify(scope)});
	if (!reg) return "no registration";
	const list = await reg.getNotifications();
	return JSON.stringify(list.map((n) => ({tag: n.tag, title: n.title, body: n.body, data: n.data, actions: (n.actions || []).map((a) => a.action)})));
})()`;

export default async function run(page) {
	const pushScope = `${ORIGIN}/push/${UUID}/`;
	const rootScope = `${ORIGIN}/`;

	await page.grantPermissions(["notifications"], ORIGIN);
	await page.addInitScript(FAKE_PUSH_API);
	await page.goto(page.url, {waitForSelector: "#connect form"});

	// --- seed: the network, its push-only worker and a (fake) subscription --
	const seeded = await page.evaluate(`(async () => {
		const reg = await navigator.serviceWorker.register("service-worker.js", {scope: "push/${UUID}/"});
		const worker = reg.installing || reg.waiting || reg.active;
		if (worker.state !== "activated") {
			await new Promise((r) => worker.addEventListener("statechange", () => worker.state === "activated" && r()));
		}
		const sub = (await reg.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: "${VAPID}"})).toJSON();
		localStorage.setItem("thelounge.networks", JSON.stringify([${JSON.stringify(SAVED_NETWORK)}]));
		localStorage.setItem("thelounge.push", JSON.stringify({"${UUID}": {vapid: "${VAPID}", endpoint: sub.endpoint, keys: sub.keys}}));
		localStorage.setItem("thelounge.push.neverAsk", "1");
		return reg.scope;
	})()`);
	page.check(`0. the push-only worker is registered (${seeded})`, seeded === pushScope);

	await page.goto(page.url);
	await page.waitFor(`!!document.querySelector(".channel-list-item[data-type='lobby']")`, {
		label: "the network in the sidebar",
		timeout: 30000,
	});
	await page.waitFor(
		`[...document.querySelectorAll(".lobby-nick")].some((e) => e.textContent.includes(${JSON.stringify(
			NICK
		)}))`,
		{label: "the page registered", timeout: 30000}
	);
	await page.sleep(1000);

	// --- 1 + 2. a PM from the bot -----------------------------------------
	const text = `page notification ${RUN}`;
	const msgid = await sendPm(NICK, text);
	page.check(`0. the bot's echo carried a msgid (${msgid})`, Boolean(msgid));

	let onPush = [];
	const deadline = Date.now() + 8000;

	while (Date.now() < deadline) {
		const raw = await page.evaluate(NOTIFICATIONS(pushScope));
		onPush = raw.startsWith("[") ? JSON.parse(raw) : [];

		if (onPush.length > 0) {
			break;
		}

		await page.sleep(200);
	}

	const rec = onPush.find((n) => n.tag === `push-${BOT}`);
	page.check(
		`1. the push worker shows push-${BOT} (got ${JSON.stringify(onPush.map((n) => n.tag))})`,
		Boolean(rec)
	);

	if (rec) {
		page.check(`1. its title is the sender (${rec.title})`, rec.title === BOT);
		page.check(`1. its body is the message (${rec.body})`, rec.body === text);
		page.check("1. it is the push's shape", rec.data?.kind === "push");
		page.check(
			"1. it holds the message's msgid (Reply answers it)",
			rec.data?.messages?.some((m) => m.msgid === msgid)
		);
		page.check(
			`1. Mark read and Reply (${rec.actions})`,
			rec.actions.join() === "markread,reply"
		);
	}

	const onRoot = await page.evaluate(NOTIFICATIONS(rootScope));
	page.check(`2. the root worker shows nothing (${onRoot})`, onRoot === "[]");

	await page.screenshot("after-pm");

	// --- 3. reading the conversation closes it ---------------------------
	await page.click(`.channel-list-item[data-name="${BOT}"]`);
	let left = "";
	const closeBy = Date.now() + 5000;

	while (Date.now() < closeBy) {
		left = await page.evaluate(NOTIFICATIONS(pushScope));

		if (left === "[]") {
			break;
		}

		await page.sleep(200);
	}

	page.check(`3. opening the query closes its notification (${left})`, left === "[]");
	await page.screenshot("query-open");

	page.check(
		`4. no console errors (${page.consoleErrors.join(" | ")})`,
		page.consoleErrors.length === 0
	);
}
