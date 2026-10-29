// The download question on the in-page fake engine (?fakeTranslate on a
// non-production build, with ?askDownloads so the fake asks at all):
// Settings' own Download of the Italian -> English OPUS pair is consent
// already -- no question, and the yes is remembered under
// thelounge.state.translateConsent; with reading switched on, three Italian
// lines (the GPU model is a better class than the pair for Italian,
// routes.default.ts) ask once, "Download <model>?", and Not now sends every
// one of them to the downloaded pair -- the fake's request log shows the
// OPUS model and never the GPU model, and no second question is asked; a
// German line then (the GPU model and the German pair, neither downloaded)
// fails with "Needs <model>, a <size> download: get it in Settings →
// Translation." without a question (the page's connection reports Save-Data,
// and the question says so); its Retry asks again, Download is
// remembered, and the line is translated on the GPU model. Under --mobile
// reading is switched on in the full-screen sheet, and the question has to
// come up over it (ConfirmDialog's overlay outranks the sheet). A real
// browser's dialog, a scripted engine: translate-capability.mjs asks the
// same of the real worker, which has nothing on the device to fall back to.
//
//   corepack yarn build && python3 -m http.server -d public 8021 &
//   (or any port, with SEANCE_HTTP=http://localhost:<port>/)
//   CHROME_BIN=/seance/tmp/chrome-pw.sh node tools/browser-drive.mjs tools/scenarios/translate-consent.mjs
//   … --mobile --width=390 --height=844
//
// Needs the dev ircd's plain-WS port on 127.0.0.1:8067. NODE_ENV must be
// unset for the build: a production build compiles the fake out.

import {readFileSync} from "node:fs";

const RUN = Date.now().toString(36);
const NICK = `cn${RUN}`;
const SPEAKER = `it${RUN}`;
const CHANNEL = "#seance-consent";
const IRCD = process.env.SEANCE_IRC_WS || "ws://127.0.0.1:8067/";
const BASE = process.env.SEANCE_HTTP ?? "http://localhost:8021/";
const EN = JSON.parse(readFileSync("client/locales/en.json", "utf8"));
const MOBILE = process.argv.includes("--mobile");
const GLOBE = "#chat button.translate";
const OPUS_IT = "Xenova/opus-mt-it-en";
const REQUESTS = `((window.__seanceTranslateFake && window.__seanceTranslateFake.requests) || [])`;
const OPEN = `!!document.querySelector("#confirm-dialog-overlay.opened")`;

export const url = `${BASE}?host=127.0.0.1&port=8067&tls=false&nick=${NICK}&join=${encodeURIComponent(
	CHANNEL
)}&fakeTranslate&askDownloads`;

function speaker(nick) {
	const ws = new WebSocket(IRCD, ["text.ircv3.net"]);

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("speaker never joined")), 20000);

		ws.onopen = () => {
			ws.send(`NICK ${nick}`);
			ws.send(`USER ${nick} 0 * :seance consent speaker`);
		};
		ws.onmessage = (ev) => {
			const msg = String(ev.data);

			if (msg.startsWith("PING")) {
				ws.send(msg.replace("PING", "PONG"));
			} else if (/ 001 /.test(msg)) {
				ws.send(`JOIN ${CHANNEL}`);
			} else if (new RegExp(`^(?:@\\S+ )?:${nick}\\S* JOIN`).test(msg)) {
				clearTimeout(timer);
				resolve({
					say: (text) => ws.send(`PRIVMSG ${CHANNEL} :${text}`),
					quit: () => ws.send("QUIT :done"),
				});
			}
		};
		ws.onerror = () => reject(new Error("speaker socket error"));
	});
}

/** The newest row whose text includes `text`, as an expression. */
const rowOf = (text) =>
	`[...document.querySelectorAll("#chat .msg")].filter((m) => m.textContent.includes(${JSON.stringify(
		text
	)})).pop()`;

// A connection in data-saver mode: the question says so.
const SAVE_DATA = `Object.defineProperty(Navigator.prototype, "connection", {configurable: true, get: () => ({saveData: true, type: "wifi"})});`;

