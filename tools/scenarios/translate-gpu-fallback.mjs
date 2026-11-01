// "The GPU stopped" on the in-page fake engine (?fakeTranslate on a
// non-production build): a translation carrying the fake's `[gpu-lost]`
// token fails on the GPU as a lost device does, the language model's GPU
// copy is marked down, and the confirm dialog asks whether to carry on on
// the CPU (service.ts `askCpuFallback`, index.ts) -- the title, the body
// with the CPU copy's download size, the browser's reason quoted under it in
// a <bdi>, three buttons (the main one filled and focused, in a modal
// dialog labelled by its title). "Use the CPU this time" carries the same
// request on to the CPU (it resolves with the fake's translation, the
// fake's request log shows it ran) and leaves the setting on Auto; after
// the one reload the question comes back, and "Always use the CPU here"
// pins `translateLlmDevice` to `cpu` in the stored settings. No ircd: the
// dev build's `seanceTranslate` console aid drives the service.
//
//   corepack yarn build && python3 -m http.server -d public 8021 &
//   (or any port, with SEANCE_HTTP=http://localhost:<port>/)
//   CHROME_BIN=/seance/tmp/chrome-pw.sh node tools/browser-drive.mjs tools/scenarios/translate-gpu-fallback.mjs
//   … --mobile --width=390 --height=844
//
// NODE_ENV must be unset for the build: a production build compiles the
// fake out.

import {readFileSync} from "node:fs";

const BASE = process.env.SEANCE_HTTP ?? "http://localhost:8021/";
const EN = JSON.parse(readFileSync("client/locales/en.json", "utf8"));
const OPEN = `!!document.querySelector("#confirm-dialog-overlay.opened")`;
const STORED_DEVICE = `JSON.parse(localStorage.getItem("settings") ?? "{}").translateLlmDevice ?? null`;
const REQUESTS = `((window.__seanceTranslateFake && window.__seanceTranslateFake.requests) || [])`;

export const url = `${BASE}?fakeTranslate`;

const SMALL = "Qwen3-1.7B-q4f16_1-MLC";
// The fake's probe fits the 4B, which has no CPU copy and is never asked
// about: choose the 1.7B, keeping whatever else the settings hold (the
// reload must keep the device the first half did not set).
const CHOOSE_SMALL = `(() => {
	const s = JSON.parse(localStorage.getItem("settings") || "{}");
	s.translateLlmModel = ${JSON.stringify(SMALL)};
	localStorage.setItem("settings", JSON.stringify(s));
})()`;

/** Starts a translation the fake fails on the GPU; its outcome lands in window.__fallback. */
const START = `(() => {
	window.__fallback = null;
	window.seanceTranslate("[gpu-lost] Hallo Welt", "en", "de").then(
		(text) => { window.__fallback = {text}; },
		(e) => { window.__fallback = {error: String(e && e.message || e)}; }
	);
})()`;

const BUTTON = (label) =>
	`[...document.querySelectorAll("#confirm-dialog .confirm-buttons button")].find((b) => b.textContent.trim() === ${JSON.stringify(
		label
	)})`;

async function clickButton(page, label) {
	await page.evaluate(`${BUTTON(label)}.click()`);
}

