// UI cleanup verification for the push-notification settings work:
//
//   pnpm build && python3 -m http.server -d public 8001 &
//   node tools/browser-drive.mjs tools/scenarios/ui-cleanup.mjs
//
// SEANCE_URL (default http://127.0.0.1:8001/) points it at another build;
// SEANCE_SASL_ACCOUNT / SEANCE_SASL_PASSWORD at another account (default
// pushtest1, the testnet's push test account).
//
// Checks, in a real browser against the testnet ircd (SASL + draft/webpush):
//   1. the connect-time "enable push notifications?" prompt appears once the
//      SASL'd registration completes on a push-capable network;
//   2. "No" closes it and it asks again on the next connect;
//   3. "Never" closes it and it stays closed across reloads (device-local);
//   4. the Settings → Notifications screen no longer renders the Session
//      panel (list / Refresh / Force logout are gone);
//   5. subscribed, Settings still only hints at the network editor (the
//      Push API is faked, lib/fake-push.mjs, with notifications granted —
//      headless Chromium has no FCM to make a real one). The snooze
//      row it used to measure is gone: do not disturb replaced it
//      (docs/projects/do-not-disturb.md).

import {FAKE_PUSH_API, pushScope, storedSubs, waitFrame} from "./lib/fake-push.mjs";

const ORIGIN = new URL(process.env.SEANCE_URL ?? "http://127.0.0.1:8001/").origin;
const ACCOUNT = process.env.SEANCE_SASL_ACCOUNT ?? "pushtest1";
const PASSWORD = process.env.SEANCE_SASL_PASSWORD ?? "pushtest1-pass";
const STORE = `document.querySelector("[data-v-app]").__vue_app__.config.globalProperties.$store`;

// A link never carries the password (link approval, helpers/linkTarget.ts):
// the first load fills it into the connect form, remembered, and every later
// load is the app's own URL, where the saved network autoconnects.
export const url =
	`${ORIGIN}/?host=127.0.0.1&port=8067&tls=false` +
	`&nick=puiclean&join=%23seance&sasl=plain&saslAccount=${encodeURIComponent(ACCOUNT)}`;

const frameText = (f) => (typeof f.payloadData === "string" ? f.payloadData : "");

/** Wait for the *next* registration after `before` (PERSISTENCE SET ON goes
 * out from onRegistered, so seeing one means SASL succeeded and the server
 * burst is done). */
async function waitRegistered(page, before) {
	await page.waitFor(`!!document.querySelector("#chat")`, {label: "the chat to render"});

	const deadline = Date.now() + 20000;

	while (Date.now() < deadline) {
		if (page.wsFrames.slice(before).some((f) => frameText(f).startsWith("PERSISTENCE"))) {
			return;
		}

		await page.sleep(100);
	}

	throw new Error("timed out waiting for the registration (PERSISTENCE SET)");
}

const promptOpened = `document.querySelector("#push-prompt-overlay")?.classList.contains("opened")`;
// A prompt takes no answer in its first moments (webpush.ts PROMPT_ARM_MS);
// `data-armed` marks it ready.
const promptArmed = `document.querySelector("#push-prompt[data-armed]") !== null`;

const openSettings = `(() => {
	const el = document.querySelector(".push-networks-hint");

	if (el) {
		const r = el.getBoundingClientRect();

		if (r.width > 0 && r.height > 0) {
			return true;
		}
	}

	location.hash = "#/settings/notifications";
	return false;
})()`;

