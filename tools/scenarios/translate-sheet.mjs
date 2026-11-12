// One sheet per conversation (docs/resources/translation.md § One sheet), in
// a real browser on the in-page fake engine (?fakeTranslate) and a
// fabricated network (lib/fake-network.mjs: #seance on screen, chan 2), so
// it needs a development build and no ircd.
//
// In order:
//  1. The channel menu's "Translation…" opens the sheet on its switches:
//     the reading switch on, Write in Off, no language list, More closed.
//     There is no other translation panel.
//  2. The translate panel's language button (the chip opens the panel)
//     opens the same sheet with the language list open. Portuguese picked
//     there and a translation inserted make it the conversation's write
//     target: the chip reads "PT", and the sheet opened again from the
//     menu shows Write in on Portuguese.
//  3. More: the register is stored for the conversation; "I write" opens
//     the list on the other side.
//  4. Adversarial, the panel open: text is being translated into
//     Portuguese in the panel when "Reset choices for this conversation" is
//     pressed. The panel goes with the target, the record is gone, the chip
//     is the plain glyph again, and Enter sends the composer's draft as typed.
//  5. Reset lifts an exclusion: with reading off here a German line stays
//     as written; Reset reads it.
//  6. Adversarial, the language changed mid-translation: the panel's
//     language is changed while the translation into the old one is still
//     streaming, and the translation that stands is for the new one.
//  7. Off by the user: the menu's sheet is one button, nothing else.
//  8. The sheet is modal: Tab and Shift+Tab stay inside it.
//
//   NODE_ENV=development pnpm build && python3 -m http.server -d public 8021 &
//   SEANCE_HTTP=http://localhost:8021/ CHROME_BIN=… node tools/browser-drive.mjs tools/scenarios/translate-sheet.mjs
//   … --mobile --width=390 --height=844

import {fakeNetworkSnippet} from "./lib/fake-network.mjs";
import {
	SHEET,
	TRANSLATION_ON,
	closeTranslationSheet,
	openTranslationSheet,
} from "./lib/translation.mjs";

const BASE = process.env.SEANCE_HTTP || "http://localhost:8021/";

export const url = `${BASE}?fakeTranslate`;

const NETWORK = "fake-0000-0000";
const CHANNEL = 2;
const KEY = `${NETWORK}/#seance`;
const STORE = `document.getElementById("app").__vue_app__.config.globalProperties.$store`;
const RECORD = `(JSON.parse(localStorage.getItem("thelounge.translate") || "{}")[${JSON.stringify(
	KEY
)}] ?? null)`;
const CHIP = `((document.querySelector("#translate-once .translate-once-target") || {}).textContent || "").trim()`;
const PANEL_UP = `!!document.querySelector(".translate-panel")`;
const INSERT_READY = `(() => {
	const b = document.querySelector("#form .translate-panel-insert");
	return !!b && !b.disabled;
})()`;

let nextId = 700;

async function say(page, text) {
	const id = nextId++;

	await page.evaluate(`window.socket.dispatch("msg", {
		chan: ${CHANNEL},
		msg: {id: ${id}, type: "message", from: {mode: "", modes: [], away: "", lastMessage: Date.now(), nick: "moria"}, text: ${JSON.stringify(
		text
	)}, self: false, time: new Date(), users: [], msgid: "seance-fake-${id}"},
	})`);

	return id;
}

const translated = (id) => `!!document.querySelector("#msg-${id} .msg-translated")`;

async function fabricate(page) {
	const made = await page.evaluate(fakeNetworkSnippet());

	page.check("a development build fabricated the network", made === true);
	await page.waitFor(`document.querySelectorAll("#chat .msg").length >= 3`, {
		label: "the fabricated channel's messages",
	});
}

/** What the open sheet shows. */
const SHOWN = `(() => {
	const sheet = document.querySelector("${SHEET}");

	if (!sheet) {
		return null;
	}

	const checked = (selector) =>
		sheet.querySelector(selector)?.getAttribute("aria-checked") === "true";

	return {
		reading: sheet.querySelector(".language-sheet-read-box")?.checked ?? null,
		off: checked(".translation-sheet-off"),
		language: sheet.querySelector(".translation-sheet-language")?.textContent.trim() ?? "",
		list: !!sheet.querySelector(".language-sheet-list"),
		search: !!sheet.querySelector(".language-sheet-search"),
		more: sheet.querySelector(".translation-sheet-more")?.open ?? null,
		enable: !!sheet.querySelector(".translation-sheet-enable-button"),
		panels: document.querySelectorAll(".translation-panel, .header-popover.translation-panel").length,
	};
})()`;

async function typeDraft(page, text) {
	await page.fill("#form #input", text);
	await page.evaluate(
		`document.querySelector("#form #input").dispatchEvent(new Event("input", {bubbles: true}))`
	);
}

