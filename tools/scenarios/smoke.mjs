// Smoke: the built app boots on a fresh profile, shows the connect form and
// logs no console error or page exception. CI runs it after the production
// build (.github/workflows/ci.yml); it catches a bundle that throws on load,
// which neither mocha nor the build itself would notice. No IRC connection.
//
//   NODE_ENV=production yarn build && python3 -m http.server -d public 8000 &
//   node tools/browser-drive.mjs tools/scenarios/smoke.mjs --no-ws

const BASE = process.env.SEANCE_HTTP ?? "http://localhost:8000/";

export const url = BASE;

export default async function run(page) {
	await page.goto(page.url, {waitForSelector: "#connect"});
	// Give anything scheduled after first paint (the service worker, lazy
	// chunks) a moment to fail.
	await page.sleep(2000);

	page.check("the connect form is shown", (await page.count("#connect")) === 1);

	const errors = page.consoleErrors.map((e) => `${e.type}: ${e.text}`);
	page.check(
		`no console errors${errors.length ? ` (${errors.join(" | ")})` : ""}`,
		errors.length === 0
	);
}
