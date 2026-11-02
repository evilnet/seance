// Push subscription (draft/webpush) round-trip, end to end in a real browser.
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   (testnet ircd with CAP_draft_webpush + SASLDB — see
//   docs/projects/push-subscription.md; the ports below assume it)
//   node tools/browser-drive.mjs tools/scenarios/webpush-subscribe.mjs
//
// Phase-1 claim under test (docs/projects/push-subscription.md, verification
// step 4): the Settings toggle drives the real lifecycle — clicking Subscribe
// puts a `WEBPUSH REGISTER <endpoint> p256dh=…;auth=…` on the wire, the
// server's `WEBPUSH REGISTER <endpoint>` echo flips the state to subscribed,
// and Unsubscribe puts `WEBPUSH UNREGISTER` on the wire and lands its echo.
// The browser push subscription is created by the real PushManager (Chrome
// talks to its push service); only the permission prompt is stubbed, because
// headless has no UI for it. Delivery (a service-worker `push` handler) is
// phase 2 — see notifications.md.

const IRCD = "ws://127.0.0.1:8067/";

export const url =
	`http://127.0.0.1:8000/?host=127.0.0.1&port=8067&tls=false` +
	`&nick=pwsub&join=%23seance&sasl=plain&saslAccount=testaccount&saslPassword=mypassword` +
	`&autoconnect=1`;

const frameText = (f) => (typeof f.payloadData === "string" ? f.payloadData : "");

/** Poll a Node-side condition, reading `page.wsFrames` between sleeps. */
async function waitUntil(page, what, test, timeoutMs = 20000) {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		if (test()) {
			return;
		}

		await page.sleep(100);
	}

	throw new Error(`timed out waiting for ${what}`);
}

export default async function run(page) {
	await page.goto(page.url, {waitForSelector: "#chat"});
	// Let registration settle: SASL, init, and the channel list are all in.
	await page.waitFor(`!!document.querySelector("#sidebar .channel-list-item")`, {
		label: "the sidebar to list networks",
	});

	// Headless has no permission prompt: grant the notifications permission
	// through the browser's own permission store (CDP), the way Puppeteer
	// does. Everything else on this page — PushManager, service worker,
	// VAPID key — stays real.
	await page.send("Browser.grantPermissions", {
		permissions: ["notifications"],
		origin: "http://127.0.0.1:8000",
	});
	await page.evaluate(`Notification.requestPermission = () => Promise.resolve("granted")`);

	// init.ts's own navigation to the active channel can land after ours and
	// pull the route back to #seance, so keep asking until the settings
	// window with the push toggle is actually on screen.
	const openSettings = `(() => {
		const btn = document.querySelector("#pushNotifications");

		if (btn) {
			const r = btn.getBoundingClientRect();
			if (r.width > 0 && r.height > 0) {
				return true;
			}
		}

		location.hash = "#/settings/notifications";
		return false;
	})()`;
	await page.waitFor(openSettings, {label: "the settings window with the push toggle"});

	const buttonBefore = await page.evaluate(
		`document.querySelector("#pushNotifications").textContent.trim()`
	);
	page.check(
		"subscribe is offered once a webpush server is connected",
		buttonBefore === "Subscribe to push notifications"
	);
	await page.screenshot("1-settings-notifications");

	// --- subscribe ----------------------------------------------------------
	await page.click("#pushNotifications");

	await waitUntil(page, "the WEBPUSH REGISTER frame to go out", () =>
		page.wsFrames.some((f) => f.dir === "out" && frameText(f).startsWith("WEBPUSH REGISTER "))
	);
	page.check("WEBPUSH REGISTER went out on the wire", true);

	await waitUntil(page, "the server's WEBPUSH REGISTER echo", () =>
		page.wsFrames.some((f) => f.dir === "in" && frameText(f).startsWith("WEBPUSH REGISTER "))
	);
	page.check("the server echoed WEBPUSH REGISTER", true);

	await page.waitFor(`!!document.querySelector("#pushSubscribed")`, {
		label: "the subscribed state to render",
	});
	await page.screenshot("2-subscribed");

	// --- unsubscribe --------------------------------------------------------
	await page.click("#pushNotifications");

	await waitUntil(page, "the WEBPUSH UNREGISTER frame to go out", () =>
		page.wsFrames.some((f) => f.dir === "out" && frameText(f).startsWith("WEBPUSH UNREGISTER"))
	);
	page.check("WEBPUSH UNREGISTER went out on the wire", true);

	await waitUntil(page, "the server's WEBPUSH UNREGISTER echo", () =>
		page.wsFrames.some((f) => f.dir === "in" && frameText(f).startsWith("WEBPUSH UNREGISTER"))
	);
	page.check("the server echoed WEBPUSH UNREGISTER", true);

	await page.waitFor(
		`document.querySelector("#pushNotifications").textContent.includes("Subscribe to push")`,
		{label: "the toggle to return to its subscribe label"}
	);

	console.log("  webpush subscription lifecycle verified in the browser");
}
