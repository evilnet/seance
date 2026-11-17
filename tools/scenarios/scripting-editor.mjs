// Settings → Scripts, no IRC needed: the tab holds the Aliases row, the
// Enable Lua switch and the library, greyed out and inert while the switch
// is off; a script opens in the editor at
// /settings/scripts/<id>, an overlay one layer above the settings modal and
// wider than it, closed by Done, ✕ or Escape back to the list (Escape
// closes the editor alone, not the settings under it); its code is a
// CodeMirror editor highlighting Lua in the theme's code colours. There is no
// scripting icon in the sidebar footer, and the Fengari chunk is fetched
// only once an enabled script exists.
//
//   pnpm build && python3 -m http.server -d public 8022 &
//   node tools/browser-drive.mjs tools/scenarios/scripting-editor.mjs
//   (also --mobile --width=390 --height=844)

const BASE = `http://localhost:${process.env.SEANCE_PORT ?? 8022}/`;
export const url = BASE;

const FENGARI_RESOURCES = `performance.getEntriesByType("resource").filter((e) => e.name.includes("fengari")).length`;
const STORED = `JSON.parse(localStorage.getItem("thelounge.scripts") || "[]")`;

const KEYS = {
	Tab: {key: "Tab", keyCode: 9},
	Escape: {key: "Escape", keyCode: 27},
	End: {key: "End", keyCode: 35},
	Enter: {key: "Enter", keyCode: 13, text: "\r"},
	KeyA: {key: "a", keyCode: 65},
};
const CTRL = 2;
const SHIFT = 8;

async function key(page, code, modifiers = 0) {
	const {key: name, keyCode, text} = KEYS[code];

	for (const type of ["keyDown", "keyUp"]) {
		await page.send("Input.dispatchKeyEvent", {
			type,
			key: name,
			code,
			windowsVirtualKeyCode: keyCode,
			modifiers,
			// A key that types (Enter) activates a link through its text.
			...(text && type === "keyDown" ? {text} : {}),
		});
	}

	await page.sleep(50);
}

/** Shift+Tab round a layer `n` times: true when the focus never left `layer`. */
async function staysInside(page, layer, n) {
	for (let i = 0; i < n; i++) {
		await key(page, "Tab", SHIFT);

		if (!(await page.evaluate(`!!document.activeElement?.closest(${JSON.stringify(layer)})`))) {
			return false;
		}
	}

	return true;
}

const FOCUSED = (selector) => `!!document.activeElement?.matches(${JSON.stringify(selector)})`;

/** Replace the editor's code the way typing would: select all, insert. */
async function setCode(page, text) {
	await page.click(".script-editor .cm-content");
	await key(page, "KeyA", CTRL);
	await page.send("Input.insertText", {text});
	await page.sleep(50);
}

