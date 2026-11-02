// The settings window as a modal (Windows/Settings.vue): its own pane over
// a dimmed backdrop, a horizontal tab strip across the top that drops
// inactive tabs to icons when the pane is narrow, settings scrolling in
// their own section, and an always-visible footer with a Done button.
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   node tools/browser-drive.mjs tools/scenarios/settings-modal.mjs
//   node tools/browser-drive.mjs tools/scenarios/settings-modal.mjs --width=390 --height=844
//
// The checks adapt to the window: on a wide window the modal floats with a
// backdrop and every tab shows its label; on a narrow one the modal is the
// whole screen and only the active tab keeps its label. No IRC connection
// is needed — the settings window renders without one.

const BASE = process.env.SEANCE_HTTP ?? "http://localhost:8000/";

export const url = `${BASE}#/settings/appearance`;

const MODAL = ".settings-modal";
const MENU = ".settings-menu";

const PROBE = `(() => {
	const modal = document.querySelector("${MODAL}");
	const body = document.querySelector("${MODAL} .settings-modal-body");
	const footer = document.querySelector("${MODAL} .settings-modal-footer");
	const tabs = Array.from(document.querySelectorAll("${MENU} button"));
	const labelShown = (b) => {
		const label = b.querySelector(".tab-label");
		return !!label && getComputedStyle(label).display !== "none";
	};
	return {
		modal: modal.getBoundingClientRect().toJSON(),
		window: {w: innerWidth, h: innerHeight},
		rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
		tabTops: tabs.map((b) => Math.round(b.getBoundingClientRect().top)),
		activeLabelled: tabs.filter((b) => b.classList.contains("active")).every(labelShown),
		inactiveLabels: tabs.filter((b) => !b.classList.contains("active")).map(labelShown),
		footerBottom: footer.getBoundingClientRect().bottom,
		bodyScrollable: body.scrollHeight > body.clientHeight + 1,
	};
})()`;

export default async function run(page) {
	await page.goto(page.url, {waitForSelector: MODAL});
	await page.waitFor(`!!document.querySelector("${MENU} button.active")`, {
		label: "an active tab",
	});

	const p = await page.evaluate(PROBE);
	const narrow = p.modal.width < 42 * p.rem;

	await page.check(
		"the tabs sit on one row",
		p.tabTops.length > 1 && Math.max(...p.tabTops) - Math.min(...p.tabTops) < 2
	);
	await page.check("the active tab always shows its label", p.activeLabelled);
	await page.check(
		narrow
			? "narrow pane: inactive tabs are icons only"
			: "wide pane: every tab shows its label",
		narrow ? p.inactiveLabels.every((shown) => !shown) : p.inactiveLabels.every(Boolean)
	);
	await page.check(
		narrow
			? "narrow window: the modal is the whole screen"
			: "wide window: the modal floats over a backdrop",
		narrow
			? p.modal.width >= p.window.w - 1 && p.modal.height >= p.window.h - 1
			: p.modal.width < p.window.w && p.modal.height < p.window.h
	);
	await page.check(
		`the footer is on screen (bottom ${Math.round(p.footerBottom)} of ${p.window.h})`,
		p.footerBottom <= p.window.h + 1
	);
	await page.screenshot("1-modal");

	// The settings scroll inside their own section; the footer holds still.
	await page.check("the appearance page overflows into its own scroller", p.bodyScrollable);
	await page.evaluate(`document.querySelector("${MODAL} .settings-modal-body").scrollTo(0, 500)`);
	await page.sleep(150);
	const after = await page.evaluate(PROBE);
	await page.check(
		"scrolling the body moves neither tabs nor footer",
		Math.abs(after.footerBottom - p.footerBottom) < 2 && after.tabTops[0] === p.tabTops[0]
	);
	await page.screenshot("2-scrolled");

	// Tabs switch inside the modal.
	await page.click(`${MENU} .notifications`);
	await page.waitFor(
		`document.querySelector("${MENU} button.active")?.classList.contains("notifications")`,
		{label: "notifications tab active"}
	);
	await page.screenshot("3-other-tab");

	// Done leaves the settings route (no networks: back to the connect form).
	await page.click(`${MODAL} .settings-modal-done`);
	await page.waitFor(`!document.querySelector("${MODAL}")`, {label: "the modal gone"});
	await page.check(
		"Done leaves for the connect form",
		(await page.evaluate(`location.hash`)).includes("connect")
	);
	await page.screenshot("4-closed");

	await page.check("no console errors", page.consoleErrors.length === 0);
}
