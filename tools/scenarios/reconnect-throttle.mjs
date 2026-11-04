// The server's connection throttle, said over the WebSocket
// (docs/projects/reconnect-throttle.md): an `ERROR … throttled` makes the
// retry wait what it names (a second more), or 42 s when it names nothing,
// and the strip says the server limits quick reconnects, with a countdown
// and Connect now.
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/reconnect-throttle.mjs
//   (also --mobile --width=390 --height=844)
//
// nefarious2 refuses a throttled connection before the WebSocket upgrade
// today, so the page cannot read it; the server change this expects finishes
// the handshake and sends the ERROR first. Until then the page's WebSocket
// constructor is wrapped: a dial made while `window.__throttleNext` is set
// gets a stand-in socket that opens, says the ERROR and closes. Then:
//  - with a wait named (37 s), the retry waits it, says why, counts down and
//    opens no socket; "Connect now" dials at once and registers;
//  - with no wait named (stock nefarious2's text), the retry waits 42 s, and
//    the sidebar's status icon dials at once.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // dev ircd's self-signed cert

const PORT = process.env.SEANCE_PORT ?? "8000";
const RUN = Date.now().toString(36).slice(-5);

export const url = `http://localhost:${PORT}/?host=localhost&port=8443&tls=true&nick=thr${RUN}&join=%23seance`;
// The socket is dropped under the client on purpose (and /disconnect quits):
// the ircd's last lines arrive after the browser has begun the close.
export const allowWsFrameErrors = /(Data frame|Close) received after close/;

const COUNT_DIALS = `(() => {
	const Real = window.WebSocket;
	window.__dials = 0;
	window.__throttleNext = null;
	class Throttled extends EventTarget {
		constructor(text) {
			super();
			this.readyState = 0;
			this.protocol = "text.ircv3.net";
			this.binaryType = "blob";
			setTimeout(() => {
				this.readyState = 1;
				this.dispatchEvent(new Event("open"));
				this.dispatchEvent(new MessageEvent("message", {data: text}));
				this.readyState = 3;
				this.dispatchEvent(new CloseEvent("close", {code: 1006, wasClean: false}));
			}, 50);
		}
		send() {}
		close() {}
	}
	for (const [k, v] of Object.entries({CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3})) {
		Throttled.prototype[k] = v;
	}
	function Counted(...args) {
		window.__dials++;
		if (window.__throttleNext !== null) {
			const text = window.__throttleNext;
			window.__throttleNext = null;
			return new Throttled(text);
		}
		window.__lastWs = new Real(...args);
		return window.__lastWs;
	}
	Counted.prototype = Real.prototype;
	for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Counted[k] = Real[k];
	window.WebSocket = Counted;
})()`;

const STOCK = "ERROR :Your host is trying to (re)connect too fast -- throttled";
const NAMED = `${STOCK} (retry in 37 seconds)`;

const LABEL = `document.querySelector(".connection-bar-label")?.textContent ?? ""`;
const BAR_GONE = `!document.querySelector(".connection-bar")`;

/** Drop the socket under the client, with the retry's dial throttled by `text`. */
async function throttle(page, text) {
	await page.evaluate(`window.__throttleNext = ${JSON.stringify(text)}`);
	await page.evaluate("window.__lastWs.close()");
	await page.waitFor(`/the server limits/.test(${LABEL})`, {
		timeout: 20000, // the strip shows after 10 s down (ChatInput.vue)
		label: "the throttled wait",
	});
	await page.waitFor("window.__throttleNext === null", {label: "the throttled dial"});
	return page.evaluate("window.__dials");
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

	const before = await throttle(page, NAMED);
	const label = await page.evaluate(LABEL);
	const seconds = Number((label.match(/ in (\d+)s/) ?? [])[1]);
	await page.check(
		`the retry waits, saying why ("${label}")`,
		/the server limits quick reconnects/.test(label)
	);
	// 38 s from the ERROR, of which the strip's 10 s have gone.
	await page.check(
		`with the server's wait counting down (${seconds}s)`,
		seconds >= 20 && seconds <= 30
	);
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

	// Stock nefarious2's ERROR names no wait: the fallback, answered from the
	// sidebar's status icon (during a retry's wait it dials).
	await page.sleep(1000);
	const beforeIcon = await throttle(page, STOCK);
	const stock = Number(((await page.evaluate(LABEL)).match(/ in (\d+)s/) ?? [])[1]);
	await page.check(`no wait named: the fallback (${stock}s left)`, stock >= 25 && stock <= 34);
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

	await page.check("no console errors", page.consoleErrors.length === 0);
}
