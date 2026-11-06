// The composer's emoji picker: typing `:` and two letters of a name opens
// the message toolbar's picker over the composer, its search seeded with
// what was typed, and the emoji picked replaces the `:name` in the draft
// (ChatInput.vue, helpers/emojiTrigger.ts, ReactionPicker.vue `insert`).
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/composer-emoji.mjs
//   node tools/browser-drive.mjs tools/scenarios/composer-emoji.mjs --mobile --width=390 --height=844
//
// What it checks, with real key events: `:tad` opens the picker with 🎉
// first and the composer keeps the keyboard; typing on follows into the
// search; ArrowDown moves the picker's highlight, not the input history;
// Enter (a tap, on a phone) puts the emoji where `:tad` was, caret after it,
// and sends nothing; Escape closes the picker, leaves the text and the focus,
// and the same `:name` typed on does not reopen it; `:wq then` typed key by
// key stays text; Backspace narrows the search and past two letters closes
// it; back (a CloseWatcher's close) and the Close button close it, the
// draft kept; Tab takes the highlighted emoji; `:tada:` becomes 🎉 on its
// closing colon and an unknown `:name:` stays text; Shift+Enter breaks the
// line and closes the picker; a paste ending in `:tad` opens nothing; no "React with …"
// row, and Enter with nothing matching sends the message as typed; a time
// (10:30) never opens it. `SEANCE_PORT` serves the app from another port.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const PORT = process.env.SEANCE_PORT ?? "8000";
const NICK = `emo${Date.now().toString(36).slice(-5)}`;

export const url = `http://localhost:${PORT}/?host=localhost&port=8443&tls=true&nick=${NICK}&join=%23seance`;

const INPUT = `document.querySelector("#input")`;
const PICKER = `document.querySelector(".reaction-picker")`;
const SEARCH = `document.querySelector(".reaction-picker-input")`;

/** Type at the caret, as a keyboard does (input events, one per call). */
const type = (page, text) => page.send("Input.insertText", {text});

const enterIn = (selector) => `(() => {
	const el = document.querySelector(${JSON.stringify(selector)});
	el.dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", bubbles: true, cancelable: true}));
})()`;

const key = async (page, name, code, extra = {}) => {
	await page.send("Input.dispatchKeyEvent", {
		type: "rawKeyDown",
		key: name,
		code: name,
		windowsVirtualKeyCode: code,
		...extra,
	});

	if (name === "Enter") {
		await page.send("Input.dispatchKeyEvent", {type: "char", key: "Enter", text: "\r"});
	}

	await page.send("Input.dispatchKeyEvent", {
		type: "keyUp",
		key: name,
		code: name,
		windowsVirtualKeyCode: code,
	});
	await page.sleep(200);
};

