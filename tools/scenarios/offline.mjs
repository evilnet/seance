// The device loses its network (docs/projects/reconnect-throttle.md): the
// client says once that it is offline, with no certificate hint and no
// retries every few seconds, and reconnects as soon as the network is back.
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/offline.mjs
//   (also --mobile --width=390 --height=844)
//
// Chrome's network emulation sets `navigator.onLine` and fires `offline` /
// `online`; the socket is dropped under the client to stand in for the OS
// killing it.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // dev ircd's self-signed cert

const PORT = process.env.SEANCE_PORT ?? "8000";
const RUN = Date.now().toString(36).slice(-5);

export const url = `http://localhost:${PORT}/?host=localhost&port=8443&tls=true&nick=off${RUN}&join=%23seance`;
export const allowWsFrameErrors = /(Data frame|Close) received after close/;

const KEEP_SOCKET = `(() => {
	const Real = window.WebSocket;
	window.__dials = 0;
	function Kept(...args) {
		window.__dials++;
		window.__lastWs = new Real(...args);
		return window.__lastWs;
	}
	Kept.prototype = Real.prototype;
	for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Kept[k] = Real[k];
	window.WebSocket = Kept;
})()`;

const LABEL = `document.querySelector(".connection-bar-label")?.textContent ?? ""`;
const BAR_GONE = `!document.querySelector(".connection-bar")`;
const LOBBY_TEXT = `Array.from(document.querySelectorAll("#chat .msg")).map((m) => m.textContent.trim())`;

function network(page, offline) {
	return page.send("Network.emulateNetworkConditions", {
		offline,
		latency: 0,
		downloadThroughput: -1,
		uploadThroughput: -1,
	});
}

export default async function run(page) {
	await page.addInitScript(KEEP_SOCKET);
	await page.send("Network.enable");
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="#seance"]')`, {
		timeout: 30000,
		label: "#seance in the sidebar",
	});
	await page.click('.channel-list-item[data-name="#seance"]');
	await page.waitFor(`document.querySelector("#input")`, {label: "the input"});
	await page.sleep(1500);

	page.expectWsErrors = true;
	await network(page, true);
	await page.evaluate("window.__lastWs.close()");
	const dials = await page.evaluate("window.__dials");
	await page.waitFor(`/You're offline/.test(${LABEL})`, {
		timeout: 20000, // the strip shows after 10 s down (ChatInput.vue)
		label: "the offline strip",
	});
	const label = await page.evaluate(LABEL);
	await page.check(
		`the strip says the device is offline, no countdown ("${label}")`,
		/^You're offline\. Will reconnect to .+ when the network is back\.$/.test(label)
	);
	await page.check("no dials while offline", (await page.evaluate("window.__dials")) === dials);
	await page.screenshot("1-offline", {selector: "#form", pad: 30});

	await page.evaluate(`document.querySelector(".channel-list-item[data-type='lobby']").click()`);
	await page.sleep(500);
	const lobby = await page.evaluate(LOBBY_TEXT);
	await page.check(
		"the lobby says it once",
		lobby.filter((l) => /You're offline/.test(l)).length === 1
	);
	await page.check(
		"and gives no certificate hint",
		!lobby.some((l) => /does not reveal why/.test(l))
	);

	// Synthetic, as for the lobby: on a phone the sidebar is closed by now.
	await page.evaluate(
		`document.querySelector('.channel-list-item[data-name="#seance"]').click()`
	);
	await page.waitFor(`/You're offline/.test(${LABEL})`, {label: "the strip again"});
	const back = Date.now();
	await network(page, false);
	await page.waitFor(BAR_GONE, {timeout: 15000, label: "reconnected"});
	page.expectWsErrors = false;
	const took = Date.now() - back;
	await page.check(`the network back, it reconnects at once (${took} ms)`, took < 5000);

	await page.check("no console errors", page.consoleErrors.length === 0);
}
