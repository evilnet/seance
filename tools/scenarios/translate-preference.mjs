// Power users' two choices and the one place a model is named
// (docs/resources/translation.md § Which model goes first, § The live
// preview and send safety), in a real browser on the in-page fake engine
// (?fakeTranslate) and a fabricated network (lib/fake-network.mjs: #seance
// is chan 2). No ircd. What the composer sends is read off the bus.
//
//  1. Settings → Advanced has "Show your translation": Automatic / As you
//     type / When you press Return, on Automatic; a choice saves.
//  2. When you press Return: typing and pausing translates nothing; the
//     first Return translates and shows the strip, the next one (once it
//     has been seen) sends the translation.
//  3. As you type: a pause in typing translates the draft into the strip,
//     with no Return.
//  4. Adversarial, on Return: the target changed with a draft typed and no
//     Return yet makes no preview.
//  5. A translated line's "Translation options" ends with a quiet line
//     naming the model that translated it; the keyboard passes over it.
//
//   NODE_ENV=development pnpm build && python3 -m http.server -d public 8021 &
//   SEANCE_HTTP=http://localhost:8021/ CHROME_BIN=… node tools/browser-drive.mjs tools/scenarios/translate-preference.mjs
//   … --mobile --width=390 --height=844

import {readFileSync} from "node:fs";
import {fakeNetworkSnippet} from "./lib/fake-network.mjs";
import {TRANSLATION_ON} from "./lib/translation.mjs";

const BASE = process.env.SEANCE_HTTP || "http://localhost:8021/";
const EN = JSON.parse(readFileSync("client/locales/en.json", "utf8"));

export const url = `${BASE}?fakeTranslate`;

const STORE = `document.getElementById("app").__vue_app__.config.globalProperties.$store`;
const KEY = "fake-0000-0000/#seance";
const CHANNEL = 2;
const STRIP = `(${STORE}.state.outgoingTranslations[${CHANNEL}]?.status ?? null)`;
const SENT = `JSON.parse(JSON.stringify(window.__sent))`;
const PREVIEW = "#settings .translate-preview";

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

async function setting(page, name, value) {
	await page.evaluate(
		`${STORE}.dispatch("settings/update", {name: ${JSON.stringify(
			name
		)}, value: ${JSON.stringify(value)}, sync: true})`
	);
}

async function writeIn(page, to) {
	await page.evaluate(`(() => {
		const all = JSON.parse(localStorage.getItem("thelounge.translate") || "{}");
		const base = {exclude: false, write: null, writeFrom: null, formality: "auto", terms: [], once: null, noSuggest: false};
		all[${JSON.stringify(KEY)}] = {...base, ...(all[${JSON.stringify(
		KEY
	)}] || {}), write: ${JSON.stringify(to)}, writeFrom: "en"};
		localStorage.setItem("thelounge.translate", JSON.stringify(all));
		${STORE}.commit("translateChannelSet", {key: ${JSON.stringify(KEY)}, value: all[${JSON.stringify(
		KEY
	)}]});
	})()`);
}

async function clearDraft(page) {
	await page.evaluate(`${STORE}.commit("outgoingTranslationRemove", ${CHANNEL})`).catch(() => {});
	await typeDraft(page, "");
	await page.sleep(300);
}

