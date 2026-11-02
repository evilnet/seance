// The 12/24-hour default comes from the browser's locale on first run:
// Appearance's "Use 12-hour timestamps" is already ticked in an en-US browser
// and already clear in a de-DE one, nothing is written to localStorage until
// the reader touches a setting, and a stored value always wins afterwards
// (client/js/helpers/hourCycle.ts, settings.ts, store-settings.ts).
//
// Needs no ircd — Settings is reachable from the connect form. Chromium takes
// its locale from `--lang`, which this driver does not pass, so drive it with
// the environment instead and run it once per locale:
//
//   pnpm build && python3 -m http.server -d public 8031 &
//   LANGUAGE=en-US LANG=en_US.UTF-8 node tools/browser-drive.mjs tools/scenarios/clock-locale.mjs
//   LANGUAGE=de-DE LANG=de_DE.UTF-8 node tools/browser-drive.mjs tools/scenarios/clock-locale.mjs
//
// Each run asserts against the locale the browser reports, so both runs pass
// the same checks from opposite sides — and the run tells you which side it
// took.

const BASE = "http://localhost:8031/";

export const url = `${BASE}#/settings/appearance`;

const CHECKBOX = `input[name="use12hClock"]`;
const CHECKED = `document.querySelector(${JSON.stringify(CHECKBOX)}).checked`;
const LOCALE = `Intl.DateTimeFormat().resolvedOptions().locale`;
const HOUR_CYCLE = `Intl.DateTimeFormat(undefined, {hour: "numeric"}).resolvedOptions().hourCycle`;
const STORED = `localStorage.getItem("settings")`;

export default async function run(page) {
	// A `goto` back to the same hash is a same-document navigation and boots
	// nothing (docs/resources/browser-testing.md, rule 8); reload for real.
	const coldLoad = async () => {
		await page.evaluate(`(() => { window.__coldLoad = true; })()`);
		await page.send("Page.reload");
		const started = Date.now();

		for (;;) {
			try {
				if (
					await page.evaluate(
						`!window.__coldLoad && !!document.querySelector(${JSON.stringify(
							CHECKBOX
						)})`
					)
				) {
					return;
				}
			} catch {
				// the document is being replaced
			}

			if (Date.now() - started > 20000) {
				throw new Error("timed out waiting for the appearance page after a reload");
			}

			await page.sleep(150);
		}
	};

	await page.goto(page.url, {waitForSelector: CHECKBOX});

	const locale = await page.evaluate(LOCALE);
	const hourCycle = await page.evaluate(HOUR_CYCLE);
	const wants12h = hourCycle === "h11" || hourCycle === "h12";
	const checked = await page.evaluate(CHECKED);

	page.check(
		`the browser is ${locale} (${hourCycle}), so the box starts ${
			wants12h ? "ticked" : "clear"
		} — and it is ${checked ? "ticked" : "clear"}`,
		checked === wants12h
	);

	// A default is not a stored setting: nothing has been written yet, so the
	// answer still follows the browser if the reader changes their locale.
	page.check("nothing stored yet", (await page.evaluate(STORED)) === null);

	// Flipping it stores the opposite, and that is what survives a reload.
	await page.click(CHECKBOX);
	await page.waitFor(`${CHECKED} === ${!wants12h}`, {label: "the box flips"});
	page.check(
		"the flip is stored",
		JSON.parse(await page.evaluate(STORED)).use12hClock === !wants12h
	);

	await coldLoad();
	page.check(
		"a stored setting wins over the locale",
		(await page.evaluate(CHECKED)) !== wants12h
	);

	await page.screenshot(`clock-locale-${locale}`);
	page.check("no console errors", page.consoleErrors.length === 0);
}
