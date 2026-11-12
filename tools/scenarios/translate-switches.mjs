// The engine switches reach the translator however it was first made
// (docs/resources/translation.md § Engines), in a real browser on the
// in-page fake engine (?fakeTranslate) and a fabricated network
// (lib/fake-network.mjs: #seance on screen, chan 2): no ircd.
//
// The service is made by whatever asks first, which on a cold load is the
// chat view's own computed. Opening Settings unmounts the chat view; the
// switches changed there must still reach the service when it closes.
//
//  1. A German line is read on OPUS-MT (the language model switched off).
//  2. Settings opens (the chat view unmounts), every engine is switched
//     off there, and Settings closes.
//  3. A new German line is not translated: it fails with no engine, and
//     its toolbar offers Translate.
//
//   NODE_ENV=development pnpm build && python3 -m http.server -d public 8021 &
//   SEANCE_HTTP=http://localhost:8021/ CHROME_BIN=… node tools/browser-drive.mjs tools/scenarios/translate-switches.mjs

import {fakeNetworkSnippet} from "./lib/fake-network.mjs";
import {TRANSLATION_ON} from "./lib/translation.mjs";

const BASE = process.env.SEANCE_HTTP || "http://localhost:8021/";

export const url = `${BASE}?fakeTranslate`;

const STORE = `document.getElementById("app").__vue_app__.config.globalProperties.$store`;
const entry = (id) => `JSON.parse(JSON.stringify(${STORE}.state.translations[${id}] ?? null))`;

let nextId = 800;

async function say(page, text) {
	const id = nextId++;

	await page.evaluate(`window.socket.dispatch("msg", {
		chan: 2,
		msg: {id: ${id}, type: "message", from: {mode: "", modes: [], away: "", lastMessage: Date.now(), nick: "moria"}, text: ${JSON.stringify(
		text
	)}, self: false, time: new Date(), users: [], msgid: "seance-switch-${id}"},
	})`);

	return id;
}

export default async function run(page) {
	await page.addInitScript(TRANSLATION_ON);
	await page.goto(page.url, {waitForSelector: "#connect form"});
	page.check(
		"a development build fabricated the network",
		await page.evaluate(fakeNetworkSnippet())
	);
	await page.waitFor(`document.querySelectorAll("#chat .msg").length >= 3`, {
		label: "the fabricated channel's messages",
	});
	await page.evaluate(
		`${STORE}.dispatch("settings/update", {name: "translateLlm", value: false, sync: true})`
	);

	// --- 1. Read on OPUS-MT. ---------------------------------------------
	const first = await say(
		page,
		"Heute ist das Wetter wirklich schön, und wir gehen am Nachmittag im Park spazieren."
	);

	await page.waitFor(`${STORE}.state.translations[${first}]?.status === "done"`, {
		label: "the first line is read",
		timeout: 15000,
	});
	page.check(
		"the first line is read on OPUS-MT",
		(await page.evaluate(entry(first))).engine === "seq2seq"
	);

	// --- 2. Every engine off, in Settings. -------------------------------
	await page.evaluate(`location.hash = "#/settings/translation"`);
	await page.waitFor(`!!document.querySelector('input[name="translateCpu"]')`, {
		label: "Settings → Translation",
	});
	page.check(
		"the chat view is unmounted under Settings",
		!(await page.evaluate(`!!document.querySelector("#chat")`))
	);

	for (const name of ["translateCpu", "translateNllb", "translateSystem"]) {
		await page.evaluate(
			`${STORE}.dispatch("settings/update", {name: "${name}", value: false, sync: true})`
		);
	}

	await page.click(".settings-modal-done");
	await page.waitFor(
		`!document.querySelector(".settings-modal") && !!document.querySelector("#chat")`,
		{
			label: "Settings closed, the chat back",
		}
	);

	// --- 3. A new line finds no engine. ----------------------------------
	const second = await say(
		page,
		"Ich finde, wir sollten das morgen im Büro noch einmal gründlich besprechen, bitte."
	);

	await page.waitFor(
		`["failed", "done"].includes(${STORE}.state.translations[${second}]?.status)`,
		{label: "the second line settles", timeout: 15000}
	);

	const after = await page.evaluate(entry(second));

	console.log("second line", JSON.stringify(after));
	page.check(
		"every engine off: the new line is not translated (no engine takes it)",
		after.status === "failed" && !after.text
	);
	page.check(
		"its toolbar offers Translate",
		await page.evaluate(`!!document.querySelector("#msg-${second} .msg-action-translate")`)
	);
}
