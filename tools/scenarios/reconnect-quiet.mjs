// A reconnect leaves nothing in the channels: no "The topic is …", no
// "Topic set by …", no "Channel mode is …" — after a dropped socket, after
// F5, and after a phone kills the app in the background and it comes back
// (the socket dies first, then the page reloads). Only a channel joined by
// hand shows its topic as a line (the header truncates a long one), and
// /topic and /mode still answer. Other users must see nothing of any of it.
// docs/projects/seamless-reconnect.md § Round ten.
//
// Needs an ircd with SASL, draft/persistence (the bouncer hold) and
// draft/event-playback — the e-testnet rig — and an account of its own (do
// not share one with a live session: the bouncer attaches to that session,
// and the clean-up parts channels):
//
//   pnpm build && python3 -m http.server -d "$PWD/public" -b 127.0.0.1 8031 &
//   SEANCE_URL=http://localhost:8031/ SEANCE_IRC_PORT=18067 \
//   SEANCE_SASL_ACCOUNT=… SEANCE_SASL_PASSWORD=… \
//     node tools/browser-drive.mjs tools/scenarios/reconnect-quiet.mjs
//
// The page reaches the ircd through a TCP proxy (lib/irc-proxy.mjs) so the
// radio can be cut; a second connection, straight to the ircd, owns one of
// the channels, sets its topic and records what other users see.

import {startProxy} from "./lib/irc-proxy.mjs";
import {observe} from "./lib/irc-observer.mjs";

const ACCOUNT = process.env.SEANCE_SASL_ACCOUNT;
const PASSWORD = process.env.SEANCE_SASL_PASSWORD;
const BASE = process.env.SEANCE_URL ?? "http://localhost:8000/";
const IRC_HOST = process.env.SEANCE_IRC_HOST ?? "127.0.0.1";
const IRC_PORT = Number(process.env.SEANCE_IRC_PORT ?? 8067);
const PROXY_PORT = Number(process.env.SEANCE_PROXY_PORT ?? 18170);
const RUN = Date.now().toString(36).slice(-5);
// Owned by the observer, with a topic long enough to be cut off in the header.
const OWNED = `#sq-${RUN}`;
const OWNED_TOPIC = `Quiet reconnects ${RUN}: the topic of a channel someone else runs, long enough that the header cuts it off`;
// Created by the page itself.
const MINE = `#sq2-${RUN}`;
const MINE_TOPIC = `our own topic ${RUN}`;

export const url = BASE;
// Cutting the socket is the point; the frames it breaks are expected.
export const allowWsFrameErrors = true;

const STORE = `document.getElementById("app").__vue_app__.config.globalProperties.$store`;
const NET = `${STORE}.state.networks[0]`;
const guard = (expr) => `(() => { try { return ${expr}; } catch (e) { return false; } })()`;
const CONNECTED = guard(`${NET}.status.connected === true`);
const DOWN = guard(`${NET}.status.connected === false`);
const JOINED = (name) =>
	guard(`${NET}.channels.some((c) => c.name === ${JSON.stringify(name)} && c.state === 1)`);
// Every channel's lines, the lobby left out (it reports the connection).
const LINES = `JSON.stringify(${NET}.channels.filter((c) => c.type === "channel").map((c) => ({
	name: c.name,
	topic: c.topic,
	msgs: c.messages.map((m) => ({type: m.type, text: String(m.text ?? ""), msgid: m.msgid ?? null, time: m.time})),
})))`;
// What the page makes up itself, as opposed to what the server stored.
const STATE_TYPES = new Set(["topic", "topic_set_by", "mode_channel"]);
const keyOf = (m) => m.msgid ?? `${m.type}|${m.text}|${m.time}`;

