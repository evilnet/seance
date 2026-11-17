// The settings window as a modal (Windows/Settings.vue): its own pane over
// a dimmed backdrop, a tab strip across the top that drops every tab to its
// icon when the pane is narrow (the title then names the open tab) and
// wraps rather than hide a tab past the edge, settings scrolling in their
// own section, and an always-visible footer with a Done button.
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   node tools/browser-drive.mjs tools/scenarios/settings-modal.mjs
//   node tools/browser-drive.mjs tools/scenarios/settings-modal.mjs --width=390 --height=844
//
// The checks adapt to the window: on a wide window the modal floats with a
// backdrop and every tab shows its label; on a narrow one the modal is the
// whole screen, the tabs are icons and the title reads "Settings › …".
// SEANCE_FONT_SIZE=large|huge runs it at a bigger text size. No IRC connection
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
	const strip = document.querySelector("${MENU} ul").getBoundingClientRect();
	const labelShown = (b) => {
		const label = b.querySelector(".tab-label");
		return !!label && getComputedStyle(label).display !== "none";
	};
	const shown = (sel) => {
		const el = document.querySelector(sel);
		return !!el && getComputedStyle(el).display !== "none";
	};
	return {
		clipped: tabs
			.filter((b) => {
				const r = b.getBoundingClientRect();
				return r.left < strip.left - 1 || r.right > strip.right + 1;
			})
			.map((b) => b.getAttribute("aria-label")),
		titlePlain: shown(".settings-title-plain"),
		titleText: document.querySelector("${MODAL} .settings-modal-header h1").innerText.trim(),
		activeLabel: document.querySelector("${MENU} button.active")?.getAttribute("aria-label"),
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

	if (process.env.SEANCE_FONT_SIZE) {
		await page.evaluate(
			`(() => { const s = JSON.parse(localStorage.getItem("settings") ?? "{}"); s.fontSize = ${JSON.stringify(
				process.env.SEANCE_FONT_SIZE
			)}; localStorage.setItem("settings", JSON.stringify(s)); location.reload(); })()`
		);
		await page.sleep(1500);
		await page.waitFor(`!!document.querySelector("${MODAL}")`, {label: "the modal again"});
	}
	await page.waitFor(`!!document.querySelector("${MENU} button.active")`, {
		label: "an active tab",
	});

	const p = await page.evaluate(PROBE);
	const narrow = p.modal.width < 42 * p.rem;

	await page.check(
		`no tab is cut off past the strip's edge${p.clipped.length ? `: ${p.clipped}` : ""}`,
		p.clipped.length === 0
	);
	const rows = new Set(p.tabTops).size;
	console.log(`tab rows: ${rows}, rem ${p.rem}px`);

	if (narrow) {
		await page.check(
			"narrow pane: every tab is its icon alone",
			!p.activeLabelled && p.inactiveLabels.every((shown) => !shown)
		);
		await page.check(
			`narrow pane: the title names the open tab (${p.titleText})`,
			!p.titlePlain && p.titleText.endsWith(p.activeLabel)
		);
	} else {
		await page.check(
			"wide pane: the tabs sit on one row, every one labelled",
			rows === 1 && p.activeLabelled && p.inactiveLabels.every(Boolean)
		);
		await page.check(
			`wide pane: the title is plain (${p.titleText})`,
			p.titlePlain && p.titleText === "Settings"
		);
	}
	// The pane's own width decides the tabs; the window's (768px, the
	// sidebar's overlay breakpoint) decides whether the modal fills it.
	const phone = p.window.w <= 768;
	await page.check(
		phone
			? "narrow window: the modal is the whole screen"
			: "wide window: the modal floats over a backdrop",
		phone
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