async function pressEnter(page) {
	await page.evaluate(
		`document.querySelector("#form #input").dispatchEvent(new KeyboardEvent("keypress", {key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true}))`
	);
}

/** The chip opens the panel; the panel's language button, the sheet's list. */
async function openFromChip(page) {
	if (!(await page.evaluate(PANEL_UP))) {
		await page.click("#translate-once");
		await page.waitFor(PANEL_UP, {label: "the chip opens the translate panel"});
	}

	await page.click("#form .translate-panel-language");
	await page.waitFor(`!!document.querySelector("${SHEET} .language-sheet-list")`, {
		label: "the panel's language button opens the sheet on the language list",
	});
}

async function typeInPanel(page, text) {
	await page.fill("#translate-panel-input", text);
}

async function pickLanguage(page, code) {
	// A real click on a row the list scrolled near the screen's top can
	// land on the header instead; the row's own click is the pick.
	await page.evaluate(
		`document.querySelector('${SHEET} .language-sheet-row[data-code="${code}"]').click()`
	);
	await page.waitFor(`!document.querySelector("${SHEET}")`, {label: "a pick closes the sheet"});
}

async function openMore(page) {
	await page.evaluate(`(() => {
		const more = document.querySelector("${SHEET} .translation-sheet-more");

		if (!more.open) {
			more.querySelector("summary").click();
		}
	})()`);
	await page.waitFor(`document.querySelector("${SHEET} .translation-sheet-more").open`, {
		label: "More opens",
	});
}

async function tab(page, shift) {
	for (const type of ["rawKeyDown", "keyUp"]) {
		await page.send("Input.dispatchKeyEvent", {
			type,
			key: "Tab",
			code: "Tab",
			windowsVirtualKeyCode: 9,
			modifiers: shift ? 8 : 0,
		});
	}
}

/** Tab past both ends of the open sheet: where the focus went outside it. */
async function tabOutside(page) {
	const TABBABLE = `[...document.querySelector("${SHEET}").querySelectorAll("button, select, input, summary, a[href], [tabindex]")].filter((el) => el.tabIndex >= 0 && !el.disabled && el.getClientRects().length > 0)`;
	const count = await page.evaluate(`${TABBABLE}.length`);
	const outside = [];

	await page.evaluate(`${TABBABLE}[0].focus()`);

	for (let i = 0; i < 2 * count + 4; i++) {
		await tab(page, i >= count + 2);

		const at = await page.evaluate(
			`(() => { const a = document.activeElement; return a && a.closest("${SHEET}") ? null : a ? a.tagName + "." + a.className : "none"; })()`
		);

		if (at) {
			outside.push(at);
		}
	}

	return {count, outside};
}

