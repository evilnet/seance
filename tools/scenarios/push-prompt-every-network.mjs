// Two push networks connecting together each get their turn at the push
// prompt (webpush.ts `waiting` / `scheduleHandoff`): the prompt is one at a
// time, and the second network used to be skipped until it reconnected.
//
//   npx webpack && python3 -m http.server -d public 8001 &
//   node tools/browser-drive.mjs tools/scenarios/push-prompt-every-network.mjs
//
// Defaults to the testnet ircd the other push scenarios use. Against a real
// network (one SASL account is enough — both saved networks log in with it —
// or a second one in SEANCE_PUSH_ACCOUNT2 / SEANCE_PUSH_PASSWORD2):
//
//   SEANCE_PUSH_HOST=fractalrealities.afternet.org/wockets/secure \
//   SEANCE_PUSH_PORT=9998 SEANCE_PUSH_TLS=1 SEANCE_PUSH_CHANNEL='#textual' \
//   SEANCE_PUSH_ACCOUNT=… SEANCE_PUSH_PASSWORD=… node tools/browser-drive.mjs …
//
// There, run one part at a time (SEANCE_PUSH_PARTS=1, then 4, 5, 6): the
// whole run dials often enough for the server's connection throttle to
// refuse the last part's sockets.
//
// The Push API is faked (lib/fake-push.mjs); SASL and WEBPUSH on the wire are
// real, and the run unsubscribes both networks at the end of each part, so
// the account is left with nothing registered. Notification permission is
// reset to "default" (Browser.resetPermissions) before each part.
//
// Claims under test:
//   1. with notification permission not yet asked, two networks connecting
//      together open one prompt, for one of them;
//   2. accepting it subscribes that network, then the other one silently
//      under the permission just granted — a REGISTER on each socket, two
//      entries — with no second prompt;
//   3. both unsubscribe again (cleanup);
//   4. permission granted only AFTER the Yes: while the browser's permission
//      request is pending (held open by a stand-in requestPermission), a
//      second network connecting and announcing push opens no prompt of its
//      own; once permission is granted, both subscribe, still no prompt;
//   5. one network's prompt answered with a double-click on No declines that
//      network only: the second click, landing as the next network's prompt
//      comes up, answers nothing (a prompt takes no answer in its first
//      450 ms, webpush.ts PROMPT_ARM_MS); a held Escape (auto-repeat
//      keydowns) does not answer it either; a plain Escape does;
//   6. a click the OS counts as the second of a double-click (a slow
//      double-click setting, the count carried over from the click before)
//      still answers a prompt that has been up past that first moment.

import {FAKE_PUSH_API, storedSubs, webpushOut} from "./lib/fake-push.mjs";

const ORIGIN = "http://127.0.0.1:8001";
const env = process.env;
const HOST = env.SEANCE_PUSH_HOST || "127.0.0.1";
const PORT = Number(env.SEANCE_PUSH_PORT || 8067);
const TLS = env.SEANCE_PUSH_TLS === "1";
const CHANNEL = env.SEANCE_PUSH_CHANNEL || "#seance";
const ACCOUNT1 = env.SEANCE_PUSH_ACCOUNT || "pushtest1";
const PASSWORD1 = env.SEANCE_PUSH_PASSWORD || "pushtest1-pass";
// A second account if given, else the first one again (both log in with it).
const ACCOUNT2 = env.SEANCE_PUSH_ACCOUNT2 || (env.SEANCE_PUSH_ACCOUNT ? ACCOUNT1 : "pushtest2");
const PASSWORD2 =
	env.SEANCE_PUSH_PASSWORD2 || (env.SEANCE_PUSH_ACCOUNT ? PASSWORD1 : "pushtest2-pass");
// Which parts to run (SEANCE_PUSH_PARTS="1,4,5,6", the default, is all of
// them; 1 includes 2 and 3). Against a real network the full run dials
// eight times, and nefarious2's connection throttle refuses the last of them
// (docs/resources/nefarious2-websocket.md § Connection throttle): run the
// parts one at a time there, a few minutes apart.
const PARTS = new Set((env.SEANCE_PUSH_PARTS || "1,4,5,6").split(/[\s,]+/));
const tag = Math.random().toString(36).slice(2, 6);
const NET1 = {
	uuid: `pp1-${tag}`,
	name: "First",
	nick: `ppA${tag}`,
	account: ACCOUNT1,
	password: PASSWORD1,
};
const NET2 = {
	uuid: `pp2-${tag}`,
	name: "Second",
	nick: `ppB${tag}`,
	account: ACCOUNT2,
	password: PASSWORD2,
};

