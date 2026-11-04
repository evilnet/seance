// A reload on the settings page (or help) brings the saved networks back —
// and leaves the page where it was — end to end in a real browser
// (client/js/boot.ts, socket-events/network.ts, socket-events/init.ts).
//
//   pnpm build && python3 -m http.server -d public 8001 &
//   node tools/browser-drive.mjs tools/scenarios/reload-on-settings.mjs
//
// The default target is a plain-WS ircd on 127.0.0.1:8067 (the testnet rig,
// or the dev ircd's ws:// port). Against the dev ircd over TLS:
//   node tools/browser-drive.mjs tools/scenarios/reload-on-settings.mjs \
//     --url='http://localhost:8000/?host=localhost&port=8443&tls=true&nick=roswatch&join=%23seance'
//
// The claims under test are what `pnpm test` cannot see: that the saved
// networks flagged autoconnect are dialed at boot whatever page the URL
// opened on (they used to be dialed by the connect form when it mounted, so
// a reload on settings showed an empty sidebar until "Add network" was
// pressed), that a page the user opened on purpose keeps the view through
// the network's announce and its registration, that the sidebar it fills is
// live, and that a plain reload still lands on the remembered conversation.
// One browser profile is used throughout: localStorage has to survive the
// reloads, that is the point.

const RUN = Date.now().toString(36);
const NICK = `ros${RUN}`;
const BASE = "http://localhost:8001/";

export const url = `${BASE}?host=127.0.0.1&port=8067&tls=false&nick=${NICK}&join=%23seance`;

/** Name of the conversation the chat window shows, or null. */
const ACTIVE = `(document.querySelector("#chat-container")?.dataset.currentChannel ?? null)`;
const STORED = `localStorage.getItem("thelounge.state.lastChannel")`;
const HASH = `location.hash`;
const NETWORKS = `document.querySelectorAll("#sidebar .network").length`;
const joined = (name) =>
	`!!document.querySelector('.channel-list-item[data-name="${name}"]:not(.parted-channel)')`;
const item = (name) => `.channel-list-item[data-name="${name}"]`;

export default async function run(page) {
	const stored = async () => JSON.parse((await page.evaluate(STORED)) ?? "null");
	/** True when `expr` becomes truthy within `timeout` ms; a check, not an abort. */
	const eventually = async (expr, timeout, label) => {
		try {
			await page.waitFor(expr, {timeout, label});
			return true;
		} catch {
			return false;
		}
	};
	// What F5 does on that page: put the address in place and reload.
	// (`Page.navigate` to a URL that differs only by its fragment is a
	// same-document navigation — no reload, no boot — and a hop through
	// about:blank swaps renderer processes, which on a busy box loses the
	// DevTools reply to a poll in flight and hangs the driver.) A marker on
	// the old window tells the new document apart from the one being
	// replaced; evaluate fails while the swap is under way, so it polls on.
	const coldLoad = async (path, waitForSelector) => {
		await page.evaluate(
			`(() => { window.__coldLoad = true; history.replaceState(null, "", ${JSON.stringify(
				path
			)}); })()`
		);
		await page.send("Page.reload");
		const started = Date.now();

		for (;;) {
			try {
				if (
					await page.evaluate(
						`!window.__coldLoad && !!document.querySelector(${JSON.stringify(
							waitForSelector
						)})`
					)
				) {
					return;
				}
			} catch {
				// the document is being replaced
			}

			if (Date.now() - started > 20000) {
				throw new Error(`timed out waiting for ${waitForSelector} after reloading ${path}`);
			}

			await page.sleep(150);
		}
	};

	// 1. First connect through the form, autoconnect on so a reload brings
	//    the network back by itself.
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.click('#connect input[name="autoconnect"]');
	await page.click('#connect button[type="submit"]');
	await page.waitFor(joined("#seance"), {timeout: 20000, label: "joined #seance"});
	await page.sleep(300);
	page.check("lands on #seance", (await page.evaluate(ACTIVE)) === "#seance");
	page.check("remembers it", (await stored())?.target === "#seance");
	await page.screenshot("1-first-connect");

	// 2. A cold load on the settings page: the network is announced at boot,
	//    so it is in the sidebar before anything comes back from the server,
	//    it rejoins, and the view stays on settings through the announce and
	//    the registration (`init`).
	await coldLoad("/#/settings", "#settings");
	page.check(
		"network listed on settings at once",
		await eventually(`${NETWORKS} === 1`, 3000, "network in the sidebar")
	);
	page.check(
		"rejoined #seance from settings",
		await eventually(joined("#seance"), 20000, "rejoined #seance")
	);
	await page.sleep(1500);
	page.check(
		"still on settings after the join burst",
		String(await page.evaluate(HASH)).startsWith("#/settings") &&
			(await page.count("#settings")) === 1
	);
	page.check("no chat window opened", (await page.evaluate(ACTIVE)) === null);
	page.check("memory untouched by settings", (await stored())?.target === "#seance");
	await page.screenshot("2-settings-reload");

	// 3. The sidebar it filled is live once the modal is out of the way:
	// settings is a modal over the whole app now, so leave it through its
	// Done button first, then open the channel from the sidebar.
	await page.click(".settings-modal-done");
	await page.waitFor(`!document.querySelector(".settings-modal")`, {label: "settings closed"});
	await page.click(item("#seance"));
	await page.waitFor(`${ACTIVE} === "#seance"`, {label: "opened #seance from the sidebar"});

	// 4. Same on help.
	await coldLoad("/#/help", "#help");
	page.check(
		"network listed on help at once",
		await eventually(`${NETWORKS} === 1`, 3000, "network in the sidebar")
	);
	page.check(
		"rejoined #seance from help",
		await eventually(joined("#seance"), 20000, "rejoined #seance")
	);
	await page.sleep(1500);
	page.check(
		"still on help after the join burst",
		(await page.evaluate(HASH)) === "#/help" && (await page.count("#help")) === 1
	);
	await page.screenshot("3-help-reload");

	// 5. A plain reload has nowhere better to be than the remembered
	//    conversation: it lands there, as before.
	await coldLoad("/", "#chat-container");
	page.check(
		"plain reload lands on #seance",
		await eventually(`${ACTIVE} === "#seance"`, 3000, "on #seance")
	);
	await page.waitFor(joined("#seance"), {timeout: 20000, label: "rejoined #seance again"});
	await page.sleep(300);
	page.check(
		"still on #seance after the join burst",
		(await page.evaluate(ACTIVE)) === "#seance"
	);
	await page.screenshot("4-plain-reload");

	page.check("no console errors", page.consoleErrors.length === 0);
}
