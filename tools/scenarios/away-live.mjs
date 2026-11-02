// Away as OTHER users and the server see it (docs/projects/do-not-disturb.md).
// tools/scenarios/dnd.mjs checks what Seance sends; this one checks what
// arrives elsewhere: a second connection with away-notify sits in #seance
// and records every AWAY about our nick, and asks WHOIS (301) and WHO
// (H/G) after each step. A third connection logs into the same account to
// read the push mute list back the way another device would.
//
// Needs the testnet rig (SASL, draft/persistence, draft/pre-away,
// draft/metadata-2) and an account of its own:
//
//   pnpm build && python3 -m http.server -d public 8001 &
//   SEANCE_SASL_ACCOUNT=idleuser SEANCE_SASL_PASSWORD=idlepass \
//     node tools/browser-drive.mjs tools/scenarios/away-live.mjs
//
// The page is hidden and shown by overriding document.visibilityState and
// firing visibilitychange / focus / blur, the events foreground.ts listens to.
//
// The page dials the ircd through lib/irc-proxy.mjs (SEANCE_PROXY_PORT,
// default 9876), so a same-page reconnect can be forced by cutting the
// socket: the bouncer holds the session and the client redials, as after a
// radio drop. Reloads and reconnects must never show the user back to
// others while /away, do not disturb or away mode is in force: the client
// declares its away state before CAP END (draft/pre-away).
//
// A present Auto page that reloads must not blink away and back either: its
// AWAY * is handed to the service worker as it unloads, which says it only
// when no window of the app is open 5 s later (a close). That needs the
// worker's stashed login, which the page writes for a push-enabled network
// with a remembered password: the Push API is faked (lib/fake-push.mjs) and
// notifications granted, so the network subscribes without a prompt.

import {observe} from "./lib/irc-observer.mjs";
import {startProxy} from "./lib/irc-proxy.mjs";
import {FAKE_PUSH_API} from "./lib/fake-push.mjs";

const ACCOUNT = process.env.SEANCE_SASL_ACCOUNT;
const PASSWORD = process.env.SEANCE_SASL_PASSWORD;
const RUN = Date.now().toString(36);
const NICK = `awl${RUN.slice(-6)}`;
const BASE = process.env.SEANCE_URL ?? "http://localhost:8001/";
const IRCD = process.env.SEANCE_IRC_WS ?? "ws://127.0.0.1:8067/";
const IRCD_PORT = Number(new URL(IRCD).port || 8067);
const PROXY_PORT = Number(process.env.SEANCE_PROXY_PORT ?? 9876);
const SETTLE = 1500; // a line's round trip through the server, generously

// A link never carries the password (link approval): the form fills it.
export const url = `${BASE}?host=127.0.0.1&port=${PROXY_PORT}&tls=false&nick=${NICK}&join=%23seance&saslAccount=${encodeURIComponent(
	ACCOUNT ?? ""
)}`;

const LOBBY = '.channel-list-item[data-type="lobby"]';
const PILL = "#sidebar .presence-pill";
const DOT = `${LOBBY} .lobby-presence .presence-dot`;
const MENU_ITEM = (cls) => `#context-menu .context-menu-${cls}`;
const joined = (name) =>
	`!!document.querySelector('.channel-list-item[data-name="${name}"]:not(.parted-channel)')`;
const OUR_NICK = `document.querySelector('${LOBBY} .lobby-nick')?.textContent.replace(/^\\s*Nickname:\\s*/, "").trim()`;

// about:blank has no ServiceWorkerRegistration to patch.
const PUSH_API = `if (typeof ServiceWorkerRegistration !== "undefined") ${FAKE_PUSH_API}`;

// Navigating away puts the page in the back/forward cache (pagehide with
// persisted = true), which is a hide, not a close. An unload listener makes
// Chromium unload it for real, as closing the tab does.
const CLOSE_FOR_REAL = `addEventListener("unload", () => {})`;

// The page has a controlling worker and the stash (IndexedDB seance-push)
// carries a remembered password for a network.
const STASHED_LOGIN = `(async () => {
	if (!navigator.serviceWorker.controller) return false;
	const db = await new Promise((res, rej) => {
		const r = indexedDB.open("seance-push", 1);
		r.onsuccess = () => res(r.result);
		r.onerror = () => rej(r.error);
	});
	const stash = await new Promise((res) => {
		const g = db.transaction("kv").objectStore("kv").get("stash");
		g.onsuccess = () => res(g.result);
		g.onerror = () => res(undefined);
	});
	db.close();
	return (stash?.networks ?? []).some((n) => n.saslPassword);
})()`;

