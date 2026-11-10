// The composer's source under a send target, on the in-page fake engine
// (?fakeTranslate on a development build) in #seance-translate on the dev
// ircd. A tester's reports: the button said "EN → ES" while a draft was
// translated from whatever the detector made of it; and a slow model showed
// nothing but a caret. The button names only the target ("ES") here, and
// the draft goes from the source it was picked or detected from.
// Steps:
//
// - English into Spanish: the button reads "ES", and a one-word draft
//   ("Testing", too short to place) is requested from English;
// - while the model works and nothing has streamed, the strip says
//   "Translating…" (watched by a MutationObserver set up before the draft);
// - a long, unmistakably French draft, with no source picked, is requested
//   from French, and the button still says "ES" (someone who
//   writes in two languages keeps that);
// - adversarial: a draft already in Spanish is sent as typed, with no
//   request: detection still decides that;
// - a source picked with the target ("Translate from" German, written as
//   the channel's `writeFrom`) leaves the button on "ES", and a draft
//   is requested from German even when it reads as English: a picked
//   source is never second-guessed.
//
// Needs the dev ircd's plain-WS port on 127.0.0.1:8067 and a development
// build (a production build compiles the fake out):
//
//   NODE_ENV=development pnpm build && python3 -m http.server -d public 8021 &
//   node tools/browser-drive.mjs tools/scenarios/translate-composer-source.mjs [--mobile]

import {readFileSync} from "node:fs";
import {
	SHEET,
	TRANSLATION_ON,
	TRANSLATION_OFFERED,
	openTranslationSheet,
} from "./lib/translation.mjs";

const EN = JSON.parse(readFileSync("client/locales/en.json", "utf8"));
const RUN = Date.now().toString(36);
const NICK = `ts${RUN}`;
const BASE = process.env.SEANCE_HTTP || "http://localhost:8021/";

export const url = `${BASE}?host=127.0.0.1&port=8067&tls=false&nick=${NICK}&join=%23seance-translate&fakeTranslate`;

const INPUT = "#form #input";
const REQUESTS = "((window.__seanceTranslateFake && window.__seanceTranslateFake.requests) || [])";
const BUTTON_TARGET = `((document.querySelector("#translate-once .translate-once-target") || {}).textContent || "").trim()`;
const LAST_FROM = `(${REQUESTS}.filter((r) => r.purpose === "write").at(-1) || {}).from`;
const WRITES = `${REQUESTS}.filter((r) => r.purpose === "write").length`;

/**
 * The conversation's send target through the menu's sheet: Write in's Off,
 * or its language, which opens the list, and the row is the pick (a pick
 * closes the sheet). As translate-composer.mjs `setWriteTarget`.
 */
async function setWriteTarget(page, code) {
	await openTranslationSheet(page);

	if (!code) {
		await page.click(`${SHEET} .translation-sheet-off`);
	} else {
		await page.click(`${SHEET} .translation-sheet-language`);
		await page.waitFor(
			`!!document.querySelector('${SHEET} .language-sheet-row[data-code="${code}"]')`,
			{label: "the sheet's language list"}
		);
		await page.evaluate(
			`document.querySelector('${SHEET} .language-sheet-row[data-code="${code}"]').click()`
		);
	}

	await page.waitFor(`!document.querySelector(${JSON.stringify(SHEET)})`, {
		label: "the pick closed the sheet",
	});
}

/** Type a draft and wait for its preview's write request; resolves to its `from`. */
async function previewFrom(page, text, label) {
	const before = await page.evaluate(WRITES);

	await page.fill(INPUT, text);
	await page.waitFor(`${WRITES} > ${before}`, {timeout: 15000, label});

	return page.evaluate(LAST_FROM);
}

async function clearDraft(page) {
	await page.fill(INPUT, "");
	await page.waitFor(`!document.querySelector(".translate-bar")`, {
		timeout: 10000,
		label: "strip closed",
	});
}

