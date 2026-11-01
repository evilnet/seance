// A deploy with translation turned off still lets the reader choose the
// interface's language (client/components/Settings/Translation.vue): the
// language select stands outside the tab's translation.enabled branch, is
// labelled "Interface language" there, and switching it to German puts the
// interface into German. With translation on, the same select keeps its
// "Interface and reading language" label.
//
// No ircd: an init script rewrites config.json's `translation` block on the
// way in (window.fetch), so one served build covers both deploys.
//
//   NODE_ENV=production corepack yarn build
//   python3 -m http.server -d public 8041 &
//   SEANCE_HTTP=http://localhost:8041/ CHROME_BIN=/seance/tmp/chrome-pw.sh \
//     node tools/browser-drive.mjs tools/scenarios/translation-off-locale.mjs

import {readFileSync} from "node:fs";

const BASE = process.env.SEANCE_HTTP ?? "http://localhost:8041/";
const EN = JSON.parse(readFileSync("client/locales/en.json", "utf8"));
const DE = JSON.parse(readFileSync("client/locales/de.json", "utf8"));

export const url = `${BASE}#/settings/translation`;

// Read at every document start: "off" turns translation off for that load.
const CONFIG_PATCH = `(() => {
	let mode = null;
	try { mode = localStorage.getItem("seance.test.translation"); } catch (e) {}
	if (mode !== "off") { return; }
	const real = window.fetch.bind(window);
	window.fetch = async (input, init) => {
		const href = typeof input === "string" ? input : input.url;
		const response = await real(input, init);
		if (!/config\\.json(\\?|$)/.test(href)) { return response; }
		const config = await response.json();
		config.translation = {...(config.translation || {}), enabled: false};
		return new Response(JSON.stringify(config), {status: 200, headers: {"Content-Type": "application/json"}});
	};
})()`;

const LABEL = `(() => {
	const select = document.querySelector('select[name="locale"]');
	const label = select && select.closest("label");
	return {
		select: !!select,
		label: label ? label.querySelector("span").textContent.trim() : "",
		disabledHint: [...document.querySelectorAll(".translate-hint")].map((el) => el.textContent.trim()),
		models: !!document.querySelector(".translate-models"),
	};
})()`;

export default async function run(page) {
	await page.addInitScript(CONFIG_PATCH);

	// Translation off.
	await page.goto(page.url, {waitForSelector: "#app"});
	await page.evaluate(`localStorage.setItem("seance.test.translation", "off")`);
	await page.evaluate(`location.reload()`);
	await page.sleep(500);
	await page.waitFor(`!!document.querySelector('select[name="locale"]')`, {
		label: "the language select is there with translation off",
	});

	const off = await page.evaluate(LABEL);

	page.check(
		`translation off: the language select is offered as "${EN["translate.settings.interfaceLanguageLabel"]}" (${off.label})`,
		off.select && off.label === EN["translate.settings.interfaceLanguageLabel"]
	);
	page.check(
		"translation off: the tab says so and shows no model manager",
		off.disabledHint.includes(EN["translate.settings.disabled"]) && !off.models
	);
	await page.screenshot("off-en");

	await page.evaluate(`(() => {
		const select = document.querySelector('select[name="locale"]');
		select.value = "de";
		select.dispatchEvent(new Event("change", {bubbles: true}));
	})()`);
	await page.waitFor(
		`(document.querySelector('select[name="locale"]').closest("label").querySelector("span").textContent.trim()) === ${JSON.stringify(
			DE["translate.settings.interfaceLanguageLabel"]
		)}`,
		{label: "the interface turned German"}
	);

	const german = await page.evaluate(`({
		lang: document.documentElement.lang,
		heading: document.querySelector(".settings-modal h2, h2")?.textContent.trim(),
	})`);

	page.check(
		`translation off: choosing German puts the interface into German (${german.lang}, ${german.heading})`,
		german.lang.startsWith("de") && german.heading === DE["translate.settings.heading"]
	);
	await page.screenshot("off-de");

	// Translation on: the same select, labelled for both languages.
	await page.evaluate(`(() => {
		localStorage.removeItem("seance.test.translation");
		const settings = JSON.parse(localStorage.getItem("settings") || "{}");
		settings.locale = "en";
		localStorage.setItem("settings", JSON.stringify(settings));
	})()`);
	await page.evaluate(`location.reload()`);
	await page.sleep(500);
	await page.waitFor(`!!document.querySelector(".translate-models")`, {
		label: "the model manager is there with translation on",
	});

	const on = await page.evaluate(LABEL);

	page.check(
		`translation on: the select reads "${EN["translate.settings.languageLabel"]}" (${on.label})`,
		on.select && on.label === EN["translate.settings.languageLabel"]
	);
	await page.screenshot("on-en");
}
