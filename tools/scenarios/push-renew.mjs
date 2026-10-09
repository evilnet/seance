// VAPID rotation recovery (draft/webpush): the renew prompt and the
// pushKeyChange policies, end to end in a real browser against the testnet
// ircd (SASL + draft/webpush), on one network.
//
//   npx webpack && python3 -m http.server -d public 8001 &
//   node tools/browser-drive.mjs tools/scenarios/push-renew.mjs [--chrome=…]
//
// Headless Chromium has no push service, so the Push API is faked per
// service-worker registration (lib/fake-push.mjs); everything else — the
// workers, SASL, WEBPUSH on the wire — is real.
//
// Claims under test (docs/projects/push-subscription.md § VAPID rotation,
// push-per-network.md):
//   1. with permission granted, a fresh connect subscribes silently on the
//      network's own registration (`push/<uuid>/`) and registers with the
//      server under its announced key;
//   2. once the entry matches no announced key, the connect opens the prompt
//      in its `renew` variant, naming the network, instead of renewing
//      silently;
//   3. "No" closes it; Settings reports the stale subscription and points at
//      the network's settings, whose Renew button recreates the subscription
//      (old endpoint unregistered, new one registered, entry re-keyed); the
//      prompt returns on the next connect;
//   4. "Never" flips the pushKeyChange setting to "ignore" and no later
//      connect prompts (the subscribe prompt's own never-flag stays untouched);
//   5. back on "ask", "Yes" does what the Renew button does;
//   6. the connect after a renewal re-registers the new endpoint and asks
//      nothing;
//   7. on "trust" a rotation is renewed on the spot, no prompt.
// The run ends by turning push off for the network, which unsubscribes it
// and drops its registration, so the account keeps none of the endpoints.

import {
	FAKE_ENDPOINT,
	FAKE_PUSH_API,
	announcedVapid,
	getSetting,
	pushScope,
	registrationScopes,
	rotateAway,
	setSetting,
	storedSubs,
	waitFrame,
	webpushOut,
} from "./lib/fake-push.mjs";

const ORIGIN = "http://127.0.0.1:8001";
const ACCOUNT = "pushtest1";
const PASSWORD = "pushtest1-pass";

export const url =
	`${ORIGIN}/?host=127.0.0.1&port=8067&tls=false` +
	`&nick=pwren&join=%23seance&sasl=plain&saslAccount=${ACCOUNT}&saslPassword=${PASSWORD}` +
	`&autoconnect=1`;

const promptOpened = `document.querySelector("#push-prompt-overlay")?.classList.contains("opened")`;
// A prompt takes no answer in its first moments (webpush.ts PROMPT_ARM_MS);
// `data-armed` marks it ready.
const promptArmed = `document.querySelector("#push-prompt[data-armed]") !== null`;
/** The overlay fades out over 0.2 s and swallows clicks until it is hidden. */
const promptGone = `getComputedStyle(document.querySelector("#push-prompt-overlay")).visibility === "hidden"`;

/** Wait for the *next* registration after `before` (PERSISTENCE SET ON goes
 * out from onRegistered, so seeing one means SASL succeeded). */
async function waitRegistered(page, before) {
	await page.waitFor(`!!document.querySelector("#chat")`, {
		label: "the chat to render",
		timeout: 60000,
	});
	await waitFrame(page, before, "out", /^PERSISTENCE/, "the registration (PERSISTENCE SET)");
}

/** Load `target`, wait for the registration, and make sure this document
 * sees the notification permission as granted: the CDP grant can lose the
 * race with the app's early connect (re-grant + reload until it sticks —
 * `Notification.requestPermission()` would otherwise hang headless, with
 * no prompt to answer). Returns the frame index the load started at. */
async function connect(page, target) {
	let before = page.wsFrames.length;
	await page.goto(target);
	await waitRegistered(page, before);

	for (let i = 0; i < 3; i++) {
		if (await page.evaluate(`Notification.permission === "granted"`)) {
			return before;
		}

		await page.grantPermissions(["notifications"], ORIGIN);
		before = page.wsFrames.length;
		await page.evaluate(`location.reload()`);
		await waitRegistered(page, before);
	}

	throw new Error("the page never saw the notification permission as granted");
}