export default async function run(page) {
	await page.addInitScript(TRANSLATION_ON);
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.click('#connect button[type="submit"]');
	await page.waitFor(`!!document.querySelector(${JSON.stringify(INPUT)})`, {
		timeout: 20000,
		label: "the channel view",
	});
	await page.waitFor(TRANSLATION_OFFERED, {timeout: 20000, label: "translation offered"});

	await setWriteTarget(page, "es");
	page.check("the button reads ES", (await page.evaluate(BUTTON_TARGET)) === "ES");

	// Watch the strip from before the draft: "Translating…" may be up for
	// only a moment on the fake.
	const translating = EN["translate.strip.translating"];

	await page.evaluate(`(() => {
		window.__sawTranslating = false;
		new MutationObserver(() => {
			const note = document.querySelector("#form .translate-bar-download");
			if (note && note.textContent.includes(${JSON.stringify(translating)})) {
				window.__sawTranslating = true;
			}
		}).observe(document.body, {subtree: true, childList: true, characterData: true});
	})()`);

	page.check(
		"a one-word draft is requested from English, as the button says",
		(await previewFrom(page, "Testing", "the one-word draft's request")) === "en"
	);
	await page.waitFor(`!document.querySelector("#form .translate-bar-caret")`, {
		timeout: 15000,
		label: "the preview done",
	});
	page.check(
		"the strip said Translating… before the first words",
		await page.evaluate(`window.__sawTranslating === true`)
	);
	await page.check(
		"and says it no more once the translation is there",
		!(await page.evaluate(
			`(document.querySelector("#form .translate-bar") || {}).textContent?.includes(${JSON.stringify(
				translating
			)}) ?? false`
		))
	);
	await page.screenshot("composer-source-en");
	await clearDraft(page);

	page.check(
		"a long French draft with no source picked is requested from French",
		(await previewFrom(
			page,
			`Bonjour à tous, je voudrais savoir si quelqu'un a déjà essayé cette configuration ${RUN}`,
			"the French draft's request"
		)) === "fr"
	);
	page.check("and the button says ES", (await page.evaluate(BUTTON_TARGET)) === "ES");
	await clearDraft(page);
	page.check(
		"with the draft gone the button is back on ES",
		(await page.evaluate(BUTTON_TARGET)) === "ES"
	);

	// Already in the target: sent as typed, so no write request at all.
	const writesBefore = await page.evaluate(WRITES);
	const spanish = `Hola a todos, ¿alguien sabe si el servidor vuelve a funcionar esta noche? ${RUN}`;

	await page.fill(INPUT, spanish);
	await new Promise((resolve) => setTimeout(resolve, 3000));
	page.check(
		"a draft already in Spanish asks for no translation",
		(await page.evaluate(WRITES)) === writesBefore
	);
	await clearDraft(page).catch(() => {});

	// A source picked with the target: the channel record's writeFrom.
	await page.evaluate(`(() => {
		const store = document.getElementById("app").__vue_app__.config.globalProperties.$store;
		const active = store.state.activeChannel;
		const key = active.network.uuid + "/" + active.channel.name.toLowerCase();
		const all = JSON.parse(localStorage.getItem("thelounge.translate") || "{}");
		all[key] = {...(all[key] || {}), write: "es", writeFrom: "de"};
		localStorage.setItem("thelounge.translate", JSON.stringify(all));
		store.commit("translateChannelSet", {key, value: {...store.state.translateChannels[key], write: "es", writeFrom: "de"}});
	})()`);
	await page.waitFor(`${BUTTON_TARGET} === "ES"`, {
		timeout: 5000,
		label: "the button reads ES",
	});
	page.check(
		"with German picked, even an English-looking draft is requested from German",
		(await previewFrom(
			page,
			`Could someone please check whether the server restarts tonight ${RUN}`,
			"the German-source draft's request"
		)) === "de"
	);
	page.check("and the button still says ES", (await page.evaluate(BUTTON_TARGET)) === "ES");
	await clearDraft(page);
}