export default async function run(page) {
	await page.addInitScript(CHOOSE_SMALL);
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(START);
	await page.waitFor(OPEN, {timeout: 20000, label: "the GPU fallback question"});

	const dialog = await page.evaluate(`(() => {
		const d = document.getElementById("confirm-dialog");
		return {
			title: d.querySelector(".confirm-text-title").textContent.trim(),
			text: d.querySelector(".confirm-text p").textContent.trim(),
			quote: d.querySelector(".confirm-quote")?.textContent.trim() ?? null,
			bdi: d.querySelector(".confirm-quote bdi")?.textContent ?? null,
			buttons: [...d.querySelectorAll(".confirm-buttons button")].map((b) => b.textContent.trim()),
			role: d.getAttribute("role"),
			modal: d.getAttribute("aria-modal"),
			labelled: document.getElementById(d.getAttribute("aria-labelledby"))?.textContent.trim() ?? null,
		};
	})()`);

	page.check(`titled "${dialog.title}"`, dialog.title === EN["translate.gpuFallback.title"]);
	page.check(
		`the body names the model and a download (${dialog.text})`,
		dialog.text.startsWith("Qwen3") && /\d/.test(dialog.text) && !dialog.text.includes("{")
	);
	page.check(
		`the browser's reason, verbatim in a <bdi> (${dialog.quote})`,
		dialog.bdi === "Device was lost: the fake GPU stopped" &&
			dialog.quote === EN["translate.gpuFallback.reason"].replace("{reason}", dialog.bdi)
	);
	page.check(
		`three buttons (${dialog.buttons.join(" | ")})`,
		dialog.buttons.length === 3 &&
			dialog.buttons.includes(EN["translate.gpuFallback.once"]) &&
			dialog.buttons.includes(EN["translate.gpuFallback.always"]) &&
			dialog.buttons.includes(EN["translate.consent.notNow"])
	);
	page.check(
		`a modal dialog labelled by its title (${dialog.role}, ${dialog.modal}, ${dialog.labelled})`,
		dialog.role === "dialog" && dialog.modal === "true" && dialog.labelled === dialog.title
	);

	// The overlay fades in; the main answer takes the focus once it has.
	await page.sleep(600);

	const focused = await page.evaluate(`document.activeElement?.textContent.trim() ?? null`);

	page.check(
		`the main answer has the focus (${focused})`,
		focused === EN["translate.gpuFallback.once"]
	);

	// Away from the focus (whose fill every button shares), the main answer
	// is filled and "Always" is outlined.
	await page.evaluate(`document.activeElement.blur()`);
	// The buttons' colour transition (0.2 s).
	await page.sleep(400);

	const fills = await page.evaluate(`(() => {
		const bg = (b) => getComputedStyle(b).backgroundColor;
		const [main, always] = document.querySelectorAll("#confirm-dialog .confirm-buttons button");
		return {main: bg(main), always: bg(always)};
	})()`);

	page.check(
		`the main answer stands out (${fills.main} vs ${fills.always})`,
		fills.main !== fills.always && !/rgba\(0, 0, 0, 0\)|transparent/.test(fills.main)
	);
	await page.screenshot("gpu-fallback-dialog");

	await clickButton(page, EN["translate.gpuFallback.once"]);
	await page.waitFor(`!!window.__fallback`, {timeout: 20000, label: "the translation"});

	const once = await page.evaluate(`({
		result: window.__fallback,
		stored: ${STORED_DEVICE},
		open: ${OPEN},
		models: ${REQUESTS}.map((r) => r.model),
	})`);

	page.check(
		`this time: the same request arrives (${JSON.stringify(once.result)})`,
		typeof once.result.text === "string" && once.result.text.includes("Hallo Welt")
	);
	page.check(
		`this time: the language model ran twice, the GPU then the CPU, and nothing else (${once.models.join(
			", "
		)})`,
		once.models.length === 2 && once.models.every((m) => m === SMALL)
	);
	page.check(`this time: the setting stays on Auto (${once.stored})`, once.stored !== "cpu");
	page.check(`no second question`, once.open === false);

	// The one reload: a new session asks again.
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(START);
	await page.waitFor(OPEN, {timeout: 20000, label: "the question again after a reload"});
	await clickButton(page, EN["translate.gpuFallback.always"]);
	await page.waitFor(`!!window.__fallback`, {timeout: 20000, label: "the translation"});

	const always = await page.evaluate(`({result: window.__fallback, stored: ${STORED_DEVICE}})`);

	page.check(
		`always: the request arrives (${JSON.stringify(always.result)})`,
		typeof always.result.text === "string" && always.result.text.includes("Hallo Welt")
	);
	page.check(`always: translateLlmDevice is cpu (${always.stored})`, always.stored === "cpu");
}
