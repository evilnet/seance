// The Account page (`features.editNetworks: false` on a sign-in deploy) end
// to end in a real browser: Settings → Networks with no list, no edit form
// and no delete — the one network, who this device signs in as, Connect or
// Disconnect, and Sign in or Sign out.
//
// A successful sign-in needs services, so this runs against the e-testnet
// (~/afternet/e-testnet: ws:// on 18067, SASL seance1/seancepass1). The
// config is read at boot, so a copy of the built tree with its own
// config.json is enough — public/ itself stays as it is:
//
//   pnpm build
//   rm -rf /tmp/account-page && cp -r public /tmp/account-page
//   cat > /tmp/account-page/config.json <<'JSON'
//   {
//     "appName": "TestNet",
//     "defaultNetwork": {
//       "name": "TestNet",
//       "host": "127.0.0.1",
//       "port": 18067,
//       "tls": false,
//       "channels": ["#seance"],
//       "nick": "guest????"
//     },
//     "features": {"signIn": true, "multiNetwork": false, "editNetworks": false}
//   }
//   JSON
//   python3 -m http.server -d /tmp/account-page 8023 &
//   node tools/browser-drive.mjs tools/scenarios/account-page.mjs
//
// SEANCE_ACCOUNT / SEANCE_PASSWORD pick other credentials. What it pins
// down:
//
//   * the gear on the lobby row opens the Account page, and the tab is
//     called Account;
//   * the page offers no edit link and no delete, and the edit form's own
//     address lands back on the page; the lobby's context menu has neither
//     "Edit this network…" nor Remove, but still Connect/Disconnect;
//   * a guest sees "Guest: <nick>", Disconnect / Connect work from the page;
//   * Sign in from a live guest session ends that session and dials again
//     as the account (Connect.vue `start`) — the credentials do not wait for
//     a reconnect that never comes;
//   * Sign out asks first, then forgets the entry, closes the connection and
//     lands on the sign-in panel.

const RUN = Date.now().toString(36);
const BASE = `http://localhost:${process.env.SEANCE_PORT ?? "8023"}/`;
const ACCOUNT = process.env.SEANCE_ACCOUNT ?? "seance1";
const PASSWORD = process.env.SEANCE_PASSWORD ?? "seancepass1";

export const url = BASE;

const PANEL = `!!document.querySelector("#connect form.sign-in")`;
const ACCOUNT_PAGE = `!!document.querySelector(".account-settings")`;
const NETWORKS = `JSON.parse(localStorage.getItem("thelounge.networks") ?? "[]")`;
const IDENTITY = `(document.querySelector(".account-settings .account-identity")?.textContent ?? "").trim()`;
const STATUS = `(document.querySelector(".account-settings .network-settings-status")?.className ?? "")`;
const LOBBY = `.channel-list-item[data-type="lobby"]`;
const joined = (name) =>
	`!!document.querySelector('.channel-list-item[data-name="${name}"]:not(.parted-channel)')`;

/** Type into an input the way the user does, so Vue's v-model sees it. */
const fill = (selector, value) =>
	`(() => {
		const el = document.querySelector(${JSON.stringify(selector)});
		el.value = ${JSON.stringify(value)};
		el.dispatchEvent(new Event("input", {bubbles: true}));
	})()`;