export default async function run(page) {
	await page.addInitScript(SAVE_DATA);
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.click('#connect button[type="submit"]');
	await page.waitFor(`!!document.querySelector("#form #input")`, {
		timeout: 20000,
		label: "chat input up",
	});
	await page.waitFor(`!!document.querySelector(${JSON.stringify(GLOBE)})`, {
		timeout: 10000,
		label: "the translate button, once the probe answered",
	});
	// Every question the dialog is opened with, from now on: the overlay
	// stays in the page and takes "opened" while one is up.
	await page.evaluate(`(() => {
		window.__questions = [];
		const overlay = document.getElementById("confirm-dialog-overlay");
		let open = false;
		new MutationObserver(() => {
			const now = overlay.classList.contains("opened");
			if (now && !open) { window.__questions.push(overlay.querySelector(".confirm-text-title").textContent.trim()); }
			open = now;
		}).observe(overlay, {attributes: true, attributeFilter: ["class"], childList: true, subtree: true});
	})()`);

	// 1. Settings' Download is the user's yes: no question.
	await page.evaluate(`location.hash = "#/settings/translation"`);
	await page.waitFor(
		`!!document.querySelector('.translate-model[data-model="${OPUS_IT}"] .translate-copy[data-device="cpu"] .translate-copy-download')`,
		{label: "the Italian pair's CPU copy"}
	);
	await page.evaluate(
		`document.querySelector('.translate-model[data-model="${OPUS_IT}"]').scrollIntoView({block: "center"})`
	);
	await page.sleep(200);
	await page.click(
		`.translate-model[data-model="${OPUS_IT}"] .translate-copy[data-device="cpu"] .translate-copy-download`
	);
	await page.waitFor(
		`document.querySelector('.translate-model[data-model="${OPUS_IT}"] .translate-copy[data-device="cpu"]').dataset.cached === "true"`,
		{label: "the pair downloaded"}
	);

	const settings = await page.evaluate(`({
		questions: window.__questions.length,
		consent: JSON.parse(localStorage.getItem("thelounge.state.translateConsent") || "[]"),
	})`);

	page.check(
		`Settings' Download asks nothing and is remembered (${settings.questions}, ${settings.consent})`,
		settings.questions === 0 && settings.consent.includes(OPUS_IT)
	);
	await page.click(".settings-modal-done");
	await page.waitFor(`!document.querySelector(".settings-modal")`, {label: "settings closed"});

	// 2. Three Italian lines; reading on.
	const other = await speaker(SPEAKER);
	const italian = [
		`Buongiorno a tutti, oggi parliamo del progetto nuovo ${RUN}.`,
		`Secondo me dovremmo finire la documentazione entro venerdì ${RUN}.`,
		`Qualcuno sa dove posso trovare le istruzioni per la configurazione ${RUN}?`,
	];

	for (const line of italian) {
		other.say(line);
	}

	await page.waitFor(
		`${JSON.stringify(
			italian
		)}.every((line) => [...document.querySelectorAll("#chat .msg")].some((m) => m.textContent.includes(line)))`,
		{
			label: "the Italian lines",
			timeout: 20000,
		}
	);

	await page.click(GLOBE);

	if (MOBILE) {
		await page.waitFor(`!!document.querySelector(".translation-panel")`, {
			label: "the tap opened the panel",
		});
		await page.evaluate(
			`(() => { for (const s of document.querySelectorAll('.translation-panel-segmented .translation-panel-segment')) { if (s.textContent.trim() === "On") { s.click(); return; } } throw new Error("no reading segment"); })()`
		);
	}

	await page.waitFor(OPEN, {label: "the download question", timeout: 20000});
	await page.sleep(1500);

	const question = await page.evaluate(`({
		count: window.__questions.length,
		title: document.querySelector("#confirm-dialog .confirm-text-title").textContent.trim(),
		note: (document.querySelector("#confirm-dialog .confirm-note") || {}).textContent?.trim() || "",
	})`);
	const model = /^Download (.+)\?$/.exec(question.title)?.[1] ?? "";

	page.check(
		`one question for the channel's lines, about the language model (${question.count}: ${question.title})`,
		question.count === 1 &&
			["Qwen3 1.7B", "Qwen3 4B"].some(
				(name) => model === EN["translate.model.llm"].replace("{name}", name)
			)
	);
	page.check(
		`the question says the connection saves data (${question.note})`,
		question.note === EN["translate.consent.metered"]
	);
	await page.screenshot("consent-fake-question");
	// Past the overlay's fade-in before the click.
	await page.sleep(500);
	await page.click("#confirm-dialog .btn-cancel");

	// The question came over the sheet the switch was thrown in; put it away.
	if (MOBILE) {
		await page.evaluate(`document.querySelector(".translation-panel-close").click()`);
		await page.waitFor(`!document.querySelector(".translation-panel")`, {
			label: "the sheet put away",
		});
	}

	// Not now: the downloaded pair takes every line.
	await page.waitFor(
		`${JSON.stringify(
			italian
		)}.every((line) => { const m = [...document.querySelectorAll("#chat .msg")].filter((el) => el.textContent.includes(line)).pop(); return m && m.querySelector('.msg-translation[data-status="done"]'); })`,
		{label: "the Italian lines translated", timeout: 20000}
	);

	const fallback = await page.evaluate(`(() => {
		const lines = ${JSON.stringify(italian)};
		const reqs = ${REQUESTS}.filter((r) => lines.some((line) => (r.text || "").includes(${JSON.stringify(
		RUN
	)})));
		return {
			models: [...new Set(reqs.map((r) => r.model))],
			questions: window.__questions.length,
			open: ${OPEN},
		};
	})()`);

	page.check(
		`Not now: every Italian line went to the downloaded pair (${fallback.models.join(", ")})`,
		fallback.models.length === 1 && fallback.models[0] === OPUS_IT
	);
	page.check(
		`Not now: no second question (${fallback.questions})`,
		fallback.questions === 1 && !fallback.open
	);
	await page.screenshot("consent-fake-fallback");

	// 3. A German line: neither the GPU model nor the German pair is here.
	const german = `Ich glaube, wir sollten das morgen gemeinsam besprechen ${RUN}.`;

	other.say(german);
	await page.waitFor(
		`(() => { const m = ${rowOf(
			german
		)}; return m && m.querySelector('.msg-translation[data-status="failed"] .msg-translation-reason'); })()`,
		{label: "the German line failed", timeout: 20000}
	);

	const failed = await page.evaluate(`(() => {
		const m = ${rowOf(german)};
		return {
			reason: m.querySelector(".msg-translation-reason").textContent.trim(),
			questions: window.__questions.length,
		};
	})()`);
	const reason = new RegExp(
		`^${EN["translate.why.needsDownload"]
			.replace(/[.*+?^$()|[\]\\]/g, "\\$&")
			.replace("{model}", ".+")
			.replace("{size}", "[\\d.]+ [KMG]iB")}$`
	);

	page.check(
		`a later line fails naming the download, unasked (${failed.questions}: ${failed.reason})`,
		failed.questions === 1 && reason.test(failed.reason)
	);
	await page.screenshot("consent-fake-needs-download");

	// 4. Its Retry asks again; Download is remembered and the GPU model runs.
	await page.evaluate(`${rowOf(german)}.querySelector(".msg-translation-retry").click()`);
	await page.waitFor(OPEN, {label: "the question after a Retry"});
	// Past the overlay's fade-in before the click.
	await page.sleep(500);
	await page.click("#confirm-dialog .btn-confirm");
	await page.waitFor(
		`(() => { const m = ${rowOf(
			german
		)}; return m && m.querySelector('.msg-translation[data-status="done"]'); })()`,
		{label: "the German line translated", timeout: 20000}
	);

	const yes = await page.evaluate(`(() => ({
		questions: window.__questions.length,
		consent: JSON.parse(localStorage.getItem("thelounge.state.translateConsent") || "[]"),
		model: ${REQUESTS}.filter((r) => (r.text || "").includes(${JSON.stringify(
		german.slice(0, 20)
	)})).map((r) => r.model).pop(),
	}))()`);

	page.check(
		`a Retry asks once more, and Download is remembered (${yes.questions}, ${yes.consent.join(
			", "
		)})`,
		yes.questions === 2 && yes.consent.length === 2 && yes.consent.includes(OPUS_IT)
	);
	page.check(
		`the German line ran on the GPU model (${yes.model})`,
		/^Qwen3-/.test(yes.model || "")
	);

	other.quit();
	page.check(
		`no console errors (${page.consoleErrors.map((e) => e.text).join(" | ")})`,
		page.consoleErrors.length === 0
	);
}
