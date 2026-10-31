// Help and the release notes as modals in the settings frame
// (Windows/Help.vue, Windows/Changelog.vue): a pane over a dimmed backdrop
// with a header (title + ✕), a body that scrolls by itself and a footer
// with Done; the release notes are reached from Help and lead back to it.
//
//   corepack yarn build && python3 -m http.server -d public 8000 &
//   node tools/browser-drive.mjs tools/scenarios/help-modal.mjs
//   node tools/browser-drive.mjs tools/scenarios/help-modal.mjs --width=390 --height=844
//
// The checks adapt to the window: on a wide window the modal floats with a
// backdrop; on a narrow one it is the whole screen. No IRC connection is
// needed — Help renders without one, and every way out lands on the
// connect form.

const BASE = process.env.SEANCE_HTTP ?? "http://localhost:8000/";

export const url = `${BASE}#/help`;

const MODAL = ".settings-modal";
const HASH = `location.hash`;

const PROBE = `(() => {
	const modal = document.querySelector("${MODAL}");
	const header = document.querySelector("${MODAL} .settings-modal-header");
	const body = document.querySelector("${MODAL} .settings-modal-body");
	const footer = document.querySelector("${MODAL} .settings-modal-footer");
	const done = document.querySelector("${MODAL} .settings-modal-done");
	return {
		modal: modal.getBoundingClientRect().toJSON(),
		window: {w: innerWidth, h: innerHeight},
		rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
		title: header.querySelector("h1").textContent.trim(),
		headerTop: header.getBoundingClientRect().top,
		footerBottom: footer.getBoundingClientRect().bottom,
		doneRight: done.getBoundingClientRect().right,
		footerRight: footer.getBoundingClientRect().right,
		bodyScrollable: body.scrollHeight > body.clientHeight + 1,
		sidebarToggle: !!document.querySelector("#help .lt, #changelog .lt"),
	};
})()`;

/** Escape as a real key (keybinds.ts listens on the document). */
async function pressEscape(page) {
	const key = {
		key: "Escape",
		code: "Escape",
		windowsVirtualKeyCode: 27,
		nativeVirtualKeyCode: 27,
	};
	await page.send("Input.dispatchKeyEvent", {type: "keyDown", ...key});
	await page.send("Input.dispatchKeyEvent", {type: "keyUp", ...key});
	await page.sleep(100);
}

/** Open Help afresh from wherever the last check left the app. */
async function openHelp(page) {
	await page.evaluate(`(() => { location.hash = "#/help"; })()`);
	await page.waitFor(`!!document.querySelector("#help ${MODAL}")`, {label: "Help open"});
}

export default async function run(page) {
	await page.goto(page.url, {waitForSelector: `#help ${MODAL}`});

	const p = await page.evaluate(PROBE);
	const narrow = p.modal.width < 42 * p.rem;

	await page.check(`the pane is titled Help (${p.title})`, p.title === "Help");
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
	await page.check("Done sits at the footer's right", p.footerRight - p.doneRight < 32);
	await page.check("no sidebar toggle in the pane", !p.sidebarToggle);
	await page.screenshot("1-help");

	// Help scrolls inside its own section; the header and footer hold still.
	await page.check("Help overflows into its own scroller", p.bodyScrollable);
	await page.evaluate(`document.querySelector("${MODAL} .settings-modal-body").scrollTo(0, 800)`);
	await page.sleep(150);
	const after = await page.evaluate(PROBE);
	await page.check(
		"scrolling the body moves neither header nor footer",
		Math.abs(after.footerBottom - p.footerBottom) < 2 &&
			Math.abs(after.headerTop - p.headerTop) < 2
	);
	await page.screenshot("2-scrolled");

	// The release notes open in the same frame and lead back to Help.
	await page.evaluate(`document.querySelector("${MODAL} .settings-modal-body").scrollTo(0, 0)`);
	await page.click("#view-changelog");
	await page.waitFor(`!!document.querySelector("#changelog ${MODAL}")`, {
		label: "release notes open",
	});
	const notes = await page.evaluate(PROBE);
	await page.check(
		`the release notes are titled (${notes.title})`,
		notes.title.startsWith("Release notes for v")
	);
	await page.check(
		"the release notes pane is the same size as Help's",
		Math.abs(notes.modal.width - p.modal.width) < 2 &&
			Math.abs(notes.modal.height - p.modal.height) < 2
	);
	await page.screenshot("3-release-notes");

	await page.click("#back-to-help");
	await page.waitFor(`!!document.querySelector("#help ${MODAL}")`, {label: "back on Help"});
	await page.check("« Help goes back to Help", (await page.evaluate(HASH)) === "#/help");

	// Every way out leaves for the connect form (there are no networks).
	const leaves = async (label, act) => {
		await openHelp(page);
		await act();
		await page.waitFor(`!document.querySelector("${MODAL}")`, {label: `${label} closes`});
		await page.check(
			`${label} leaves for the connect form`,
			(await page.evaluate(HASH)).includes("connect")
		);
	};

	await leaves("Done", () => page.click(`${MODAL} .settings-modal-done`));
	await leaves("✕", () => page.click(`${MODAL} .settings-modal-close`));
	await leaves("Escape", () => pressEscape(page));

	if (!narrow) {
		// The backdrop: a click on the dimmed window itself, outside the pane.
		await leaves("A backdrop click", () =>
			page.evaluate(`((el) => {
			// v-backdrop counts a click pressed and released on the backdrop itself.
			for (const type of ["pointerdown", "pointerup"]) el.dispatchEvent(new PointerEvent(type, {bubbles: true}));
			el.click();
		})(document.querySelector("#help.window"))`)
		);
	}

	// Escape closes the release notes too.
	await page.evaluate(`(() => { location.hash = "#/changelog"; })()`);
	await page.waitFor(`!!document.querySelector("#changelog ${MODAL}")`, {
		label: "release notes open",
	});
	await pressEscape(page);
	await page.waitFor(`!document.querySelector("${MODAL}")`, {label: "release notes closed"});
	await page.screenshot("4-closed");

	await page.check("no console errors", page.consoleErrors.length === 0);
}