/** The network's entry is for the server's key and the given endpoint. */
const entryIs = (subs, uuid, vapid, endpoint) =>
	Object.keys(subs).join() === uuid &&
	subs[uuid].vapid === vapid &&
	subs[uuid].endpoint === endpoint;

export default async function run(page) {
	await page.grantPermissions(["notifications"], ORIGIN);
	await page.addInitScript(FAKE_PUSH_API);

	// --- 1. fresh profile, permission granted: silent subscribe ------------
	let before = await connect(page, page.url);
	const vapid = announcedVapid(page);
	page.check("the server announced a VAPID key in CAP LS", Boolean(vapid));

	// The uuid of the network the URL parameters just created/saved.
	const uuid = await page.evaluate(
		`JSON.parse(localStorage.getItem("thelounge.networks"))[0].uuid`
	);

	await waitFrame(
		page,
		before,
		"out",
		new RegExp(`^WEBPUSH REGISTER ${FAKE_ENDPOINT(1)} `),
		"the first WEBPUSH REGISTER"
	);
	await waitFrame(
		page,
		before,
		"in",
		new RegExp(`WEBPUSH REGISTER ${FAKE_ENDPOINT(1)}`),
		"the server's WEBPUSH REGISTER echo"
	);
	page.check(
		"1. permission granted: subscribed without a prompt",
		(await page.evaluate(`!(${promptOpened})`)) === true
	);
	let subs = await storedSubs(page);
	page.check(
		"1. the entry is keyed by the network and carries the server's key",
		entryIs(subs, uuid, vapid, FAKE_ENDPOINT(1))
	);
	page.check(
		"1. the network got its own service-worker registration",
		(await registrationScopes(page)).includes(pushScope(ORIGIN, uuid))
	);
	await page.screenshot("1-subscribed");

	// Later passes reload the plain origin: the saved entry autoconnects
	// with its remembered password instead of the URL minting a network.
	await page.evaluate(`(() => {
		const all = JSON.parse(localStorage.getItem("thelounge.networks"));
		Object.assign(all[0], {autoconnect: true, rememberPassword: true, saslPassword: ${JSON.stringify(
			PASSWORD
		)}});
		localStorage.setItem("thelounge.networks", JSON.stringify(all));
		return all.length;
	})()`);

	// --- 2. the server rotated its key: the renew prompt ------------------
	await rotateAway(page, ORIGIN, uuid, "one");
	before = await connect(page, `${ORIGIN}/`);
	await page.waitFor(promptOpened, {label: "the prompt after a key rotation"});
	page.check(
		"2. the prompt is the renew variant",
		(await page.evaluate(
			`document.querySelector("#push-prompt")?.classList.contains("renew")`
		)) === true
	);
	page.check(
		"2. the title says renew",
		String(
			await page.evaluate(
				`document.querySelector("#push-prompt .confirm-text-title")?.textContent`
			)
		).includes("Renew")
	);
	page.check("2. nothing was renewed on its own", webpushOut(page, before).length === 0);
	const label = String(
		await page.evaluate(
			`document.querySelector("#push-prompt .push-prompt-target")?.textContent`
		)
	);
	page.check(
		"2. the prompt names the network's server and account",
		label.includes("127.0.0.1:8067") && label.includes(ACCOUNT)
	);
	await page.screenshot("2-renew-prompt");

	// --- 3. "No": closed, Settings says stale, Renew in Edit network works --
	await page.waitFor(promptArmed, {label: "the prompt to take answers"});
	await page.click("#pushPromptNo");
	await page.waitFor(promptGone, {label: "the prompt to close on No"});
	page.check("3. No sends nothing", webpushOut(page, before).length === 0);

	await page.evaluate(`location.hash = "#/settings/notifications"`);
	await page.waitFor(`!!document.querySelector("#pushStale")`, {
		label: "the stale warning in Settings",
	});
	page.check(
		"3. Settings hides the snooze row while stale",
		(await page.count(".push-snooze")) === 0
	);
	page.check(
		"3. Settings points at the network settings instead of renewing itself",
		(await page.count("#pushRenew")) === 0 &&
			String(
				await page.evaluate(`document.querySelector("#pushStale").textContent`)
			).includes("network's settings")
	);
	await page.screenshot("3-settings-stale");

	await page.evaluate(`location.hash = "#/edit-network/${uuid}"`);
	await page.waitFor(`!!document.querySelector("#pushRenew")`, {
		label: "the Renew button in Edit network",
	});
	await page.evaluate(`document.querySelector("#pushRenew").scrollIntoView({block: "center"})`);
	await page.screenshot("3b-edit-network-stale");
	page.check(
		"3. the Renew button is what a click at its centre hits",
		(await page.evaluate(`(() => {
			const r = document.querySelector("#pushRenew").getBoundingClientRect();
			const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
			return Boolean(el && el.closest("#pushRenew"));
		})()`)) === true
	);
	let mark = page.wsFrames.length;
	await page.click("#pushRenew");
	await waitFrame(
		page,
		mark,
		"out",
		new RegExp(`^WEBPUSH UNREGISTER ${FAKE_ENDPOINT(1)}$`),
		"the old endpoint's UNREGISTER (Renew button)"
	);
	await waitFrame(
		page,
		mark,
		"out",
		new RegExp(`^WEBPUSH REGISTER ${FAKE_ENDPOINT(2)} `),
		"the new endpoint's REGISTER (Renew button)"
	);
	await waitFrame(
		page,
		mark,
		"in",
		new RegExp(`WEBPUSH REGISTER ${FAKE_ENDPOINT(2)}`),
		"the server's echo for the renewed endpoint"
	);
	subs = await storedSubs(page);
	page.check(
		"3. Renew re-keyed the entry to the server's key",
		entryIs(subs, uuid, vapid, FAKE_ENDPOINT(2))
	);
	await page.waitFor(`!document.querySelector("#pushStaleRow")`, {
		label: "the Renew row to leave the form",
	});
	await page.evaluate(`location.hash = "#/settings/notifications"`);
	await page.waitFor(`!!document.querySelector(".push-snooze")`, {
		label: "Settings back to subscribed",
	});
	page.check("3. the stale warning is gone", (await page.count("#pushStale")) === 0);
	await page.screenshot("4-settings-renewed");

	await rotateAway(page, ORIGIN, uuid, "two");
	before = await connect(page, `${ORIGIN}/`);
	await page.waitFor(promptOpened, {label: "the prompt again after No"});
	page.check("3. No: asked again on the next connect", true);

	// --- 4. "Never": the setting flips to ignore, no prompt on later connects
	await page.waitFor(promptArmed, {label: "the prompt to take answers"});
	await page.click("#pushPromptNever");
	await page.waitFor(
		`JSON.parse(localStorage.getItem("settings") || "{}").pushKeyChange === "ignore"`,
		{label: "the pushKeyChange setting to read ignore"}
	);
	page.check(
		"4. Never leaves the subscribe prompt's own flag alone",
		(await page.evaluate(`localStorage.getItem("thelounge.push.neverAsk")`)) === null
	);

	before = await connect(page, `${ORIGIN}/`);
	await page.sleep(2000);
	page.check(
		"4. Never: no prompt on the next connect",
		(await page.evaluate(`!(${promptOpened})`)) === true
	);
	page.check("4. Never: nothing renewed on its own", webpushOut(page, before).length === 0);
	await page.screenshot("5-never-no-prompt");

	// The Settings page shows the choice, reversible there.
	await page.evaluate(`location.hash = "#/settings/notifications"`);
	await page.waitFor(`!!document.querySelector('input[name="pushKeyChange"][value="ignore"]')`, {
		label: "the push identity radios in Settings",
	});
	page.check(
		"4. Settings shows Suspicious selected",
		(await page.evaluate(
			`document.querySelector('input[name="pushKeyChange"][value="ignore"]').checked`
		)) === true
	);
	await page.screenshot("5b-settings-suspicious");

	// --- 5. back on ask: "Yes" ------------------------------------------------
	await setSetting(page, "pushKeyChange", "ask");
	before = await connect(page, `${ORIGIN}/`);
	await page.waitFor(promptOpened, {label: "the prompt once the flag is cleared"});
	mark = page.wsFrames.length;
	await page.waitFor(promptArmed, {label: "the prompt to take answers"});
	await page.click("#pushPromptYes");
	await waitFrame(
		page,
		mark,
		"out",
		new RegExp(`^WEBPUSH UNREGISTER ${FAKE_ENDPOINT(2)}$`),
		"the old endpoint's UNREGISTER (Yes)"
	);
	await waitFrame(
		page,
		mark,
		"out",
		new RegExp(`^WEBPUSH REGISTER ${FAKE_ENDPOINT(3)} `),
		"the new endpoint's REGISTER (Yes)"
	);
	await waitFrame(
		page,
		mark,
		"in",
		new RegExp(`WEBPUSH REGISTER ${FAKE_ENDPOINT(3)}`),
		"the server's echo (Yes)"
	);
	await page.waitFor(promptGone, {label: "the prompt to close on Yes"});
	subs = await storedSubs(page);
	page.check(
		"5. Yes re-keyed the entry to the server's key",
		entryIs(subs, uuid, vapid, FAKE_ENDPOINT(3))
	);
	page.check(
		"5. the browser subscription was recreated under the server's key",
		(await page.evaluate(
			`JSON.parse(localStorage.getItem(${JSON.stringify(
				`__fakePush:${pushScope(ORIGIN, uuid)}`
			)})).key`
		)) === vapid
	);
	await page.screenshot("6-renewed-by-yes");

	// --- 6. the next connect after Yes is quiet: the renewed subscription
	// matches the announced key, so it is re-registered and nobody is asked.
	before = await connect(page, `${ORIGIN}/`);
	await waitFrame(
		page,
		before,
		"out",
		new RegExp(`^WEBPUSH REGISTER ${FAKE_ENDPOINT(3)} `),
		"the renewed endpoint's re-REGISTER on the next connect"
	);
	await page.sleep(1500);
	page.check(
		"6. no prompt on the connect after Yes",
		(await page.evaluate(`!(${promptOpened})`)) === true
	);
	page.check(
		"6. the entry still carries the server's key",
		entryIs(await storedSubs(page), uuid, vapid, FAKE_ENDPOINT(3))
	);

	// --- 7. "trust": a rotation is renewed on the spot, nobody is asked -----
	await setSetting(page, "pushKeyChange", "trust");
	await rotateAway(page, ORIGIN, uuid, "three");
	before = await connect(page, `${ORIGIN}/`);
	await waitFrame(
		page,
		before,
		"out",
		new RegExp(`^WEBPUSH UNREGISTER ${FAKE_ENDPOINT(3)}$`),
		"the old endpoint's UNREGISTER (trust)"
	);
	await waitFrame(
		page,
		before,
		"out",
		new RegExp(`^WEBPUSH REGISTER ${FAKE_ENDPOINT(4)} `),
		"the new endpoint's REGISTER (trust)"
	);
	page.check("7. trust: no prompt", (await page.evaluate(`!(${promptOpened})`)) === true);
	page.check(
		"7. trust: the entry was re-keyed on its own",
		entryIs(await storedSubs(page), uuid, vapid, FAKE_ENDPOINT(4))
	);
	page.check(
		"7. trust: the setting reads back",
		(await getSetting(page, "pushKeyChange")) === "trust"
	);
	await page.screenshot("7-trusting");

	// --- cleanup: push off for the network → unsubscribed, registration gone
	mark = page.wsFrames.length;
	await page.evaluate(`location.hash = "#/edit-network/${uuid}"`);
	await page.waitFor(`!!document.querySelector('input[name="pushEnabled"]')`, {
		label: "the push checkbox in Edit network",
	});

	// The form is longer than the viewport: bring each control on screen
	// before the real click (a click outside the viewport hits nothing).
	for (const selector of ['input[name="pushEnabled"]', 'button[type="submit"]']) {
		await page.evaluate(
			`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block: "center"})`
		);
		await page.click(selector);
	}

	await waitFrame(
		page,
		mark,
		"out",
		new RegExp(`^WEBPUSH UNREGISTER ${FAKE_ENDPOINT(4)}$`),
		"the cleanup UNREGISTER"
	);
	await page.waitFor(
		`navigator.serviceWorker.getRegistrations().then((rs) => !rs.some((r) => r.scope === ${JSON.stringify(
			pushScope(ORIGIN, uuid)
		)}))`,
		{label: "the network's registration to be dropped"}
	);
	page.check(
		"cleanup: push off unsubscribed the network and dropped its registration",
		Object.keys(await storedSubs(page)).length === 0
	);

	page.check("no console errors", page.consoleErrors.length === 0);
}
