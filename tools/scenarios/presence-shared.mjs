// Shared presence on TWO devices of one account
// (docs/projects/shared-presence-modes.md). Device A is browser-drive's
// page, device B a second Chromium with its own profile (lib/device.mjs).
//
//   CHROME_BIN=<chromium> SEANCE_SASL_ACCOUNT=idleuser2 \
//     SEANCE_SASL_PASSWORD=idlepass node tools/browser-drive.mjs \
//     tools/scenarios/presence-shared.mjs --no-ws
//
// 1. a mode change on A reaches a connected B live;
// 2. B closed, A changes, B reopens and shows A's mode after its login read;
// 3. B disconnected, B changes, B reconnects and A shows B's mode;
// 4. both change while apart (A, then B later): both end on B's;
// 5. The global mode: a network on Same as global follows the pill on both
//    devices, and a network's own mode overrides it.

import {observe} from "./lib/irc-observer.mjs";
import {FAKE_PUSH_API} from "./lib/fake-push.mjs";
import {startDevice} from "./lib/device.mjs";

const ACCOUNT = process.env.SEANCE_SASL_ACCOUNT;
const PASSWORD = process.env.SEANCE_SASL_PASSWORD;
const RUN = Date.now().toString(36).slice(-6);
const BASE = process.env.SEANCE_URL ?? "http://localhost:8001/";
const IRCD = process.env.SEANCE_IRC_WS ?? "ws://127.0.0.1:8067/";
const IRCD_PORT = Number(new URL(IRCD).port || 8067);
const READ_MS = 14000; // the login read (10 s) and its answer

const linkFor = (nick) =>
	`${BASE}?host=127.0.0.1&port=${IRCD_PORT}&tls=false&nick=${nick}&join=%23seance&saslAccount=${encodeURIComponent(
		ACCOUNT ?? ""
	)}`;

export const url = linkFor(`psa${RUN}`);
// A's /disconnect: the ircd answers the QUIT with a close frame and then its
// ERROR line, which Chrome reports as "Data frame (or Close) received after close" (the
// server's close handshake, as in network-panel.mjs).
export const allowWsFrameErrors = /(Data frame|Close) received after close/;

const LOBBY = '.channel-list-item[data-type="lobby"]';
const DOT = `${LOBBY} .lobby-presence .presence-dot`;
const PILL = "#sidebar .presence-pill";
const MENU_ITEM = (cls) => `#context-menu .context-menu-${cls}`;
const joined = `!!document.querySelector('.channel-list-item[data-name="#seance"]:not(.parted-channel)')`;
const offline = `!!document.querySelector('${DOT}.is-offline')`;
const online = `!!document.querySelector('${DOT}:not(.is-offline)')`;
const OUR_NICK = `document.querySelector('${LOBBY} .lobby-nick')?.textContent.replace(/^\\s*Nickname:\\s*/, "").trim()`;
// The dot's title is the mode's words: "Away", "Online", "Auto · away", "Do not disturb", "<mode> · not connected".
const DOT_TEXT = `document.querySelector('${DOT}')?.getAttribute("title") ?? ""`;
const PILL_TEXT = `document.querySelector('${PILL}')?.textContent.trim() ?? ""`;