export default async function run(page) {
	const mobile = page.flags.has("--mobile");
	const value = () => page.evaluate(`${INPUT}.value`);
	const open = () => page.evaluate(`!!${PICKER}`);

	await page.grantPermissions(["clipboardReadWrite", "clipboardSanitizedWrite"]);
	// Every CloseWatcher the page makes, so the back gesture can be played:
	// requestClose() is what Android's back does to the newest one.
	await page.addInitScript(`(() => {
		const Real = window.CloseWatcher;
		if (!Real) return;
		window.__watchers = [];
		window.CloseWatcher = class extends Real {
			constructor(...args) { super(...args); window.__watchers.push(this); }
		};
	})()`);
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="#seance"]')`, {
		timeout: 30000,
		label: "#seance in the sidebar",
	});
	await page.evaluate(
		`document.querySelector('.channel-list-item[data-name="#seance"]').click()`
	);
	await page.waitFor(`${INPUT}`, {label: "the composer"});
	await page.sleep(1000);
	await page.evaluate(`${INPUT}.focus()`);

	// A time never opens it.
	await type(page, "at 10:30 ");
	await page.sleep(200);
	await page.check("a time does not open the picker", !(await open()));

	// 1. `:tad` opens it, search seeded, 🎉 first, the keyboard stays here.
	for (const ch of "party :tad") {
		await type(page, ch);
	}

	await page.waitFor(`${PICKER} && ${PICKER}.querySelector(".reaction-picker-option")`, {
		label: "the picker with results",
	});
	const search = await page.evaluate(`${SEARCH}.value`);
	await page.check(`the search holds what was typed (${search})`, search === "tad");
	const first = await page.evaluate(
		`${PICKER}.querySelector(".reaction-picker-option").textContent.trim()`
	);
	await page.check(`🎉 comes first (${first})`, first === "🎉");
	await page.check(
		"the composer keeps the keyboard",
		await page.evaluate(`document.activeElement === ${INPUT}`)
	);
	await page.sleep(400); // past the picker's pop-in
	await page.screenshot("1-picker-open");

	await type(page, "a");
	await page.sleep(200);
	const followed = await page.evaluate(`${SEARCH}.value`);
	await page.check(`typing on follows into the search (${followed})`, followed === "tada");

	if (mobile) {
		await page.click(".reaction-picker .reaction-picker-option");
	} else {
		await key(page, "Enter", 13);
	}

	await page.sleep(300);
	let text = await value();
	await page.check(
		`🎉 took the place of the :name (${JSON.stringify(text)})`,
		text === "at 10:30 party 🎉"
	);
	await page.check("the picker closed", !(await open()));
	const caret = await page.evaluate(
		`[document.activeElement === ${INPUT}, ${INPUT}.selectionStart, ${INPUT}.value.length]`
	);
	await page.check(
		`the caret is back after the emoji (${JSON.stringify(caret)})`,
		caret[0] && caret[1] === caret[2]
	);

	// 2. ArrowDown is the picker's; Escape leaves the text and the focus,
	//    and the same token stays closed.
	for (const ch of " :smi") {
		await type(page, ch);
	}

	await page.waitFor(`!!${PICKER}`, {label: "the picker for :smi"});
	await page.sleep(300);

	if (!mobile) {
		const before = await page.evaluate(
			`${PICKER}.querySelector(".reaction-picker-option.active")?.dataset.index`
		);
		await key(page, "ArrowDown", 40);
		const after = await page.evaluate(
			`${PICKER}.querySelector(".reaction-picker-option.active")?.dataset.index`
		);
		await page.check(
			`ArrowDown moves the picker's highlight (${before} → ${after})`,
			before !== after
		);
		await page.check("…and leaves the draft alone", (await value()).endsWith(" :smi"));
	}

	await key(page, "Escape", 27);
	await page.check("Escape closes the picker", !(await open()));
	text = await value();
	await page.check(`…leaves the text as typed (${JSON.stringify(text)})`, text.endsWith(" :smi"));
	await page.check(
		"…and the composer keeps the focus",
		await page.evaluate(`document.activeElement === ${INPUT}`)
	);
	await type(page, "l");
	await page.sleep(300);
	await page.check("typing on in that :name does not open it again", !(await open()));

	// 3. `:wq then`, key by key: nothing is lost to the picker.
	for (const ch of " :wq then") {
		await type(page, ch);
	}

	await page.sleep(200);
	text = await value();
	await page.check(`":wq then" stays text (${JSON.stringify(text)})`, text.endsWith(" :wq then"));
	await page.check("…and the picker closed at the space", !(await open()));

	// 4. A paste ending in `:tad` opens nothing.
	await page.evaluate(`navigator.clipboard.writeText(" pasted :tad")`);
	await page.send("Input.dispatchKeyEvent", {
		type: "rawKeyDown",
		modifiers: 2,
		key: "v",
		code: "KeyV",
		windowsVirtualKeyCode: 86,
		commands: ["paste"],
	});
	await page.send("Input.dispatchKeyEvent", {
		type: "keyUp",
		modifiers: 2,
		key: "v",
		code: "KeyV",
		windowsVirtualKeyCode: 86,
	});
	await page.sleep(300);
	text = await value();
	await page.check(`the paste landed (${JSON.stringify(text)})`, text.endsWith(" pasted :tad"));
	await page.check("…and opened no picker", !(await open()));

	// 5. Backspace narrows the search, and past two letters closes it;
	//    typing the name again opens it again.
	for (const ch of " :smil") {
		await type(page, ch);
	}

	await page.waitFor(`!!${PICKER}`, {label: "the picker for :smil"});
	await key(page, "Backspace", 8);
	const narrowed = await page.evaluate(`${SEARCH}.value`);
	await page.check(`Backspace narrows the search (${narrowed})`, narrowed === "smi");
	await key(page, "Backspace", 8);
	await key(page, "Backspace", 8);
	await page.check("…and closes the picker at one letter", !(await open()));
	await type(page, "m");
	await page.waitFor(`!!${PICKER}`, {label: "the picker again for :sm"});
	await page.check(
		"typing the name again opens it again",
		(await page.evaluate(`${SEARCH}.value`)) === "sm"
	);

	// 6. Back (a CloseWatcher's close, as Android's back gesture does it)
	//    closes it and keeps the draft.
	text = await value();
	const watched = await page.evaluate(`!!window.__watchers?.length`);

	if (watched) {
		await page.evaluate(`window.__watchers.at(-1).requestClose()`);
		await page.sleep(300);
		await page.check("back closes the picker", !(await open()));
		await page.check("…and keeps the draft", (await value()) === text);
	} else {
		await page.check("this Chromium has CloseWatcher", false);
	}

	// 7. The Close button, on a phone and in the composer's picker alike.
	await key(page, "Backspace", 8);
	await type(page, "m");
	await page.waitFor(`!!${PICKER}`, {label: "the picker for the Close button"});
	await page.click(".reaction-picker .reaction-picker-close");
	await page.sleep(300);
	await page.check("Close closes the picker", !(await open()));
	await page.check("…and keeps the draft", (await value()) === text);

	// 8. Tab takes the highlighted emoji, as the old completion did.
	await page.evaluate(
		`${INPUT}.focus(); ${INPUT}.setSelectionRange(${INPUT}.value.length, ${INPUT}.value.length)`
	);
	for (const ch of " :tad") {
		await type(page, ch);
	}

	await page.waitFor(`${PICKER} && ${PICKER}.querySelector(".reaction-picker-option")`, {
		label: "the picker for Tab",
	});
	await key(page, "Tab", 9);
	text = await value();
	await page.check(
		`Tab inserts the highlighted emoji (${JSON.stringify(text)})`,
		text.endsWith(" 🎉")
	);
	await page.check("…and closes the picker", !(await open()));

	// 9. A closing colon on a shortcode is the emoji at once.
	for (const ch of " :tada:") {
		await type(page, ch);
	}

	await page.sleep(200);
	text = await value();
	await page.check(
		`":tada:" becomes 🎉 on its closing colon (${JSON.stringify(text)})`,
		text.endsWith(" 🎉 🎉")
	);
	await page.check("…with no picker left open", !(await open()));
	for (const ch of " :notashortcode:") {
		await type(page, ch);
	}

	await page.sleep(200);
	await page.check(
		"an unknown :name: stays text",
		(await value()).endsWith(" :notashortcode:") && !(await open())
	);

	// 10. Shift+Enter is the composer's line break, not a pick.
	for (const ch of " :tad") {
		await type(page, ch);
	}

	await page.waitFor(`!!${PICKER}`, {label: "the picker for Shift+Enter"});
	await page.send("Input.dispatchKeyEvent", {
		type: "rawKeyDown",
		key: "Enter",
		code: "Enter",
		windowsVirtualKeyCode: 13,
		modifiers: 8,
	});
	await page.send("Input.dispatchKeyEvent", {
		type: "char",
		key: "Enter",
		text: "\r",
		modifiers: 8,
	});
	await page.send("Input.dispatchKeyEvent", {
		type: "keyUp",
		key: "Enter",
		code: "Enter",
		windowsVirtualKeyCode: 13,
		modifiers: 8,
	});
	await page.sleep(300);
	text = await value();
	await page.check(
		`Shift+Enter breaks the line, the :name kept (${JSON.stringify(text.slice(-8))})`,
		text.endsWith(" :tad\n")
	);
	await page.check("…and the picker closed", !(await open()));
	await page.check(
		"…with the composer still focused",
		await page.evaluate(`document.activeElement === ${INPUT}`)
	);

	// 11. Emoji only; Enter with nothing matching sends as typed.
	for (const ch of " :zzqxw") {
		await type(page, ch);
	}

	await page.waitFor(`!!${PICKER}`, {label: "the picker for :zzqxw"});
	await page.sleep(300);
	const free = await page.evaluate(
		`document.querySelectorAll(".reaction-picker-option.free").length`
	);
	await page.check(`no "React with …" row while inserting (${free})`, free === 0);
	await page.screenshot("2-no-match");

	if (!mobile) {
		await key(page, "Enter", 13);
		await page.sleep(300);
		text = await value();
		await page.check(
			`Enter with nothing to insert sends the message (${JSON.stringify(text)})`,
			text === ""
		);
		await page.check("…and the picker is gone", !(await open()));
	}

	await page.check("no console errors", page.consoleErrors.length === 0);
}
