// Per-network push settings verification:
//
//   pnpm build && python3 -m http.server -d public 8100 &
//   node tools/browser-drive.mjs tools/scenarios/push-network-setting.mjs
//
// Push notification settings live in the network settings (some servers can
// push, others cannot — the networks are independent).  Checks, in a real
// browser against the testnet ircd (SASL + draft/webpush):
//   1. Edit network renders a checked "Push notifications for this network"
//      box by default (entries without the flag read as enabled);
//   2. unchecking + saving persists pushEnabled: false into
//      thelounge.networks and the Settings per-network row flips to "Off";
//   3. re-checking and saving flips it back (and the row reads Subscribed
//      once a fake subscription for the server's VAPID key is planted).

const IRCD = "ws://127.0.0.1:8067/";

export const url =
	`http://127.0.0.1:8100/?host=127.0.0.1&port=8067&tls=false` +
	`&nick=puinet&join=%23seance&sasl=plain&saslAccount=testaccount&saslPassword=mypassword` +
	`&autoconnect=1`;

const frameText = (f) => (typeof f.payloadData === "string" ? f.payloadData : "");

const promptOpened = `document.querySelector("#push-prompt-overlay")?.classList.contains("opened")`;

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

export default async function run(page) {
	let before = page.wsFrames.length;
	await page.goto(page.url);
	await page.waitFor(`!!document.querySelector("#chat")`, {
		label: "the chat to render",
		timeout: 60000,
	});
	await waitRegistered(page, before);

	// Keep the connect-time prompt out of the way for the rest of the run.
	await page.evaluate(`localStorage.setItem("thelounge.push.neverAsk", "1")`);

	// The uuid of the network the URL parameters just created/saved.
	const uuid = await page.evaluate(
		`JSON.parse(localStorage.getItem("thelounge.networks"))[0].uuid`
	);

	// The server's VAPID key, off the CAP LS line (for the fake subscription).
	const vapid = (() => {
		for (const f of page.wsFrames) {
			const m = frameText(f).match(/draft\/webpush=vapid=([A-Za-z0-9_-]+)/);

			if (m) {
				return m[1];
			}
		}

		return undefined;
	})();

	page.check("the server announced a VAPID key in CAP LS", Boolean(vapid));

	// --- 1. the edit form renders a checked push box by default -----------
	await page.goto(`http://127.0.0.1:8100/#/edit-network/${uuid}`);
	await page.waitFor(`!!document.querySelector('input[name="pushEnabled"]')`, {
		label: "the push checkbox to render in Edit network",
		timeout: 60000,
	});

	const boxState = await page.evaluate(
		`(() => {
			const box = document.querySelector('input[name="pushEnabled"]');
			const r = box.getBoundingClientRect();

			return JSON.stringify({checked: box.checked, visible: r.width > 0});
		})()`
	);
	page.check(
		"Edit network defaults the push checkbox to checked",
		boxState === JSON.stringify({checked: true, visible: true})
	);
	await page.screenshot("1-edit-network-checked");

	// --- 2. uncheck + save → stored flag false, settings row says Off ----
	await page.evaluate(`document.querySelector('input[name="pushEnabled"]').click()`);
	await page.evaluate(`document.querySelector('button[type="submit"]').click()`);
	await page.waitFor(`!JSON.parse(localStorage.getItem("thelounge.networks"))[0].pushEnabled`, {
		label: "pushEnabled to persist as false",
	});

	page.check("disabling a network persists as pushEnabled: false", true);
	await page.screenshot("2-disabled-persisted");

	// The old Settings rows are gone; only the hint remains.
	await page.evaluate(`location.hash = "#/settings/notifications"`);
	await page.waitFor(`!!document.querySelector(".push-networks-hint")`, {
		label: "the notifications settings hint to render",
	});
	page.check(
		"Settings no longer lists per-network push rows",
		(await page.evaluate(`document.querySelectorAll(".push-network-state").length`)) === 0 &&
			(await page.evaluate(`!document.querySelector("#pushState")`)) === true
	);
	await page.screenshot("2-settings-slimmed");

	// --- 3. re-enable; the flag flips back on ------------------------------
	await page.evaluate(`location.hash = "#/edit-network/${uuid}"`);
	await page.waitFor(`!!document.querySelector('input[name="pushEnabled"]')`, {
		label: "the push checkbox again",
	});
	await page.evaluate(`document.querySelector('input[name="pushEnabled"]').click()`);
	await page.evaluate(`document.querySelector('button[type="submit"]').click()`);
	await page.waitFor(
		`JSON.parse(localStorage.getItem("thelounge.networks"))[0].pushEnabled === true`,
		{label: "pushEnabled to persist as true again"}
	);
	page.check("re-enabling a network persists as pushEnabled: true", true);
	await page.screenshot("3-re-enabled");

	// --- 4. the add-network form: the option exists only with SASL on, and
	// defaults to enabled ("register when the server supports it") ---------
	await page.goto("http://127.0.0.1:8100/#/connect");
	await page.waitFor(`!!document.querySelector('input[name="sasl"]')`, {
		label: "the connect form to render",
	});
	page.check(
		"no push option without authentication configured",
		(await page.evaluate(`!!document.querySelector('input[name="pushEnabled"]')`)) === false
	);
	page.check(
		"browser notifications are offered without authentication",
		(await page.evaluate(`!!document.querySelector('input[name="notifyEnabled"]')`)) === true
	);
	await page.evaluate(`document.querySelector('input[name="sasl"]').click()`);
	await page.waitFor(`!!document.querySelector('input[name="pushEnabled"]')`, {
		label: "the push checkbox to render once SASL is selected",
	});
	const connectBox = await page.evaluate(
		`(() => {
			const box = document.querySelector('input[name="pushEnabled"]');
			const r = box.getBoundingClientRect();

			return JSON.stringify({checked: box.checked, visible: r.width > 0});
		})()`
	);
	page.check(
		"the add-network form defaults push to enabled (connect-if-available)",
		connectBox === JSON.stringify({checked: true, visible: true})
	);
	await page.screenshot("4-connect-form-default-on");

	// The browser-notifications checkbox stays when SASL goes off (it is
	// not gated on authentication), while push disappears with it.
	await page.evaluate(`document.querySelector('input[name="sasl"]').click()`);
	await page.sleep(200);
	page.check(
		"browser notifications stay offered when SASL is off",
		(await page.evaluate(`!!document.querySelector('input[name="notifyEnabled"]')`)) === true &&
			(await page.evaluate(`!!document.querySelector('input[name="pushEnabled"]')`)) === false
	);

	// --- 5. auto-subscribe: with notification permission pre-granted, a
	// fresh connect subscribes WITHOUT the prompt (headless has no FCM, so
	// the attempt ends in the "blocked" state - which is the proof it fired).
	await page.evaluate(`localStorage.removeItem("thelounge.push")`);
	await page.grantPermissions(["notifications"], "http://127.0.0.1:8100");
	await page.goto(page.url);
	await page.waitFor(`!!document.querySelector("#chat")`, {
		label: "the chat to render (auto-subscribe pass)",
		timeout: 60000,
	});
	// The CDP grant can lose the race with the app's early connect: make
	// sure the page itself sees "granted" (re-grant + reload if not), so
	// the auto-subscribe branch of maybePrompt is what we are exercising.
	for (let i = 0; i < 3; i++) {
		if (await page.evaluate(`Notification.permission === "granted"`)) {
			break;
		}

		await page.grantPermissions(["notifications"], "http://127.0.0.1:8100");
		await page.evaluate(`location.reload()`);
		await page.waitFor(`!!document.querySelector("#chat")`, {timeout: 60000});
	}

	page.check(
		"notification permission is granted to the page",
		await page.evaluate(`Notification.permission === "granted"`)
	);
	let before2 = page.wsFrames.length;
	await waitRegistered(page, before2);
	await page.waitFor(`!(${promptOpened})`, {label: "no prompt when permission is granted"});
	page.check(
		"auto-subscribe: no prompt while permission is granted and enabled",
		(await page.evaluate(`!(${promptOpened})`)) === true
	);
	await page.screenshot("5-auto-subscribe");

	// Leave the profile clean.
	await page.evaluate(`localStorage.removeItem("thelounge.push")`);
	await page.evaluate(`localStorage.removeItem("thelounge.push.neverAsk")`);
}
