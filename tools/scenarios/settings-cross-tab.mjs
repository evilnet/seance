// Two copies of the app open at once (two tabs, or the installed app beside
// a browser tab) share one stored settings object. A change made in one is
// not undone by the other, and shows up in the other without a reload
// (client/js/store-settings.ts `update` and `watch`,
// client/js/helpers/settingsSync.ts).
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   node tools/browser-drive.mjs tools/scenarios/settings-cross-tab.mjs
//
// No ircd: Settings opens over the connect form.
//
// The report this guards: the 12/24-hour clock "kept flipping back". Each tab
// used to store its whole in-memory settings on any change, and nothing took
// another tab's writes, so tab A setting 24-hour was undone the next time a
// tab still holding 12-hour changed anything at all.
//
// The driver's page is tab B, a second tab of the same browser (one profile,
// one localStorage) is tab A.
//
//   1. B is stale: an init script keeps the storage event from its listeners
//      while `__deaf` is set, as when an event has not landed yet. A sets
//      24-hour, B changes "show seconds"; storage keeps both, and B reloads
//      into both. This is the write half: B writes only what it changed.
//   2. B is live: A sets the clock back and picks another theme; B's switch
//      and its theme stylesheet follow without a reload, and B writes
//      nothing back.
//   3. A empties the entry (as signing out or a restore without settings
//      does): B goes back to the defaults and writes nothing.

import {openTab} from "./lib/device.mjs";

export const url = "http://localhost:8000/";

const SETTINGS = "#/settings/appearance";
const RAW = `localStorage.getItem("settings")`;
const stored = (name) => `(JSON.parse(${RAW} || "{}")[${JSON.stringify(name)}] ?? null)`;
const input = (name) => `#settings input[name="${name}"]`;
const checked = (name) => `(document.querySelector('${input(name)}')?.checked ?? null)`;
const THEME_HREF = `document.getElementById("theme")?.getAttribute("href")`;

const DEAF = `window.addEventListener("storage", (e) => {
	if (window.__deaf) e.stopImmediatePropagation();
}, true);`;

async function openSettings(tab) {
	await tab.evaluate(`(() => { location.hash = ${JSON.stringify(SETTINGS)}; })()`);
	await tab.waitFor(`!!document.querySelector('${input("use12hClock")}')`, {
		label: "Settings → Appearance open",
	});
}

/** F5 on the page it is on (browser-testing.md rule 8): wait for a new
 * document, tolerating the evaluate that lands mid-swap. */
async function reload(page) {
	await page.evaluate(`window.__before = true`);
	await page.send("Page.reload");

	for (let i = 0; i < 200; i++) {
		try {
			if (
				await page.evaluate(
					`!window.__before && !!document.querySelector('${input("use12hClock")}')`
				)
			) {
				return;
			}
		} catch {
			// the document is being replaced
		}

		await page.sleep(150);
	}

	throw new Error("the reload never brought Settings back");
}

/** Pick a theme in a tab's select (a native dropdown takes no clicks). */
const pickTheme = (tab, value) =>
	tab.evaluate(`(() => {
		const el = document.querySelector("#theme-select");
		el.value = ${JSON.stringify(value)};
		el.dispatchEvent(new Event("change", {bubbles: true}));
	})()`);

export default async function run(page) {
	await page.addInitScript(DEAF);
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await openSettings(page);

	const a = await openTab(page, {name: "tab-a"});

	try {
		await a.goto(page.url, {waitForSelector: "#connect form"});
		await openSettings(a);

		// The browser's locale decides the default clock; whichever it is,
		// A turns it the other way.
		const initial = await page.evaluate(checked("use12hClock"));
		const flipped = !initial;
		const defaultTheme = await page.evaluate(`document.querySelector("#theme-select").value`);
		const defaultHref = await page.evaluate(THEME_HREF);

		page.check(
			"both tabs start on the same clock",
			(await a.evaluate(checked("use12hClock"))) === initial
		);
		page.check("nothing stored yet", (await page.evaluate(RAW)) === null);

		// --- 1. A stale tab's write does not undo the other's ------------
		await page.evaluate(`window.__deaf = true`);
		await a.click(input("use12hClock"));
		await a.waitFor(`${stored("use12hClock")} === ${flipped}`, {label: "A stored the clock"});
		await page.sleep(500);
		page.check(
			"B has not seen A's clock (stale, as set up)",
			(await page.evaluate(checked("use12hClock"))) === initial
		);

		await page.click(input("showSeconds"));
		await page.waitFor(`${stored("showSeconds")} === true`, {label: "B stored show seconds"});
		page.check(
			"after B's write, the clock A set is still stored",
			(await page.evaluate(stored("use12hClock"))) === flipped
		);
		await page.screenshot("1-stale-b-wrote");

		await reload(page);
		page.check(
			"B reloads into A's clock",
			(await page.evaluate(checked("use12hClock"))) === flipped
		);
		page.check(
			"B reloads into its own show seconds",
			(await page.evaluate(checked("showSeconds"))) === true
		);
		await page.screenshot("1-b-reloaded");

		// --- 2. A live tab follows the other's changes --------------------
		// B is a fresh document now: no __deaf.
		page.check(
			"A took B's show seconds without a reload",
			await a
				.waitFor(`${checked("showSeconds")} === true`, {timeout: 5000})
				.catch(() => false)
		);
		await a.click(input("use12hClock"));
		await a.waitFor(`${stored("use12hClock")} === ${initial}`, {label: "A stored the clock"});

		const otherTheme = await a.evaluate(`[...document.querySelectorAll("#theme-select option")]
			.map((o) => o.value)
			.find((v) => v !== ${JSON.stringify(defaultTheme)} && v !== "ps")`);

		await pickTheme(a, otherTheme);
		await a.waitFor(`${stored("theme")} === ${JSON.stringify(otherTheme)}`, {
			label: "A stored the theme",
		});

		const written = await a.evaluate(RAW);
		const followed = await page
			.waitFor(
				`${checked("use12hClock")} === ${initial} &&
				document.querySelector("#theme-select").value === ${JSON.stringify(otherTheme)}`,
				{timeout: 5000, label: "B follows A"}
			)
			.catch(() => false);

		page.check("B shows A's clock without a reload", followed);
		page.check(
			`B applies A's theme (${otherTheme}): its stylesheet is A's`,
			(await page.evaluate(THEME_HREF)) === (await a.evaluate(THEME_HREF)) &&
				(await page.evaluate(THEME_HREF)) !== defaultHref
		);
		await page.sleep(500);
		page.check("B wrote nothing back", (await page.evaluate(RAW)) === written);
		await page.screenshot("2-b-followed");

		// --- 3. Emptied storage reads as the defaults ---------------------
		await a.evaluate(`localStorage.removeItem("settings")`);

		const reset = await page
			.waitFor(
				`${checked("showSeconds")} === false &&
				document.querySelector("#theme-select").value === ${JSON.stringify(defaultTheme)}`,
				{timeout: 5000, label: "B back on the defaults"}
			)
			.catch(() => false);

		page.check("B goes back to the defaults when the entry is removed", reset);
		page.check(
			"B's stylesheet is the default theme's again",
			(await page.evaluate(THEME_HREF)) === defaultHref
		);
		await page.sleep(500);
		page.check("B did not store its old settings back", (await page.evaluate(RAW)) === null);
		await page.screenshot("3-b-defaults");

		page.check("no console errors in A", a.consoleErrors.length === 0);
	} finally {
		await a.close();
	}

	page.check("no console errors", page.consoleErrors.length === 0);
}
