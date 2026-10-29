// The missing-key tripwire, proven in a real browser: a dev build exposes
// window.seanceI18n, a deliberately bogus key renders as itself while one
// console.warn names it, missingKeys() records the trip, and the unknown-var
// warning fires the same way. This is the runtime safety net for assembled
// call sites the build-time tracker (tools/i18n/check.ts, ALLOWED_DYNAMIC)
// misses — and the proof that a quiet console during normal use means a
// clean tree, not a broken detector:
//
//   NODE_ENV=development corepack yarn i18n:compile && corepack yarn build:client
//   python3 -m http.server -d public 8000 &
//   CHROME_BIN=$PWD/tmp/chrome-headless-wrapper.sh \
//     node tools/browser-drive.mjs tools/scenarios/i18n-warnings.mjs
import {readFileSync} from "node:fs";

export const url = "http://127.0.0.1:8000/";

// The hook exists only when the compile baked DEV=true (a development
// build); the production build never assigns it.
const DEV_BAKED = /export const DEV = true/.test(
	readFileSync(new URL("../../client/js/i18n/available.ts", import.meta.url), "utf8")
);

export default async function run(page) {
	await page.goto(page.url, {waitForSelector: "#connect form"});

	page.check(
		"the dev hook is exposed (window.seanceI18n)",
		(await page.evaluate(`typeof window.seanceI18n`)) === "object"
	);

	// Capture the warnings without silencing them.
	await page.evaluate(
		`window.__warns = [];
		 console.warn = ((orig) => (...a) => { window.__warns.push(a.join(" ")); orig(...a); })(console.warn);`
	);

	// The missing-key case — twice, to prove the once-per-key dedupe. An
	// assembled key warns twice by design (dynamic label + missing key).
	await page.evaluate(
		`window.seanceI18n.t("bogus.demo.key"); window.seanceI18n.t("bogus.demo.key");`
	);
	const warns = await page.evaluate(`window.__warns`);
	page.check(
		"one console.warn fired for the missing key",
		warns.filter((line) => line.includes("missing key")).length === 1
	);
	page.check(
		"the warning names the key and the locale",
		warns
			.find((line) => line.includes("missing key"))
			?.includes('[seance i18n] missing key "bogus.demo.key" (en)') === true
	);
	page.check(
		"the same call also warns as a dynamic label",
		warns.some((line) => line.includes("dynamic label") && line.includes('"bogus.demo.key"'))
	);
	page.check(
		"missingKeys() records the trip, readably",
		JSON.stringify(await page.evaluate(`window.seanceI18n.missingKeys()`)).includes(
			"en · key · bogus.demo.key"
		)
	);

	// Rendering never breaks: the key itself is the visible fallback.
	page.check(
		"rendering falls back to the key itself",
		(await page.evaluate(`window.seanceI18n.t("also.bogus")`)) === "also.bogus"
	);

	// The unknown-{var} case: a FLAT key whose template names a var the
	// call site never passed — the placeholder stays visible and warns
	// once, naming key and var. (A plural key without a count routes
	// through the missing-key warning instead: its catalog entry is an
	// object, not a string.)
	await page.evaluate(`window.seanceI18n.t("lobby.nickOn")`);
	const varWarns = await page.evaluate(`window.__warns`);
	page.check(
		"an unknown {var} warns and names it",
		varWarns.some((line) => line.includes('unknown var {network} in "lobby.nickOn"'))
	);
}
