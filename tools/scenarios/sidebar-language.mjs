// The globe beside the sidebar logo: the most primitive language access.
// One click opens the panel with the full target list (every option in the
// language's own name, untranslated targets disabled), a pick applies the
// locale at once (<html lang>/<html dir> flip, no navigation), Escape
// closes the panel, and the connect form's selector still reflects the
// pick. Runs against a development build (the qqx pick needs it):
//
//   NODE_ENV=development corepack yarn i18n:compile && corepack yarn build:client
//   python3 -m http.server -d public 8000 &
//   CHROME_BIN=$PWD/tmp/chrome-headless-wrapper.sh \
//     node tools/browser-drive.mjs tools/scenarios/sidebar-language.mjs
import {readFileSync} from "node:fs";

export const url = "http://127.0.0.1:8000/";

// The selector's list is generated from the curated txt; count from the
// source, so the assertion moves when the roadmap does.
const TARGETS = readFileSync(new URL("../../translation-languages.txt", import.meta.url), "utf8")
	.split("\n")
	.filter((line) => {
		const name = line.trim();
		return name.length > 0 && !name.startsWith("#");
	}).length;

const GLOBE = `#sidebar .locale-toggle`;
const POPOVER = `#sidebar .locale-popover`;
const SELECT = `${POPOVER} select`;
const OPTIONS = `Array.from(document.querySelectorAll(${JSON.stringify(
	`${SELECT} option`
)})).map((o) => ({value: o.value, disabled: o.disabled, label: o.label}))`;
const LANG = `document.documentElement.lang`;
const DIR = `document.documentElement.dir`;
const OPEN = `!!document.querySelector(${JSON.stringify(POPOVER)})`;

/** Choose an <option> the way a user does: set + change event. */
const pick = (page, tag) =>
	page.evaluate(
		`(() => {
			const el = document.querySelector(${JSON.stringify(SELECT)});
			el.value = ${JSON.stringify(tag)};
			el.dispatchEvent(new Event("change", {bubbles: true}));
		})()`
	);

export default async function run(page) {
	await page.goto(page.url, {waitForSelector: "#connect form"});

	const targets = TARGETS;
	page.check(
		"the sidebar renders a globe toggle",
		(await page.evaluate(`!!document.querySelector(${JSON.stringify(GLOBE)})`)) === true
	);

	await page.click(GLOBE);
	await page.waitFor(OPEN, {label: "the language panel opens"});
	const options = (await page.evaluate(OPTIONS)).filter(
		// "auto" rides first and the dev-only qqx rides last; the target
		// list sits between them.
		(option) => option.value !== "auto" && option.value !== "qqx"
	);
	page.check(`the panel lists all ${targets} target languages`, options.length === targets);
	page.check(
		"English first, German second (file order)",
		options[0].value === "en" && options[1].value === "de"
	);
	page.check(
		"Arabic is listed and disabled (no catalog yet)",
		options.some((o) => o.value === "ar" && o.disabled)
	);
	page.check(
		"labels are the languages' own names",
		options.some((o) => o.value === "de" && o.label === "Deutsch") &&
			options.some((o) => o.value === "ar" && o.label === "العربية")
	);
	await page.screenshot("sidebar-language-open");

	// A pick applies at once and closes the panel.
	await pick(page, "qqx");
	await page.waitFor(`${LANG} === "qqx"`, {label: "the pick applies at once"});
	page.check("the direction flipped to rtl", (await page.evaluate(DIR)) === "rtl");
	page.check("the panel closed on pick", (await page.evaluate(`!${OPEN}`)) === true);

	// Escape closes (the panel listens for its own keydown: keybinds
	// deliberately ignores Escape inside form fields, and the select has
	// the focus); the value sticks.
	await page.click(GLOBE);
	await page.waitFor(OPEN, {label: "the panel reopens"});
	await page.evaluate(
		`document.querySelector(${JSON.stringify(
			SELECT
		)}).dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true}))`
	);
	await page.waitFor(`!(${OPEN})`, {label: "Escape closes the panel"});
	page.check("the pick survived closing", (await page.evaluate(LANG)) === "qqx");
	await page.screenshot("sidebar-language-closed");
}
