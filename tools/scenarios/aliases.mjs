// Command aliases, end to end in a real browser
// (docs/resources/aliases.md, client/components/Settings/Aliases.vue,
// client/js/helpers/aliases.ts).
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/aliases.mjs
//
// The claims under test are what `pnpm test` cannot see: the Aliases tab
// renders and edits, a row persists to localStorage as soon as it is valid,
// an invalid row shows its error and is *not* saved, the "Try it" box
// previews the expansion, and a typed `/alias` in a real channel goes out
// expanded (nested alias included, `$chan`/`$1` filled in) while `//` still
// escapes to literal text.

const RUN = Date.now().toString(36);
const NICK = `al${RUN}`;
const CHANNEL = "#seance";
const BASE = process.env.SEANCE_HTTP ?? "http://localhost:8000/";

export const url = `${BASE}?host=127.0.0.1&port=8067&tls=false&nick=${NICK}&join=%23seance`;

const PAGE = ".settings-aliases";
const ADD = `${PAGE} .alias-actions .btn`;
const STATUS = `${PAGE} .alias-status`;
const TRY = `${PAGE} .alias-try`;

/** The name/body inputs of row `n` (0-based; .alias-head is nth-child(1)). */
const row = (n) => `${PAGE} .alias-table > div:nth-child(${n + 2})`;

const STORED = `JSON.parse(localStorage.getItem("thelounge.aliases") ?? "null")`;

/** Text of every message row of this run's channel view. */
const MESSAGES = `Array.from(document.querySelectorAll("#chat .msg[data-type='message'], #chat .msg[data-type='action']"))
	.map((el) => ({type: el.dataset.type, text: el.querySelector(".content")?.textContent.trim() ?? ""}))`;

export default async function run(page) {
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="${CHANNEL}"]')`, {
		timeout: 30000,
		label: `${CHANNEL} in the sidebar`,
	});

	// --- The settings tab ---------------------------------------------------
	await page.click("#footer button.settings");
	await page.waitFor(`!!document.querySelector(".settings-menu .aliases")`, {
		label: "the Aliases tab in the settings menu",
	});
	await page.click(".settings-menu .aliases");
	await page.waitFor(`!!document.querySelector(${JSON.stringify(PAGE)})`, {
		label: "the aliases page",
	});
	await page.check(
		"starts empty",
		(await page.evaluate(`document.querySelector("${PAGE} .alias-empty")?.textContent`)) != null
	);
	await page.screenshot("1-empty");

	// A first alias: valid as soon as name and body are both there.
	await page.click(ADD);
	await page.fill(`${row(0)} .alias-name`, "wave");
	await page.fill(`${row(0)} .alias-body`, "/me waves at $1 in $chan");
	await page.waitFor(`(${STORED})?.length === 1`, {label: "the alias saved to localStorage"});
	const one = await page.evaluate(STORED);
	await page.check(
		"the valid row persists at once",
		one?.[0]?.name === "wave" && one?.[0]?.body === "/me waves at $1 in $chan"
	);
	await page.check(
		"the status says 1 alias saved",
		String(await page.evaluate(`document.querySelector("${STATUS}")?.textContent`)).includes(
			"1 alias saved"
		)
	);

	// The preview expands against the live rows.
	await page.fill(TRY, "/wave bob");
	await page.waitFor(`!!document.querySelector("${PAGE} .alias-preview-line")`, {
		label: "a preview line",
	});
	const previewed = await page.evaluate(
		`document.querySelector("${PAGE} .alias-preview-line")?.textContent`
	);
	await page.check(
		`the Try box previews the expansion (${JSON.stringify(previewed)})`,
		previewed === "/me waves at bob in #channel"
	);
	await page.screenshot("2-one-alias");

	// A duplicate name is an error, stays on screen, and is not saved.
	await page.click(ADD);
	await page.fill(`${row(1)} .alias-name`, "Wave");
	await page.fill(`${row(1)} .alias-body`, "/echo nope");
	await page.waitFor(`!!document.querySelector("${PAGE} .alias-error")`, {
		label: "the duplicate-name error",
	});
	await page.check(
		"a duplicate row is not persisted",
		((await page.evaluate(STORED)) ?? []).length === 1
	);
	await page.check(
		"the status warns about rows with errors",
		String(await page.evaluate(`document.querySelector("${STATUS}")?.textContent`)).includes(
			"errors"
		)
	);
	await page.screenshot("3-duplicate-error");
	await page.click(`${row(1)} .alias-remove`);
	await page.waitFor(`!document.querySelector("${PAGE} .alias-error")`, {
		label: "the error gone after remove",
	});

	// A second, nested alias: /greet uses /wave and $chan.
	await page.click(ADD);
	await page.fill(`${row(1)} .alias-name`, "greet");
	await page.fill(`${row(1)} .alias-body`, "/wave $1\nwelcome to $chan, $1!");
	await page.waitFor(`(${STORED})?.length === 2`, {label: "both aliases saved"});

	// --- In a real channel ----------------------------------------------------
	// Settings is a modal over the whole app: leave through Done before
	// reaching for the sidebar.
	await page.click(".settings-modal-done");
	await page.waitFor(`!document.querySelector(".settings-modal")`, {label: "settings closed"});
	await page.click(`.channel-list-item[data-name="${CHANNEL}"]`);
	await page.waitFor(`!!document.querySelector("#input")`, {label: "the input box"});
	await page.sleep(1500); // let the join burst and catch-up settle

	await page.fill("#input", `/greet bob-${RUN}`);
	await page.evaluate(`document.querySelector("#form").requestSubmit()`);
	await page.waitFor(
		`(${MESSAGES}).some((m) => m.text.includes("welcome to ${CHANNEL}, bob-${RUN}!"))`,
		{timeout: 10000, label: "the expanded text line echoed back"}
	);
	// Both on the wire (the alias owns the outgoing line) and in the DOM
	// (the echo renders as an action). A raw "\x01ACTION" — or U+FFFD — in
	// the DOM here means the dev ircd predates nefarious2 aef2f29 (C0
	// control characters rewritten to U+FFFD in WS text mode): rebuild the
	// image, the client is not at fault.
	const sentAction = page.wsFrames.some(
		(f) =>
			f.dir === "out" &&
			String(f.payloadData ?? "").includes(
				`PRIVMSG ${CHANNEL} :\x01ACTION waves at bob-${RUN} in ${CHANNEL}\x01`
			)
	);
	await page.check("the nested /wave went out as a /me with $1 and $chan filled in", sentAction);
	const messages = await page.evaluate(MESSAGES);
	const action = messages.find((m) => m.text.includes(`waves at bob-${RUN} in ${CHANNEL}`));
	await page.check("the echoed /me renders as an action", action?.type === "action");

	// `//` still escapes: the line goes out literal, one leading slash kept.
	await page.fill("#input", `//wave literal ${RUN}`);
	await page.evaluate(`document.querySelector("#form").requestSubmit()`);
	await page.waitFor(
		`(${MESSAGES}).some((m) => m.type === "message" && m.text === "/wave literal ${RUN}")`,
		{timeout: 10000, label: "the //-escaped literal line"}
	);
	await page.screenshot("4-expanded-in-channel", {selector: "#chat"});

	await page.check("no console errors", page.consoleErrors.length === 0);
}