export default async function run(page) {
	const networks = async () => JSON.parse(await page.evaluate(`JSON.stringify(${NETWORKS})`));
	const outbound = () =>
		page.wsFrames.filter((f) => f.dir === "out").map((f) => String(f.payloadData ?? ""));

	/** True when `expr` becomes truthy within `timeout` ms; a check, not an abort. */
	const eventually = async (expr, timeout, label) => {
		try {
			await page.waitFor(expr, {timeout, label});
			return true;
		} catch {
			return false;
		}
	};

	// The phone layout keeps the sidebar off-canvas (as dormant-networks.mjs).
	const openSidebar = async () => {
		if (
			(await page.evaluate(`window.innerWidth <= 768`)) &&
			!(await page.evaluate(`!!document.querySelector("#viewport.menu-open")`))
		) {
			await page.sleep(500);
			await page.click("#viewport .lt");
			await page.waitFor(`document.querySelector("#viewport.menu-open")`, {
				label: "drawer open",
			});
			await page.sleep(500);
		}
	};

	const openAccountPage = async () => {
		await page.evaluate(`location.hash = "#/settings/networks"`);
		await page.waitFor(ACCOUNT_PAGE, {label: "the Account page"});
	};

	// 1. A guest comes in.
	await page.goto(BASE, {waitForSelector: "#connect form"});
	await page.sleep(300);
	page.check("the sign-in panel opens", (await page.evaluate(PANEL)) === true);
	const guestNick = `ga${RUN}`.slice(0, 15);
	await page.evaluate(fill("#connect\\:guestNick", guestNick));
	await page.click("#connect button.btn-guest");
	await page.waitFor(joined("#seance"), {timeout: 25000, label: "the guest joined #seance"});
	const uuid = (await networks())[0]?.uuid;

	// 2. The lobby gear is the way to the Account page.
	page.check(
		"the lobby gear is labelled Account",
		(await page.evaluate(
			`document.querySelector(${JSON.stringify(
				`${LOBBY} button.edit-network`
			)})?.getAttribute("aria-label")`
		)) === "Account"
	);
	await openSidebar();
	await page.click(`${LOBBY} button.edit-network`);
	await page.waitFor(ACCOUNT_PAGE, {label: "the gear opened the Account page"});
	page.check(
		"at Settings → Networks, not the edit form",
		(await page.evaluate("location.hash")) === "#/settings/networks"
	);
	page.check(
		"the tab is called Account",
		(
			await page.evaluate(
				`[...document.querySelectorAll(".settings-menu button")].map((b) => b.textContent.trim())`
			)
		).includes("Account")
	);
	page.check(
		"no Networks tab label beside it",
		!(
			await page.evaluate(
				`[...document.querySelectorAll(".settings-menu button")].map((b) => b.textContent.trim())`
			)
		).includes("Networks")
	);

	// 3. What a guest sees: who, the status, and only the two buttons.
	page.check(
		"the guest's nick is shown",
		(await page.evaluate(IDENTITY)) === `Guest: ${guestNick}`
	);
	page.check("connected", (await page.evaluate(STATUS)).includes("is-connected"));
	page.check(
		"Disconnect and Sign in, and nothing else",
		(await page.count(".account-settings .account-disconnect")) === 1 &&
			(await page.count(".account-settings .account-sign-in")) === 1 &&
			(await page.count(".account-settings .account-sign-out")) === 0 &&
			(await page.count(".account-settings .account-connect")) === 0
	);
	page.check(
		"no edit link, no delete, no add",
		(await page.count(".account-settings a")) === 0 &&
			(await page.count(".account-settings .btn-danger")) === 0 &&
			(await page.count(".network-settings-list")) === 0
	);
	await page.screenshot("1-guest-account-page");

	// 4. Disconnect, then Connect again, from the page.
	await page.click(".account-settings .account-disconnect");
	page.check(
		"Disconnect hangs up",
		await eventually(`${STATUS}.includes("is-disconnected")`, 10000, "disconnected")
	);
	page.check(
		"and Connect takes its place",
		(await page.count(".account-settings .account-connect")) === 1 &&
			(await page.count(".account-settings .account-disconnect")) === 0
	);
	page.check("the network stays in the sidebar", (await page.count(LOBBY)) === 1);
	await page.screenshot("2-guest-disconnected");
	await page.click(".account-settings .account-connect");
	page.check(
		"Connect dials it again",
		await eventually(`${STATUS}.includes("is-connected")`, 25000, "connected again")
	);

	// 5. The edit form's own address lands on the Account page.
	await page.evaluate(`location.hash = "#/settings/networks/${uuid}"`);
	await page.sleep(500);
	page.check(
		"the edit form redirects to the Account page",
		(await page.evaluate("location.hash")) === "#/settings/networks" &&
			(await page.evaluate(ACCOUNT_PAGE)) === true &&
			(await page.count("#connect.network-form-embedded")) === 0
	);

	// 6. The lobby's context menu: no edit, no remove, connect controls kept.
	await page.evaluate(`(() => {
		const row = document.querySelector(${JSON.stringify(LOBBY)});
		const r = row.getBoundingClientRect();
		row.dispatchEvent(new MouseEvent("contextmenu", {
			bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10,
		}));
	})()`);
	await page.waitFor(`!!document.querySelector("#context-menu")`, {label: "the context menu"});
	const menu = await page.evaluate(
		`[...document.querySelectorAll("#context-menu .context-menu-item")].map((el) => el.className)`
	);
	page.check(
		"the lobby menu has no Edit this network…",
		!menu.some((c) => /\bcontext-menu-edit\b/.test(c))
	);
	page.check("nor Remove", !menu.some((c) => /\bcontext-menu-close\b/.test(c)));
	page.check(
		"but still Disconnect",
		menu.some((c) => /\bcontext-menu-disconnect\b/.test(c))
	);
	await page.screenshot("3-lobby-menu");
	for (const type of ["keyDown", "keyUp"]) {
		await page.send("Input.dispatchKeyEvent", {
			type,
			key: "Escape",
			code: "Escape",
			windowsVirtualKeyCode: 27,
		});
	}

	await page.waitFor(`!document.querySelector("#context-menu")`, {label: "the menu closed"});

	// 7. Sign in from the live guest session: the panel ends it and dials
	//    again as the account.
	await openAccountPage();
	await page.click(".account-settings .account-sign-in");
	await page.waitFor(PANEL, {label: "Sign in opened the panel"});
	page.check(
		"the guest is still connected while the panel is open",
		(await page.evaluate(
			`!!document.querySelector(${JSON.stringify(
				`${LOBBY} .connection-status-icon.is-connected`
			)})`
		)) === true
	);
	const framesBefore = outbound().length;
	const allBefore = page.wsFrames.length;
	await page.evaluate(fill("#connect\\:saslAccount", ACCOUNT));
	await page.evaluate(fill("#connect\\:saslPassword", PASSWORD));
	await page.click('#connect input[name="rememberMe"]');
	await page.click('#connect button[type="submit"]');
	// The server's welcome under the account's nick, not the sidebar: the
	// client shows the nick it will register with as soon as it redials.
	const welcomed = async () => {
		const deadline = Date.now() + 25000;

		while (Date.now() < deadline) {
			if (
				page.wsFrames
					.slice(allBefore)
					.some(
						(f) =>
							f.dir === "in" &&
							new RegExp(` 001 ${ACCOUNT} `).test(String(f.payloadData ?? ""))
					)
			) {
				return true;
			}

			await page.sleep(200);
		}

		return false;
	};
	page.check("the server welcomed the account's nick", await welcomed());
	page.check(
		"and the sidebar shows it",
		await eventually(
			`(document.querySelector(${JSON.stringify(
				`${LOBBY} .lobby-nick bdi`
			)})?.textContent ?? "").trim() === ${JSON.stringify(ACCOUNT)}`,
			5000,
			"the account's nick"
		)
	);
	const after = outbound().slice(framesBefore);
	const quitAt = after.findIndex((line) => /^QUIT\b/.test(line));
	const nickAt = after.findIndex((line, i) => i > quitAt && /^NICK\b/.test(line));
	const authAt = after.findIndex((line) => /^AUTHENTICATE PLAIN\b/.test(line));
	page.check("the guest connection sent QUIT", quitAt !== -1);
	page.check(
		"the new registration's NICK is the account",
		nickAt !== -1 && after[nickAt].trim() === `NICK ${ACCOUNT}`
	);
	page.check(
		"and the account authenticated after it, on a fresh connection",
		authAt !== -1 && authAt > quitAt
	);
	const signedIn = await networks();
	page.check(
		"one saved network, now the account's",
		signedIn.length === 1 &&
			signedIn[0].uuid === uuid &&
			signedIn[0].sasl === "plain" &&
			signedIn[0].saslAccount === ACCOUNT
	);
	await page.sleep(1500);
	await page.screenshot("4-signed-in-lobby");

	await openAccountPage();
	page.check(
		"the page says who is signed in",
		await eventually(
			`${IDENTITY} === ${JSON.stringify(`Signed in as ${ACCOUNT}`)}`,
			5000,
			"Signed in as"
		)
	);
	page.check(
		"Sign out instead of Sign in",
		(await page.count(".account-settings .account-sign-out")) === 1 &&
			(await page.count(".account-settings .account-sign-in")) === 0
	);
	page.check(
		"connected as the account",
		await eventually(`${STATUS}.includes("is-connected")`, 15000, "connected")
	);
	await page.screenshot("5-account-page-signed-in");

	// 8. Sign out: asked first; Cancel changes nothing.
	await page.click(".account-settings .account-sign-out");
	await page.waitFor(`!!document.querySelector("#confirm-dialog .btn-danger")`, {
		label: "the sign-out confirmation",
	});
	// The live network's name, as the sidebar shows it: the server's
	// ISUPPORT NETWORK may differ from the deploy's (the e-testnet says
	// "Network").
	const shownName = await page.evaluate(
		`document.querySelector(".account-settings .network-settings-summary strong").textContent.trim()`
	);
	page.check(
		"the dialog names the network",
		shownName.length > 0 &&
			(await page.evaluate(
				`document.querySelector("#confirm-dialog-title").textContent.trim()`
			)) === `Sign out of ${shownName}?`
	);
	await page.screenshot("6-sign-out-confirm");
	await page.click("#confirm-dialog .btn-cancel");
	await page.sleep(300);
	page.check(
		"Cancel keeps the sign-in",
		(await networks()).length === 1 && (await page.evaluate(STATUS)).includes("is-connected")
	);

	await page.click(".account-settings .account-sign-out");
	await page.waitFor(`!!document.querySelector("#confirm-dialog .btn-danger")`, {
		label: "the sign-out confirmation, again",
	});
	await page.click("#confirm-dialog .btn-danger");
	await page.waitFor(PANEL, {timeout: 15000, label: "signed out to the panel"});
	page.check("the saved entry is gone", (await networks()).length === 0);
	page.check(
		"nothing left in the sidebar, live or dormant",
		(await page.count(LOBBY)) === 0 && (await page.count(".dormant-network")) === 0
	);
	page.check(
		"the connection said goodbye",
		outbound()
			.slice(framesBefore)
			.filter((line) => /^QUIT\b/.test(line)).length >= 2
	);
	await page.screenshot("7-signed-out");

	page.check("no console errors", page.consoleErrors.length === 0);
}
