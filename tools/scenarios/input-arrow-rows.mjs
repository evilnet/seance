// ArrowUp/ArrowDown in the composer decide by the rows the textarea shows.
//
//   corepack yarn build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/input-arrow-rows.mjs
//
// The claims under test: in a long line that wraps, ArrowUp moves the caret
// up a row until it is on the top row, and only then recalls history (the
// old code counted "\n" and recalled from anywhere in a wrapped line); a
// line broken with a newline still moves the caret first; a recalled entry
// or a stepped edit puts the caret at its start after ArrowUp and at its end
// after ArrowDown, so holding either key keeps stepping through long
// entries instead of climbing their rows; the caret in a middle row moves
// rather than steps, in history and in an edit alike.
//
// The keys are real (CDP Input.dispatchKeyEvent), so where the handler
// lets a press through, the browser moves the caret. A channel of its own
// per run, so the edit stepping meets only this run's messages.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // dev ircd's self-signed cert

const RUN = Date.now().toString(36);
const CHANNEL = `#arrows-${RUN}`;

export const url = `http://localhost:8000/?host=localhost&port=8443&tls=true&nick=arrows&join=${encodeURIComponent(
	CHANNEL
)}`;

const SHORT = `arrows ${RUN} short`;
const LONG = `arrows ${RUN} long ${"lorem ipsum dolor sit amet ".repeat(12).trim()}`;
const NEWEST = `arrows ${RUN} newest`;
const DRAFT = `draft ${RUN} ${"consectetur adipiscing elit sed do ".repeat(9).trim()}`;
const TWO_LINES = "first line\nsecond line";

const KEY_CODES = {ArrowUp: 38, ArrowDown: 40, Escape: 27};

const STATE = `(() => {
	const el = document.querySelector("#input");
	const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
	return {
		value: el.value,
		caret: el.selectionStart,
		rows: Math.round(el.scrollHeight / lineHeight),
		scrollTop: el.scrollTop,
		editing: document.querySelector(".compose-bar .compose-bar-preview")?.textContent.trim() ?? null,
	};
})()`;

const caretAt = (position) =>
	`(() => { const el = document.querySelector("#input"); el.focus(); el.setSelectionRange(${position}, ${position}); })()`;

