// The sign-in panel with guests turned off (`features.guestAccess: false`,
// branding.ts `accountRequired`) end to end in a real browser: a network's
// own client that lets only accounts in. sign-in.mjs covers the panel with
// its guest half; this one covers the deploy without it, and every other way
// in that could still register a stranger.
//
// A successful sign-in needs services, so this runs against the e-testnet
// (~/afternet/e-testnet: ws:// on 18067, SASL seance1/seancepass1). The
// config is read at boot, so a copy of the built tree with its own
// config.json is enough — public/ itself stays as it is. The config is the
// shape AfterNET ships:
//
//   pnpm build
//   rm -rf /tmp/members-only && cp -r public /tmp/members-only
//   cat > /tmp/members-only/config.json <<'JSON'
//   {
//     "appName": "AfterNET Chat",
//     "defaultNetwork": {
//       "name": "AfterNET",
//       "host": "127.0.0.1",
//       "port": 18067,
//       "tls": false,
//       "channels": ["#afternet"],
//       "nick": "Guest????",
//       "lockHost": true
//     },
//     "links": {"register": "https://accounts.example/register"},
//     "features": {"signIn": true, "guestAccess": false, "allowCustomServer": false,
//                  "multiNetwork": false, "saveNetworks": true, "editNetworks": false}
//   }
//   JSON
//   python3 -m http.server -d /tmp/members-only 8031 &
//   node tools/browser-drive.mjs tools/scenarios/sign-in-members-only.mjs
//   node tools/browser-drive.mjs tools/scenarios/sign-in-members-only.mjs \
//     --width=390 --height=844 --mobile
//
// SEANCE_PORT picks another port, SEANCE_ACCOUNT / SEANCE_PASSWORD other
// credentials. The scenario reads the served config.json and stops at once
// if it lets guests in. What it pins down:
//
//   * the panel is the title, account, password, "Stay signed in", Sign in
//     and the register link (`links.register`, a new tab) — no guest
//     heading, nick or button, the word "guest" nowhere, and nothing left
//     below the register link where the guest half was;
//   * no link or query parameter dials: `?nick=`, a `?host=` or web+irc://
//     link to the deploy's own server (its dialog is the same guest-free
//     panel, and Not now leaves it be) or to another one;
//   * a wrong password ends disconnected, never registered (no CAP END, no
//     001), and the lobby's hint does not offer "No authentication";
//   * `/server <host>` typed in that lobby is refused before it dials
//     (client.ts `refusedWithoutLogin`), where it used to register a guest;
//   * a guest's saved entry from before guests were turned off — even one
//     set to connect by itself — dials nothing: not at load, not from its
//     sidebar row, not through a link to it, not from the Account page's
//     Connect; each opens the panel instead (saved-networks.ts
//     `needsPassword`);
//   * the Account page (`editNetworks: false`; these steps and Sign out
//     are skipped on a config without it) calls such an entry "Not
//     signed in", not a guest; its Sign in leads to the panel, and its edit
//     form's address back to the page, never to a form that offers "No
//     authentication";
//   * the right password still signs in (903, then 001) and reaches the
//     lobby, a reload signs in again by itself, and Sign out lands on the
//     panel;
//   * and over the whole run, no WebSocket ever ended CAP or reached 001
//     without a SASL success (903) first.

const RUN = Date.now().toString(36).slice(-5);
const BASE = `http://localhost:${process.env.SEANCE_PORT ?? "8031"}/`;
const ACCOUNT = process.env.SEANCE_ACCOUNT ?? "seance1";
const PASSWORD = process.env.SEANCE_PASSWORD ?? "seancepass1";

export const url = BASE;

// A refused login and Sign out both drop the connection, and nefarious2's
// closing line lands after the browser has begun the close handshake.
export const allowWsFrameErrors = /after close/;

