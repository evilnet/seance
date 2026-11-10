// A GPU lost under a translation before (service.ts `ServiceDeps.gpuMemory`,
// remembered in localStorage by translate/index.ts): Settings → Translation
// lists "GPU lost while translating, so it is not used" among the device's
// reasons, with a "Try the GPU again" button beside it, and the button puts
// the probe's own answer back. The fake engine (?fakeTranslate) keeps no
// memory of its own, so the scenario lays the reason over the store's
// capability itself, as the service does after a reload.
//
//   NODE_ENV=development pnpm build && python3 -m http.server -d public 8021 &
//   CHROME_BIN=… node tools/browser-drive.mjs tools/scenarios/translate-gpu-lost.mjs [--mobile]

import {readFileSync} from "node:fs";
import {TRANSLATION_ON} from "./lib/translation.mjs";

const BASE = process.env.SEANCE_HTTP ?? "http://localhost:8021/";
const EN = JSON.parse(readFileSync("client/locales/en.json", "utf8"));
const STORE = `document.querySelector("#app").__vue_app__.config.globalProperties.$store`;
const REASONS = `[...document.querySelectorAll("#settings .translate-device-reasons li")].map((li) => li.textContent.trim().replace(/\\s+/g, " "))`;

export const url = `${BASE}?fakeTranslate`;

export default async function (page) {
	await page.addInitScript(TRANSLATION_ON);
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(`location.hash = "#/settings/translation"`);
	await page.waitFor(`!!${STORE}.state.translation.capability`, {label: "the probe"});
	await page.waitFor(`!!document.querySelector("#settings .translate-device")`, {
		label: "the device line",
	});

	const before = await page.evaluate(`${STORE}.state.translation.capability.reasons.slice()`);

	await page.evaluate(`(() => {
		const store = ${STORE};
		const cap = store.state.translation.capability;
		store.commit("translationCapability", {...cap, tier: "cpu", reasons: [...cap.reasons, "GPU_LOST"]});
	})()`);
	await page.waitFor(`!!document.querySelector("#settings .translate-retry-gpu")`, {
		label: "the Try the GPU again button",
	});

	const reasons = await page.evaluate(REASONS);

	console.log("reasons", JSON.stringify(reasons));
	page.check(
		"the reason is listed in its own words",
		reasons.some((text) => text.startsWith(EN["translate.capability.reason.gpuLost"]))
	);
	page.check(
		"with the button beside it",
		(await page.evaluate(
			`document.querySelector("#settings .translate-retry-gpu").textContent.trim()`
		)) === EN["translate.capability.retryGpu"]
	);
	await page.evaluate(
		`document.querySelector("#settings .translate-device").scrollIntoView({block: "center"})`
	);
	await page.screenshot("gpu-lost-settings", {selector: "#settings .translate-device"});
	await page.click("#settings .translate-retry-gpu");
	await page.waitFor(`!document.querySelector("#settings .translate-retry-gpu")`, {
		label: "the button gone",
	});
	page.check(
		"the probe's own answer is back",
		JSON.stringify(
			await page.evaluate(`${STORE}.state.translation.capability.reasons.slice()`)
		) === JSON.stringify(before)
	);
}