export default async function run(page) {
	if (!ACCOUNT || !PASSWORD) {
		throw new Error(
			"set SEANCE_SASL_ACCOUNT and SEANCE_SASL_PASSWORD (a test account of your own)"
		);
	}

	const proxy = startProxy({port: PROXY_PORT, target: {host: IRC_HOST, port: IRC_PORT}});
	await proxy.listen();
	page.expectWsErrors = true;

	const lines = async () => JSON.parse(await page.evaluate(LINES));
	const chan = async (name) => (await lines()).find((c) => c.name === name);
	// The push prompt follows a SASL login and swallows every click while open.
	const neverPush = async () => {
		if ((await page.count("#push-prompt[data-armed]")) > 0) {
			await page.click("#pushPromptNever");
			await page.sleep(300);
		}
	};
	const settle = async (ms) => {
		for (let t = 0; t < ms; t += 500) {
			await neverPush();
			await page.sleep(500);
		}
	};
	const open = async (name) => {
		await neverPush();
		await page.click(`.channel-list-item[data-name="${name}"]`);
		await page.sleep(250);
	};
	const type = async (where, text) => {
		await open(where);
		await page.fill("#input", text);
		await page.click("#submit");
		await page.sleep(400);
	};
	// Lines that appeared since `before`, per channel.
	const newLines = (before, after) =>
		after.flatMap((c) => {
			const seen = new Set((before.find((b) => b.name === c.name)?.msgs ?? []).map(keyOf));
			return c.msgs.filter((m) => !seen.has(keyOf(m))).map((m) => ({chan: c.name, ...m}));
		});
	const describe = (list) =>
		list.map((m) => `${m.chan} ${m.type} ${m.text.slice(0, 40)}`).join("; ") || "none";
	// The page's own state lines (no msgid: the server did not store them).
	const stateLines = (snapshot) =>
		snapshot.flatMap((c) =>
			c.msgs
				.filter((m) => !m.msgid && STATE_TYPES.has(m.type))
				.map((m) => ({chan: c.name, ...m}))
		);
	const backUp = async (label) => {
		await page.sleep(1000);
		await page.waitFor(CONNECTED, {timeout: 40000, label});
		// The catch-up of the channels not on screen is paced (catchup.ts).
		await settle(12000);
	};

	// 1. A saved network with SASL, autoconnecting through the proxy.
	await page.goto(BASE, {waitForSelector: "#app"});
	await page.evaluate(
		`localStorage.setItem("thelounge.networks", ${JSON.stringify(
			JSON.stringify([
				{
					uuid: `sq-${RUN}`,
					name: "quiet",
					host: "127.0.0.1",
					port: PROXY_PORT,
					tls: false,
					nick: `sq${RUN}`,
					join: "#seance",
					sasl: "plain",
					saslAccount: ACCOUNT,
					saslPassword: PASSWORD,
					rememberPassword: true,
					autoconnect: true,
				},
			])
		)})`
	);
	await page.send("Page.reload", {});
	await page.waitFor(JOINED("#seance"), {timeout: 30000, label: "joined #seance (SASL)"});
	await settle(2000);

	// A held session keeps the channels of earlier runs: leave them.
	const stale = (await lines()).map((c) => c.name).filter((n) => /^#sq2?-/.test(n));

	for (const name of stale) {
		await type("#seance", `/part ${name}`);
	}

	// 2. Someone else's channel with a topic, joined by hand: its topic is a
	//    line, once, with who set it.
	const obs = await observe(`ws://${IRC_HOST}:${IRC_PORT}/`, `sqo${RUN}`, {join: OWNED});
	obs.send(`TOPIC ${OWNED} :${OWNED_TOPIC}`);
	await obs.waitFor((l) => l.includes(` TOPIC ${OWNED} `), 10000, "observer's TOPIC");
	await type("#seance", `/join ${OWNED}`);
	await page.waitFor(JOINED(OWNED), {timeout: 15000, label: `joined ${OWNED}`});
	await settle(3000);

	const owned = await chan(OWNED);
	const told = owned.msgs.filter((m) => !m.msgid);
	page.check(
		"a channel joined by hand shows its topic once",
		told.filter((m) => m.type === "topic" && m.text === OWNED_TOPIC).length === 1
	);
	page.check("… and who set it", told.filter((m) => m.type === "topic_set_by").length === 1);
	page.check("… and the header has it", owned.topic === OWNED_TOPIC);

	// 3. A channel of our own, with a topic and a line in each.
	await type("#seance", `/join ${MINE}`);
	await page.waitFor(JOINED(MINE), {timeout: 15000, label: `joined ${MINE}`});
	await type(MINE, `/topic ${MINE} ${MINE_TOPIC}`);
	await type(MINE, `a line in ${MINE}`);
	await type(OWNED, `a line in ${OWNED}`);
	await settle(4000);

	const me = await page.evaluate(`${NET}.nick`);
	const seenOfMe = (since) =>
		obs.since(since).filter((l) => l.includes(`:${me}!`) && !/ (PRIVMSG|TOPIC) /.test(l));

	// 4. The radio goes away and comes back, the page alive.
	let before = await lines();
	let t = Date.now();
	proxy.cut();
	await page.waitFor(DOWN, {timeout: 15000, label: "the drop noticed"});
	await backUp("back after the drop");
	let fresh = newLines(before, await lines());
	page.check(
		`a dropped socket adds no line to a channel (${describe(fresh)})`,
		fresh.length === 0
	);
	page.check(
		`… and other users see nothing (${seenOfMe(t).join(" | ") || "nothing"})`,
		seenOfMe(t).length === 0
	);

	// 5. F5. The page that comes back remembers nothing; nothing may say so.
	t = Date.now();
	await page.send("Page.reload", {});
	await backUp("back after F5");
	let after = await lines();
	page.check(
		`F5 adds no topic or mode line (${describe(stateLines(after))})`,
		stateLines(after).length === 0
	);
	page.check(
		"… the headers have the topics",
		after.find((c) => c.name === OWNED)?.topic === OWNED_TOPIC &&
			after.find((c) => c.name === MINE)?.topic === MINE_TOPIC
	);
	page.check(
		"… and the history still has the real topic changes",
		after.find((c) => c.name === OWNED)?.msgs.some((m) => m.type === "topic" && m.msgid) &&
			after.find((c) => c.name === MINE)?.msgs.some((m) => m.type === "topic" && m.msgid)
	);
	page.check(
		`… other users see nothing (${seenOfMe(t).join(" | ") || "nothing"})`,
		seenOfMe(t).length === 0
	);
	await page.screenshot("after-f5");

	// Each channel opened after a reload asks for its modes: still no line.
	before = after;
	const other =
		(await page.evaluate(
			`${NET}.channels.find((c) => c.id === ${STORE}.state.activeChannel?.channel.id)?.name`
		)) === OWNED
			? MINE
			: OWNED;
	await open(other);
	await settle(5000);
	fresh = newLines(before, await lines());
	page.check(`opening a channel after F5 adds no line (${describe(fresh)})`, fresh.length === 0);

	// 6. The phone: the socket dies in the background, the app is killed,
	//    and it is opened again (no QUIT gets out).
	t = Date.now();
	proxy.cut();
	await page.send("Page.reload", {});
	await backUp("back after the kill");
	after = await lines();
	page.check(
		`a killed app comes back without a topic or mode line (${describe(stateLines(after))})`,
		stateLines(after).length === 0
	);
	page.check(
		`… other users see nothing (${seenOfMe(t).join(" | ") || "nothing"})`,
		seenOfMe(t).length === 0
	);

	// 7. Asked for, both still answer.
	before = after;
	await type(OWNED, "/topic");
	await type(OWNED, "/mode");
	await settle(5000);
	fresh = newLines(before, await lines());
	page.check(
		`/topic and /mode answer (${describe(fresh)})`,
		fresh.some((m) => m.type === "topic" && m.text === OWNED_TOPIC) &&
			fresh.some((m) => m.type === "mode_channel")
	);
	await page.screenshot("asked");

	// 8. Leave the held session as it was found.
	await type(OWNED, `/part ${OWNED}`);
	await type(MINE, `/part ${MINE}`);
	await settle(1500);
	obs.close();
	proxy.close();
}
