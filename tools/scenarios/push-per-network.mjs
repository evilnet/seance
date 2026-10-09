// Push subscriptions per network (docs/projects/push-per-network.md), end to
// end in a real browser against the testnet ircd with two networks (two SASL
// accounts on the same server — the same key, which is the harder case for
// telling the subscriptions apart).
//
//   npx webpack && python3 -m http.server -d public 8001 &
//   node tools/browser-drive.mjs tools/scenarios/push-per-network.mjs [--chrome=…]
//
// The Push API is faked per service-worker registration (lib/fake-push.mjs);
// the workers, SASL and WEBPUSH on the wire are real. Frames are told apart
// by socket (`requestId`), the socket by the account its AUTHENTICATE named.
//
// Claims under test:
//   1. two networks get two registrations (`push/<uuid>/` each) and two
//      subscriptions, each REGISTERed on its own connection only;
//   2. a rotation on one network prompts for that one (named), and renewing
//      it leaves the other's subscription and endpoint alone — no swap;
//   3. a legacy `thelounge.push` (the pre-per-network per-key map) migrates:
//      the root registration's subscription goes, the legacy endpoint is
//      UNREGISTERed on every network announcing its key, and per-network
//      subscriptions are created silently;
//   4. push off for one network unsubscribes it alone: its UNREGISTER, its
//      entry and its registration go, the other's stay.

import {
	FAKE_PUSH_API,
	announcedVapid,
	pushScope,
	registrationScopes,
	rotateAway,
	storedSubs,
	waitFrame,
} from "./lib/fake-push.mjs";

const ORIGIN = "http://127.0.0.1:8001";
const NET1 = {account: "pushtest1", password: "pushtest1-pass", nick: "pwpn1"};
const NET2 = {account: "pushtest2", password: "pushtest2-pass", nick: "pwpn2", name: "Second"};

export const url =
	`${ORIGIN}/?host=127.0.0.1&port=8067&tls=false` +
	`&nick=${NET1.nick}&join=%23seance&sasl=plain&saslAccount=${NET1.account}&saslPassword=${NET1.password}` +
	`&autoconnect=1`;

const frameText = (f) => (typeof f.payloadData === "string" ? f.payloadData : "");
const promptOpened = `document.querySelector("#push-prompt-overlay")?.classList.contains("opened")`;
// A prompt takes no answer in its first moments (webpush.ts PROMPT_ARM_MS);
// `data-armed` marks it ready.
const promptArmed = `document.querySelector("#push-prompt[data-armed]") !== null`;
const promptGone = `getComputedStyle(document.querySelector("#push-prompt-overlay")).visibility === "hidden"`;

/** The socket (requestId) that authenticated as `account`, among frames
 * from index `since`: SASL PLAIN's AUTHENTICATE carries base64 of
 * `\0account\0password`. */
function socketOf(page, since, account) {
	for (const f of page.wsFrames.slice(since)) {
		const text = frameText(f);

		if (f.dir === "out" && text.startsWith("AUTHENTICATE ") && text !== "AUTHENTICATE PLAIN") {
			try {
				const decoded = atob(text.slice("AUTHENTICATE ".length).trim());

				if (decoded.split("\0")[1] === account) {
					return f.requestId;
				}
			} catch {
				// not base64
			}
		}
	}

	return undefined;
}

/** Outgoing WEBPUSH lines on one socket since `since`. */
const webpushOn = (page, since, requestId) =>
	page.wsFrames
		.slice(since)
		.filter(
			(f) =>
				f.dir === "out" && f.requestId === requestId && frameText(f).startsWith("WEBPUSH ")
		)
		.map(frameText);

/** Wait until both networks registered (one PERSISTENCE SET per socket). */
async function waitBothRegistered(page, before) {
	await page.waitFor(`!!document.querySelector("#chat")`, {
		label: "the chat to render",
		timeout: 60000,
	});
	const deadline = Date.now() + 30000;

	while (Date.now() < deadline) {
		const sockets = new Set(
			page.wsFrames
				.slice(before)
				.filter((f) => f.dir === "out" && frameText(f).startsWith("PERSISTENCE"))
				.map((f) => f.requestId)
		);

		if (sockets.size >= 2) {
			return;
		}

		await page.sleep(100);
	}

	throw new Error("timed out waiting for both networks to register");
}

