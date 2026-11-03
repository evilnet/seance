// Never dial into the server's connection throttle (irc/dialLedger.ts): with
// this device's recent dials on record, a connect waits out the gap — and
// says so — instead of dialling into a refusal that would renew the server's
// window.
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/reconnect-throttle.mjs
//   (also --mobile --width=390 --height=844)
//
// The dev ircd's own throttle is relaxed (100 / 1 s / 1 s), so nothing here
// is refused by the server: what is checked is the client's ledger. (The
// ircd's registration notice reports that limit, `ca 1(100)`, and the ledger
// takes it; the seed below replaces the record without one, so the default
// limit of 4 applies again.) The
// page's WebSocket constructor is wrapped to count dials. Three dials are
// written into `thelounge.state.dials` as if the app had been reopened three
// times in quick succession, and the socket is dropped under the client;
// then:
//  - the automatic retry waits, with the throttle wording and a countdown,
//    and opens no socket;
//  - "Connect now" during the wait dials at once (the user asked) and the
//    network registers;
//  - after /disconnect with the record cleared, Connect dials at once.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // dev ircd's self-signed cert

const PORT = process.env.SEANCE_PORT ?? "8000";
const RUN = Date.now().toString(36).slice(-5);
const KEY = "thelounge.state.dials";

export const url = `http://localhost:${PORT}/?host=localhost&port=8443&tls=true&nick=thr${RUN}&join=%23seance`;
// The socket is dropped under the client on purpose (and /disconnect quits):
// the ircd's last lines arrive after the browser has begun the close.
export const allowWsFrameErrors = /(Data frame|Close) received after close/;

const COUNT_DIALS = `(() => {
	const Real = window.WebSocket;
	window.__dials = 0;
	function Counted(...args) {
		window.__dials++;
		window.__lastWs = new Real(...args);
		return window.__lastWs;
	}
	Counted.prototype = Real.prototype;
	for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Counted[k] = Real[k];
	window.WebSocket = Counted;
})()`;

/** Three recent dials on record, as if the app had been reopened three times. */
const SEED = `localStorage.setItem(${JSON.stringify(
	KEY
)}, JSON.stringify({localhost: {d: [Date.now() - 30000, Date.now() - 25000, Date.now() - 20000], c: []}}))`;

const LABEL = `document.querySelector(".connection-bar-label")?.textContent ?? ""`;
const BAR_GONE = `!document.querySelector(".connection-bar")`;

async function disconnect(page) {
	await page.fill("#input", "/disconnect");
	await page.evaluate(`document.querySelector("#form").requestSubmit()`);
	await page.waitFor(`(${LABEL}).startsWith("Disconnected from")`, {
		timeout: 10000,
		label: "the network disconnected",
	});
}

export default async function run(page) {
	await page.addInitScript(COUNT_DIALS);
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="#seance"]')`, {
		timeout: 30000,
		label: "#seance in the sidebar",
	});
	await page.click('.channel-list-item[data-name="#seance"]');
	await page.waitFor(`document.querySelector("#input")`, {label: "the input"});
	await page.sleep(1500);

	await page.evaluate(SEED);
	const before = await page.evaluate("window.__dials");
	// Lost under the client: the transport's own retry asks the gate.
	await page.evaluate("window.__lastWs.close()");
	await page.waitFor(`/the server limits/.test(${LABEL})`, {
		timeout: 20000, // the strip shows after 10 s down (ChatInput.vue)
		label: "the retry waits",
	});

	const label = await page.evaluate(LABEL);
	const seconds = Number((label.match(/ in (\d+)s/) ?? [])[1]);
	await page.check(
		`the retry waits, saying why ("${label}")`,
		/the server limits quick reconnects/.test(label)
	);
	await page.check(`with a countdown (${seconds}s)`, seconds >= 15 && seconds <= 45);
	const cut = await page.evaluate(
		`(() => { const el = document.querySelector(".connection-bar-label"); return el.scrollWidth > el.clientWidth + 1; })()`
	);
	await page.check("the reason is not cut off (a phone wraps it)", !cut);
	await page.sleep(2000);
	await page.check(
		"no socket was opened during the wait",
		(await page.evaluate("window.__dials")) === before
	);
	await page.screenshot("1-throttled", {selector: "#form", pad: 30});

	await page.click(".connection-bar-connect");
	await page.sleep(300);
	await page.check(
		"Connect now during the wait dials at once",
		(await page.evaluate("window.__dials")) === before + 1
	);
	await page.waitFor(BAR_GONE, {timeout: 15000, label: "registered after Connect now"});

	// The same wait again, answered from the sidebar's status icon: during a
	// retry's wait it dials (it cancels only a dial in flight).
	await page.sleep(1000);
	await page.evaluate(SEED);
	const beforeIcon = await page.evaluate("window.__dials");
	await page.evaluate("window.__lastWs.close()");
	await page.waitFor(`/the server limits/.test(${LABEL})`, {
		timeout: 20000, // the strip shows after 10 s down (ChatInput.vue)
		label: "the retry waits again",
	});
	const iconLabel = await page.evaluate(
		`document.querySelector(".connection-status-icon")?.getAttribute("aria-label") ?? ""`
	);
	await page.check(
		`the sidebar's status icon offers to connect now ("${iconLabel}")`,
		/connect now/.test(iconLabel)
	);
	// Synthetic: on the phone layout the sidebar is closed, and what is
	// checked is what the icon does, not the drawer.
	await page.evaluate(`document.querySelector(".connection-status-icon").click()`);
	await page.sleep(300);
	await page.check(
		"the sidebar's status icon dials during the wait",
		(await page.evaluate("window.__dials")) === beforeIcon + 1
	);
	await page.waitFor(BAR_GONE, {timeout: 15000, label: "registered after the icon"});

	await page.sleep(1000);
	await disconnect(page);
	await page.evaluate(`localStorage.removeItem(${JSON.stringify(KEY)})`);
	const again = await page.evaluate("window.__dials");
	await page.click(".connection-bar-connect");
	await page.sleep(300);
	await page.check(
		"with no dials on record, Connect dials at once",
		(await page.evaluate("window.__dials")) === again + 1 &&
			!/the server limits/.test(await page.evaluate(LABEL))
	);
	await page.waitFor(BAR_GONE, {timeout: 15000, label: "registered at once"});

	await page.check("no console errors", page.consoleErrors.length === 0);
}