export default async function run(page) {
	await page.addInitScript(TRANSLATION_ON);
	await page.goto(page.url, {waitForSelector: "#connect form"});
	page.check(
		"a development build fabricated the network",
		await page.evaluate(fakeNetworkSnippet())
	);
	await page.evaluate(`(() => {
		window.__sent = [];
		const emit = window.socket.emit.bind(window.socket);
		window.socket.emit = (name, payload) => {
			if (name === "input") { window.__sent.push(payload); }
			return emit(name, payload);
		};
	})()`);

	// --- 1. Settings. -------------------------------------------------------
	await page.evaluate(`location.hash = "#/settings/translation"`);
	await page.waitFor(`!!document.querySelector("${PREVIEW}")`, {label: "Show your translation"});

	const choice = await page.evaluate(`({
		heading: document.querySelector("${PREVIEW} h3")?.textContent.trim(),
		labels: [...document.querySelectorAll("${PREVIEW} label.opt")].map((l) => l.textContent.trim()),
		checked: document.querySelector("${PREVIEW} input:checked")?.value,
	})`);

	console.log("preview choice", JSON.stringify(choice));
	page.check(
		`Advanced has "${choice.heading}", on Automatic`,
		choice.heading === EN["translate.preview.label"] &&
			choice.labels.join("|") ===
				[
					EN["translate.preview.auto"],
					EN["translate.preview.typing"],
					EN["translate.preview.enter"],
				].join("|") &&
			choice.checked === "auto"
	);
	await page.evaluate(
		`document.querySelector('${PREVIEW} input[value="enter"]').scrollIntoView({block: "center"})`
	);
	await page.screenshot("1-show-your-translation");
	await page.click(`${PREVIEW} input[value="enter"]`);
	await page.waitFor(`${STORE}.state.settings.translatePreview === "enter"`, {
		label: "When you press Return saved",
	});
	page.check("a choice saves", true);
	await page.click(".settings-modal-done");
	await page.waitFor(
		`!document.querySelector(".settings-modal") && !!document.querySelector("#chat")`,
		{
			label: "Settings closed",
		}
	);

	// --- 2. When you press Return. -----------------------------------------
	await writeIn(page, "de");
	await typeDraft(page, "see you all tomorrow at the station");
	await page.sleep(1800);
	page.check(
		"on Return: a pause in typing translates nothing",
		(await page.evaluate(STRIP)) === null
	);
	await pressEnter(page);
	await page.waitFor(`${STRIP} === "done"`, {
		label: "the first Return translates",
		timeout: 15000,
	});
	page.check(
		"the first Return translates and sends nothing",
		(await page.evaluate(`${SENT}.length`)) === 0
	);
	await page.screenshot("2-on-return-strip");
	await page.sleep(700);
	await pressEnter(page);
	await page.waitFor(`${SENT}.length === 1`, {label: "the second Return sends"});

	const sent = (await page.evaluate(SENT))[0];

	page.check(
		`the second Return sends the translation (${sent.text})`,
		sent.text !== "see you all tomorrow at the station"
	);

	// --- 4. Adversarial: a target change on Return makes no preview. -------
	await typeDraft(page, "the station is closed on sundays though");
	await page.sleep(300);
	await writeIn(page, "fr");
	await page.sleep(1800);
	page.check(
		"on Return: changing the target with a draft typed previews nothing",
		(await page.evaluate(STRIP)) === null
	);
	await clearDraft(page);

	// --- 3. As you type. ----------------------------------------------------
	await setting(page, "translatePreview", "typing");
	await writeIn(page, "de");
	await typeDraft(page, "the train leaves at nine in the morning");
	await page.waitFor(`${STRIP} === "done"`, {
		label: "a pause in typing translates",
		timeout: 15000,
	});
	page.check(
		"as you type: a pause translates the draft, no Return, nothing sent",
		(await page.evaluate(`${SENT}.length`)) === 1
	);
	await clearDraft(page);
	await writeIn(page, null);
	await setting(page, "translatePreview", "auto");

	// --- 5. The model, at the foot of a translated line's options. --------
	const id = 977;

	await page.evaluate(`window.socket.dispatch("msg", {
		chan: ${CHANNEL},
		msg: {id: ${id}, type: "message", from: {mode: "", modes: [], away: "", lastMessage: Date.now(), nick: "moria"}, text: "Guten Morgen zusammen, wie geht es euch heute?", self: false, time: new Date(), users: [], msgid: "seance-pref-${id}"},
	})`);
	await page.waitFor(`${STORE}.state.translations[${id}]?.status === "done"`, {
		label: "the German line read",
		timeout: 15000,
	});

	const model = await page.evaluate(`${STORE}.state.translations[${id}]?.model ?? null`);

	page.check(
		`the line knows its model (${model})`,
		typeof model === "string" && model.length > 0
	);
	await page.evaluate(
		`document.querySelector("#msg-${id}").scrollIntoView({block: "center"}); document.querySelector("#msg-${id} .msg-action-translate").click()`
	);
	await page.waitFor(`!!document.querySelector("#context-menu .context-menu-translate-by")`, {
		label: "Translation options with its model",
	});

	const menu = await page.evaluate(`(() => {
		const items = [...document.querySelectorAll("#context-menu li")];
		const note = document.querySelector("#context-menu .context-menu-translate-by");
		return {
			note: note?.textContent.trim(),
			last: items[items.length - 1] === note,
			role: note?.getAttribute("role"),
		};
	})()`);

	console.log("menu", JSON.stringify(menu));
	page.check(
		`the menu ends with the model, quietly (${menu.note})`,
		menu.last &&
			menu.role === "none" &&
			/^Translated on this device by .+/.test(menu.note ?? "")
	);
	await page.screenshot("3-translation-options");

	// The keyboard never lands on it: walking up from the top wraps to the
	// last item that can be chosen.
	await page.evaluate(
		`document.querySelector("#context-menu").dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowUp", bubbles: true}))`
	);
	await page.sleep(100);
	page.check(
		"the keyboard passes over it",
		!(await page.evaluate(
			`document.querySelector("#context-menu .context-menu-translate-by")?.classList.contains("active")`
		))
	);

	page.check(
		`no console errors (${page.consoleErrors.map((e) => e.text).join(" | ")})`,
		page.consoleErrors.length === 0
	);
}
