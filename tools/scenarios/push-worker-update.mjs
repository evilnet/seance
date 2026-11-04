// A network's push-only worker (`push/<uuid>/`) is updated by nothing unless
// the page asks: a worker re-checks its script on a navigation inside its
// scope (the page never navigates there), on a push event only when the last
// check is a day old, and on `register()` only when the script URL changed.
// Left alone, a device that subscribed before a deploy keeps running the old
// worker — the old notification actions, the old reply path — until a push
// arrives a day later, or for ever without one. So the page asks every stored
// network's registration to `update()` as it comes up (webpush.ts
// syncStoredWithBrowser), and again when a subscribe reuses a registration.
//
//   NODE_ENV=production pnpm build && python3 -m http.server -d public 8001 &
//   node tools/browser-drive.mjs tools/scenarios/push-worker-update.mjs [--chrome=…]
//
// Needs the testnet ircd on ws://127.0.0.1:8067 with the SASL account below.
// The network is seeded into `thelounge.networks` as a saved autoconnect
// network (a link may not carry a password, and an unknown server asks
// before connecting). The Push API is faked per registration
// (lib/fake-push.mjs); the workers, SASL and WEBPUSH on the wire are real.
// `ServiceWorkerRegistration.prototype.update` is wrapped to record the
// scopes it is called on.
//
// Claims under test:
//   1. the first visit subscribes the network (permission granted up front)
//      by creating its registration, not by updating one;
//   2. the next visit asks that registration to update before it
//      re-REGISTERs the stored subscription, and the check succeeds;
//   3. the root (shell) registration is left to the browser's own
//      navigation-time check;
//   4. no console errors.

import {FAKE_PUSH_API, pushScope, storedSubs, waitFrame} from "./lib/fake-push.mjs";

const ORIGIN = "http://127.0.0.1:8001";
const NET = {account: "pushtest1", password: "pushtest1-pass", nick: "pwu1"};
const UUID = "pwu-" + Math.random().toString(36).slice(2, 10);

export const url = `${ORIGIN}/`;

/** The saved network the scenario boots with: autoconnect, SASL, password kept. */
const SAVED_NETWORK = {
	uuid: UUID,
	name: "Push worker update",
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

/** Records every `update()` call on a registration: the scope when called,
 * the outcome once the check settled. */
const RECORD_UPDATES = `(() => {
	window.__swUpdates = [];
	const update = ServiceWorkerRegistration.prototype.update;
	ServiceWorkerRegistration.prototype.update = function () {
		const entry = {scope: this.scope, done: false, ok: null, error: null};
		window.__swUpdates.push(entry);
		return update.apply(this, arguments).then(
			(r) => { entry.done = true; entry.ok = true; return r; },
			(e) => { entry.done = true; entry.ok = false; entry.error = String(e); throw e; }
		);
	};
})()`;

const updates = (page) => page.evaluate(`JSON.stringify(window.__swUpdates)`).then(JSON.parse);

/** Load the app and wait until the network registered (PERSISTENCE SET);
 * re-grant and reload if the page did not see the permission as granted. */
async function visit(page, target) {
	for (let i = 0; i < 3; i++) {
		const before = page.wsFrames.length;
		await page.goto(target);
		await page.waitFor(`!!document.querySelector("#chat")`, {
			label: "the chat to render",
			timeout: 60000,
		});
		await waitFrame(page, before, "out", /^PERSISTENCE/, "the registration", 30000);

		if (await page.evaluate(`Notification.permission === "granted"`)) {
			return before;
		}

		await page.grantPermissions(["notifications"], ORIGIN);
	}

	throw new Error("the page never saw the notification permission as granted");
}

export default async function run(page) {
	await page.grantPermissions(["notifications"], ORIGIN);
	await page.addInitScript(FAKE_PUSH_API);
	await page.addInitScript(RECORD_UPDATES);

	// --- seed: a saved autoconnect network with its password kept ----------
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(
		`localStorage.setItem("thelounge.networks", ${JSON.stringify(
			JSON.stringify([SAVED_NETWORK])
		)})`
	);
	const uuid = UUID;

	// --- 1. first visit: the network subscribes, creating its registration --
	let before = await visit(page, page.url);
	await waitFrame(page, before, "out", /^WEBPUSH REGISTER /, "the first REGISTER", 30000);
	const scope = pushScope(ORIGIN, uuid);
	const subs = await storedSubs(page);
	page.check(
		"1. the first visit stored a subscription for the network",
		Boolean(subs[uuid] && subs[uuid].endpoint)
	);
	const first = await updates(page);
	page.check(
		"1. a fresh registration is created, not updated",
		!first.some((u) => u.scope === scope)
	);
	await page.screenshot("1-subscribed");

	// --- 2. next visit: the stored registration is asked to update ---------
	before = await visit(page, page.url);
	await waitFrame(page, before, "out", /^WEBPUSH REGISTER /, "the re-REGISTER", 30000);
	const second = await updates(page);
	const asked = second.find((u) => u.scope === scope);
	page.check("2. the next visit asks the network's push registration to update", Boolean(asked));
	await page
		.waitFor(
			`(window.__swUpdates || []).some((u) => u.scope === ${JSON.stringify(
				scope
			)} && u.done)`,
			{label: "the update check to settle", timeout: 15000}
		)
		.catch(() => {});
	const settled = (await updates(page)).find((u) => u.scope === scope);
	page.check(
		"2. the update check succeeded" + (settled && settled.error ? ` (${settled.error})` : ""),
		Boolean(settled && settled.done && settled.ok)
	);
	page.check(
		"3. the root registration is not asked (the navigation already checks it)",
		!second.some((u) => u.scope === `${ORIGIN}/`)
	);
	await page.screenshot("2-revisit");

	page.check("4. no console errors", page.consoleErrors.length === 0);

	if (page.consoleErrors.length > 0) {
		console.log(page.consoleErrors);
	}
}