async function connectBoth(page) {
	let before = page.wsFrames.length;
	await page.goto(`${ORIGIN}/`);
	await waitBothRegistered(page, before);

	for (let i = 0; i < 3; i++) {
		if (await page.evaluate(`Notification.permission === "granted"`)) {
			return before;
		}

		await page.grantPermissions(["notifications"], ORIGIN);
		before = page.wsFrames.length;
		await page.evaluate(`location.reload()`);
		await waitBothRegistered(page, before);
	}

	throw new Error("the page never saw the notification permission as granted");
}

/** Wait for a network's REGISTER on its own socket; returns the endpoint. */
async function waitRegisterOn(page, since, requestId, what) {
	const deadline = Date.now() + 20000;

	while (Date.now() < deadline) {
		const hit = page.wsFrames
			.slice(since)
			.find(
				(f) =>
					f.dir === "out" &&
					f.requestId === requestId &&
					/^WEBPUSH REGISTER /.test(frameText(f))
			);

		if (hit) {
			return frameText(hit).split(" ")[2];
		}

		await page.sleep(100);
	}

	throw new Error(`timed out waiting for ${what}`);
}

export default async function run(page) {
	await page.grantPermissions(["notifications"], ORIGIN);
	await page.addInitScript(FAKE_PUSH_API);

	// --- setup: network 1 from the URL, then a second saved network ---------
	let before = page.wsFrames.length;
	await page.goto(page.url);
	await page.waitFor(`!!document.querySelector("#chat")`, {
		label: "the chat to render",
		timeout: 60000,
	});
	await waitFrame(page, before, "out", /^PERSISTENCE/, "the first registration");
	const vapid = announcedVapid(page);
	page.check("the server announced a VAPID key in CAP LS", Boolean(vapid));

	const uuids = await page.evaluate(`(() => {
		const all = JSON.parse(localStorage.getItem("thelounge.networks"));
		Object.assign(all[0], {autoconnect: true, rememberPassword: true, saslPassword: ${JSON.stringify(
			NET1.password
		)}});
		const second = {...all[0], uuid: "pn2-" + Math.random().toString(36).slice(2, 10), name: ${JSON.stringify(
			NET2.name
		)}, nick: ${JSON.stringify(NET2.nick)}, saslAccount: ${JSON.stringify(
		NET2.account
	)}, saslPassword: ${JSON.stringify(NET2.password)}};
		all.push(second);
		localStorage.setItem("thelounge.networks", JSON.stringify(all));
		return [all[0].uuid, second.uuid];
	})()`);
	const [uuid1, uuid2] = uuids;

	// --- 1. two networks, two registrations, two subscriptions --------------
	before = await connectBoth(page);
	const sock1 = socketOf(page, before, NET1.account);
	const sock2 = socketOf(page, before, NET2.account);
	page.check(
		"1. both networks authenticated on their own sockets",
		Boolean(sock1 && sock2 && sock1 !== sock2)
	);
	const ep1 = await waitRegisterOn(page, before, sock1, "network 1's REGISTER");
	const ep2 = await waitRegisterOn(page, before, sock2, "network 2's REGISTER");
	page.check("1. each network registered its own endpoint", Boolean(ep1 && ep2) && ep1 !== ep2);
	page.check(
		"1. no network was told about the other's endpoint",
		!webpushOn(page, before, sock1).some((l) => l.includes(ep2)) &&
			!webpushOn(page, before, sock2).some((l) => l.includes(ep1))
	);
	let subs = await storedSubs(page);
	page.check(
		"1. two entries, keyed by network, each with the server's key",
		Object.keys(subs).sort().join() === [uuid1, uuid2].sort().join() &&
			subs[uuid1].vapid === vapid &&
			subs[uuid2].vapid === vapid &&
			subs[uuid1].endpoint === ep1 &&
			subs[uuid2].endpoint === ep2
	);
	const scopes = await registrationScopes(page);
	page.check(
		"1. one push-only registration per network, plus the root",
		scopes.includes(pushScope(ORIGIN, uuid1)) &&
			scopes.includes(pushScope(ORIGIN, uuid2)) &&
			scopes.includes(`${ORIGIN}/`)
	);
	page.check(
		"1. no prompt: permission granted",
		(await page.evaluate(`!(${promptOpened})`)) === true
	);
	await page.screenshot("1-two-networks");

	// --- 2. a rotation on network 2 prompts for it; renewing it spares 1 ----
	await rotateAway(page, ORIGIN, uuid2, "two");
	before = await connectBoth(page);
	const s1 = socketOf(page, before, NET1.account);
	const s2 = socketOf(page, before, NET2.account);
	await page.waitFor(promptOpened, {label: "the renew prompt for network 2"});
	const label = String(
		await page.evaluate(
			`document.querySelector("#push-prompt .push-prompt-target")?.textContent`
		)
	);
	page.check(
		"2. the prompt names the rotated network",
		label.includes(NET2.name) && label.includes(NET2.account) && !label.includes(NET1.account)
	);
	page.check(
		"2. network 1 re-registered its own endpoint meanwhile",
		webpushOn(page, before, s1).some(
			(l) =>
				l ===
				`WEBPUSH REGISTER ${ep1} p256dh=${subs[uuid1].keys.p256dh};auth=${subs[uuid1].keys.auth}`
		)
	);
	await page.screenshot("2-prompt-network-2");
	const mark = page.wsFrames.length;
	await page.waitFor(promptArmed, {label: "the prompt to take answers"});
	await page.click("#pushPromptYes");
	await waitFrame(
		page,
		mark,
		"out",
		new RegExp(`^WEBPUSH UNREGISTER ${ep2}$`),
		"network 2's old endpoint UNREGISTER"
	);
	const ep2b = await waitRegisterOn(page, mark, s2, "network 2's renewed REGISTER");
	await page.waitFor(promptGone, {label: "the prompt to close"});
	page.check(
		"2. the renewal went to network 2's socket",
		webpushOn(page, mark, s2).some((l) => l.startsWith(`WEBPUSH REGISTER ${ep2b} `)) &&
			ep2b !== ep2
	);
	page.check("2. network 1 heard nothing of it", webpushOn(page, mark, s1).length === 0);
	subs = await storedSubs(page);
	page.check(
		"2. network 1's entry is untouched, network 2's re-keyed",
		subs[uuid1].endpoint === ep1 &&
			subs[uuid1].vapid === vapid &&
			subs[uuid2].endpoint === ep2b &&
			subs[uuid2].vapid === vapid
	);
	page.check(
		"2. network 1's browser subscription is untouched",
		(await page.evaluate(
			`JSON.parse(localStorage.getItem(${JSON.stringify(
				`__fakePush:${pushScope(ORIGIN, uuid1)}`
			)})).endpoint`
		)) === ep1
	);
	await page.sleep(1500);
	page.check(
		"2. no second prompt: nothing swapped",
		(await page.evaluate(`!(${promptOpened})`)) === true
	);

	// --- 3. legacy map migrates ---------------------------------------------
	// Back to the world before per-network subscriptions: no push-only
	// registrations, one subscription on the root registration for the
	// server's key, and thelounge.push keyed by that key.
	const legacyEndpoint = "https://push.invalid/fake/legacy";
	await page.evaluate(`(async () => {
		for (const r of await navigator.serviceWorker.getRegistrations()) {
			if (/\\/push\\/[^/]+\\/$/.test(r.scope)) { await r.unregister(); localStorage.removeItem("__fakePush:" + r.scope); }
		}
		const keys = {p256dh: "BLEGACYp256dh", auth: "legacyauth"};
		localStorage.setItem("thelounge.push", JSON.stringify({[${JSON.stringify(
			vapid
		)}]: {endpoint: ${JSON.stringify(legacyEndpoint)}, keys}}));
		localStorage.setItem("__fakePush:" + ${JSON.stringify(
			`${ORIGIN}/`
		)}, JSON.stringify({endpoint: ${JSON.stringify(legacyEndpoint)}, key: ${JSON.stringify(
		vapid
	)}, p256dh: keys.p256dh, auth: keys.auth}));
		return true;
	})()`);
	before = await connectBoth(page);
	const t1 = socketOf(page, before, NET1.account);
	const t2 = socketOf(page, before, NET2.account);
	await waitFrame(
		page,
		before,
		"out",
		new RegExp(`^WEBPUSH UNREGISTER ${legacyEndpoint}$`),
		"the legacy endpoint's UNREGISTER"
	);
	const ep1c = await waitRegisterOn(
		page,
		before,
		t1,
		"network 1's fresh REGISTER after migration"
	);
	const ep2c = await waitRegisterOn(
		page,
		before,
		t2,
		"network 2's fresh REGISTER after migration"
	);
	page.check(
		"3. the legacy endpoint was unregistered",
		webpushOn(page, before, t1)
			.concat(webpushOn(page, before, t2))
			.some((l) => l === `WEBPUSH UNREGISTER ${legacyEndpoint}`)
	);
	page.check(
		"3. the root registration's subscription is gone",
		(await page.evaluate(
			`localStorage.getItem(${JSON.stringify(`__fakePush:${ORIGIN}/`)})`
		)) === null
	);
	page.check(
		"3. both networks subscribed again silently",
		(await page.evaluate(`!(${promptOpened})`)) === true && ep1c !== ep2c
	);
	subs = await storedSubs(page);
	page.check(
		"3. the map is per network again, nothing legacy left",
		Object.keys(subs).sort().join() === [uuid1, uuid2].sort().join() &&
			subs[uuid1].endpoint === ep1c &&
			subs[uuid2].endpoint === ep2c &&
			(await page.evaluate(`localStorage.getItem("thelounge.push.legacy")`)) === null
	);
	await page.screenshot("3-migrated");

	// --- 4. push off for network 2 unsubscribes it alone ---------------------
	const m4 = page.wsFrames.length;
	await page.evaluate(`location.hash = "#/edit-network/${uuid2}"`);
	await page.waitFor(`!!document.querySelector('input[name="pushEnabled"]')`, {
		label: "the push checkbox in Edit network",
	});

	for (const selector of ['input[name="pushEnabled"]', 'button[type="submit"]']) {
		await page.evaluate(
			`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block: "center"})`
		);
		await page.click(selector);
	}

	await waitFrame(
		page,
		m4,
		"out",
		new RegExp(`^WEBPUSH UNREGISTER ${ep2c}$`),
		"network 2's UNREGISTER on push off"
	);
	await page.waitFor(
		`navigator.serviceWorker.getRegistrations().then((rs) => !rs.some((r) => r.scope === ${JSON.stringify(
			pushScope(ORIGIN, uuid2)
		)}))`,
		{label: "network 2's registration to be dropped"}
	);
	page.check(
		"4. the UNREGISTER went on network 2's socket only",
		webpushOn(page, m4, t2).length === 1 && webpushOn(page, m4, t1).length === 0
	);
	subs = await storedSubs(page);
	page.check(
		"4. network 1 keeps its entry and registration",
		Object.keys(subs).join() === uuid1 &&
			subs[uuid1].endpoint === ep1c &&
			(await registrationScopes(page)).includes(pushScope(ORIGIN, uuid1))
	);
	await page.screenshot("4-network-2-off");

	// --- cleanup: network 1 off as well -------------------------------------
	const m5 = page.wsFrames.length;
	await page.evaluate(`location.hash = "#/edit-network/${uuid1}"`);
	await page.waitFor(`!!document.querySelector('input[name="pushEnabled"]')`, {
		label: "the push checkbox for network 1",
	});

	for (const selector of ['input[name="pushEnabled"]', 'button[type="submit"]']) {
		await page.evaluate(
			`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block: "center"})`
		);
		await page.click(selector);
	}

	await waitFrame(
		page,
		m5,
		"out",
		new RegExp(`^WEBPUSH UNREGISTER ${ep1c}$`),
		"network 1's cleanup UNREGISTER"
	);
	page.check("cleanup: nothing stored", Object.keys(await storedSubs(page)).length === 0);

	page.check("no console errors", page.consoleErrors.length === 0);
}
