// The last opened conversation comes back after a reload, and opening a
// conversation puts the caret in the input — end to end in a real browser
// (helpers/lastChannel.ts, ChatInput.vue).
//
//   pnpm build && python3 -m http.server -d public 8001 &
//   node tools/browser-drive.mjs tools/scenarios/last-channel.mjs
//
// The default target is a plain-WS ircd on 127.0.0.1:8067 (the testnet rig,
// or the dev ircd's ws:// port). Against the dev ircd over TLS:
//   node tools/browser-drive.mjs tools/scenarios/last-channel.mjs \
//     --url='http://localhost:8000/?host=localhost&port=8443&tls=true&nick=slcwatch&join=%23seance,%23slc-other'
//
// The claims under test are what `pnpm test` cannot see: that the channel
// shown is what gets remembered (and the lobby is not), that a reload lands
// on it *before* the JOIN comes back — the autojoin channels are placeholders
// from the network's announce — and stays there through the join burst, that
// a remembered private conversation is reopened once registered, and that
// opening a conversation focuses the input with the caret after the draft.
// One browser profile is used throughout: localStorage has to survive the
// reloads, that is the point.

const RUN = Date.now().toString(36);
const NICK = `slc${RUN}`;
const OTHER = `#slc-${RUN}`;
const BUDDY = `buddy${RUN}`;
const BASE = "http://localhost:8001/";

export const url = `${BASE}?host=127.0.0.1&port=8067&tls=false&nick=${NICK}&join=${encodeURIComponent(
	`#seance,${OTHER}`
)}`;

/** Name of the conversation the chat window shows, or null. */
const ACTIVE = `(document.querySelector("#chat-container")?.dataset.currentChannel ?? null)`;
const STORED = `localStorage.getItem("thelounge.state.lastChannel")`;
const FOCUSED = `(document.activeElement?.id ?? null)`;
const joined = (name) =>
	`!!document.querySelector('.channel-list-item[data-name="${name}"]:not(.parted-channel)')`;
const item = (name) => `.channel-list-item[data-name="${name}"]`;

export default async function run(page) {
	const stored = async () => JSON.parse((await page.evaluate(STORED)) ?? "null");

	// 1. First connect through the form, autoconnect on so a reload brings
	//    the network back by itself.
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.click('#connect input[name="autoconnect"]');
	await page.click('#connect button[type="submit"]');
	await page.waitFor(joined(OTHER), {timeout: 20000, label: `joined ${OTHER}`});
	await page.sleep(300);

	page.check(
		"lands on the last channel of the join list",
		(await page.evaluate(ACTIVE)) === OTHER
	);
	page.check("remembers it", (await stored())?.target === OTHER);
	page.check(
		"headless chromium is a keyboard machine",
		(await page.evaluate(
			`window.matchMedia("(hover: none) and (pointer: coarse)").matches`
		)) === false
	);
	page.check("input focused on open", (await page.evaluate(FOCUSED)) === "input");
	await page.screenshot("1-first-connect");

	// 2. Click #seance in the sidebar: remembered, and the caret goes to the
	//    input — at the end of a draft when switching back to one.
	await page.click(item("#seance"));
	await page.waitFor(`${ACTIVE} === "#seance"`, {label: "switched to #seance"});
	await page.sleep(200);
	page.check("remembers #seance", (await stored())?.target === "#seance");
	page.check("input focused after switching", (await page.evaluate(FOCUSED)) === "input");

	await page.fill("#input", "draft text");
	await page.click(item(OTHER));
	await page.waitFor(`${ACTIVE} === "${OTHER}"`, {label: `switched to ${OTHER}`});
	await page.click(item("#seance"));
	await page.waitFor(`${ACTIVE} === "#seance"`, {label: "back on #seance"});
	await page.sleep(200);
	page.check(
		"caret at the end of the restored draft",
		(await page.evaluate(
			`(() => { const el = document.getElementById("input"); return !!el && document.activeElement === el && el.value === "draft text" && el.selectionStart === el.value.length; })()`
		)) === true
	);
	await page.screenshot("2-seance-open");

	// 3. Reload without connect parameters: the saved network autoconnects and
	//    the view is on #seance as soon as the network is announced — before
	//    the JOIN — and still there once the join burst is done.
	await page.goto(BASE, {waitForSelector: "#chat-container"});
	page.check("restored to #seance before the join", (await page.evaluate(ACTIVE)) === "#seance");
	await page.waitFor(joined("#seance"), {timeout: 20000, label: "rejoined #seance"});
	await page.waitFor(joined(OTHER), {timeout: 20000, label: `rejoined ${OTHER}`});
	await page.sleep(300);
	page.check(
		"still on #seance after the join burst",
		(await page.evaluate(ACTIVE)) === "#seance"
	);
	page.check("memory unchanged by the restore", (await stored())?.target === "#seance");
	page.check("input focused after the restore", (await page.evaluate(FOCUSED)) === "input");
	await page.screenshot("3-restored");

	// 4. A private conversation is remembered and, not being a placeholder,
	//    reopened once registered: the page waits in the lobby, then lands.
	await page.fill("#input", `/query ${BUDDY}`);
	await page.click("#submit");
	await page.waitFor(`${ACTIVE} === "${BUDDY}"`, {label: "query opened"});
	await page.sleep(200);
	page.check("remembers the query", (await stored())?.target === BUDDY);

	await page.goto(BASE, {waitForSelector: "#chat-container"});
	const whileWaiting = await page.evaluate(ACTIVE);
	await page.waitFor(`${ACTIVE} === "${BUDDY}"`, {timeout: 20000, label: "query restored"});
	page.check(
		"waited in the lobby, not on a channel",
		whileWaiting === BUDDY || (whileWaiting !== "#seance" && whileWaiting !== OTHER)
	);
	page.check("lobby did not overwrite the memory", (await stored())?.target === BUDDY);
	await page.waitFor(joined("#seance"), {timeout: 20000, label: "rejoined #seance again"});
	await page.sleep(300);
	page.check("still on the query after the join burst", (await page.evaluate(ACTIVE)) === BUDDY);
	await page.screenshot("4-query-restored");

	page.check("no console errors", page.consoleErrors.length === 0);
}
