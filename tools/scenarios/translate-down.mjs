// A model that failed to load earlier in the session, on the in-page fake
// worker (client/js/translate/fakePort.ts `failLoad`, reached with
// ?fakeTranslate on a development build). The language model is switched
// off, so English into Spanish has only OPUS-MT's en-es model (the route
// table gives the pair no other), and every seq2seq load is scripted to
// fail. Steps:
//
// - the first request fails naming the last model that would not load (the
//   reason travels with the error, as it did before);
// - the second request finds every copy down and says so: the model failed
//   to load earlier and a reload tries it again, with the reason, rather
//   than a bare "no translation engine can take this request";
// - adversarial: the fake's cache now says the failed copies are on the
//   device (a real cache does), which used to reset their rows to
//   "Downloaded"; Settings still says "Failed to load … Reload the page";
// - adversarial: a copy that never ran (OPUS-MT German → English) keeps its
//   plain "Not downloaded" line, and NLLB-200 (not this pair's) none of the
//   failure either: the down note is the failed copy's own;
// - a reload clears the session's down set: the row no longer says it
//   failed, and the pair translates again once loads work.
//
//   NODE_ENV=development pnpm build && python3 -m http.server -d public 8021 &
//   node tools/browser-drive.mjs tools/scenarios/translate-down.mjs

import {readFileSync} from "node:fs";
import {TRANSLATION_ON} from "./lib/translation.mjs";

const BASE = process.env.SEANCE_HTTP || "http://localhost:8021/";
const EN = JSON.parse(readFileSync("client/locales/en.json", "utf8"));

export const url = `${BASE}?fakeTranslate`;

const OPUS = "Xenova/opus-mt-en-es";
const UNTRIED = "Xenova/opus-mt-de-en";
const NLLB = "Xenova/nllb-200-distilled-600M";
const FAILURE = "Can't create a session: fake model broke";

const ROW = (id) => `.translate-model[data-model="${id}"]`;
const COPY = (id, device) => `${ROW(id)} .translate-copy[data-device="${device}"]`;
const STATE = (id, device) =>
	`document.querySelector('${COPY(
		id,
		device
	)} .translate-copy-state')?.textContent.trim() ?? null`;

/** The language model off, so the pair has only the seq2seq models. */
const LLM_OFF = `(() => {
	try {
		const settings = JSON.parse(localStorage.getItem("settings") || "{}");
		settings.translateLlm = false;
		localStorage.setItem("settings", JSON.stringify(settings));
	} catch (e) {}
})()`;

const FOOTER_VISIBLE = `(() => {
	const el = document.querySelector("#footer button.settings");
	if (!el) return false;
	const r = el.getBoundingClientRect();
	return r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= window.innerWidth;
})()`;

async function openTranslationSettings(page) {
	if (!(await page.evaluate(FOOTER_VISIBLE))) {
		await page.click(`button.lt`);
		await page.waitFor(FOOTER_VISIBLE, {label: "sidebar open"});
	}

	await page.click(`#footer button.settings`);
	await page.waitFor(`!!document.querySelector(".settings-menu button.translation")`, {
		label: "settings open",
	});
	await page.click(`.settings-menu button.translation`);
	await page.waitFor(`document.querySelectorAll(".translate-copy").length >= 4`, {
		label: "copy lines rendered",
	});
}

/** Runs one translation through the dev console aid; resolves to its error, or "" on success. */
const attempt = (text, to, from) =>
	`seanceTranslate(${JSON.stringify(text)}, ${JSON.stringify(to)}, ${JSON.stringify(
		from
	)}).then(() => "", (e) => String(e?.message ?? e))`;

export default async function run(page) {
	await page.addInitScript(TRANSLATION_ON);
	await page.addInitScript(LLM_OFF);
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.waitFor(`typeof seanceTranslate === "function"`, {label: "console aid"});
	await page.evaluate(
		`(globalThis.__seanceTranslateFake ??= {requests: []}).failLoad = {seq2seq: ${JSON.stringify(
			FAILURE
		)}}`
	);

	const first = await page.evaluate(attempt("Good morning", "es", "en"));

	page.check(
		"the first request names the model that would not load",
		first.startsWith("no translation engine can take this request: ") && first.includes(FAILURE)
	);

	const second = await page.evaluate(attempt("Good evening", "es", "en"));

	page.check(
		"the next request says the model failed earlier, with why",
		second.startsWith("the model for this failed to load earlier: ") && second.includes(FAILURE)
	);

	await openTranslationSettings(page);

	const downCopy = EN["translate.model.down"].replace("{error}", FAILURE);

	await page.waitFor(`${STATE(OPUS, "cpu")} === ${JSON.stringify(downCopy)}`, {
		label: "the failed OPUS-MT copy says it failed and to reload",
	});
	page.check(
		"the failed copy is not shown as plain Downloaded",
		!(await page.evaluate(STATE(OPUS, "cpu"))).startsWith(
			EN["translate.model.copyDownloaded"].split("{size}")[0]
		)
	);

	const nllbStates = await page.evaluate(
		`[...document.querySelectorAll('${ROW(
			NLLB
		)} .translate-copy-state')].map((el) => el.textContent.trim())`
	);

	// English into Spanish is OPUS-MT's alone in the route table: NLLB-200
	// was never tried, so nothing of the failure lands on its rows.
	page.check(
		"NLLB-200, never tried for this pair, carries no failure",
		nllbStates.length > 0 && nllbStates.every((state) => !state.includes(FAILURE))
	);

	const untried = await page.evaluate(STATE(UNTRIED, "cpu"));

	page.check(
		"a copy that never ran keeps its own line",
		untried !== null && !untried.includes(FAILURE)
	);
	await page.evaluate(
		`document.querySelector('${COPY(OPUS, "cpu")}').scrollIntoView({block: "center"})`
	);
	await page.screenshot("translation-down");

	// A reload is what the copy promises: the down set is the session's.
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.waitFor(`typeof seanceTranslate === "function"`, {label: "console aid again"});
	await openTranslationSettings(page);
	await page.waitFor(`${STATE(OPUS, "cpu")} !== null`, {label: "OPUS-MT row"});

	const afterReload = await page.evaluate(STATE(OPUS, "cpu"));

	page.check("after a reload the row no longer says it failed", !afterReload.includes(FAILURE));
	page.check(
		"and the pair translates again",
		(await page.evaluate(attempt("Good night", "es", "en"))) === ""
	);
}