export default async function run(page) {
	if (!ACCOUNT || !PASSWORD) {
		throw new Error("set SEANCE_SASL_ACCOUNT and SEANCE_SASL_PASSWORD (an account of its own)");
	}

	const origin = new URL(BASE).origin;
	const b = await startDevice({name: "B"});

	const command = async (dev, text) => {
		await dev.fill("#input", text);
		await dev.click("#submit");
	};
	const pick = async (dev, opener, cls) => {
		await dev.click(opener);
		await dev.waitFor(`!!document.querySelector('${MENU_ITEM(cls)}')`, {label: `menu ${cls}`});
		await dev.click(MENU_ITEM(cls));
		await dev.sleep(300);
	};
	const setMode = (dev, mode) => pick(dev, DOT, `presence-${mode}`);
	const login = async (dev, link) => {
		await dev.addInitScript(
			`if (typeof ServiceWorkerRegistration !== "undefined") ${FAKE_PUSH_API}`
		);
		await dev.grantPermissions(["notifications"], origin);
		await dev.goto(link, {waitForSelector: "#connect form"});
		await dev.fill('#connect input[name="saslPassword"]', PASSWORD);

		for (const name of ["rememberPassword", "autoconnect"]) {
			if (
				!(await dev.evaluate(
					`document.querySelector('#connect input[name="${name}"]').checked`
				))
			) {
				await dev.click(`#connect input[name="${name}"]`);
			}
		}

		await dev.click('#connect button[type="submit"]');
		await dev.waitFor(joined, {timeout: 25000, label: "joined"});
	};
	const close = async (dev) => {
		await dev.evaluate(`addEventListener("unload", () => {})`);
		await dev.goto("about:blank");
	};
	const reopen = async (dev) => {
		await dev.goto(BASE, {waitForSelector: "#chat-container"});
		await dev.waitFor(joined, {timeout: 25000, label: "session restored"});
	};
	const waitText = async (dev, expr, re, label, timeout = READ_MS + 6000) => {
		const t = Date.now();

		while (Date.now() - t < timeout) {
			if (re.test(await dev.evaluate(expr))) {
				return true;
			}

			await dev.sleep(500);
		}

		console.log(`  ${label}: still "${await dev.evaluate(expr)}"`);
		return false;
	};
	const waitMode = (dev, re, label, timeout) => waitText(dev, DOT_TEXT, re, label, timeout);

	let obs;

	try {
		await login(page, page.url);
		await login(b, linkFor(`psb${RUN}`));
		const me = await page.evaluate(OUR_NICK);
		const bNick = await b.evaluate(OUR_NICK);
		page.check(`B on the same session (${bNick})`, bNick === me);
		obs = await observe(IRCD, `pso${RUN}`, {caps: ["away-notify"], join: "#seance"});
		await page.sleep(READ_MS); // both login reads answered
		await pick(page, PILL, "status-auto");

		// Start from Online on both.
		await setMode(page, "online");
		page.check("0. B follows A to Online", await waitMode(b, /^Online/, "0"));

		// 1. Live.
		await setMode(page, "away");
		page.check("1. A's Away reaches a connected B live", await waitMode(b, /^Away/, "1", 6000));
		await page.sleep(1500);
		const flag1 = await obs.who(me);
		page.check(`1. others see the account away (${flag1})`, flag1 === "G");

		// 2. B closed while A changes.
		await close(b);
		await page.sleep(2000);
		await setMode(page, "dnd");
		await page.sleep(1500);
		await reopen(b);
		page.check(
			"2. B reopens and takes A's Do not disturb after its login read",
			await waitMode(b, /^Do not disturb/, "2")
		);

		// 3. B disconnected, changes, reconnects.
		await command(b, "/disconnect");
		await b.waitFor(offline, {label: "B offline"});
		await setMode(b, "online");
		await page.sleep(3000);
		page.check(
			`3. A has not seen B's offline change yet (${await page.evaluate(DOT_TEXT)})`,
			/^Do not disturb/.test(await page.evaluate(DOT_TEXT))
		);
		await command(b, "/server");
		await b.waitFor(online, {timeout: 25000, label: "B back"});
		page.check(
			"3. B's offline Online reaches A after B reconnects",
			await waitMode(page, /^Online/, "3")
		);

		// 4. Both change while apart; B's choice is the later one.
		await command(page, "/disconnect");
		await command(b, "/disconnect");
		await page.waitFor(offline, {label: "A offline"});
		await b.waitFor(offline, {label: "B offline"});
		await setMode(page, "away");
		await page.sleep(1500);
		await setMode(b, "dnd");
		await command(page, "/server");
		await page.waitFor(online, {timeout: 25000, label: "A back"});
		await page.sleep(READ_MS);
		await command(b, "/server");
		await b.waitFor(online, {timeout: 25000, label: "B back"});
		page.check("4. B (later) keeps Do not disturb", await waitMode(b, /^Do not disturb/, "4b"));
		page.check(
			"4. A adopts B's later Do not disturb",
			await waitMode(page, /^Do not disturb/, "4a")
		);

		// 5. The global mode: a network on Same as global follows the pill on both devices.
		await setMode(page, "global");
		page.check(
			"5. B's network follows A to Same as global",
			await waitMode(b, / · global$/, "5 setup")
		);
		await pick(page, PILL, "status-away");
		page.check("5. B's pill reads Away", await waitText(b, PILL_TEXT, /^Away/, "5 pill", 6000));
		page.check(
			"5. B's dot reads Away · global",
			await waitMode(b, /^Away · global$/, "5 dot", 6000)
		);
		await page.sleep(1500);
		const flag5 = await obs.who(me);
		page.check(`5. others see the account away (${flag5})`, flag5 === "G");
		await setMode(b, "online");
		page.check(
			"5. B's own Online reaches A's dot",
			await waitMode(page, /^Online$/, "5 own", 6000)
		);
		await page.sleep(1500);
		const flag5b = await obs.who(me);
		page.check(
			`5. the network's own Online wins over the global Away (${flag5b})`,
			flag5b === "H"
		);
		await pick(b, PILL, "status-online");
		page.check(
			"5. Online on B: A's pill reads Online",
			await waitText(page, PILL_TEXT, /^Online/, "5 back", 6000)
		);

		// Leave the account on Same as global and Auto.
		await setMode(page, "global");
		await pick(page, PILL, "status-auto");
		await waitMode(b, /^Auto · global/, "cleanup");
	} finally {
		await b.close();
		obs?.close();
	}

	page.check(
		`no console errors (A ${page.consoleErrors.length}, B ${b.consoleErrors.length})`,
		page.consoleErrors.length === 0 && b.consoleErrors.length === 0
	);
}