const HIDE = `(() => {
	Object.defineProperty(document, "visibilityState", {configurable: true, get: () => "hidden"});
	Object.defineProperty(document, "hidden", {configurable: true, get: () => true});
	window.dispatchEvent(new Event("blur"));
	document.dispatchEvent(new Event("visibilitychange"));
})()`;
const SHOW = `(() => {
	delete document.visibilityState;
	delete document.hidden;
	document.dispatchEvent(new Event("visibilitychange"));
	window.dispatchEvent(new Event("focus"));
})()`;

export default async function run(page) {
	if (!ACCOUNT || !PASSWORD) {
		throw new Error("set SEANCE_SASL_ACCOUNT and SEANCE_SASL_PASSWORD (an account of its own)");
	}

	const proxy = startProxy({port: PROXY_PORT, target: {host: "127.0.0.1", port: IRCD_PORT}});
	await proxy.listen();

	const command = async (text) => {
		await page.fill("#input", text);
		await page.click("#submit");
	};
	const menu = async (opener, cls) => {
		await page.click(opener);
		await page.waitFor(`!!document.querySelector('${MENU_ITEM(cls)}')`, {label: `menu ${cls}`});
		await page.click(MENU_ITEM(cls));
		await page.sleep(200);
	};
	// Yes, so the network subscribes (the fake Push API grants it) and the
	// worker gets the login the close steps need; Never would leave it out.
	const answerPushPrompt = async (waitMs = 8000) => {
		for (let waited = 0; waited <= waitMs; waited += 250) {
			if ((await page.count("#push-prompt[data-armed]")) > 0) {
				await page.click("#pushPromptYes");
				await page.sleep(300);
				return;
			}

			await page.sleep(250);
		}
	};

	// --- 1. Seance logs in; an ordinary user watches from #seance. ----------
	await page.addInitScript(PUSH_API);
	await page.grantPermissions(["notifications"], new URL(BASE).origin);
	await page.goto(page.url, {waitForSelector: "#connect form"});
	// A link never carries the password into the form (link approval).
	await page.fill('#connect input[name="saslPassword"]', PASSWORD);

	for (const name of ["rememberPassword", "autoconnect"]) {
		if (
			!(await page.evaluate(
				`document.querySelector('#connect input[name="${name}"]').checked`
			))
		) {
			await page.click(`#connect input[name="${name}"]`);
		}
	}

	await page.click('#connect button[type="submit"]');
	await page.waitFor(joined("#seance"), {timeout: 25000, label: "joined #seance (SASL)"});
	await answerPushPrompt();
	const me = await page.evaluate(OUR_NICK);
	page.check(`logged in as ${me}`, !!me);
	// The worker that takes a closing page's AWAY * over: controlling the
	// page, with this network's login in its stash.
	await page.waitFor(STASHED_LOGIN, {
		timeout: 20000,
		label: "the worker's stash holds the login",
	});
	page.check(
		"the service worker controls the page and holds the login",
		(await page.evaluate(STASHED_LOGIN)) === true
	);

	const obs = await observe(IRCD, `obs${RUN.slice(-6)}`, {
		caps: ["away-notify", "draft/metadata-2"],
		join: "#seance",
	});
	const state = async (label) => {
		const w = await obs.whois(me);
		const flag = await obs.who(me);
		console.log(`  ${label}: WHO ${flag}, WHOIS away=${JSON.stringify(w.away)}`);
		return {flag, away: w.away};
	};
	const step = async (label, action) => {
		const t = Date.now();
		await action();
		await page.sleep(SETTLE);
		const aways = obs.awaysSince(me, t);
		const s = await state(label);
		return {aways, ...s};
	};

	// Leave the page for about:blank and come back: Chromium keeps the page
	// in the back/forward cache (pagehide persisted = true), so this is a
	// HIDE and a fresh page load, not a reload; the saved network
	// autoconnects and attaches to the held session. Returns the AWAY lines
	// others saw meanwhile. A real reload is realReload below.
	const bfcacheHide = async (label) => {
		const t = Date.now();
		await page.goto("about:blank");
		await page.sleep(2000);
		await page.goto(BASE, {waitForSelector: "#chat-container"});
		await page.waitFor(joined("#seance"), {
			timeout: 25000,
			label: `${label}: session restored`,
		});
		await page.evaluate(SHOW);
		await page.sleep(4000);
		const lines = obs.awaysSince(me, t);
		return {lines, ...(await state(label))};
	};
	// A real reload (Page.reload: pagehide persisted = false, the page
	// unloads); the saved network autoconnects to the held session.
	const realReload = async (label) => {
		const t = Date.now();
		await page.send("Page.reload");
		await page.waitFor(joined("#seance"), {
			timeout: 25000,
			label: `${label}: session restored`,
		});
		await page.evaluate(SHOW);
		await page.sleep(4000);
		const lines = obs.awaysSince(me, t);
		return {lines, ...(await state(label))};
	};
	// Cut the socket under the page and wait for the client to redial and
	// register again, on the same page.
	const reconnect = async (label) => {
		const t = Date.now();
		proxy.cut();
		// Refuse the redials for a while so the bouncer holds the session
		// and the next dial resumes it as its primary connection — the path
		// a reload takes — rather than racing the old socket's teardown.
		// These checks pass on the round-1 build without pre-away too (seen
		// 2026-10-13): a cut socket gets no star out, and the resumed
		// session keeps its state, so they guard against a regression but
		// do not tell old from new; the real-close checks (section 10) do.
		proxy.refuse();
		page.expectWsErrors = true;
		setTimeout(() => proxy.accept(), 3000);
		let sawDown = false;

		for (let waited = 0; waited < 5000 && !sawDown; waited += 50) {
			sawDown = await page.evaluate(`!!document.querySelector("#chat.disconnected")`);
			await page.sleep(50);
		}

		page.check(`${label}: the page saw the socket go`, sawDown);
		await page.waitFor(`!document.querySelector("#chat.disconnected")`, {
			timeout: 30000,
			label: `${label}: reconnected`,
		});
		page.expectWsErrors = false;
		await page.sleep(4000);
		const lines = obs.awaysSince(me, t);
		return {lines, ...(await state(label))};
	};
	const noBack = (lines) => !lines.some((l) => /AWAY\s*$/.test(l));

	try {
		// Clean start: whatever an earlier run left behind. A DND left on the
		// account (its mute entry) is read ~10 s after registration
		// (MUTE_READ_DELAY_MS) and is shared DND here too: wait for that read,
		// then Off from the pill, which clears it for every device.
		await page.sleep(11000);
		const shared = await page.evaluate(`document.querySelector('${PILL}').textContent.trim()`);
		console.log(`  pill after the account's mute list was read: ${JSON.stringify(shared)}`);
		await menu(PILL, "status-auto");
		await command("/back");
		await page.evaluate(SHOW);
		await page.sleep(SETTLE);
		let s = await state("start");
		page.check("start: present to others (WHO H, no 301)", s.flag === "H" && s.away === null);

		// --- 2. Auto: a hidden page goes away, coming back returns. ---------
		let r = await step("auto, hidden", () => page.evaluate(HIDE));
		page.check(
			`auto, hidden: observer got one AWAY with text (${JSON.stringify(r.aways)})`,
			r.aways.length === 1 && / AWAY :\S/.test(r.aways[0])
		);
		page.check("auto, hidden: WHO G and a 301", r.flag === "G" && r.away !== null);
		r = await step("auto, shown", () => page.evaluate(SHOW));
		page.check(
			`auto, shown: observer got AWAY with no text = back (${JSON.stringify(r.aways)})`,
			r.aways.length === 1 && /AWAY\s*$/.test(r.aways[0])
		);
		page.check("auto, shown: WHO H, no 301", r.flag === "H" && r.away === null);

		// --- 3. Manual /away is not undone by coming back. -------------------
		r = await step("/away lunch", () => command("/away out to lunch"));
		page.check(
			`/away: observer sees "out to lunch" (${JSON.stringify(r.aways)})`,
			r.aways.some((l) => l.endsWith(":out to lunch"))
		);
		r = await step("/away, hidden", () => page.evaluate(HIDE));
		page.check(
			`/away, hidden: no AWAY line (${JSON.stringify(r.aways)})`,
			r.aways.length === 0
		);
		page.check("/away, hidden: still 301 out to lunch", r.away === "out to lunch");
		r = await step("/away, shown", () => page.evaluate(SHOW));
		page.check(
			`/away, shown again: NOT marked back (${JSON.stringify(r.aways)})`,
			r.aways.length === 0 && r.flag === "G" && r.away === "out to lunch"
		);
		// Many returns in a row: still nothing.
		const t3 = Date.now();
		for (let i = 0; i < 3; i++) {
			await page.evaluate(HIDE);
			await page.sleep(300);
			await page.evaluate(SHOW);
			await page.sleep(300);
		}
		await page.sleep(SETTLE);
		s = await state("/away, flapped 3x");
		page.check(
			"/away, three hide/show cycles: no AWAY line, still away",
			obs.awaysSince(me, t3).length === 0 && s.away === "out to lunch"
		);

		// DND on top of /away changes nothing others see; Off leaves /away.
		r = await step("/away + DND on", () => menu(PILL, "dnd-indefinite"));
		page.check(
			`/away + DND: no AWAY line, still out to lunch (${JSON.stringify(r.aways)})`,
			r.aways.length === 0 && r.away === "out to lunch"
		);
		r = await step("/away + DND off", () => menu(PILL, "status-auto"));
		page.check(
			`/away + DND off: still out to lunch (${JSON.stringify(r.aways)})`,
			r.aways.length === 0 && r.away === "out to lunch"
		);

		r = await step("/back", () => command("/back"));
		page.check(
			`/back on a visible page: observer sees back (${JSON.stringify(r.aways)})`,
			r.aways.length === 1 && /AWAY\s*$/.test(r.aways[0]) && r.flag === "H"
		);

		// --- 4. DND: away to others, and coming back does not end it. --------
		r = await step("DND on", () => menu(PILL, "dnd-indefinite"));
		page.check(
			`DND on: observer sees away (${JSON.stringify(r.aways)})`,
			r.aways.length === 1 && r.flag === "G" && r.away !== null
		);
		const t4 = Date.now();
		for (let i = 0; i < 2; i++) {
			await page.evaluate(HIDE);
			await page.sleep(300);
			await page.evaluate(SHOW);
			await page.sleep(300);
		}
		await page.sleep(SETTLE);
		s = await state("DND, flapped");
		page.check(
			"DND: hiding and showing the page sends others nothing, still away",
			obs.awaysSince(me, t4).length === 0 && s.flag === "G"
		);

		// The push mute: another device of the account reads it back; a
		// stranger cannot.
		const other = await observe(IRCD, `dev${RUN.slice(-6)}`, {
			caps: ["draft/metadata-2"],
			sasl: {account: ACCOUNT, password: PASSWORD},
		});
		// Closed in finally: a failing check in here must not leak it.
		try {
			const ownRead = await other.metadataGet("*", "draft/webpush/mute");
			const strangerRead = await obs.metadataGet(me, "draft/webpush/mute");
			console.log(`  own device reads: ${JSON.stringify(ownRead)}`);
			console.log(`  stranger reads: ${JSON.stringify(strangerRead)}`);
			page.check(
				"DND: the account's own other device reads a private *:<until> entry",
				ownRead.some((l) => / 761 /.test(l) && / private :.*\*:\d+/.test(l))
			);
			page.check(
				"DND: a stranger cannot read the mute list",
				!strangerRead.some((l) => / 761 /.test(l) && /\*:\d+/.test(l))
			);
			// That other device is present, so the server now shows the account
			// present to everyone (pre-away aggregation). Expected; note it.
			await page.sleep(SETTLE);
			s = await state("DND + a present second device");
			console.log(
				`  with a present second device the account shows ${s.flag} (server aggregation)`
			);
		} finally {
			other.close();
		}
		await page.sleep(SETTLE);
		s = await state("DND, second device gone");
		page.check("DND: second device gone, away again to others", s.flag === "G");

		r = await step("DND off", () => menu(PILL, "status-auto"));
		page.check(
			`DND off: observer sees back (${JSON.stringify(r.aways)})`,
			r.flag === "H" && r.away === null && r.aways.some((l) => / AWAY\s*$/.test(l))
		);

		// --- 5. Per-network modes. --------------------------------------------
		r = await step("mode online, hidden", async () => {
			await menu(DOT, "presence-online");
			await page.evaluate(HIDE);
		});
		page.check(
			`online, hidden: never away to others (${JSON.stringify(r.aways)})`,
			r.aways.length === 0 && r.flag === "H"
		);
		await page.evaluate(SHOW);
		r = await step("mode away, shown", () => menu(DOT, "presence-away"));
		page.check(
			`away mode on a visible page: away to others (${JSON.stringify(r.aways)})`,
			r.flag === "G"
		);
		r = await step("mode away, focus again", () => page.evaluate(SHOW));
		page.check("away mode: focus brings nothing back", r.aways.length === 0 && r.flag === "G");
		r = await step("mode auto", () => menu(DOT, "presence-auto"));
		page.check(
			`back to auto on a visible page: present (${JSON.stringify(r.aways)})`,
			r.flag === "H"
		);

		// --- 6. Persistence: /away survives the socket going and coming. ------
		// The page leaves for about:blank (a bfcache hide) and a new load
		// comes back to the held session.
		r = await step("/away before reload", () => command("/away gone fishing"));
		page.check("before reload: away 'gone fishing'", r.away === "gone fishing");
		const t6 = Date.now();
		await page.goto("about:blank");
		await page.sleep(3000);
		s = await state("page hidden (bfcache), session held");
		page.check(
			`page hidden (bfcache): others see no QUIT, still away (${s.flag}, ${JSON.stringify(
				s.away
			)})`,
			!obs.since(t6).some((l) => new RegExp(`:${me}!\\S+ QUIT`, "i").test(l)) &&
				s.flag === "G"
		);
		const t6b = Date.now();
		await page.goto(BASE, {waitForSelector: "#chat-container"});
		await page.waitFor(joined("#seance"), {timeout: 25000, label: "session restored"});
		await page.evaluate(SHOW);
		await page.sleep(4000);
		const after = obs.awaysSince(me, t6b);
		s = await state("after a bfcache hide and a new load");
		page.check(
			`bfcache hide + new load: still away 'gone fishing' to others (${
				s.flag
			}, ${JSON.stringify(s.away)}, lines ${JSON.stringify(after)})`,
			s.flag === "G" && s.away === "gone fishing"
		);
		page.check(
			`bfcache hide + new load: never shown back in between (${JSON.stringify(after)})`,
			!after.some((l) => /AWAY\s*$/.test(l))
		);

		// --- 7. ... a real reload and a same-page reconnect. --------------
		let x = await realReload("/away, real reload");
		page.check(
			`/away, real reload: still 'gone fishing', never back (${x.flag}, ${JSON.stringify(
				x.away
			)}, lines ${JSON.stringify(x.lines)})`,
			x.flag === "G" && x.away === "gone fishing" && noBack(x.lines)
		);
		x = await reconnect("/away, reconnected");
		page.check(
			`/away, same-page reconnect: still 'gone fishing', never back (${
				x.flag
			}, ${JSON.stringify(x.away)}, lines ${JSON.stringify(x.lines)})`,
			x.flag === "G" && x.away === "gone fishing" && noBack(x.lines)
		);
		r = await step("/back after the reconnect", () => command("/back"));
		page.check(
			`/back after the reconnect: present (${JSON.stringify(r.aways)})`,
			r.flag === "H" && r.away === null
		);
		x = await bfcacheHide("bfcache hide after /back");
		// The hidden page's own AWAY * then back, by design (a hide).
		page.check(
			`bfcache hide + new load after /back: present, the old away not declared again (${
				x.flag
			}, ${JSON.stringify(x.lines)})`,
			x.flag === "H" && x.away === null && !x.lines.some((l) => /gone fishing/.test(l))
		);

		// --- 8. DND across a hide, a real reload and a reconnect. ----------
		r = await step("DND on before reload", () => menu(PILL, "dnd-indefinite"));
		page.check("DND on before reload: away", r.flag === "G");
		x = await bfcacheHide("DND, bfcache hide + new load");
		page.check(
			`DND, bfcache hide + new load: never back, still away (${
				x.flag
			}, lines ${JSON.stringify(x.lines)})`,
			x.flag === "G" && x.away !== null && noBack(x.lines)
		);
		x = await realReload("DND, real reload");
		page.check(
			`DND, real reload: never back, still away (${x.flag}, lines ${JSON.stringify(
				x.lines
			)})`,
			x.flag === "G" && x.away !== null && noBack(x.lines)
		);
		x = await reconnect("DND, reconnected");
		page.check(
			`DND, same-page reconnect: never back, still away (${x.flag}, lines ${JSON.stringify(
				x.lines
			)})`,
			x.flag === "G" && x.away !== null && noBack(x.lines)
		);
		r = await step("DND off after reload", () => menu(PILL, "status-auto"));
		page.check("DND off after reload: present", r.flag === "H" && r.away === null);

		// --- 9. Away mode across a hide and a reconnect. --------------------
		r = await step("away mode before reload", () => menu(DOT, "presence-away"));
		page.check("away mode before reload: away", r.flag === "G");
		x = await bfcacheHide("away mode, bfcache hide + new load");
		page.check(
			`away mode, bfcache hide + new load: never back, still away (${
				x.flag
			}, lines ${JSON.stringify(x.lines)})`,
			x.flag === "G" && x.away !== null && noBack(x.lines)
		);
		x = await reconnect("away mode, reconnected");
		page.check(
			`away mode, same-page reconnect: never back, still away (${
				x.flag
			}, lines ${JSON.stringify(x.lines)})`,
			x.flag === "G" && x.away !== null && noBack(x.lines)
		);
		r = await step("away mode → auto", () => menu(DOT, "presence-auto"));
		page.check("auto after away mode: present", r.flag === "H");

		// --- 10. A present Auto page: reload, close, reopen. ---------------
		// A reload: the unloading page hands its AWAY * to the worker, which
		// finds the new window and says nothing. Long enough for the worker's
		// 5 s delay to run out. (Chromium's real reload never blinked here:
		// the pagehide QUIT goes out before the unload's star. The blink is
		// the back/forward cache's — `bfcacheHide()` above — which is a hide
		// and keeps its star on purpose.) The close is what the
		// old build got wrong: its star never got out, and the held session
		// showed WHO G with no 301 and no AWAY to away-notify clients.
		let t10 = Date.now();
		await page.send("Page.reload");
		await page.waitFor(joined("#seance"), {timeout: 25000, label: "reload: session restored"});
		await page.evaluate(SHOW);
		await page.sleep(8000);
		let lines = obs.awaysSince(me, t10);
		s = await state("present, reloaded");
		page.check(
			`present Auto, reload: no AWAY line at all (${s.flag}, ${JSON.stringify(lines)})`,
			lines.length === 0 && s.flag === "H" && s.away === null
		);

		// A close: no window of the app left, so the worker logs in and says
		// AWAY * to the held session.
		t10 = Date.now();
		await page.evaluate(CLOSE_FOR_REAL);
		await page.goto("about:blank");
		for (let waited = 0; waited < 8000 && obs.awaysSince(me, t10).length === 0; waited += 250) {
			await page.sleep(250);
		}
		const closedAfter = Date.now() - t10;
		await page.sleep(2500); // nothing more may follow
		lines = obs.awaysSince(me, t10);
		s = await state("present, closed");
		page.check(
			`present Auto, close: one away, the worker's after its delay, within 8 s (${closedAfter} ms, ${JSON.stringify(
				lines
			)})`,
			lines.length === 1 &&
				/ AWAY :\S/.test(lines[0]) &&
				closedAfter >= 4000 &&
				closedAfter < 8000
		);
		page.check(
			`present Auto, close: held session WHO G with a 301 (${s.flag}, ${JSON.stringify(
				s.away
			)})`,
			s.flag === "G" && s.away !== null
		);

		// Reopen: present again, on Auto, on a visible page.
		t10 = Date.now();
		await page.goto(BASE, {waitForSelector: "#chat-container"});
		await page.waitFor(joined("#seance"), {timeout: 25000, label: "reopen: session restored"});
		await page.evaluate(SHOW);
		// The resumed session says AWAY only once the account's mute list
		// was read (another device's DND), 10 s after registration: up to
		// ~10 s away to others after a worker's star (accepted).
		const opened = Date.now();
		let back = false;

		for (let waited = 0; waited < 16000 && !back; waited += 500) {
			back = obs.awaysSince(me, t10).some((l) => /AWAY\s*$/.test(l));
			await page.sleep(500);
		}

		const backAfter = Date.now() - opened;
		await page.sleep(SETTLE);
		lines = obs.awaysSince(me, t10);
		s = await state("reopened");
		page.check(
			`reopen after the close: present within ~15 s of the page (${backAfter} ms, ${
				s.flag
			}, ${JSON.stringify(lines)})`,
			s.flag === "H" && s.away === null && backAfter < 16000
		);
	} finally {
		await command("/back").catch(() => undefined);
		await page.sleep(500);
		obs.close();
		proxy.close();
	}

	page.check("no console errors", page.consoleErrors.length === 0);
}