const PANEL = `!!document.querySelector("#connect form.sign-in")`;
const DIALOG = `!!document.querySelector("#connect.link-approval form.sign-in")`;
const ACCOUNT_PAGE = `!!document.querySelector(".account-settings")`;
const NETWORKS = `JSON.parse(localStorage.getItem("thelounge.networks") ?? "[]")`;
const CHAT_TEXT = `(document.querySelector("#chat .messages")?.textContent ?? "")`;
const joined = (name) =>
	`!!document.querySelector('.channel-list-item[data-name="${name}"]:not(.parted-channel)')`;

export default async function run(page) {
	const networks = async () => JSON.parse(await page.evaluate(`JSON.stringify(${NETWORKS})`));
	const outboundSince = (mark) =>
		page.wsFrames
			.slice(mark)
			.filter((f) => f.dir === "out")
			.map((f) => String(f.payloadData ?? ""));
	const inboundSince = (mark) =>
		page.wsFrames
			.slice(mark)
			.filter((f) => f.dir === "in")
			.map((f) => String(f.payloadData ?? ""));

	/**
	 * Sockets that registered, or ended CAP, before any SASL success: a
	 * stranger on the wire. The question this whole scenario asks.
	 */
	const strangers = () => {
		const sockets = new Map();

		for (const f of page.wsFrames) {
			sockets.set(f.requestId, [...(sockets.get(f.requestId) ?? []), f]);
		}

		return [...sockets.entries()]
			.filter(([, frames]) => {
				let loggedIn = false;

				for (const f of frames) {
					const line = String(f.payloadData ?? "");

					if (f.dir === "in" && / 903 /.test(line)) {
						loggedIn = true;
					} else if (
						!loggedIn &&
						((f.dir === "out" && /^CAP END\b/.test(line)) ||
							(f.dir === "in" && / 001 /.test(line)))
					) {
						return true;
					}
				}

				return false;
			})
			.map(([id]) => id);
	};

	/** True when `expr` becomes truthy within `timeout` ms; a check, not an abort. */
	const eventually = async (expr, timeout, label) => {
		try {
			await page.waitFor(expr, {timeout, label});
			return true;
		} catch {
			return false;
		}
	};

	/** Whether a SASL success, then the server's welcome, arrived since `mark`. */
	const signedInSince = async (mark, timeout = 25000) => {
		const deadline = Date.now() + timeout;

		while (Date.now() < deadline) {
			const lines = inboundSince(mark);
			const ok = lines.findIndex((line) => / 903 /.test(line));

			if (ok !== -1 && lines.slice(ok).some((line) => / 001 /.test(line))) {
				return true;
			}

			await page.sleep(200);
		}

		return false;
	};

	// A cold load that keeps localStorage (sign-in.mjs).
	const reload = async (waitForSelector) => {
		await page.evaluate(`window.__cold = true`);
		await page.send("Page.reload");
		const started = Date.now();

		for (;;) {
			try {
				if (
					await page.evaluate(
						`!window.__cold && !!document.querySelector(${JSON.stringify(
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
				throw new Error(`timed out waiting for ${waitForSelector} after a reload`);
			}

			await page.sleep(150);
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
		await page.sleep(300);
	};

	/** The panel is up, and it is the account form alone. */
	const membersOnlyPanel = async (label) => {
		const panel = await page.evaluate(`(() => {
			const form = document.querySelector("#connect form.sign-in");

			if (!form) {
				return null;
			}

			return {
				fields:
					!!form.querySelector("[id='connect:saslAccount']") &&
					!!form.querySelector("[id='connect:saslPassword']") &&
					!!form.querySelector(".btn-signin"),
				guest: document.querySelectorAll(
					"#connect .sign-in-guest, [id='connect:guestNick'], #connect .btn-guest"
				).length,
				text: form.innerText,
			};
		})()`);

		page.check(`${label}: the sign-in panel`, panel?.fields === true);
		page.check(
			`${label}: no guest way in`,
			panel !== null && panel.guest === 0 && !/guest/i.test(panel.text)
		);
	};

	// 0. The served config is the one under test.
	await page.goto(BASE, {waitForSelector: "#connect form"});
	const config = await page.evaluate(`fetch("config.json").then((r) => r.json())`);
	const features = config.features ?? {};

	if (features.signIn !== true || features.guestAccess !== false) {
		throw new Error(
			"the served config.json must set features.signIn true and guestAccess false (see the header)"
		);
	}

	// The deploy's own server and channel, as its config names them.
	const net = config.defaultNetwork;
	const channel = net.channels?.[0] ?? "#afternet";
	const hostLink =
		`?host=${net.host}&port=${net.port}&tls=${net.tls === false ? "0" : "1"}` +
		`&join=${encodeURIComponent(channel)}`;

	/** A guest's entry as the panel saved it while guests were welcome, set
	 * to connect by itself as an older connect form could leave it. */
	const legacyGuest = {
		uuid: "6e5d4c3b-2a19-4807-a6f5-e4d3c2b1a090",
		name: net.name ?? "",
		host: net.host,
		port: net.port,
		tls: net.tls !== false,
		nick: `Guest${RUN}`.slice(0, 15),
		join: channel,
		sasl: "",
		saslAccount: "",
		saslPassword: "",
		autoconnect: true,
	};

	const size = (await page.evaluate(`window.innerWidth <= 768`)) ? "phone" : "desktop";
	const shot = (name) => page.screenshot(`${name}-${size}`);

	// 1. The panel: the account form, the register link, and nothing else.
	await page.sleep(500);
	await membersOnlyPanel("first visit");
	page.check(
		"titled as the deploy says",
		(await page.evaluate(
			`document.querySelector("#connect form.sign-in .title")?.textContent.trim()`
		)) === (config.strings?.["connect.signInTitle"] ?? "Sign in")
	);
	page.check(
		"Stay signed in is offered",
		(await page.count('#connect form.sign-in input[name="rememberMe"]')) === 1
	);
	page.check(
		"a register link under Sign in opens the sign-up page in a new tab",
		(await page.evaluate(`(() => {
			const a = document.querySelector("#connect .sign-in-register a");
			const signIn = document.querySelector("#connect .btn-signin");
			return !!a && !!signIn &&
				a.href === ${JSON.stringify(config.links?.register ?? "")} &&
				a.target === "_blank" && a.rel === "noopener" &&
				a.getBoundingClientRect().top > signIn.getBoundingClientRect().bottom;
		})()`)) === true
	);
	page.check(
		"nothing left where the guest half was: no heading, no rule, nothing below the link",
		(await page.evaluate(`(() => {
			const form = document.querySelector("#connect form.sign-in");
			const link = form.querySelector(".sign-in-register");
			const bottom = link.getBoundingClientRect().bottom;
			const below = [...form.querySelectorAll("*")].filter((el) => {
				const r = el.getBoundingClientRect();
				return r.height > 0 && r.top >= bottom - 1;
			});
			return form.lastElementChild === link &&
				form.querySelectorAll("h2, hr").length === 0 &&
				below.length === 0;
		})()`)) === true
	);
	page.check("the panel dials nothing", page.wsFrames.length === 0);
	await shot("1-panel");

	// 2. Links and query parameters pre-fill or ask; none of them dials.
	const links = [
		["?nick= and ?join=", `?nick=sneaky${RUN}&join=${encodeURIComponent(channel)}`, false],
		["a ?host= link to the deploy's own server", `${hostLink}&nick=sneaky${RUN}`, true],
		[
			"a web+irc:// link to it",
			`?uri=${encodeURIComponent(
				`web+irc://${net.host}:${net.port}/${encodeURIComponent(channel)}`
			)}`,
			true,
		],
		["a ?host= link elsewhere", `?host=irc.example.org&port=6697&nick=sneaky${RUN}`, false],
	];

	for (const [i, [label, query, dialog]] of links.entries()) {
		const mark = page.wsFrames.length;
		await page.goto(BASE + query, {waitForSelector: "#connect form.sign-in"});
		await page.sleep(800);
		await membersOnlyPanel(label);

		if (dialog) {
			page.check(`${label}: asks, in the panel's own dialog`, await page.evaluate(DIALOG));
			await shot(`2-link-dialog-${i}`);
			await page.click("#connect .link-approval-buttons .btn-cancel");
			await page.sleep(800);
			page.check(`${label}: Not now leaves the plain panel`, !(await page.evaluate(DIALOG)));
			await membersOnlyPanel(`${label}, after Not now`);
		}

		page.check(`${label}: dials nothing`, outboundSince(mark).length === 0);
	}

	page.check("nothing saved by any link", (await networks()).length === 0);

	// 3. A wrong password: refused, reported, never registered.
	let mark = page.wsFrames.length;
	await page.fill("[id='connect:saslAccount']", ACCOUNT);
	await page.fill("[id='connect:saslPassword']", `wrong-${RUN}`);
	await page.click('#connect button[type="submit"]');
	page.check(
		"the refusal is reported in the lobby",
		await eventually(
			`${CHAT_TEXT}.includes("without the login you asked for")`,
			25000,
			"the SASL failure"
		)
	);
	await page.sleep(1500);
	page.check(
		"the login was tried, and the connection never registered",
		outboundSince(mark).some((line) => /^AUTHENTICATE PLAIN\b/.test(line)) &&
			!outboundSince(mark).some((line) => /^CAP END\b/.test(line)) &&
			!inboundSince(mark).some((line) => / 001 /.test(line))
	);
	page.check(
		"the hint does not offer No authentication",
		!(await page.evaluate(`${CHAT_TEXT}.includes("No authentication")`)) &&
			(await page.evaluate(`${CHAT_TEXT}.includes("then sign in again")`))
	);
	await shot("3-wrong-password");

	// 4. `/server` in that lobby: a network with no login, refused before it
	//    dials. (It used to register a guest.)
	mark = page.wsFrames.length;
	await page.fill("#input", `/server ${net.host} ${net.port}`);
	await page.evaluate(`document.querySelector("#form").requestSubmit()`);
	page.check(
		"/server is refused, and the lobby says why",
		await eventually(`${CHAT_TEXT}.includes("without signing in")`, 10000, "the refusal")
	);
	await page.sleep(3000);
	page.check("/server dials nothing", outboundSince(mark).length === 0);
	await shot("4-server-command");

	// 5. A guest's entry from before guests were turned off, set to connect
	//    by itself: the next visit is the panel, and nothing dials.
	await page.evaluate(
		`localStorage.setItem("thelounge.networks", ${JSON.stringify(
			JSON.stringify([legacyGuest])
		)})`
	);
	mark = page.wsFrames.length;
	await reload("#connect form.sign-in");
	await page.sleep(3000);
	await membersOnlyPanel("a guest's old entry, at load");
	page.check("its autoconnect dials nothing", outboundSince(mark).length === 0);

	//    Its sidebar row opens the panel instead of dialling.
	await openSidebar();
	page.check(
		"its sidebar row asks for a sign-in",
		(await page.evaluate(
			`document.querySelector("#sidebar .dormant-network .dormant-network-state")?.textContent.trim()`
		)) === "Needs password"
	);
	await shot("5-legacy-guest-row");
	await page.click("#sidebar .dormant-network-connect");
	await page.sleep(1500);
	await membersOnlyPanel("its sidebar row");
	page.check("its sidebar row dials nothing", outboundSince(mark).length === 0);

	//    So does a link to it.
	await page.goto(`${BASE}${hostLink}`, {
		waitForSelector: "#connect form.sign-in",
	});
	await page.sleep(1500);
	await membersOnlyPanel("a link to it");
	page.check("a link to it dials nothing", outboundSince(mark).length === 0);
	await shot("5-legacy-guest-link");

	// 6. The Account page (`editNetworks: false`): Connect and Sign in lead
	//    to the panel, and the edit form's address back to the page.
	if (features.editNetworks === false) {
		await openAccountPage();
		await shot("6-account-page");
		page.check(
			"the old guest entry: Connect and Sign in",
			(await page.count(".account-settings .account-connect")) === 1 &&
				(await page.count(".account-settings .account-sign-in")) === 1
		);
		page.check(
			"and nobody signed in, rather than a guest",
			(await page.evaluate(
				`document.querySelector(".account-settings .account-identity")?.textContent.trim()`
			)) === "Not signed in"
		);
		await page.click(".account-settings .account-connect");
		await page.waitFor(PANEL, {label: "Connect opened the panel"});
		await membersOnlyPanel("the Account page's Connect");
		page.check("its Connect dials nothing", outboundSince(mark).length === 0);

		await openAccountPage();
		await page.click(".account-settings .account-sign-in");
		await page.waitFor(PANEL, {label: "Sign in opened the panel"});
		await membersOnlyPanel("the Account page's Sign in");

		await page.evaluate(`location.hash = "#/settings/networks/${legacyGuest.uuid}"`);
		await page.sleep(800);
		page.check(
			"the edit form's address lands on the Account page, with no No authentication",
			(await page.evaluate(ACCOUNT_PAGE)) &&
				(await page.count('input[name="sasl"][value=""]')) === 0
		);
		page.check("the Account page dials nothing", outboundSince(mark).length === 0);
		await page.evaluate(`location.hash = "#/connect"`);
		await page.waitFor(PANEL, {label: "back to the panel"});
	}

	// 7. The right password still signs in, replacing the old entry.
	mark = page.wsFrames.length;
	await page.fill("[id='connect:saslAccount']", ACCOUNT);
	await page.fill("[id='connect:saslPassword']", PASSWORD);
	await page.click('#connect input[name="rememberMe"]');
	await page.click('#connect button[type="submit"]');
	page.check("signed in: 903, then the welcome", await signedInSince(mark));
	page.check(
		"and into the lobby and the deploy's channel",
		await eventually(
			`!!document.querySelector('.channel-list-item[data-type="lobby"]') && ${joined(
				channel
			)}`,
			20000,
			`joined ${channel}`
		)
	);
	const signedIn = await networks();
	page.check(
		"one saved network, the account's, set to sign in by itself",
		signedIn.length === 1 &&
			signedIn[0].sasl === "plain" &&
			signedIn[0].saslAccount === ACCOUNT &&
			signedIn[0].autoconnect === true
	);
	await page.sleep(1500);
	await shot("7-signed-in");

	// 8. A reload after the session signs in again by itself.
	mark = page.wsFrames.length;
	await reload(`.channel-list-item[data-type="lobby"]`);
	page.check("a reload signs in again by itself", await signedInSince(mark));

	// 9. Sign out lands on the panel.
	if (features.editNetworks === false) {
		await page.sleep(1500);
		await openAccountPage();
		page.check(
			"the Account page says who is signed in",
			await eventually(
				`(document.querySelector(".account-settings .account-identity")?.textContent ?? "").trim() === ${JSON.stringify(
					`Signed in as ${ACCOUNT}`
				)}`,
				10000,
				"Signed in as"
			)
		);
		await page.click(".account-settings .account-sign-out");
		await page.waitFor(`!!document.querySelector("#confirm-dialog .btn-danger")`, {
			label: "the sign-out confirmation",
		});
		await page.click("#confirm-dialog .btn-danger");
		await page.waitFor(PANEL, {timeout: 15000, label: "signed out to the panel"});
		await page.sleep(800);
		await membersOnlyPanel("after Sign out");
		page.check("Sign out forgot the entry", (await networks()).length === 0);
		await shot("9-signed-out");
	}

	page.check(
		`no connection registered without signing in (${strangers().join(", ") || "none"})`,
		strangers().length === 0
	);
	page.check("no console errors", page.consoleErrors.length === 0);
}