export default async function run(page) {
	const press = async (key) => {
		const code = KEY_CODES[key];

		for (const type of ["rawKeyDown", "keyUp"]) {
			await page.send("Input.dispatchKeyEvent", {
				type,
				key,
				code: key,
				windowsVirtualKeyCode: code,
				nativeVirtualKeyCode: code,
			});
		}

		await page.sleep(60);
		return page.evaluate(STATE);
	};

	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="${CHANNEL}"]')`, {
		timeout: 30000,
		label: `${CHANNEL} in the sidebar`,
	});
	await page.click(`.channel-list-item[data-name="${CHANNEL}"]`);
	await page.waitFor(`document.querySelector("#input")`, {label: "the input box"});
	await page.sleep(1500);

	for (const text of [SHORT, LONG, NEWEST]) {
		await page.fill("#input", text);
		await page.evaluate(`document.querySelector("#form").requestSubmit()`);
		await page.sleep(150);
	}

	await page.waitFor(`!document.querySelector("#chat .msg.pending")`, {label: "the echoes"});
	await page.sleep(300);

	// 1. A wrapped draft: ArrowUp climbs its rows, then recalls history.
	await page.click("#input");
	await page.fill("#input", DRAFT);
	await page.evaluate(caretAt(DRAFT.length));
	let s = await page.evaluate(STATE);
	const draftRows = s.rows;
	await page.check(`the draft wraps to several rows (${draftRows})`, draftRows >= 3);

	s = await press("ArrowUp");
	await page.check(
		`ArrowUp on the bottom row of a wrapped draft moves the caret (${s.caret})`,
		s.value === DRAFT && s.caret < DRAFT.length
	);
	await page.screenshot("1-wrapped-draft-caret-up");

	let presses = 1;

	while (s.value === DRAFT && presses < 12) {
		s = await press("ArrowUp");
		presses++;
	}

	await page.check(
		`history is recalled from the top row only (${presses} presses for ${draftRows} rows)`,
		presses === draftRows && s.value === NEWEST
	);
	await page.check(`…with the caret at its start (${s.caret})`, s.caret === 0);

	// 2. Holding ArrowUp walks through a long entry without stopping in it.
	s = await press("ArrowUp");
	await page.check(
		`ArrowUp recalls the long entry (${s.rows} rows)`,
		s.value === LONG && s.rows >= 3
	);
	await page.check(
		`…caret at its start, scrolled to its top (${s.caret}, ${s.scrollTop})`,
		s.caret === 0 && s.scrollTop === 0
	);
	await page.screenshot("2-recalled-long-entry");
	s = await press("ArrowUp");
	await page.check("the next ArrowUp steps past it at once", s.value === SHORT);

	// 3. ArrowDown comes back with the caret at the end, and past the newest
	//    restores the draft.
	s = await press("ArrowDown");
	await page.check(
		`ArrowDown recalls the long entry, caret at its end (${s.caret})`,
		s.value === LONG && s.caret === LONG.length
	);

	// 4. In a middle row of a recalled entry the arrows move the caret.
	await page.evaluate(caretAt(Math.floor(LONG.length / 2)));
	s = await press("ArrowUp");
	await page.check(
		`ArrowUp in a middle row moves the caret (${s.caret})`,
		s.value === LONG && s.caret < Math.floor(LONG.length / 2)
	);
	await page.evaluate(caretAt(Math.floor(LONG.length / 2)));
	s = await press("ArrowDown");
	await page.check(
		`ArrowDown in a middle row moves the caret (${s.caret})`,
		s.value === LONG && s.caret > Math.floor(LONG.length / 2)
	);

	await page.evaluate(caretAt(LONG.length));
	s = await press("ArrowDown");
	await page.check("ArrowDown on the bottom row steps forward", s.value === NEWEST);
	s = await press("ArrowDown");
	await page.check(
		`ArrowDown past the newest restores the draft, caret at its end (${s.caret})`,
		s.value === DRAFT && s.caret === DRAFT.length
	);

	// 5. Lines broken with a newline still move the caret first.
	await page.fill("#input", TWO_LINES);
	await page.evaluate(caretAt(TWO_LINES.length));
	s = await press("ArrowUp");
	await page.check(
		`ArrowUp on the second line moves to the first (${s.caret})`,
		s.value === TWO_LINES && s.caret <= TWO_LINES.indexOf("\n")
	);
	s = await press("ArrowUp");
	await page.check("…and from the first line recalls history", s.value === NEWEST);

	// 6. Edit stepping from an empty input follows the same rows.
	await page.fill("#input", "");
	s = await press("ArrowUp");
	await page.check(
		`ArrowUp in an empty input edits the newest own message (${s.editing})`,
		s.value === NEWEST && s.editing === NEWEST && s.caret === 0
	);
	s = await press("ArrowUp");
	await page.check(
		`ArrowUp steps the edit to the long message, caret at its start (${s.caret})`,
		s.value === LONG && s.editing?.startsWith(`arrows ${RUN} long`) && s.caret === 0
	);
	s = await press("ArrowUp");
	await page.check("the next ArrowUp steps past it at once", s.value === SHORT);
	s = await press("ArrowDown");
	await page.check(
		`ArrowDown steps back to it, caret at its end (${s.caret})`,
		s.value === LONG && s.caret === LONG.length
	);
	await page.screenshot("3-editing-long-message");

	await page.evaluate(caretAt(Math.floor(LONG.length / 2)));
	s = await press("ArrowUp");
	await page.check(
		`in a middle row of the edit ArrowUp moves the caret (${s.caret})`,
		s.value === LONG && s.editing?.startsWith(`arrows ${RUN} long`)
	);

	await page.evaluate(caretAt(LONG.length));
	s = await press("ArrowDown");
	await page.check("ArrowDown on the bottom row steps the edit forward", s.value === NEWEST);
	s = await press("ArrowDown");
	await page.check(
		"ArrowDown past the newest leaves the edit",
		s.value === "" && s.editing === null
	);

	await page.check("no console errors", page.consoleErrors.length === 0);
}
