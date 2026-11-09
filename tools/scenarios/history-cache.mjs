// A channel's recent lines survive a reload: they show before the server
// answers (irc/historycache.ts), join up with its history when its first
// page meets them, and leave the buffer when it does not
// (irc/history.ts reconcileCached).
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/history-cache.mjs
//
// `SEANCE_PORT` points it at another static server. One browser profile
// throughout: IndexedDB surviving the reload is the point. The page dials
// the dev ircd through lib/irc-proxy.mjs, which refuses it across each
// reload, so what it shows then can only have come from the device.

import {startProxy} from "./lib/irc-proxy.mjs";

const IRCD = "ws://127.0.0.1:8067/";
const PROXY_PORT = 9876;
const PORT = process.env.SEANCE_PORT ?? "8000";
const RUN = Date.now().toString(36).slice(-5);
const NICK = `hcache${RUN}`;
const TALKER = `htalk${RUN}`;
const CHAN = `#hc${RUN}`;

export const url =
	`http://localhost:${PORT}/?host=127.0.0.1&port=${PROXY_PORT}` +
	`&tls=false&nick=${NICK}&join=${encodeURIComponent(CHAN)}`;

const item = (name) => `.channel-list-item[data-name="${name}"]`;
const TEXTS = `JSON.stringify(Array.from(document.querySelectorAll("#chat .msg .content")).map((c) => c.textContent.trim()))`;
const CONNECTED = `!!document.querySelector('${item(
	CHAN
)}:not(.parted-channel):not(.network-down)')`;
/** The channel's kept lines, read straight out of IndexedDB. */
const STORED = `new Promise((resolve) => {
	const req = indexedDB.open("seance-history");
	req.onerror = () => resolve("[]");
	req.onsuccess = () => {
		const db = req.result;
		if (!db.objectStoreNames.contains("channels")) { db.close(); resolve("[]"); return; }
		const all = db.transaction("channels").objectStore("channels").getAll();
		all.onsuccess = () => { db.close(); resolve(JSON.stringify(all.result.flatMap((c) => c.lines.map((l) => l.text)))); };
	};
})`;

/** A second user in the channel. */
function talker(nick) {
	const ws = new WebSocket(IRCD, ["text.ircv3.net"]);
	let onJoined = () => {};
	const echoed = new Map();

	ws.onopen = () => {
		ws.send("CAP REQ :echo-message");
		ws.send("CAP END");
		ws.send(`NICK ${nick}`);
		ws.send(`USER ${nick} 0 * :seance history cache`);
	};

	ws.onmessage = (ev) => {
		const line = String(ev.data);
		const command = line.split(" ")[1];

		if (line.startsWith("PING")) {
			ws.send(`PONG${line.slice(4)}`);
		} else if (command === "001") {
			ws.send(`JOIN ${CHAN}`);
		} else if (command === "366") {
			onJoined();
		} else if (command === "PRIVMSG") {
			echoed.get(line.slice(line.indexOf(" :") + 2))?.();
		}
	};

	return {
		ready: new Promise((resolve, reject) => {
			onJoined = resolve;
			setTimeout(() => reject(new Error(`${nick} never joined`)), 20000);
		}),
		/** Resolves once the server has taken this talker's line "flood <n>" (echo-message). */
		sent: (n) =>
			new Promise((resolve, reject) => {
				echoed.set(`flood ${n}`, resolve);
				setTimeout(() => reject(new Error(`${nick}: flood ${n} never echoed`)), 90000);
			}),
		say: (text) => ws.send(`PRIVMSG ${CHAN} :${text}`),
		quit: () => ws.send("QUIT :done"),
	};
}