export default async function run(page) {
	await page.addInitScript(TRANSLATION_ON);
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await fabricate(page);

	// --- 1. From the channel menu: the switches. ------------------------
	await openTranslationSheet(page);

	const fromMenu = await page.evaluate(SHOWN);

	console.log("from the menu", JSON.stringify(fromMenu));
	page.check(
		"the menu opens the sheet on its switches: reading on, Write in Off, no list, More closed",
		fromMenu.reading === true &&
			fromMenu.off &&
			!fromMenu.list &&
			fromMenu.more === false &&
			fromMenu.panels === 0
	);
	await page.screenshot("1-sheet-from-menu");

	const trapped = await tabOutside(page);

	page.check(
		`the sheet is modal: Tab and Shift+Tab stay inside its ${trapped.count} controls (${
			trapped.outside.join(", ") || "always inside"
		})`,
		trapped.count > 1 && trapped.outside.length === 0
	);
	await closeTranslationSheet(page);

	// --- 2. From the panel: the list; inserted, the write target. --------
	await openFromChip(page);
	page.check(
		"the panel's language button opens the same sheet with the list and its search",
		(await page.evaluate(SHOWN)).search
	);
	await page.screenshot("2-sheet-from-chip");
	await pickLanguage(page, "pt");
	await typeInPanel(page, "thanks for the help");
	await page.waitFor(INSERT_READY, {label: "the Portuguese is ready", timeout: 15000});
	await page.click("#form .translate-panel-insert");
	await page.waitFor(`!${PANEL_UP}`, {label: "Insert closes the panel"});
	await typeDraft(page, "");
	page.check(
		'Portuguese is the write target, and the chip reads "PT"',
		(await page.evaluate(RECORD))?.write === "pt" && (await page.evaluate(CHIP)) === "PT"
	);
	await openTranslationSheet(page);

	const withTarget = await page.evaluate(SHOWN);

	page.check(
		"the menu's sheet shows Write in on Portuguese",
		!withTarget.off && withTarget.language.startsWith("Portuguese")
	);

	// --- 3. More: the register, and "I write". ---------------------------
	await openMore(page);
	await page.evaluate(`(() => {
		for (const b of document.querySelectorAll('${SHEET} [name="translateFormality"]')) {
			if (b.textContent.trim() === "Formally") {
				b.click();
			}
		}
	})()`);
	await page.sleep(200);
	page.check(
		"the register is stored for the conversation",
		(await page.evaluate(RECORD))?.formality === "formal"
	);
	await page.click(`${SHEET} .language-sheet-side[data-side="from"]`);
	page.check(
		'"I write" opens the list on its side, with Detect automatically on top',
		await page.evaluate(
			`!!document.querySelector("${SHEET} .language-sheet-list") && document.querySelector("${SHEET} .language-sheet-row .language-sheet-name")?.textContent.trim() === "Detect automatically"`
		)
	);
	await page.screenshot("3-sheet-more");
	await closeTranslationSheet(page);

	// --- 4. Reset with the panel open. -----------------------------------
	await typeDraft(page, "good morning everyone");
	await page.click("#translate-once");
	await page.waitFor(PANEL_UP, {label: "the panel opens on Portuguese"});
	await typeInPanel(page, "see you soon");
	await openTranslationSheet(page);
	await openMore(page);
	await page.click(`${SHEET} .translation-sheet-reset`);
	await page.sleep(300);

	const afterReset = await page.evaluate(SHOWN);

	page.check(
		"reset: the record is gone and the sheet shows the defaults",
		(await page.evaluate(RECORD)) === null && afterReset.off && afterReset.reading === true
	);
	await closeTranslationSheet(page);
	page.check(
		"reset: the panel went with the target, and the chip is the plain glyph",
		!(await page.evaluate(PANEL_UP)) && (await page.evaluate(CHIP)) === ""
	);
	await pressEnter(page);
	await page.sleep(600);
	page.check(
		"reset: Enter sends the draft as typed",
		!(await page.evaluate(PANEL_UP)) &&
			(await page.evaluate(`document.querySelector("#form #input").value`)) === ""
	);

	// --- 5. Reset lifts an exclusion. ------------------------------------
	await openTranslationSheet(page);
	await page.click(`${SHEET} .language-sheet-read-box`);
	await closeTranslationSheet(page);
	page.check("excluded", (await page.evaluate(RECORD))?.exclude === true);

	const german = await say(
		page,
		"Heute ist das Wetter wirklich schön, und wir gehen am Nachmittag im Park spazieren."
	);

	await page.sleep(1500);
	page.check(
		"excluded: the German line stays as written",
		!(await page.evaluate(translated(german)))
	);
	await openTranslationSheet(page);
	await openMore(page);
	await page.click(`${SHEET} .translation-sheet-reset`);
	await closeTranslationSheet(page);
	await page.waitFor(translated(german), {
		label: "reset: the line on screen is read",
		timeout: 15000,
	});

	// --- 6. The panel's language changed while its translation is out. --
	await openFromChip(page);
	await pickLanguage(page, "es");
	await typeInPanel(page, "see you all tomorrow at the station");
	// The fake streams a word at a time: the Spanish preview is on its way.
	await page.waitFor(
		`(window.__seanceTranslateFake?.requests ?? []).some((r) => r.to === "es" && r.text.includes("station"))`,
		{label: "the Spanish preview is asked for", timeout: 10000}
	);
	await openFromChip(page);
	await pickLanguage(page, "fr");
	await page.waitFor(
		`(document.querySelector(".translate-panel-translation")?.textContent ?? "").includes("[French]")`,
		{label: "the panel's translation is for the new language", timeout: 20000}
	);
	// Long enough for the Spanish answer to have landed had it been kept.
	await page.sleep(3000);

	const strip = await page.evaluate(
		`JSON.stringify(${STORE}.state.outgoingTranslations[${CHANNEL}] ?? null)`
	);

	console.log("strip after the change", strip);
	page.check(
		"the translation that stands is for French, not the Spanish one that was on its way",
		JSON.parse(strip)?.to === "fr" &&
			!(
				await page.evaluate(
					`document.querySelector(".translate-panel-translation")?.textContent ?? ""`
				)
			).includes("[Spanish]")
	);
	await page.click("#form .translate-panel-cancel");
	await page.screenshot("4-strip-new-target");

	// --- 7. Off by the user: one button. ---------------------------------
	await page.evaluate(
		`${STORE}.dispatch("settings/update", {name: "translationEnabled", value: false, sync: true})`
	);
	await page.sleep(300);
	await openTranslationSheet(page);

	const off = await page.evaluate(SHOWN);

	page.check(
		"off: the sheet is the one button that switches translation on",
		off.enable && off.reading === null && off.more === null && !off.list
	);
	await page.screenshot("5-sheet-off");
	await closeTranslationSheet(page);
}
