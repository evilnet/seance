// The one place a model is named (docs/resources/translation.md § Which
// model goes first), in a real browser on the in-page fake engine
// (?fakeTranslate) and a fabricated network (lib/fake-network.mjs: #seance
// is chan 2). No ircd.
//
//  1. A translated line's "Translation options" ends with a quiet line
//     naming the model that translated it; the keyboard passes over it.
//
//   NODE_ENV=development pnpm build && python3 -m http.server -d public 8021 &
//   SEANCE_HTTP=http://localhost:8021/ CHROME_BIN=… node tools/browser-drive.mjs tools/scenarios/translate-preference.mjs
//   … --mobile --width=390 --height=844

import {fakeNetworkSnippet} from "./lib/fake-network.mjs";
import {TRANSLATION_ON} from "./lib/translation.mjs";

const BASE = process.env.SEANCE_HTTP || "http://localhost:8021/";

export const url = `${BASE}?fakeTranslate`;

const STORE = `document.getElementById("app").__vue_app__.config.globalProperties.$store`;
const KEY = "fake-0000-0000/#seance";
const CHANNEL = 2;

export default async function run(page) {
	await page.addInitScript(TRANSLATION_ON);
	await page.goto(page.url, {waitForSelector: "#connect form"});
	page.check(
		"a development build fabricated the network",
		await page.evaluate(fakeNetworkSnippet())
	);
	// --- 1. The model, at the foot of a translated line's options. --------
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
	await page.screenshot("1-translation-options");

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
