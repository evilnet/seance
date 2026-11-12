// The sign-in panel (`features.signIn`) end to end in a real browser: the
// first screen of a deploy that is one network's own client, where the
// question is who you are rather than where to connect.
//
// It needs a deploy config, so put one in place before building — this is
// the whole feature under test, and `pnpm test` never renders a component:
//
//   cp client/config.json /tmp/config.json.orig
//   cat > client/config.json <<'JSON'
//   {
//     "appName": "TestNet",
//     "defaultNetwork": {
//       "name": "TestNet",
//       "host": "127.0.0.1",
//       "port": 8067,
//       "tls": false,
//       "channels": ["#seance"],
//       "nick": "guest????"
//     },
//     "features": {"signIn": true, "allowCustomServer": false, "multiNetwork": false},
//     "links": {"register": "https://accounts.example/register"}
//   }
//   JSON
//   pnpm build && python3 -m http.server -d public 8023 &
//   node tools/browser-drive.mjs tools/scenarios/sign-in.mjs
//   cp /tmp/config.json.orig client/config.json
//
// The dev ircd runs no services, so a SASL login cannot succeed here. That
// is not a gap — it is what makes the failure path testable, and the failure
// path is the one with teeth. What the scenario pins down:
//
//   * the panel has no server fields at all, and names the network instead;
//   * `links.register` is a link under Sign in to the network's sign-up page,
//     in a new tab;
//   * a refused login is reported in the lobby and the connection dropped,
//     rather than quietly registering the user as a stranger
//     (`features.saslDisconnectOnFail`), and the view follows the report to the
//     lobby (`network:aborted`) instead of sitting on the empty autojoin channel
//     the connect flow opened;
//   * a refused login also stands the entry's `autoconnect` down, so the
//     next visit asks again instead of failing the same way for ever with
//     no route back to the panel (client.ts `onSaslRejected`);
//   * a guest connects under the nick they typed, and nothing is kept;
//   * and the deploy keeps exactly one saved network however often the way
//     in changes — a guest's nick differs every visit, and `findMatching`
//     keys on it, so without the panel's own rule they would pile up.
//
// The one thing only a services-capable ircd can show is a *successful*
// sign-in, and with it "Stay signed in" surviving as `autoconnect: true`.
// What is checked here is that the box stores `rememberPassword`.

const RUN = Date.now().toString(36);
const BASE = "http://localhost:8023/";

export const url = BASE;

// The refused login is answered with a QUIT, and nefarious2's closing line
// lands after the browser has begun the close handshake. Dropping the
// connection is the path under test, so that frame error is expected.
export const allowWsFrameErrors = /after close/;

