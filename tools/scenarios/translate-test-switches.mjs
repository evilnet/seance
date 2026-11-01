// The GPU test switches given on the URL (translate/testSwitches.ts, boot.ts
// `applyTestSwitches`): `?gpuPrefillChunk=32` stores
// thelounge.state.gpuPrefillChunk, leaves the address bar with the hash
// only (other parameters kept is test/translate/prefillChunk.ts's; here a
// leftover `nick` would open the connect form), and Settings → Translation says the prompts go to the GPU 32
// tokens at a time; `?gpuPrefillChunk=0` removes it again and the line goes.
// No ircd and no GPU: the device probe runs on whatever this browser has,
// and the line reads only the switch.
//
//   corepack yarn build && python3 -m http.server -d public 8021 &
//   (or any port, with SEANCE_HTTP=http://localhost:<port>/)
//   CHROME_BIN=/seance/tmp/chrome-pw.sh node tools/browser-drive.mjs tools/scenarios/translate-test-switches.mjs

import {readFileSync} from "node:fs";

const BASE = process.env.SEANCE_HTTP ?? "http://localhost:8021/";
const EN = JSON.parse(readFileSync("client/locales/en.json", "utf8"));
const KEY = "thelounge.state.gpuPrefillChunk";
const LINE = `document.querySelector(".translate-device-test-chunk")?.textContent.trim() ?? null`;

export const url = `${BASE}?gpuPrefillChunk=32#/settings/translation`;

export default async function run(page) {
	await page.goto(page.url, {waitForSelector: "#app"});
	await page.waitFor(`!!document.querySelector(".translate-device")`, {
		timeout: 20000,
		label: "Settings → Translation's device lines",
	});

	const after = await page.evaluate(`({
		stored: localStorage.getItem(${JSON.stringify(KEY)}),
		search: location.search,
		hash: location.hash,
		line: ${LINE},
	})`);
	const plural = EN["translate.capability.prefillChunk"];
	const expected = (typeof plural === "string" ? plural : plural.other)
		.replace("{count}", "32")
		.replace("{key}", KEY);

	page.check(`?gpuPrefillChunk=32 is stored (${after.stored})`, after.stored === "32");
	page.check(
		`the switch leaves the address bar, the hash stays (${after.search}${after.hash})`,
		after.search === "" && after.hash === "#/settings/translation"
	);
	page.check(`Settings says so (${after.line})`, after.line === expected);
	await page.screenshot("prefill-chunk-line");

	await page.goto(`${BASE}?gpuPrefillChunk=0#/settings/translation`, {
		waitForSelector: "#app",
	});
	await page.waitFor(`!!document.querySelector(".translate-device")`, {
		timeout: 20000,
		label: "the device lines again",
	});

	const cleared = await page.evaluate(`({
		stored: localStorage.getItem(${JSON.stringify(KEY)}),
		search: location.search,
		line: ${LINE},
	})`);

	page.check(
		`?gpuPrefillChunk=0 removes it, and the line goes (${JSON.stringify(cleared)})`,
		cleared.stored === null && cleared.search === "" && cleared.line === null
	);
}
