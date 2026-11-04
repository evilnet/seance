// ArrowUp/ArrowDown edit-stepping in ChatInput.
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/edit-arrow-step.mjs
//
// The claims under test: ArrowUp in an empty input edits your newest own
// message, with the caret at the end of its text (as the toolbar's Edit
// puts it); further ArrowUps step the edit to OLDER own messages (the old
// code swapped input-history text into the box while the edit stayed armed
// on the newest message, so submitting replaced the wrong line); ArrowDown
// steps back and, past the newest, leaves edit mode; a modified edit is
// never stepped away from; Escape dismisses the edit and hands ArrowUp to
// input history until the user types again.

// #seance keeps scrollback, so own messages from previous runs sit above
// this run's three: stepping past this run's oldest legitimately walks
// into them, which is why nothing here probes "the oldest own message
// ever". An accepted edit takes the original's place (the original is
// redacted and hidden behind it), so step 3 asserts position as well as
// identity: the edited row stays between its neighbours and keeps the
// original's timestamp.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // dev ircd's self-signed cert

const RUN = Date.now().toString(36);

export const url =
	"http://localhost:8000/?host=localhost&port=8443&tls=true&nick=editstep&join=%23seance";

const text = (word) => `editstep ${RUN} ${word}`;

// Mousetrap reads `which`/`keyCode`, which the KeyboardEvent constructor
// refuses to set, so define getters. (browser-drive has no CDP key API;
// Mousetrap does not check isTrusted.)
const press = (key, code) => `(() => {
	const el = document.querySelector("#input");
	const ev = new KeyboardEvent("keydown", {key: ${JSON.stringify(
		key
	)}, bubbles: true, cancelable: true});
	Object.defineProperty(ev, "which", {get: () => ${code}});
	Object.defineProperty(ev, "keyCode", {get: () => ${code}});
	el.dispatchEvent(ev);
	return el.value;
})()`;

const INPUT = `document.querySelector("#input").value`;
const CARET_AT_END = `(() => {
	const el = document.querySelector("#input");
	return el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
})()`;
const COMPOSE = `document.querySelector(".compose-bar .compose-bar-preview")?.textContent.trim() ?? null`;
const ROWS = `Array.from(document.querySelectorAll("#chat .msg[data-type='message'] .content"))
	.map((el) => el.textContent.trim())
	.filter((t) => t.includes("${RUN}"))`;
// [time, text] of this run's rows, in list order.
const TIMED_ROWS = `Array.from(document.querySelectorAll("#chat .msg[data-type='message']"))
	.map((el) => [el.querySelector(".time").textContent.trim(), el.querySelector(".content").textContent.trim()])
	.filter(([, t]) => t.includes("${RUN}"))`;