const PANEL = `!!document.querySelector("#connect form.sign-in")`;
const NETWORKS = `JSON.parse(localStorage.getItem("thelounge.networks") ?? "[]")`;
const CHAT_TEXT = `(document.querySelector("#chat .messages")?.textContent ?? "")`;
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

	/** True when `expr` becomes truthy within `timeout` ms; a check, not an abort. */
	const eventually = async (expr, timeout, label) => {
		try {
			await page.waitFor(expr, {timeout, label});
			return true;
		} catch {
			return false;
		}
	};

	// A cold load that keeps localStorage: several checks below are about
	// what the *next* visit does.
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

	// 1. The first screen is the sign-in panel, not the connect form.
	await page.goto(BASE, {waitForSelector: "#connect form"});
	await page.sleep(300);
	page.check("the sign-in panel is what opens", (await page.evaluate(PANEL)) === true);
	page.check(
		"no server fields anywhere on it",
		(await page.count('#connect input[name="host"]')) === 0 &&
			(await page.count('#connect input[name="port"]')) === 0 &&
			(await page.count('#connect input[name="tls"]')) === 0
	);
	page.check(
		"it names the network instead",
		String(
			await page.evaluate(
				`document.querySelector("#connect .connect-network")?.textContent ?? ""`
			)
		).includes("TestNet")
	);
	page.check(
		"account, password and a guest nick are the whole form",
		(await page.count("#connect\\:saslAccount")) === 1 &&
			(await page.count("#connect\\:saslPassword")) === 1 &&
			(await page.count("#connect\\:guestNick")) === 1
	);
	page.check(
		"the guest nick is pre-filled from the deploy's pattern",
		/^guest\d{4}$/.test(
			String(await page.evaluate(`document.querySelector("#connect\\\\:guestNick").value`))
		)
	);
	page.check(
		"a register link under Sign in opens the sign-up page in a new tab",
		(await page.evaluate(`(() => {
			const a = document.querySelector("#connect .sign-in-register a");
			const signIn = document.querySelector("#connect .btn-signin");
			return !!a && !!signIn &&
				a.href === "https://accounts.example/register" &&
				a.target === "_blank" && a.rel === "noopener" &&
				a.getBoundingClientRect().top > signIn.getBoundingClientRect().bottom;
		})()`)) === true
	);
	await page.screenshot("1-sign-in-panel");

	// 2. Sign in on a first run, with credentials no services can confirm.
	//    The account becomes the nick, the password goes out as SASL, and the
	//    refusal is reported in the lobby, which the view moves to.
	await page.evaluate(fill("#connect\\:saslAccount", "someaccount"));
	await page.evaluate(fill("#connect\\:saslPassword", "wrong-password"));
	await page.click('#connect input[name="rememberMe"]');
	await page.click('#connect button[type="submit"]');
	await page.waitFor(`${NETWORKS}.length === 1`, {label: "the network is saved"});

	const afterSignIn = await networks();
	page.check(
		"the account became the nick, the password went to SASL",
		afterSignIn[0]?.nick === "someaccount" &&
			afterSignIn[0]?.saslAccount === "someaccount" &&
			afterSignIn[0]?.sasl === "plain"
	);
	page.check('"Stay signed in" stored the password', afterSignIn[0]?.rememberPassword === true);
	page.check(
		"the refusal is on screen: the view followed it to the lobby",
		await eventually(
			`${CHAT_TEXT}.includes("without the login you asked for")`,
			20000,
			"the SASL failure"
		)
	);
	page.check(
		"and the lobby is what is open",
		(await page.evaluate(
			`document.querySelector(".channel-list-item.active")?.dataset.type ?? ""`
		)) === "lobby"
	);
	await page.screenshot("2-sasl-refused");
	await page.screenshot("2b-lobby-report");

	// 3. And it stood the entry down, so the next visit asks again instead of
	//    retrying credentials the server has already refused.
	page.check(
		"the refusal stood autoconnect down",
		await eventually(`${NETWORKS}[0]?.autoconnect !== true`, 5000, "autoconnect cleared")
	);
	await reload("#connect form");
	await page.sleep(500);
	page.check("so the next visit asks again", (await page.evaluate(PANEL)) === true);

	// 4. A guest connects under the nick they typed, and nothing is kept.
	const guestNick = `gu${RUN}`.slice(0, 15);
	await page.evaluate(fill("#connect\\:guestNick", guestNick));
	await page.click("#connect button.btn-guest");
	await page.waitFor(joined("#seance"), {timeout: 20000, label: "the guest joined #seance"});

	const afterGuest = await networks();
	page.check("connected under the typed nick", afterGuest[0]?.nick === guestNick);
	page.check("still exactly one saved network", afterGuest.length === 1);
	page.check(
		"a guest leaves no login behind",
		afterGuest[0]?.autoconnect !== true &&
			!afterGuest[0]?.saslAccount &&
			afterGuest[0]?.sasl !== "plain"
	);
	await page.screenshot("3-guest-connected");

	// 5. So the visit after that asks again too, and a second guest replaces
	//    the entry rather than adding one.
	await reload("#connect form");
	await page.sleep(500);
	page.check("a guest is not remembered either", (await page.evaluate(PANEL)) === true);
	await page.evaluate(fill("#connect\\:guestNick", `gv${RUN}`.slice(0, 15)));
	await page.click("#connect button.btn-guest");
	await page.waitFor(joined("#seance"), {timeout: 20000, label: "the second guest joined"});
	page.check("one saved network after three ways in", (await networks()).length === 1);
	await page.screenshot("4-guest-again");

	page.check("no console errors", page.consoleErrors.length === 0);
}
