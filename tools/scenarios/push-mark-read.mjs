// Mark read from a push notification, the page's road: the service worker
// asks an open page to set the account's read marker (bus-contract §2.2,
// `{type: "markread", network, target, time, deadline}` with a MessageChannel
// port), the page answers through the `markread` bus emit and the IRC layer
// sends `MARKREAD <target> timestamp=<time>` at once. The worker itself is
// not involved here — the message is dispatched on `navigator.serviceWorker`
// exactly as a worker's postMessage arrives — so this checks webpush.ts →
// bus.ts → handlers/markread.ts against the real ircd, which mocha cannot
// (webpush.ts imports the store). The worker's own two roads (the throwaway
// connection, the outbox write) are the harness's, test/tests/service-worker.ts.
//
//   NODE_ENV=production pnpm build && python3 -m http.server -d public 8004 &
//   node tools/browser-drive.mjs tools/scenarios/push-mark-read.mjs [--chrome=…]
//
// Needs the testnet ircd on ws://127.0.0.1:8067 with the SASL account below:
// MARKREAD wants an account, and the marker's echo proves the server took it.
// nefarious2 leaves `CAP_draft_read_marker` off by default and so does the
// rig, so the scenario switches it on for the run through the rig's oper
// (lib/rig-feature.mjs) and back off at the end. `SEANCE_URL` overrides the
// origin.
//
// Claims under test:
//   1. a relayed markread for a joined channel goes out as MARKREAD with the
//      given timestamp, at once, and the page acks {ok: true};
//   2. the server echoes the marker back — account-anchored, accepted;
//   3. a relayed markread for a query with no window still goes out;
//   4. a message past its deadline is refused ({ok: false}) and sends nothing;
//   5. a markread entry queued in the worker's outbox is sent when the network
//      comes up on the next visit, and the outbox is emptied;
//   6. no console errors.

import {waitFrame} from "./lib/fake-push.mjs";
import {rigFeature} from "./lib/rig-feature.mjs";

const ORIGIN = process.env.SEANCE_URL ?? "http://127.0.0.1:8004";
const NET = {account: "pushtest2", password: "pushtest2-pass", nick: "pmr2"};
const UUID = "pmr-" + Math.random().toString(36).slice(2, 10);
const FEATURE = "CAP_draft_read_marker";

export const url = `${ORIGIN}/`;

/** The saved network the scenario boots with: autoconnect, SASL, password kept. */
const SAVED_NETWORK = {
	uuid: UUID,
	name: "Push mark read",
	host: "127.0.0.1",
	port: 8067,
	tls: false,
	nick: NET.nick,
	join: "#seance",
	sasl: "plain",
	saslAccount: NET.account,
	saslPassword: NET.password,
	rememberPassword: true,
	autoconnect: true,
};

const frameText = (f) => (typeof f.payloadData === "string" ? f.payloadData : "");

/** Outgoing MARKREAD lines since frame index `since`. */
const markreadOut = (page, since) =>
	page.wsFrames
		.slice(since)
		.filter((f) => f.dir === "out" && frameText(f).startsWith("MARKREAD "))
		.map(frameText);

/** Dispatch a worker-style message on the page's ServiceWorkerContainer and
 * resolve with the page's answer on the port (`{ok}`), or "timeout". */
const RELAY = (message) => `(() => {
	const ch = new MessageChannel();
	return new Promise((resolve) => {
		ch.port1.onmessage = (e) => resolve(JSON.stringify(e.data));
		setTimeout(() => resolve("timeout"), 4000);
		navigator.serviceWorker.dispatchEvent(
			new MessageEvent("message", {data: ${JSON.stringify(message)}, ports: [ch.port2]})
		);
	});
})()`;

/** Read (no argument) or write the worker's outbox in the page's IndexedDB
 * (seance-push/kv, key "outbox"). */
const OUTBOX = (value) => `new Promise((resolve, reject) => {
	const req = indexedDB.open("seance-push", 1);
	req.onupgradeneeded = () => req.result.createObjectStore("kv");
	req.onerror = () => reject(req.error);
	req.onsuccess = () => {
		const tx = req.result.transaction("kv", ${value === undefined ? '"readonly"' : '"readwrite"'});
		const store = tx.objectStore("kv");
		${
			value === undefined
				? `const get = store.get("outbox"); get.onsuccess = () => resolve(JSON.stringify(get.result ?? null));`
				: `store.put(${JSON.stringify(
						value
				  )}, "outbox"); tx.oncomplete = () => resolve(true);`
		}
		tx.onerror = () => reject(tx.error);
	};
})`;

/** Load the app and wait until #seance is joined — a live JOIN, or the one
 * in the bouncer's restoration batch when the account's held session is
 * resumed (then the server volunteers the stored marker and the page fetches
 * none). Returns the frame index at which this visit began. */
