// A conversation on a network that is down: the send button is disabled (the
// draft stays; slash commands still go), the view fades like a pending
// message, and a strip above the input says what is happening — all of it
// gone the moment the network registers again
// (docs/projects/seamless-reconnect.md § Round eight).
//
//   NODE_ENV=production pnpm build && python3 -m http.server -d public 8001 &
//   node tools/browser-drive.mjs tools/scenarios/disconnected-channel.mjs [--chrome=…]
//   node tools/browser-drive.mjs tools/scenarios/disconnected-channel.mjs --mobile --width=390 --height=844
//
// Needs an ircd speaking plain WebSocket on 127.0.0.1:8067. The page connects
// through lib/irc-proxy.mjs so the socket can be cut and dials refused.
// `SEANCE_URL` overrides where the built tree is served from.
//
// Claims:
//   1. connected: send enabled, no strip, nothing faded;
//   2. the socket cut and dials refused: no strip for the first seconds (a
//      quick reconnect says nothing), then, once the network has been down
//      for 10 s, the strip says "Connecting to …" or counts the retry down;
//      the send button is disabled, the view and the sidebar rows fade;
//   3. Enter with plain text keeps the draft (nothing is sent); a slash
//      command re-enables the button;
//   4. /disconnect: the strip says "Disconnected from …" with a Connect
//      button that dials again;
//   5. once dials go through everything clears and a message sends;
//   6. no console errors.

import {startProxy} from "./lib/irc-proxy.mjs";

const HOST = process.env.SEANCE_URL ?? "http://127.0.0.1:8001";
const PROXY_PORT = 9875;
const NICK = "dc" + Math.random().toString(36).slice(2, 7);

export const url = `${HOST}/?host=127.0.0.1&port=${PROXY_PORT}&tls=false&nick=${NICK}&join=%23seance`;

const BAR = "#form .connection-bar";
const LABEL = `${BAR} .connection-bar-label`;
const ROW = ".channel-list-item[data-type='channel']";
const CONTENT = "#chat .chat-content";
/** Long enough for the 0.3 s fade to settle before its opacity is read. */
const FADE_MS = 500;

const barText = (page) =>
	page.evaluate(
		`(document.querySelector(${JSON.stringify(LABEL)}) || {textContent: ""}).textContent.trim()`
	);
const barSays = (pattern) =>
	`${pattern}.test((document.querySelector(${JSON.stringify(
		LABEL
	)}) || {textContent: ""}).textContent.trim())`;
const submitDisabled = (page) => page.evaluate(`document.querySelector("#submit").disabled`);
const opacityOf = (page, selector) =>
	page.evaluate(
		`Number(getComputedStyle(document.querySelector(${JSON.stringify(selector)})).opacity)`
	);
const chatDisconnected = (page) =>
	page.evaluate(`document.querySelector("#chat").classList.contains("disconnected")`);
const draft = (page) => page.evaluate(`document.querySelector("#input").value`);
const registered = (page, since) =>
	page.wsFrames.slice(since).some((f) => f.dir === "in" && / 001 /.test(f.payloadData ?? ""));
const sentPrivmsg = (page, since, text) =>
	page.wsFrames
		.slice(since)
		.some((f) => f.dir === "out" && (f.payloadData ?? "").includes(`PRIVMSG #seance :${text}`));

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

/** A real Enter keystroke in the focused input (keydown with text → keypress). */
async function pressEnter(page) {
	const key = {key: "Enter", code: "Enter", windowsVirtualKeyCode: 13};
	await page.send("Input.dispatchKeyEvent", {type: "keyDown", text: "\r", ...key});
	await page.send("Input.dispatchKeyEvent", {type: "keyUp", ...key});
}

export default async function run(page) {
	const proxy = startProxy({port: PROXY_PORT, target: {host: "127.0.0.1", port: 8067}});
	await proxy.listen();

	try {
		await check(page, proxy);
	} finally {
		proxy.close();
	}
}

