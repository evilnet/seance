// Settings without machinery (docs/resources/translation.md § Settings →
// Language), in a real browser on the in-page fake engine (?fakeTranslate,
// with ?askDownloads so the fake asks before a large download) and a
// fabricated network (lib/fake-network.mjs: #seance is chan 2). No ircd.
//
//  1. A user who never opened Advanced: Settings → Language shows the
//     interface language, the switch with its one consent line, Translate
//     into, I also read and the register; the engines, devices and
//     downloads are under "Advanced: engines and storage", collapsed.
//  2. Advanced opens on what is on the device, each download counted once,
//     and stays open on this device.
//  3. The large-download question is in plain words: the language and the
//     size, no model, no device.
//
//   NODE_ENV=development pnpm build && python3 -m http.server -d public 8021 &
//   SEANCE_HTTP=http://localhost:8021/ CHROME_BIN=… node tools/browser-drive.mjs tools/scenarios/translate-settings-plain.mjs
//   … --mobile --width=390 --height=844

import {readFileSync} from "node:fs";
import {fakeNetworkSnippet} from "./lib/fake-network.mjs";
import {TRANSLATION_ON} from "./lib/translation.mjs";

const BASE = process.env.SEANCE_HTTP || "http://localhost:8021/";
const EN = JSON.parse(readFileSync("client/locales/en.json", "utf8"));

export const url = `${BASE}?fakeTranslate&askDownloads`;

const STORE = `document.getElementById("app").__vue_app__.config.globalProperties.$store`;
const ADVANCED = "#settings #translate-advanced";
// Chrome lays out a closed <details>'s content (it is hidden with
// content-visibility), so rects say nothing: checkVisibility does.
const shown = (selector) =>
	`(() => { const el = document.querySelector(${JSON.stringify(
		selector
	)}); return !!el && el.checkVisibility(); })()`;

export default async function run(page) {
	// Translation on, and Advanced never opened on this device.
	await page.addInitScript(TRANSLATION_ON);
	await page.addInitScript(`(() => {
		if (!sessionStorage.getItem("seance-plain-seeded")) {
			localStorage.setItem("thelounge.state.translateAdvancedOpen", "0");
			sessionStorage.setItem("seance-plain-seeded", "1");
		}
	})()`);
	await page.goto(page.url, {waitForSelector: "#connect form"});
	page.check(
		"a development build fabricated the network",
		await page.evaluate(fakeNetworkSnippet())
	);

	// --- 1. The normal path. ---------------------------------------------
	await page.evaluate(`location.hash = "#/settings/translation"`);
	await page.waitFor(`!!document.querySelector("${ADVANCED}")`, {label: "Settings → Language"});

	const normal = await page.evaluate(`({
		locale: ${shown('#settings select[name="locale"]')},
		enable: ${shown('#settings input[name="translationEnabled"]')},
		hint: document.querySelector("#settings .translate-switch-hint")?.textContent.trim(),
		into: ${shown('#settings select[name="translateInto"]')},
		also: ${shown("#settings .translate-also-add")},
		formality: ${shown('#settings input[name="translateFormality"]')},
		open: document.querySelector("${ADVANCED}").open,
		summary: document.querySelector("${ADVANCED} > summary").textContent.trim(),
		engines: ${shown('#settings input[name="translateCpu"]')},
		models: ${shown("#settings .translate-model")},
		device: ${shown("#settings .translate-device")},
	})`);

	console.log("normal path", JSON.stringify(normal));
	page.check(
		"the normal path: interface language, the switch, Translate into, I also read, the register",
		normal.locale && normal.enable && normal.into && normal.also && normal.formality
	);
	page.check(
		`the switch carries the one consent line (${normal.hint})`,
		normal.hint === EN["translate.settings.enableHint"] &&
			normal.hint === "Runs on this device and downloads language data as you need it."
	);
	page.check(
		`the machinery is under "${normal.summary}", collapsed`,
		normal.summary === EN["translate.settings.advanced"] &&
			!normal.open &&
			!normal.engines &&
			!normal.models &&
			!normal.device
	);
	await page.screenshot("1-settings-normal");

	// --- 2. Advanced. ----------------------------------------------------
	await page.evaluate(
		`document.querySelector("${ADVANCED} > summary").scrollIntoView({block: "center"})`
	);
	await page.click(`${ADVANCED} > summary`);
	await page.waitFor(shown("#settings .translate-model"), {label: "Advanced open"});
	page.check(
		"Advanced holds the engines, the device line and the model manager",
		(await page.evaluate(shown('#settings input[name="translateCpu"]'))) &&
			(await page.evaluate(shown("#settings .translate-device")))
	);
	page.check(
		"it opens on what is on the device, counted by download",
		(await page.evaluate(
			`document.querySelector("#settings .translate-storage")?.textContent.replace(/\\s+/g, " ").trim()`
		)) === `${EN["translate.settings.storageNone"]} ${EN["translate.settings.storageShared"]}`
	);
	page.check(
		"and stays open on this device",
		(await page.evaluate(`localStorage.getItem("thelounge.state.translateAdvancedOpen")`)) ===
			"1"
	);
	await page.screenshot("2-settings-advanced");

	// Only the language model, so the write below needs its large download.
	for (const name of ["translateCpu", "translateNllb"]) {
		await page.evaluate(
			`${STORE}.dispatch("settings/update", {name: "${name}", value: false, sync: true})`
		);
	}

	await page.click(".settings-modal-done");
	await page.waitFor(
		`!document.querySelector(".settings-modal") && !!document.querySelector("#chat")`,
		{
			label: "Settings closed",
		}
	);

	// --- 3. The large-download question. ---------------------------------
	await page.evaluate(`(() => {
		const all = JSON.parse(localStorage.getItem("thelounge.translate") || "{}");
		all["fake-0000-0000/#seance"] = {write: "de", writeFrom: "en"};
		localStorage.setItem("thelounge.translate", JSON.stringify(all));
		${STORE}.commit("translateChannelSet", {key: "fake-0000-0000/#seance", value: all["fake-0000-0000/#seance"]});
	})()`);
	await page.fill("#form #input", "see you all tomorrow at the station");
	await page.evaluate(
		`document.querySelector("#form #input").dispatchEvent(new KeyboardEvent("keypress", {key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true}))`
	);
	await page.waitFor(
		`document.getElementById("confirm-dialog-overlay")?.classList.contains("opened")`,
		{
			label: "the download question",
			timeout: 15000,
		}
	);

	const question = await page.evaluate(`({
		title: document.querySelector("#confirm-dialog-overlay .confirm-text-title")?.textContent.trim(),
		text: document.querySelector("#confirm-dialog-overlay .confirm-text > p")?.textContent.replace(/\\s+/g, " ").trim(),
	})`);

	console.log("question", JSON.stringify(question));
	page.check(
		`the question names the language and the size, no model (${question.title} / ${question.text})`,
		question.title === EN["translate.consent.titlePlain"] &&
			/^German needs a larger download \(\d[\d.,]* (MiB|GiB|MB|GB)\)\./.test(question.text) &&
			!/Qwen|OPUS|NLLB|GPU|CPU/.test(`${question.title} ${question.text}`)
	);
	await page.screenshot("3-download-question");

	page.check(
		`no console errors (${page.consoleErrors.map((e) => e.text).join(" | ")})`,
		page.consoleErrors.length === 0
	);
}