export default async function run(page) {
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="#seance"]')`, {
		timeout: 30000,
		label: "#seance in the sidebar",
	});
	await page.click(`.channel-list-item[data-name="#seance"]`);
	await page.waitFor(`document.querySelector("#input")`, {label: "the input box"});
	await page.sleep(2500); // join burst + catch-up

	for (const word of ["one", "two", "three"]) {
		await page.fill("#input", text(word));
		await page.evaluate(`document.querySelector("#form").requestSubmit()`);
		await page.sleep(150);
	}

	await page.waitFor(`!document.querySelector("#chat .msg.pending")`, {label: "the echoes"});
	await page.sleep(300);
	const timesBefore = await page.evaluate(TIMED_ROWS);

	// 1. ArrowUp steps the edit target: newest, then older — never history.
	let v = await page.evaluate(press("ArrowUp", 38));
	await page.check(`first ArrowUp edits the newest own message (${v})`, v === text("three"));
	await page.check("…with the caret at the end of the text", await page.evaluate(CARET_AT_END));
	let preview = await page.evaluate(COMPOSE);
	await page.check("the compose bar says which message", preview === text("three"));

	v = await page.evaluate(press("ArrowUp", 38));
	await page.check(`second ArrowUp steps to the previous message (${v})`, v === text("two"));
	await page.check("…the caret at its end too", await page.evaluate(CARET_AT_END));
	preview = await page.evaluate(COMPOSE);
	await page.check("…and the compose bar follows", preview === text("two"));

	v = await page.evaluate(press("ArrowUp", 38));
	await page.check(`third ArrowUp reaches the oldest (${v})`, v === text("one"));
	await page.screenshot("1-editing-oldest");

	// 2. ArrowDown steps back; past the newest it leaves edit mode.
	v = await page.evaluate(press("ArrowDown", 40));
	await page.check(`ArrowDown steps forward (${v})`, v === text("two"));
	await page.evaluate(press("ArrowDown", 40));
	v = await page.evaluate(press("ArrowDown", 40));
	await page.check("ArrowDown past the newest empties the input", v === "");
	const bar = await page.evaluate(`!!document.querySelector(".compose-bar")`);
	await page.check("…and closes the compose bar", !bar);

	// 3. The reported bug, end to end: ArrowUp twice, edit, Enter must
	//    replace the SECOND-newest message — and only it.
	await page.evaluate(press("ArrowUp", 38));
	await page.evaluate(press("ArrowUp", 38));
	await page.fill("#input", `${text("two")} (fixed)`);
	await page.evaluate(`document.querySelector("#form").requestSubmit()`);
	await page.waitFor(`(${ROWS}).some((t) => t.includes("(fixed)"))`, {label: "the edit echo"});
	await page.sleep(300);
	const rows = await page.evaluate(ROWS);
	await page.check(
		`the second-newest message was replaced, the others kept (${JSON.stringify(rows)})`,
		rows.filter((t) => t.includes(`${text("two")} (fixed)`)).length === 1 &&
			!rows.includes(text("two")) &&
			rows.includes(text("one")) &&
			rows.includes(text("three"))
	);
	// (the edited row's text ends in the "(edited)" marker)
	const fixedAt = rows.findIndex((t) => t.startsWith(`${text("two")} (fixed)`));
	await page.check(
		"the edit stays in its place, between its neighbours",
		rows.indexOf(text("one")) < fixedAt && fixedAt < rows.indexOf(text("three"))
	);
	await page.waitFor(`!document.querySelector("#chat .msg.pending")`, {
		label: "the edit settled",
	});
	const timed = await page.evaluate(TIMED_ROWS);
	const before = timesBefore.find(([, t]) => t === text("two"));
	const after = timed.find(([, t]) => t.startsWith(`${text("two")} (fixed)`));
	await page.check(
		`the edit keeps the original's timestamp (${before?.[0]} → ${after?.[0]})`,
		Boolean(before && after) && before[0] === after[0]
	);
	const edited = await page.evaluate(
		`Array.from(document.querySelectorAll("#chat .msg[data-type='message']"))
			.find((el) => el.querySelector(".content").textContent.includes("${RUN} two (fixed)"))
			?.querySelector(".msg-edited")?.getAttribute("title") ?? null`
	);
	await page.check(`…and says when it was edited (${edited})`, /^Edited \d/.test(edited ?? ""));
	const barAfterEdit = await page.evaluate(`!!document.querySelector(".compose-bar")`);
	await page.check("the edit closed the compose bar", !barAfterEdit);
	await page.screenshot("2-after-edit");

	// 4. A modified edit is never stepped away from.
	await page.evaluate(press("ArrowUp", 38));
	await page.fill("#input", `poking at it ${RUN}`);
	v = await page.evaluate(press("ArrowUp", 38));
	await page.check("ArrowUp on a modified edit keeps the text", v === `poking at it ${RUN}`);
	const stillBar = await page.evaluate(`!!document.querySelector(".compose-bar")`);
	await page.check("…and stays in edit mode", stillBar);

	// 5. Escape dismisses the edit; ArrowUp then browses input history.
	await page.evaluate(press("Escape", 27));
	v = await page.evaluate(INPUT);
	await page.check("Escape empties the input", v === "");
	v = await page.evaluate(press("ArrowUp", 38));
	await page.check(
		`ArrowUp after Escape recalls input history, not an edit (${v})`,
		v === `${text("two")} (fixed)`
	);
	const barAfterEsc = await page.evaluate(`!!document.querySelector(".compose-bar")`);
	await page.check("…with no compose bar", !barAfterEsc);
	await page.screenshot("3-history-after-escape");

	// 6. The toolbar's Edit button: the text in the box, the caret after it.
	await page.evaluate(press("Escape", 27));
	const ownRow = `Array.from(document.querySelectorAll("#chat .msg.self[data-type='message']"))
		.filter((el) => el.textContent.includes("${RUN} three")).pop()`;
	await page.evaluate(`(${ownRow}).setAttribute("data-edit-probe", "1")`);
	await page.hover(`.msg[data-edit-probe="1"]`);
	await page.click(`.msg[data-edit-probe="1"] .msg-action-edit`);
	await page.sleep(200);
	v = await page.evaluate(INPUT);
	await page.check(`the toolbar's Edit fills the input (${v})`, v === text("three"));
	await page.check("…with the caret at the end", await page.evaluate(CARET_AT_END));
	await page.screenshot("4-toolbar-edit");

	// 7. An action (/me) is editable too, and stays an action: the box
	//    holds "/me …", and the replacement row is an action.
	await page.evaluate(press("Escape", 27));
	await page.fill("#input", `/me ${text("waves")}`);
	await page.evaluate(`document.querySelector("#form").requestSubmit()`);
	await page.waitFor(`!document.querySelector("#chat .msg.pending")`, {
		label: "the action's echo",
	});
	await page.sleep(300);
	v = await page.evaluate(press("ArrowUp", 38));
	await page.check(`ArrowUp edits the action as /me … (${v})`, v === `/me ${text("waves")}`);
	await page.check("…the caret at the end", await page.evaluate(CARET_AT_END));
	await page.fill("#input", `/me ${text("waves")} (fixed)`);
	await page.evaluate(`document.querySelector("#form").requestSubmit()`);
	await page.waitFor(
		`Array.from(document.querySelectorAll("#chat .msg[data-type='action']")).some((el) => el.textContent.includes("${RUN} waves (fixed)"))`,
		{label: "the edited action"}
	);
	await page.waitFor(`!document.querySelector("#chat .msg.pending")`, {
		label: "the edit settled",
	});
	const actions =
		await page.evaluate(`Array.from(document.querySelectorAll("#chat .msg[data-type='action'] .content"))
		.map((el) => el.textContent.trim()).filter((t) => t.includes("${RUN}"))`);
	await page.check(
		`the action was replaced by the edited action (${JSON.stringify(actions)})`,
		actions.length === 1 &&
			actions[0].includes("waves (fixed)") &&
			actions[0].includes("(edited)")
	);
	await page.screenshot("5-edited-action");

	await page.check("no console errors", page.consoleErrors.length === 0);
}