async function check(page, proxy) {
	// 1. Connected through the proxy, in #seance. On a phone the form's
	// submit is below the fold; a real click needs it on screen.
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(
		`document.querySelector("#connect button[type=submit]").scrollIntoView({block: "center"})`
	);
	await page.click("#connect button[type=submit]");
	await page.waitFor(`document.querySelector("#chat .header")`, {
		timeout: 15000,
		label: "the chat",
	});
	await until(page, () => registered(page, 0), 20000, "registration through the proxy");
	await page.waitFor(`document.querySelector("#chat .chat-view[data-type='channel']")`, {
		timeout: 15000,
		label: "the channel view",
	});
	await page.sleep(FADE_MS);
	page.check("1. connected: send is enabled", !(await submitDisabled(page)));
	page.check("1. connected: no connection strip", (await page.count(BAR)) === 0);
	page.check(
		"1. connected: nothing is faded",
		!(await chatDisconnected(page)) &&
			(await opacityOf(page, CONTENT)) === 1 &&
			(await opacityOf(page, ROW)) === 1
	);
	await page.screenshot("1-connected");

	// 2. The radio goes away: the socket is cut and every dial is refused.
	proxy.refuse();
	page.expectWsErrors = true;
	proxy.cut();
	await page.sleep(3000);
	page.check("2. no strip while a reconnect may still be quick", (await page.count(BAR)) === 0);
	await page.waitFor(`document.querySelector(${JSON.stringify(BAR)})`, {
		timeout: 15000,
		label: "the connection strip",
	});
	await page.sleep(FADE_MS);
	const said = await barText(page);
	page.check(
		`2. the strip says what is happening (${said})`,
		/^(Connecting to .+…|Reconnecting to .+ in \d+s…)$/.test(said)
	);
	page.check(
		"2. the strip is a polite live region",
		await page.evaluate(
			`document.querySelector(${JSON.stringify(BAR)}).getAttribute("aria-live") === "polite"`
		)
	);
	page.check("2. send is disabled", await submitDisabled(page));
	page.check(
		"2. the view fades",
		(await chatDisconnected(page)) && (await opacityOf(page, CONTENT)) < 1
	);
	page.check("2. the sidebar row fades", (await opacityOf(page, ROW)) < 1);
	await page.screenshot("2-down");

	// 2b. Between dials the strip counts the wait down and offers to skip it.
	await page.waitFor(barSays("/^Reconnecting to .+ in \\d+s…$/"), {
		timeout: 12000,
		label: "the countdown",
	});
	page.check(
		"2. the wait counts down with a Connect now button",
		(await page.evaluate(
			`(document.querySelector(${JSON.stringify(
				`${BAR} .connection-bar-connect`
			)}) || {textContent: ""}).textContent.trim()`
		)) === "Connect now"
	);
	// A dial the proxy refuses never opens, so the wait after it is the
	// fallback (transport.ts UNREACHED_RETRY_MS, 42 s).
	await page.waitFor(barSays("/^Reconnecting to .+ in [3-9]\\d*s…$/"), {
		timeout: 15000,
		label: "a longer countdown",
	});
	await page.screenshot("2b-countdown");
	await page.click(`${BAR} .connection-bar-connect`);
	await page.sleep(300);
	const after = await barText(page);
	page.check(
		`2. Connect now dials at once (${after})`,
		/^Connecting to /.test(after) || /in 4[12]s…$/.test(after)
	);

	// 3. Typing is allowed; Enter with plain text sends nothing and keeps the
	// draft; a slash command is still sendable.
	await page.click("#input");
	await page.fill("#input", "hello while down");
	page.check("3. plain text: send stays disabled", await submitDisabled(page));
	await pressEnter(page);
	await page.sleep(300);
	page.check("3. Enter kept the draft", (await draft(page)) === "hello while down");
	await page.fill("#input", "/connect");
	page.check("3. a slash command re-enables send", !(await submitDisabled(page)));
	await page.screenshot("3-draft");

	// 4. Cancelling the retries: the strip offers Connect, and it dials.
	await page.fill("#input", "/disconnect");
	await page.click("#submit");
	await page.waitFor(barSays("/^Disconnected from .+\\.$/"), {
		timeout: 5000,
		label: "the idle strip",
	});
	page.check(
		"4. /disconnect: the strip offers Connect",
		(await page.count(`${BAR} .connection-bar-connect`)) === 1
	);
	await page.screenshot("4-idle");
	await page.click(`${BAR} .connection-bar-connect`);
	await page.sleep(300);
	const dialled = await barText(page);
	page.check(
		`4. Connect dials again (${dialled})`,
		/^Connecting to /.test(dialled) || /^Reconnecting to .+ in \d+s…$/.test(dialled)
	);

	// 5. The radio is back: Connect now registers and everything clears (the
	// automatic retry after a refused dial is up to 42 s away). (A dial
	// refused just before the switch reports its error late, so the errors
	// stay expected until the registration is in.)
	proxy.accept();
	const frames = page.wsFrames.length;
	await page.waitFor(
		`document.querySelector(${JSON.stringify(`${BAR} .connection-bar-connect`)})`,
		{
			timeout: 5000,
			label: "Connect now",
		}
	);
	await page.click(`${BAR} .connection-bar-connect`);
	await until(page, () => registered(page, frames), 15000, "the re-registration");
	page.expectWsErrors = false;
	await page.waitFor(`!document.querySelector(${JSON.stringify(BAR)})`, {
		timeout: 5000,
		label: "the strip to go",
	});
	await page.sleep(FADE_MS);
	page.check("5. reconnected: the strip is gone", (await page.count(BAR)) === 0);
	page.check("5. reconnected: send is enabled", !(await submitDisabled(page)));
	page.check(
		"5. reconnected: nothing is faded",
		!(await chatDisconnected(page)) &&
			(await opacityOf(page, CONTENT)) === 1 &&
			(await opacityOf(page, ROW)) === 1
	);
	await page.fill("#input", "back again");
	await page.click("#submit");
	await until(page, () => sentPrivmsg(page, frames, "back again"), 5000, "the message to go out");
	page.check("5. a message sends", true);
	await page.screenshot("5-back");

	page.check("6. no console errors", page.consoleErrors.length === 0);

	if (page.consoleErrors.length > 0) {
		console.log(page.consoleErrors);
	}
}