export const url = `${ORIGIN}/`;

const frameText = (f) => (typeof f.payloadData === "string" ? f.payloadData : "");
const promptOpened = `document.querySelector("#push-prompt-overlay")?.classList.contains("opened")`;
// A prompt takes no answer in its first moments (webpush.ts PROMPT_ARM_MS);
// `data-armed` marks it ready.
const promptArmed = `document.querySelector("#push-prompt[data-armed]") !== null`;
const promptGone = `getComputedStyle(document.querySelector("#push-prompt-overlay")).visibility === "hidden"`;

const saved = (net) => ({
	uuid: net.uuid,
	name: net.name,
	host: HOST,
	port: PORT,
	tls: TLS,
	nick: net.nick,
	join: CHANNEL,
	sasl: "plain",
	saslAccount: net.account,
	saslPassword: net.password,
	rememberPassword: true,
	autoconnect: true,
	pushEnabled: true,
});

/** The socket (requestId) that sent `NICK <nick>`. */
function socketOfNick(page, since, nick) {
	const hit = page.wsFrames
		.slice(since)
		.find((f) => f.dir === "out" && frameText(f).trim() === `NICK ${nick}`);
	return hit?.requestId;
}

/** Wait for a frame on one socket; returns its text. */
async function waitOn(page, since, requestId, dir, re, what) {
	const deadline = Date.now() + 30000;

	while (Date.now() < deadline) {
		const hit = page.wsFrames
			.slice(since)
			.find((f) => f.dir === dir && f.requestId === requestId && re.test(frameText(f)));

		if (hit) {
			return frameText(hit);
		}

		await page.sleep(100);
	}

	throw new Error(`timed out waiting for ${what}`);
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function waitRegisterOn(page, since, requestId, what) {
	const deadline = Date.now() + 30000;

	while (Date.now() < deadline) {
		const hit = page.wsFrames
			.slice(since)
			.find(
				(f) =>
					f.dir === "out" &&
					f.requestId === requestId &&
					/^WEBPUSH REGISTER /.test(frameText(f))
			);

		if (hit) {
			return frameText(hit).split(" ")[2];
		}

		await page.sleep(100);
	}

	throw new Error(`timed out waiting for ${what}`);
}

async function pushOff(page, net, endpoint, requestId) {
	const mark = page.wsFrames.length;
	await page.evaluate(`location.hash = "#/edit-network/${net.uuid}"`);
	await page.waitFor(`!!document.querySelector('input[name="pushEnabled"]')`, {
		label: `the push checkbox for ${net.name}`,
	});

	for (const selector of ['input[name="pushEnabled"]', 'button[type="submit"]']) {
		await page.evaluate(
			`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block: "center"})`
		);
		await page.click(selector);
	}

	// The server's answer, not just our line: the account keeps nothing.
	await waitOn(
		page,
		mark,
		requestId,
		"in",
		new RegExp(`^WEBPUSH UNREGISTER ${escape(endpoint)}$`),
		`the server's answer to ${net.name}'s UNREGISTER`
	);
}

export default async function run(page) {
	await page.addInitScript(FAKE_PUSH_API);
	await page.goto(url);
	await page.waitFor(`document.readyState === "complete"`, {label: "the page"});

	if (PARTS.has("1")) {
		await bothAtOnce(page);
	}

	if (PARTS.has("4")) {
		await permissionLate(page);
	}

	if (PARTS.has("5")) {
		await doubleClickAndHeldEscape(page);
	}

	if (PARTS.has("6")) {
		await countedClickAnswers(page);
	}

	page.check("no console errors", page.consoleErrors.length === 0);
}

// --- 1–3. two networks at once: one prompt, both subscribed, cleaned up ----
async function bothAtOnce(page) {
	// --- setup: two saved networks, permission never asked -------------------
	await page.evaluate(`(() => {
		localStorage.setItem("thelounge.networks", ${JSON.stringify(
			JSON.stringify([saved(NET1), saved(NET2)])
		)});
		localStorage.removeItem("thelounge.push");
		localStorage.removeItem("thelounge.push.neverAsk");
	})()`);
	page.check(
		"setup: notification permission not yet asked",
		(await page.evaluate(`Notification.permission`)) === "default"
	);

	const before = page.wsFrames.length;
	await page.evaluate(`location.reload()`);

	// --- 1. one prompt, for one network --------------------------------------
	await page.waitFor(promptOpened, {label: "the push prompt", timeout: 60000});
	const sock1 = socketOfNick(page, before, NET1.nick);
	const sock2 = socketOfNick(page, before, NET2.nick);
	page.check(
		"1. both networks dialled on their own sockets",
		Boolean(sock1 && sock2 && sock1 !== sock2)
	);

	// The race under test: both registrations have announced push while the
	// first prompt is still open (each says so with its end of MOTD).
	for (const [sock, net] of [
		[sock1, NET1],
		[sock2, NET2],
	]) {
		await waitOn(page, before, sock, "in", / (376|422) /, `${net.name}'s registration`);
	}

	await page.sleep(1500);
	page.check(
		"1. still one prompt once both have registered",
		(await page.evaluate(promptOpened)) === true
	);
	const label = String(
		await page.evaluate(
			`document.querySelector("#push-prompt .push-prompt-target")?.textContent`
		)
	);
	const first = label.includes(NET1.name) ? NET1 : label.includes(NET2.name) ? NET2 : null;
	page.check(`1. the prompt names one network (${label.trim()})`, first !== null);
	await page.screenshot("1-one-prompt");

	// --- 2. accept: that one subscribes, then the other silently -------------
	await page.grantPermissions(["notifications"], ORIGIN);
	const mark = page.wsFrames.length;
	await page.waitFor(promptArmed, {label: "the prompt to take answers"});
	await page.click("#pushPromptYes");
	const ep1 = await waitRegisterOn(page, mark, sock1, "network 1's REGISTER");
	const ep2 = await waitRegisterOn(page, mark, sock2, "network 2's REGISTER");
	page.check("2. each network registered its own endpoint", Boolean(ep1 && ep2) && ep1 !== ep2);
	await page.sleep(1500);
	page.check("2. no second prompt", (await page.evaluate(promptGone)) === true);
	const subs = await storedSubs(page);
	page.check(
		"2. two entries, one per network",
		Object.keys(subs).sort().join() === [NET1.uuid, NET2.uuid].sort().join()
	);
	await page.screenshot("2-both-subscribed");

	// --- 3. cleanup ------------------------------------------------------------
	await pushOff(page, NET1, ep1, sock1);
	await pushOff(page, NET2, ep2, sock2);
	page.check("3. cleanup: nothing stored", Object.keys(await storedSubs(page)).length === 0);
}

/** Saved networks as given, push storage empty, permission back to "default". */
async function freshStart(page, networks) {
	await page.send("Browser.resetPermissions", {});
	await page.evaluate(`(() => {
		localStorage.setItem("thelounge.networks", ${JSON.stringify(JSON.stringify(networks))});
		localStorage.removeItem("thelounge.push");
		localStorage.removeItem("thelounge.push.neverAsk");
	})()`);
	const since = page.wsFrames.length;
	await page.evaluate(`location.reload()`);
	await page.waitFor(`document.readyState === "complete"`, {label: "the reloaded page"});
	return since;
}

/** Count every time the prompt overlay opens from here on. */
const COUNT_OPENS = `(() => {
	const overlay = document.querySelector("#push-prompt-overlay");
	window.__promptOpens = 0;
	let open = overlay.classList.contains("opened");
	new MutationObserver(() => {
		const now = overlay.classList.contains("opened");
		if (now && !open) window.__promptOpens++;
		open = now;
	}).observe(overlay, {attributes: true, attributeFilter: ["class"]});
})()`;

/** Notification.requestPermission held open until the scenario lets go,
 * then answering with the real permission (set meanwhile by
 * grantPermissions): the window in which the browser's own dialog is up.
 * Once released it answers at once, as a browser does when the question is
 * already settled — the networks subscribing after the first ask again. */
const HOLD_PERMISSION = `(() => {
	const held = [];
	let released = false;
	window.__permissionAsk = {
		asked: false,
		release() {
			released = true;
			held.splice(0).forEach((resolve) => resolve(Notification.permission));
		},
	};
	Notification.requestPermission = () => new Promise((resolve) => {
		window.__permissionAsk.asked = true;
		if (released) resolve(Notification.permission);
		else held.push(resolve);
	});
})()`;

const promptNames = (page) =>
	page
		.evaluate(`document.querySelector("#push-prompt .push-prompt-target")?.textContent || ""`)
		.then(String);

// --- 4. permission granted after the Yes, a network announcing meanwhile ----
async function permissionLate(page) {
	const since = await freshStart(page, [saved(NET1), {...saved(NET2), autoconnect: false}]);
	page.check(
		"4. setup: notification permission not yet asked",
		(await page.evaluate(`Notification.permission`)) === "default"
	);

	await page.waitFor(promptOpened, {label: "the first network's prompt", timeout: 60000});
	const sock1 = socketOfNick(page, since, NET1.nick);
	page.check(
		"4. the prompt names the first network",
		(await promptNames(page)).includes(NET1.name)
	);
	await page.evaluate(HOLD_PERMISSION);
	await page.evaluate(COUNT_OPENS);

	const mark = page.wsFrames.length;
	await page.waitFor(promptArmed, {label: "the prompt to take answers"});
	await page.click("#pushPromptYes");
	await page.waitFor(`window.__permissionAsk.asked`, {label: "the permission request"});
	// The overlay's visibility fades over 0.2 s, so wait for it.
	await page.waitFor(promptGone, {label: "the prompt to close on Yes"});

	// The second network connects and announces push while permission is
	// still being asked.
	await page.evaluate(`location.hash = "#/settings/networks"`);
	await page.waitFor(`document.querySelectorAll(".network-settings-item").length === 2`, {
		label: "the saved networks",
	});
	await page.evaluate(`[...document.querySelectorAll(".network-settings-item")]
		.find((li) => li.textContent.includes(${JSON.stringify(NET2.name)}))
		.querySelector(".network-settings-actions button").click()`);
	const deadline = Date.now() + 30000;
	let sock2;

	while (!(sock2 = socketOfNick(page, mark, NET2.nick)) && Date.now() < deadline) {
		await page.sleep(100);
	}

	page.check(
		"4. the second network dialled on its own socket",
		Boolean(sock2 && sock2 !== sock1)
	);
	await waitOn(page, mark, sock2, "in", / (376|422) /, `${NET2.name}'s registration`);
	await page.sleep(1500); // well past the 300 ms hand-off
	page.check(
		"4. no prompt for the second network while permission is pending",
		(await page.evaluate(`window.__promptOpens`)) === 0 &&
			(await page.evaluate(promptGone)) === true
	);
	page.check(
		"4. nothing registered before permission is answered",
		webpushOut(page, mark).length === 0
	);
	await page.screenshot("4-permission-pending");

	await page.grantPermissions(["notifications"], ORIGIN);
	await page.evaluate(`window.__permissionAsk.release()`);
	const ep1 = await waitRegisterOn(page, mark, sock1, "network 1's REGISTER");
	const ep2 = await waitRegisterOn(page, mark, sock2, "network 2's REGISTER");
	page.check("4. each network registered its own endpoint", Boolean(ep1 && ep2) && ep1 !== ep2);
	await page.sleep(1500);
	page.check(
		"4. no prompt at any point after the Yes",
		(await page.evaluate(`window.__promptOpens`)) === 0
	);
	const subs = await storedSubs(page);
	page.check(
		"4. two entries, one per network",
		Object.keys(subs).sort().join() === [NET1.uuid, NET2.uuid].sort().join()
	);

	await pushOff(page, NET1, ep1, sock1);
	await pushOff(page, NET2, ep2, sock2);
	page.check("4. cleanup: nothing stored", Object.keys(await storedSubs(page)).length === 0);
}

/** A real double-click: the first press-release, then — once `between`
 * holds — the second with clickCount 2, as the OS reports it. */
async function doubleClick(page, selector, between) {
	const r = await page.rect(selector);
	const x = r.x + r.width / 2;
	const y = r.y + r.height / 2;
	const press = async (clickCount) => {
		for (const type of ["mousePressed", "mouseReleased"]) {
			await page.send("Input.dispatchMouseEvent", {
				type,
				x,
				y,
				button: "left",
				buttons: type === "mousePressed" ? 1 : 0,
				clickCount,
			});
		}
	};

	await page.send("Input.dispatchMouseEvent", {type: "mouseMoved", x, y});
	await press(1);
	await between();
	await press(2);
}

/** One Escape keydown (a held key's repeats carry `autoRepeat`); `release`
 * sends its keyup. */
async function escapeKey(page, autoRepeat, release = false) {
	const key = {
		key: "Escape",
		code: "Escape",
		windowsVirtualKeyCode: 27,
		nativeVirtualKeyCode: 27,
	};
	await page.send("Input.dispatchKeyEvent", {type: "rawKeyDown", ...key, autoRepeat});

	if (release) {
		await page.send("Input.dispatchKeyEvent", {type: "keyUp", ...key});
	}
}

// --- 5. a double-click and a held Escape answer only what was on screen -----
async function doubleClickAndHeldEscape(page) {
	const since = await freshStart(page, [saved(NET1), saved(NET2)]);
	await page.waitFor(promptOpened, {label: "the first prompt", timeout: 60000});

	for (const net of [NET1, NET2]) {
		const sock = socketOfNick(page, since, net.nick);
		await waitOn(page, since, sock, "in", / (376|422) /, `${net.name}'s registration`);
	}

	await page.sleep(1500);
	const firstLabel = await promptNames(page);
	const first = firstLabel.includes(NET1.name) ? NET1 : NET2;
	const second = first === NET1 ? NET2 : NET1;
	page.check(`5. one prompt, for ${first.name}`, firstLabel.includes(first.name));

	const mark = page.wsFrames.length;
	await doubleClick(page, "#pushPromptNo", () =>
		page.waitFor(
			`${promptOpened} && (document.querySelector("#push-prompt .push-prompt-target")?.textContent || "").includes(${JSON.stringify(
				second.name
			)})`,
			{label: `${second.name}'s prompt after the first click`}
		)
	);
	await page.sleep(500);
	page.check(
		`5. the double-click's second click left ${second.name}'s prompt open`,
		(await page.evaluate(promptOpened)) === true &&
			(await promptNames(page)).includes(second.name)
	);
	await page.screenshot("5-after-double-click");

	// The keys go to the document's binding (App.vue), not the composer's.
	await page.evaluate(`document.activeElement?.blur()`);

	for (let i = 0; i < 5; i++) {
		await escapeKey(page, true);
		await page.sleep(40);
	}

	await page.sleep(300);
	page.check(
		"5. auto-repeated Escape keydowns did not answer it",
		(await page.evaluate(promptOpened)) === true
	);

	await escapeKey(page, true, true); // the held key's release
	await escapeKey(page, false, true);
	await page.waitFor(promptGone, {label: "the prompt to close on a plain Escape"});
	await page.sleep(1000);
	page.check(
		"5. a plain Escape declined it, nothing follows",
		(await page.evaluate(promptGone)) === true
	);
	page.check("5. nothing was subscribed", webpushOut(page, mark).length === 0);
}

// --- 6. a click the OS counts as a second one still answers -----------------
async function countedClickAnswers(page) {
	const since = await freshStart(page, [saved(NET1), saved(NET2)]);
	await page.waitFor(promptArmed, {label: "the first prompt to take answers", timeout: 60000});

	for (const net of [NET1, NET2]) {
		const sock = socketOfNick(page, since, net.nick);
		await waitOn(page, since, sock, "in", / (376|422) /, `${net.name}'s registration`);
	}

	await page.sleep(1500);
	const firstLabel = await promptNames(page);
	const first = firstLabel.includes(NET1.name) ? NET1 : NET2;
	const second = first === NET1 ? NET2 : NET1;
	const mark = page.wsFrames.length;

	// One press-release reported with clickCount 2, long after the prompt
	// opened: it used to be dropped as "the second click of a double-click".
	const r = await page.rect("#pushPromptNo");
	const x = r.x + r.width / 2;
	const y = r.y + r.height / 2;
	await page.send("Input.dispatchMouseEvent", {type: "mouseMoved", x, y});

	for (const type of ["mousePressed", "mouseReleased"]) {
		await page.send("Input.dispatchMouseEvent", {
			type,
			x,
			y,
			button: "left",
			buttons: type === "mousePressed" ? 1 : 0,
			clickCount: 2,
		});
	}

	await page.waitFor(
		`${promptArmed} && (document.querySelector("#push-prompt .push-prompt-target")?.textContent || "").includes(${JSON.stringify(
			second.name
		)})`,
		{label: `${second.name}'s prompt after ${first.name}'s was answered`}
	);
	page.check(`6. a clickCount-2 click answered ${first.name}'s prompt`, true);

	await page.click("#pushPromptNo");
	await page.waitFor(promptGone, {label: "the second prompt to close on No"});
	await page.sleep(1000);
	page.check("6. both declined, nothing follows", (await page.evaluate(promptGone)) === true);
	page.check("6. nothing was subscribed", webpushOut(page, mark).length === 0);
}