export default async function run(page) {
	const texts = async () => JSON.parse(await page.evaluate(TEXTS));
	const once = (list, text) => list.filter((t) => t === text).length === 1;
	const proxy = startProxy({port: PROXY_PORT, target: {host: "127.0.0.1", port: 8067}});
	await proxy.listen();
	const block = (on) => {
		if (on) {
			proxy.refuse();
			proxy.cut();
		} else {
			proxy.accept();
		}
	};

	/** F5 with the IRC socket refused: see reload-on-settings.mjs for the reload itself. */
	const coldLoadOffline = async () => {
		page.expectWsErrors = true;
		block(true);
		await page.evaluate(
			`(() => { window.__coldLoad = true; history.replaceState(null, "", "/"); })()`
		);
		await page.send("Page.reload");
		await page.waitFor(`!window.__coldLoad && !!document.querySelector('${item(CHAN)}')`, {
			timeout: 30000,
			label: "the channel in the sidebar after the reload",
		});
		await page.click(item(CHAN));
	};

	const reconnect = async () => {
		block(false);
		page.expectWsErrors = false;

		if (await page.evaluate(`!!document.querySelector(".connection-bar-connect")`)) {
			await page.click(".connection-bar-connect");
		}

		await page.waitFor(CONNECTED, {timeout: 90000, label: "connected again"});
	};

	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.click('#connect input[name="autoconnect"]');
	await page.click('#connect button[type="submit"]');
	await page.waitFor(`document.querySelector('${item(CHAN)}')`, {
		timeout: 30000,
		label: `${CHAN} in the sidebar`,
	});

	const bob = talker(TALKER);
	await bob.ready;

	for (let i = 1; i <= 3; i++) {
		bob.say(`cache line ${i}`);
	}

	await page.click(item(CHAN));
	await page.waitFor(`${TEXTS}.includes("cache line 3")`, {
		timeout: 10000,
		label: "the lines in the channel",
	});
	await page.sleep(2500); // past the cache's write throttle
	const stored = JSON.parse(await page.evaluate(STORED));
	await page.check(
		`the lines are in IndexedDB (${JSON.stringify(stored)})`,
		["cache line 1", "cache line 2", "cache line 3"].every((t) => stored.includes(t))
	);

	// 1. Reload with no connection: the lines are there anyway.
	await coldLoadOffline();
	await page.waitFor(`${TEXTS}.includes("cache line 3")`, {
		timeout: 10000,
		label: "the kept lines with the socket refused",
	});
	await page.check(
		"the kept lines show with no connection",
		await page.evaluate(`!!document.querySelector('${item(CHAN)}.network-down')`)
	);
	await page.screenshot("1-offline-restore");

	// 2. Two lines while away; back online, the first page meets the kept
	//    lines: they stay, the two new ones follow, nothing twice.
	bob.say("while away 1");
	bob.say("while away 2");
	await reconnect();
	await page.waitFor(`${TEXTS}.includes("while away 2")`, {
		timeout: 20000,
		label: "the missed lines",
	});
	await page.sleep(1000);
	const joined = (await texts()).filter((t) => /^(cache line|while away)/.test(t));
	await page.check(
		`kept and missed lines join up, in order, once each (${JSON.stringify(joined)})`,
		JSON.stringify(joined) ===
			JSON.stringify([
				"cache line 1",
				"cache line 2",
				"cache line 3",
				"while away 1",
				"while away 2",
			])
	);
	await page.screenshot("2-joined-up");

	// 3. More missed than the first page holds: it cannot meet the kept
	//    lines, so they leave rather than sit above a gap.
	await page.sleep(2500);
	await coldLoadOffline();
	await page.waitFor(`${TEXTS}.includes("while away 2")`, {
		timeout: 10000,
		label: "the kept lines again",
	});

	// More than the first page's 50 lines. The server paces each sender,
	// opers included, so four talkers share them.
	const crowd = [1, 2, 3, 4].map((n) => talker(`${TALKER.slice(0, 10)}x${n}`));
	await Promise.all(crowd.map((c) => c.ready));
	crowd.forEach((c, n) => {
		for (let i = 1; i <= 15; i++) {
			c.say(`flood ${n * 15 + i}`);
		}
	});
	await crowd[3].sent(60);
	await reconnect();
	await page.waitFor(`${TEXTS}.includes("flood 60")`, {
		timeout: 30000,
		label: "the flood",
	});
	await page.sleep(1000);
	const after = await texts();
	await page.check(
		`the kept lines are gone (${after.filter((t) => t.startsWith("cache line")).length} left)`,
		!after.some((t) => t.startsWith("cache line") || t.startsWith("while away"))
	);
	await page.check(
		"the newest lines show once each",
		once(after, "flood 60") && once(after, "flood 30")
	);
	await page.screenshot("3-gap-dropped");

	// 4. Switched off: what is kept is deleted.
	await page.evaluate(`location.hash = "#/settings"`);
	await page.waitFor(`!!document.querySelector('input[name="keepChannelHistory"]')`, {
		timeout: 10000,
		label: "the setting in Settings",
	});
	// Below the fold of the General tab: clicked where it is, not where the
	// viewport would put it.
	await page.evaluate(`document.querySelector('input[name="keepChannelHistory"]').click()`);
	await page.sleep(500);
	await page.check(
		"switched off, IndexedDB holds no lines",
		JSON.parse(await page.evaluate(STORED)).length === 0
	);
	await page.screenshot("4-setting-off", {selector: ".settings-modal, #settings"});

	bob.quit();
	proxy.close();
	await page.check(
		`no console errors (${page.consoleErrors.map((e) => e.text).join(" | ")})`,
		page.consoleErrors.length === 0
	);
}