export default async function run(page) {
	await page.goto(BASE, {waitForSelector: "#footer button.settings"});

	page.check("no scripting icon in the footer", (await page.count("#footer .scripts")) === 0);
	page.check("fengari not loaded while disabled", (await page.evaluate(FENGARI_RESOURCES)) === 0);

	// The tab is there with scripting off: the switch, and the library under
	// it greyed out and inert. (By URL: on the phone layout the sidebar, and
	// its cog, start closed.)
	await page.evaluate(`location.hash = "#/settings"`);
	await page.waitFor(`!!document.querySelector(".settings-menu button.scripts")`, {
		label: "Scripts tab",
	});
	await page.click(".settings-menu button.scripts");
	await page.waitFor(`!!document.querySelector('input[name="enableScripting"]')`, {
		label: "Scripts tab open",
	});
	page.check(
		"the URL is /settings/scripts",
		(await page.evaluate("location.hash")) === "#/settings/scripts"
	);
	page.check(
		"Enable Lua starts off",
		(await page.evaluate(`document.querySelector('input[name="enableScripting"]').checked`)) ===
			false
	);
	page.check(
		"the library is inert while off",
		(await page.evaluate(
			`document.querySelector(".scripts-library")?.inert === true &&
			document.querySelector(".scripts-actions .btn")?.closest("[inert]") !== null`
		)) === true
	);
	await page.screenshot("scripts-off");

	await page.click(".settings-menu button.general");
	await page.waitFor(`!!document.querySelector(".settings-backup")`, {label: "General open"});
	page.check(
		"General has no scripting switch",
		(await page.count('input[name="enableScripting"]')) === 0
	);
	await page.click(".settings-menu button.scripts");
	await page.waitFor(`!!document.querySelector('input[name="enableScripting"]')`, {
		label: "Scripts tab again",
	});

	await page.click('input[name="enableScripting"]');
	await page.waitFor(`document.querySelector(".scripts-library")?.inert === false`, {
		label: "library live",
	});
	page.check(
		"stored setting is on",
		(await page.evaluate(
			`JSON.parse(localStorage.getItem("settings") ?? "{}").enableScripting`
		)) === true
	);
	page.check(
		"parser still not loaded with no enabled scripts",
		(await page.evaluate(FENGARI_RESOURCES)) === 0
	);
	page.check("still no footer icon once on", (await page.count("#footer .scripts")) === 0);
	await page.screenshot("scripts-empty");

	// An example opens straight in the editor and loads the parser.
	await page.click(".scripts-examples .btn", 0);
	await page.waitFor(`!!document.querySelector("#script-editor-overlay .cm-content")`, {
		label: "editor open",
	});
	const id = await page.evaluate(`${STORED}[0]?.id`);
	page.check(
		"the editor is /settings/scripts/<id>",
		(await page.evaluate("location.hash")) === `#/settings/scripts/${id}`
	);
	page.check(
		"the Scripts tab stays active in the editor",
		(await page.count(".settings-menu button.scripts.active")) === 1
	);
	const editorBox = await page.rect(".script-editor");
	const settingsBox = await page.rect("#settings .settings-modal");
	const innerWidth = await page.evaluate("innerWidth");
	page.check(
		"the editor is wider than the settings pane (or the whole screen)",
		editorBox.width > settingsBox.width + 1 || editorBox.width >= innerWidth - 1
	);
	page.check(
		"the editor is on top of the settings",
		(await page.evaluate(
			`!!document.elementFromPoint(${editorBox.x + editorBox.width / 2}, ${
				editorBox.y + editorBox.height / 2
			})?.closest(".script-editor")`
		)) === true
	);
	page.check(
		"focus is in the editor, not in a field",
		(await page.evaluate(`document.activeElement?.classList.contains("script-editor")`)) ===
			true
	);
	await page.waitFor(`${FENGARI_RESOURCES} > 0`, {label: "fengari loaded for enabled script"});
	page.check("fengari loaded once an enabled script exists", true);
	page.check("code area is tall", (await page.rect(".script-code-wrap")).height > 250);
	page.check(
		"CodeMirror replaced the plain field",
		(await page.count(".script-code")) === 0 && (await page.count(".cm-lineNumbers")) === 1
	);
	page.check(
		"the CodeMirror chunk loads on demand",
		(await page.evaluate(
			`performance.getEntriesByType("resource").some((e) => /\\/js\\/code-editor\\.[\\w-]+\\.js$/.test(e.name))`
		)) === true
	);
	const tokens = await page.evaluate(`(() => {
		const text = (cls) => [...document.querySelectorAll(".cm-content ." + cls)].map((e) => e.textContent);
		const colour = (sel) => { const el = document.querySelector(sel); return el && getComputedStyle(el).color; };
		return {
			keyword: text("tok-keyword"),
			string: text("tok-string"),
			comment: text("tok-comment"),
			keywordColour: colour(".cm-content .tok-keyword"),
			stringColour: colour(".cm-content .tok-string"),
			plainColour: colour(".cm-content"),
		};
	})()`);
	page.check(
		"Lua keywords, strings and comments are highlighted",
		tokens.keyword.includes("function") &&
			tokens.keyword.includes("end") &&
			tokens.string.includes('"!ping"') &&
			tokens.comment.some((c) => c.includes("Auto-responder"))
	);
	page.check(
		"tokens take the theme's colours, not the text's",
		tokens.keywordColour !== tokens.plainColour &&
			tokens.stringColour !== tokens.plainColour &&
			tokens.keywordColour !== tokens.stringColour
	);
	await page.screenshot("script-edit-auto-ping");

	await page.click(".script-tools .btn", 0);
	await page.waitFor(`document.querySelector(".script-status")?.textContent === "Syntax OK"`, {
		label: "syntax ok",
		timeout: 10000,
	});
	page.check("Check syntax passes on the example", true);

	// A name the library would drop is never saved; a good one is.
	await page.fill(".script-name", "bad name");
	await page.waitFor(`!!document.querySelector(".script-error-line")`, {label: "name error"});
	await page.sleep(800);
	page.check(
		"an invalid name is not saved",
		(await page.evaluate(`${STORED}[0].name`)) === "auto_ping"
	);
	await page.fill(".script-name", "pinger");
	await page.waitFor(`${STORED}[0].name === "pinger"`, {label: "rename saved"});
	page.check("a valid rename is saved", (await page.count(".script-error-line")) === 0);

	// Tab indents; Shift+Tab leaves the field (no keyboard trap).
	await page.click(".script-editor .cm-content");
	await key(page, "End", CTRL);
	await key(page, "Tab");
	await page.waitFor(`${STORED}[0].code.endsWith("end)\\n    ")`, {
		label: "Tab inserted four spaces",
	});
	page.check("Tab inserts four spaces at the caret", true);
	await key(page, "Tab", SHIFT);
	page.check(
		"Shift+Tab moves focus out of the code",
		(await page.evaluate(`!document.activeElement?.closest(".cm-editor")`)) === true
	);

	// Escape (outside a field) closes the editor and leaves the settings up.
	await key(page, "Escape");
	await page.waitFor(`!document.querySelector("#script-editor-overlay")`, {
		label: "Escape closed the editor",
	});
	page.check(
		"Escape closes the editor alone",
		(await page.count("#settings")) === 1 &&
			(await page.evaluate("location.hash")) === "#/settings/scripts"
	);
	page.check(
		"the focus goes back to what opened the editor (the example's button)",
		await page.evaluate(FOCUSED(".scripts-examples .btn"))
	);

	// Back in the list: one flat list, no folder headings, and switched off
	// from the row.
	await page.waitFor(`!!document.querySelector(".scripts-item")`, {label: "list again"});
	page.check("the list has no folder headings", (await page.count(".settings-scripts h3")) === 0);
	page.check(
		"the row shows the new name",
		(await page.evaluate(`document.querySelector(".scripts-name")?.textContent`)) === "pinger"
	);
	await page.click(".scripts-item input[type=checkbox]");
	await page.waitFor(`${STORED}[0].enabled === false`, {label: "row switch saved"});
	page.check("the row's switch turns the script off", true);
	await page.screenshot("scripts-list");

	// A backtracking pattern stops at the matcher's step budget
	// (scripts/fengari-match-budget.js) instead of holding the page: the
	// load fails with the limit's error, shown in the editor's banner.
	await page.click(".scripts-summary");
	await page.waitFor(`!!document.querySelector(".script-editor .cm-content")`, {
		label: "editor again",
	});
	await page.screenshot("script-edit-pinger");
	await page.click(".script-run input");
	await page.waitFor(`${STORED}[0].enabled === true`, {label: "run switch saved"});
	await setCode(page, `string.find(string.rep("a", 100000), ".-.-.-.-b")`);
	// Leaving the code commits the edit, which reloads the scripts.
	await page.click(".script-desc-field .input");
	await page.waitFor(`(${STORED}[0].lastError ?? "").includes("step limit")`, {
		label: "pattern stopped at its step budget",
		timeout: 15000,
	});
	await page.waitFor(
		`[...document.querySelectorAll(".script-banner")].some((b) => b.textContent.includes("step limit"))`,
		{label: "error banner"}
	);
	page.check("a backtracking pattern stops at the step budget, and says so", true);
	await page.screenshot("script-edit-error");

	// Duplicate opens the copy (a fresh editor), switched off.
	await page.click(".script-tools .btn", 1);
	await page.waitFor(`document.querySelector(".script-name")?.value === "pinger_copy"`, {
		label: "copy open",
	});
	const copy = await page.evaluate(`${STORED}.find((s) => s.name === "pinger_copy")`);
	page.check("the copy is off", copy?.enabled === false);
	page.check(
		"the URL follows the copy",
		(await page.evaluate("location.hash")) === `#/settings/scripts/${copy?.id}`
	);

	// Delete asks first (the question over the editor), then goes back to
	// the list.
	await page.click(".script-delete");
	await page.waitFor(`!!document.querySelector("#confirm-dialog-overlay.opened")`, {
		label: "confirm",
	});
	await page.sleep(300); // its fade
	await page.screenshot("script-delete-confirm");
	await page.click("#confirm-dialog .btn-danger");
	await page.waitFor(`!document.querySelector("#script-editor-overlay")`, {
		label: "back on list",
	});
	page.check("the copy is deleted", (await page.evaluate(`${STORED}.length`)) === 1);
	page.check(
		"with its row gone, the focus lands on New script",
		await page.evaluate(FOCUSED(".scripts-actions .btn"))
	);
	await page.waitFor(`!document.querySelector("#confirm-dialog-overlay.opened")`, {
		label: "confirm closed",
	});
	await page.sleep(400); // its fade

	// Done closes the editor too, saving what was typed just before.
	await page.click(".scripts-summary");
	await page.waitFor(`!!document.querySelector(".script-editor .cm-content")`, {
		label: "editor for Done",
	});
	page.check(
		"Shift+Tab comes round inside the editor, never under it",
		await staysInside(page, "#script-editor-overlay", 20)
	);
	await page.fill(".script-desc-field .input", "Answers !ping");
	await page.click(".script-editor .settings-modal-done");
	await page.waitFor(`!document.querySelector("#script-editor-overlay")`, {
		label: "Done closed the editor",
	});
	page.check(
		"the focus goes back to the script's row",
		await page.evaluate(FOCUSED(".scripts-summary"))
	);
	page.check(
		"Done saves and the list shows it",
		(await page.evaluate(`${STORED}[0].description`)) === "Answers !ping" &&
			(await page.evaluate(`document.querySelector(".scripts-desc")?.textContent`)) ===
				"Answers !ping"
	);

	// Off again: the library greys out, each row keeps its own switch and
	// says nothing of running (a script's last error still shows), and the
	// editor's URL leads to the tab.
	await page.click('input[name="enableScripting"]');
	await page.waitFor(`document.querySelector(".scripts-library")?.inert === true`, {
		label: "library inert",
	});
	const states = await page.evaluate(
		`[...document.querySelectorAll(".scripts-item")].map((li) => (li.querySelector(".scripts-state")?.textContent.trim() ?? "") + "/" + (li.querySelector("input").title ?? ""))`
	);
	page.check(
		`with Lua off a row shows no state but an error (${states.join(", ")})`,
		states.length > 0 && states.every((s) => s === "/" || s === "Error/Error")
	);
	await page.evaluate(`location.hash = "#/settings/scripts/${id}"`);
	await page.sleep(300);
	page.check(
		"the editor is not reachable while off",
		(await page.evaluate("location.hash")) === "#/settings/scripts" &&
			(await page.count("#script-editor-overlay")) === 0
	);
	await page.screenshot("scripts-off-again");

	// The aliases' layer, from the keyboard: Enter on its row opens it, Tab
	// stays inside it, and closing it puts the focus back on the row.
	await page.evaluate(`document.querySelector(".scripts-aliases").focus()`);
	await key(page, "Enter");
	await page.waitFor(`!!document.querySelector("#aliases-overlay")`, {label: "aliases open"});
	page.check("the aliases open into their pane", await page.evaluate(FOCUSED(".aliases-layer")));
	page.check(
		"Shift+Tab comes round inside the aliases, never under them",
		await staysInside(page, "#aliases-overlay", 20)
	);
	await page.click("#aliases-overlay .settings-modal-close");
	await page.waitFor(`!document.querySelector("#aliases-overlay")`, {label: "aliases closed"});
	page.check(
		"closing the aliases puts the focus back on their row",
		await page.evaluate(FOCUSED(".scripts-aliases"))
	);

	await page.click("#settings .settings-modal-done");
	await page.waitFor(`!document.querySelector("#settings")`, {label: "settings closed"});

	// The step-limit test's own load failure is logged on purpose; nothing else may be.
	const unexpected = page.consoleErrors.filter(
		(e) => !String(e.text ?? e).includes("pattern too complex (step limit)")
	);
	page.check("no console errors", unexpected.length === 0);
}