async function visit(page) {
	const before = page.wsFrames.length;
	await page.goto(page.url);
	await page.waitFor(`!!document.querySelector("#chat")`, {
		label: "the chat to render",
		timeout: 60000,
	});
	await waitFrame(page, before, "in", / JOIN :?#seance\b/i, "the JOIN of #seance", 30000);
	await page.sleep(1500); // the JOIN burst (history, names, the stored marker) settles
	return before;
}

/** Whether this visit's CAP ACK carried `draft/read-marker`. */
const negotiatedReadMarker = (page, since) =>
	page.wsFrames
		.slice(since)
		.some((f) => f.dir === "in" && / CAP \S+ ACK .*draft\/read-marker/.test(frameText(f)));

export default async function run(page) {
	const feature = await rigFeature(FEATURE, "TRUE");
	page.check(`0. the rig offers draft/read-marker for this run`, feature.after);

	try {
		await scenario(page);
	} finally {
		if (!feature.before) {
			await rigFeature(FEATURE, "FALSE");
		}
	}
}

async function scenario(page) {
	// --- seed: a saved autoconnect network, password kept, no push prompt --
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(
		`localStorage.setItem("thelounge.networks", ${JSON.stringify(
			JSON.stringify([SAVED_NETWORK])
		)}); localStorage.setItem("thelounge.push.neverAsk", "1")`
	);

	let since = await visit(page);
	page.check("0. the page negotiated draft/read-marker", negotiatedReadMarker(page, since));
	await page.screenshot("1-joined");

	// --- 1 + 2. a relayed marker for the channel ---------------------------
	const t1 = new Date().toISOString();
	since = page.wsFrames.length;
	const ack1 = await page.evaluate(
		RELAY({
			type: "markread",
			network: UUID,
			target: "#seance",
			time: t1,
			deadline: Date.now() + 2500,
		})
	);
	page.check(`1. the page acks a channel marker (${ack1})`, ack1 === '{"ok":true}');
	page.check(
		"1. MARKREAD went out at once with the given time",
		markreadOut(page, since).includes(`MARKREAD #seance timestamp=${t1}`)
	);
	await waitFrame(
		page,
		since,
		"in",
		/ MARKREAD #seance timestamp=/,
		"the server's echo",
		10000
	).catch(() => {});
	const echo = page.wsFrames
		.slice(since)
		.filter((f) => f.dir === "in" && / MARKREAD #seance timestamp=/.test(frameText(f)))
		.map(frameText);
	page.check(
		"2. the server echoed the marker at that time",
		echo.some((l) => l.endsWith(`timestamp=${t1}`))
	);
	await page.screenshot("2-marked");

	// --- 3. a query with no window ----------------------------------------
	const t3 = new Date(Date.now() + 1000).toISOString();
	since = page.wsFrames.length;
	const ack3 = await page.evaluate(
		RELAY({
			type: "markread",
			network: UUID,
			target: "pushtest1",
			time: t3,
			deadline: Date.now() + 2500,
		})
	);
	page.check(`3. the page acks a query marker (${ack3})`, ack3 === '{"ok":true}');
	page.check(
		"3. MARKREAD for the query went out without a window for it",
		markreadOut(page, since).includes(`MARKREAD pushtest1 timestamp=${t3}`)
	);

	// --- 4. past its deadline: refused, nothing sent ------------------------
	const t4 = new Date(Date.now() + 2000).toISOString();
	since = page.wsFrames.length;
	const ack4 = await page.evaluate(
		RELAY({
			type: "markread",
			network: UUID,
			target: "#seance",
			time: t4,
			deadline: Date.now() - 1,
		})
	);
	await page.sleep(300);
	page.check(`4. a stale relay is refused (${ack4})`, ack4 === '{"ok":false}');
	page.check("4. nothing went out for it", markreadOut(page, since).length === 0);

	// --- 5. the outbox is drained on the next visit ------------------------
	const t5 = new Date(Date.now() + 3000).toISOString();
	await page.evaluate(OUTBOX([{type: "markread", network: UUID, target: "#seance", time: t5}]));
	since = await visit(page);
	await waitFrame(
		page,
		since,
		"out",
		/^MARKREAD #seance timestamp=/,
		"the queued marker",
		10000
	).catch(() => {});
	page.check(
		"5. the queued marker went out once the network was up",
		markreadOut(page, since).includes(`MARKREAD #seance timestamp=${t5}`)
	);
	const left = await page.evaluate(OUTBOX());
	page.check(`5. the outbox is empty afterwards (${left})`, left === "[]" || left === "null");
	await page.screenshot("5-drained");

	page.check("6. no console errors", page.consoleErrors.length === 0);

	if (page.consoleErrors.length > 0) {
		console.log(page.consoleErrors);
	}
}
