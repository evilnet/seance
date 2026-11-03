// After a long absence the foreground poke must not leave the user waiting
// out the backoff that piled up while the app was away: a request to connect
// restarts the schedule (client/js/irc/transport.ts;
// docs/projects/seamless-reconnect.md § Round seven).
//
//   NODE_ENV=production pnpm build && python3 -m http.server -d public 8001 &
//   node tools/browser-drive.mjs tools/scenarios/reconnect-after-backoff.mjs [--chrome=…]
//
// Needs an ircd speaking plain WebSocket on 127.0.0.1:8067 (the dev ircd or
// the testnet). The page connects through a TCP proxy this scenario runs on
// PROXY_PORT, so the connection can be cut (what a phone's radio going away
// does to the socket), every dial refused for a while (the radio still off:
// the retries pile up), and then let through again. `SEANCE_URL` overrides
// where the built tree is served from.
//
// A refused dial never opens, which a page cannot tell from a network not
// ready yet: the transport retries quickly (1, 2, 4 s), then waits 42–47 s,
// past the server's 40 s throttle window; the foreground poke leaves that
// long wait be, Connect now cuts it (docs/projects/reconnect-throttle.md).
//
// Claims:
//   1. the network registers through the proxy;
//   2. during the quick retries a foreground signal (window focus) dials at once;
//   3. after the quick retries the wait is the long one, 42–47 s;
//   4. a foreground signal during the long wait does not dial;
//   5. once dials go through again, a typed /connect registers at once;
//   6. no console errors.

import {startProxy} from "./lib/irc-proxy.mjs";

const HOST = process.env.SEANCE_URL ?? "http://127.0.0.1:8001";
const IRC = {host: "127.0.0.1", port: 8067};
const PROXY_PORT = 9874;
const NICK = "rc" + Math.random().toString(36).slice(2, 7);
/** Inside the quick retries: the first retry (about 1 s) refused, the next not yet due. */
const AWAY_MS = 2_500;

export const url = `${HOST}/?host=127.0.0.1&port=${PROXY_PORT}&tls=false&nick=${NICK}&join=%23seance`;

const LOBBY = ".channel-list-item[data-type='lobby']";
const LINES = `Array.from(document.querySelectorAll("#chat .msg")).map((m) => m.textContent.trim())`;

/** The last "Reconnecting in Ns (attempt M)…" line the lobby shows, parsed. */
function lastWait(lines) {
	for (let i = lines.length - 1; i >= 0; i--) {
		const m = /Reconnecting in (\d+)s \(attempt (\d+)\)/.exec(lines[i]);

		if (m) {
			return {seconds: Number(m[1]), attempt: Number(m[2]), index: i};
		}
	}

	return null;
}

const registered = (page, since) =>
	page.wsFrames.slice(since).some((f) => f.dir === "in" && / 001 /.test(f.payloadData ?? ""));

async function until(page, fn, timeout, label) {
	const deadline = Date.now() + timeout;

	while (Date.now() < deadline) {
		if (fn()) {
			return;
		}

		await page.sleep(200);
	}

	throw new Error(`timed out waiting for ${label}`);
}

export default async function run(page) {
	const proxy = startProxy({port: PROXY_PORT, target: IRC});
	await proxy.listen();

	try {
		await check(page, proxy);
	} finally {
		proxy.close();
	}
}

async function check(page, proxy) {
	// 1. Connect through the proxy: the URL prefills the form, an unknown
	// server asks before connecting.
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.click("#connect button[type=submit]");
	await page.waitFor(`document.querySelector("#chat .header")`, {
		timeout: 15000,
		label: "the chat",
	});
	await until(page, () => registered(page, 0), 20000, "registration through the proxy");
	page.check("1. registered through the proxy", registered(page, 0));
	// The lobby is where the connection reports. Synthetic: a real click at
	// the row's centre can land on one of its buttons (join a channel).
	await page.evaluate(`document.querySelector(${JSON.stringify(LOBBY)}).click()`);
	await page.screenshot("1-registered");

	// 2. The radio goes away: the socket is cut and every dial is refused
	// (those failed dials are the point, not a finding).
	proxy.refuse();
	page.expectWsErrors = true;
	proxy.cut();
	await page.sleep(AWAY_MS);

	// 2. The app comes back during the quick retries: it dials at once.
	let lines = await page.evaluate(LINES);
	let mark = lines.length;
	await page.evaluate(`window.dispatchEvent(new Event("focus"))`);
	await page.waitFor(
		`/Connecting to 127\\.0\\.0\\.1:${PROXY_PORT}/.test((${LINES}).slice(${mark}).join("\\n"))`,
		{timeout: 3000, label: "the foreground dial"}
	);
	page.check("2. during the quick retries the foreground signal dialled at once", true);
	await page.screenshot("2-quick");

	// 3. The quick retries run out: the long wait.
	await page.waitFor(`/Reconnecting in 4[2-7]s/.test((${LINES}).join("\\n"))`, {
		timeout: 20000,
		label: "the long wait",
	});
	lines = await page.evaluate(LINES);
	const quick = lines.filter((l) => /Reconnecting in [124]s/.test(l)).length;
	const long = lastWait(lines);
	page.check(
		`3. after quick retries (${quick} seen) the wait is the long one (${long?.seconds}s)`,
		quick >= 2 && Boolean(long) && long.seconds >= 42 && long.seconds <= 47
	);
	await page.screenshot("3-long");

	// 4. The app comes back during the long wait: it leaves it be.
	mark = lines.length;
	await page.sleep(1100); // past the foreground poke's once-a-second limit
	await page.evaluate(`window.dispatchEvent(new Event("focus"))`);
	await page.sleep(2000);
	lines = await page.evaluate(LINES);
	page.check(
		"4. a foreground signal during the long wait does not dial",
		!lines.slice(mark).some((l) => /Connecting to /.test(l))
	);

	// 5. The radio is back; the user asks: /connect dials at once and gets
	// through. (A dial refused just before the switch reports its error
	// late: errors stay expected until the registration is in.)
	proxy.accept();
	const frames = page.wsFrames.length;
	await page.fill("#input", "/connect");
	await page.evaluate(`document.querySelector("#form").requestSubmit()`);
	await until(page, () => registered(page, frames), 10000, "the re-registration");
	page.expectWsErrors = false;
	page.check("5. a typed /connect registered at once", registered(page, frames));
	await page.screenshot("4-back");

	page.check("6. no console errors", page.consoleErrors.length === 0);

	if (page.consoleErrors.length > 0) {
		console.log(page.consoleErrors);
	}
}