export default async function run(page) {
	// --- pass 1: fresh profile, prompt appears, "No" closes it ------------
	let before = page.wsFrames.length;
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.fill('#connect input[name="saslPassword"]', PASSWORD);

	for (const name of ["rememberPassword", "autoconnect"]) {
		if (
			!(await page.evaluate(
				`document.querySelector('#connect input[name="${name}"]')?.checked ?? true`
			))
		) {
			await page.click(`#connect input[name="${name}"]`);
		}
	}

	await page.click('#connect button[type="submit"]');
	await waitRegistered(page, before);

	await page.waitFor(promptOpened, {label: "the push subscribe prompt to open"});
	await page.screenshot("1-prompt");
	page.check("prompt appears on a SASL'd connect to a webpush server", true);

	await page.waitFor(promptArmed, {label: "the prompt to take answers"});
	await page.click("#pushPromptNo");
	await page.waitFor(`!(${promptOpened})`, {label: "the prompt to close after No"});
	page.check("'No' closes the prompt", true);

	// --- pass 2: reload → "No" means it asks again -------------------------
	before = page.wsFrames.length;
	await page.goto(`${ORIGIN}/`, {waitForSelector: "#chat"});
	await waitRegistered(page, before);
	await page.waitFor(promptOpened, {label: "the prompt to ask again after 'No'"});
	page.check("'No' is not sticky: the prompt asks again on the next connect", true);

	await page.waitFor(promptArmed, {label: "the prompt to take answers"});
	await page.click("#pushPromptNever");
	await page.waitFor(`!(${promptOpened})`, {label: "the prompt to close after Never"});
	page.check("'Never' closes the prompt", true);

	// --- pass 3: reload → "Never" is sticky --------------------------------
	before = page.wsFrames.length;
	await page.goto(`${ORIGIN}/`, {waitForSelector: "#chat"});
	await waitRegistered(page, before);
	await page.sleep(1500); // give any (wrongly) shown prompt its moment
	await page.waitFor(`!(${promptOpened})`, {label: "the prompt to stay closed"});
	page.check("'Never' is sticky: no prompt after reload", true);

	// --- session panel removal --------------------------------------------
	await page.waitFor(openSettings, {label: "the settings window"});
	const sessionBits = await page.evaluate(
		`JSON.stringify({
			forceLogout: !!document.querySelector("#forceLogout"),
			refresh: !!document.querySelector("#refreshSessions"),
			list: !!document.querySelector("#sessionList"),
			empty: !!document.querySelector("#sessionEmpty"),
		})`
	);
	page.check(
		"the Session panel (list / Refresh / Force logout) is gone",
		sessionBits ===
			JSON.stringify({forceLogout: false, refresh: false, list: false, empty: false})
	);
	await page.screenshot("2-settings-unsubscribed");

	// --- subscribed (the faked Push API, permission granted) -------------
	// Never only stops the asking: forget it, grant the permission, and the
	// next connect subscribes without a prompt (webpush.ts).
	await page.evaluate(`localStorage.removeItem("thelounge.push.neverAsk")`);
	await page.grantPermissions(["notifications"], ORIGIN);
	await page.addInitScript(FAKE_PUSH_API);
	before = page.wsFrames.length;
	await page.goto(`${ORIGIN}/`, {waitForSelector: "#chat"});
	await waitRegistered(page, before);
	await page.waitFor(`${STORE}.state.pushNotificationState === "subscribed"`, {
		label: "push subscribed",
		timeout: 30000,
	});
	await page.waitFor(`!(${promptOpened})`, {label: "no prompt while subscribed"});
	await page.waitFor(openSettings, {label: "the settings window again"});

	await page.waitFor(
		`!!document.querySelector(".dnd-schedule") && ${STORE}.state.pushNotificationState === "subscribed"`,
		{label: "the notification settings, subscribed"}
	);

	// Enrollment moved into the network editor: the panel keeps only the
	// hint, the do-not-disturb schedule and the browser-level warnings - no
	// rows, no global toggle, no status dot.
	const pushPanel = await page.evaluate(
		`(() => JSON.stringify({
			rows: document.querySelectorAll(".push-network").length,
			hint: !!document.querySelector(".push-networks-hint"),
			toggle: !!document.querySelector("#pushNotifications"),
			dot: !!document.querySelector("#pushState"),
		}))()`
	);
	page.check(
		"push settings live in the network editor; Settings only hints",
		(() => {
			const parsed = JSON.parse(pushPanel);

			return parsed.rows === 0 && parsed.hint && !parsed.toggle && !parsed.dot;
		})()
	);

	await page.screenshot("3-settings-subscribed");

	// Leave the account with no endpoint: push off for the network
	// unsubscribes it and drops its registration (as push-renew.mjs ends).
	const uuid = await page.evaluate(
		`JSON.parse(localStorage.getItem("thelounge.networks"))[0].uuid`
	);
	const mark = page.wsFrames.length;
	await page.evaluate(`location.hash = "#/edit-network/${uuid}"`);
	await page.waitFor(`!!document.querySelector('input[name="pushEnabled"]')`, {
		label: "the push checkbox in Edit network",
	});

	for (const selector of ['input[name="pushEnabled"]', 'button[type="submit"]']) {
		await page.evaluate(
			`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block: "center"})`
		);
		await page.click(selector);
	}

	await waitFrame(page, mark, "out", /^WEBPUSH UNREGISTER /, "the cleanup UNREGISTER");
	await page.waitFor(
		`navigator.serviceWorker.getRegistrations().then((rs) => !rs.some((r) => r.scope === ${JSON.stringify(
			pushScope(ORIGIN, uuid)
		)}))`,
		{label: "the network's registration to be dropped"}
	);
	page.check(
		"cleanup: push off unsubscribed the network",
		Object.keys(await storedSubs(page)).length === 0
	);
}
