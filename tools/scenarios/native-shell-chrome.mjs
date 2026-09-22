// What the native shell (shells/capacitor) changes about the page, checked in
// a browser that is not one: the safe-area tokens on html[data-shell="native"].
//
//   corepack yarn build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/native-shell-chrome.mjs
//
// The shell is faked the way it really happens — native.ts sets `data-shell`
// and `data-platform` on <html>, and Capacitor's Android SystemBars publishes
// `--safe-area-inset-*` there — so every rule under those selectors is the
// real one. One token pair carries the platform difference: --inset-outer-
// bottom is the strip the whole app stops above (Android's button bar) and
// --inset-inner-bottom the strip only the composer and the sidebar's footer
// reserve (iOS's home indicator). Exactly one is ever non-zero.

const IRCD = process.env.SEANCE_IRC_URL ?? "wss://localhost:8443/";
const CHANNEL = process.env.SEANCE_IRC_CHANNEL ?? "#seance";
const PORT = process.env.SEANCE_PORT ?? "8000";

const ircd = new URL(IRCD);

if (ircd.hostname === "localhost" || ircd.hostname === "127.0.0.1") {
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // dev ircd's self-signed cert
}

const stamp = Math.random().toString(36).slice(2, 6);
const NICK = `inset${stamp}`;
const HOST = ircd.hostname + ircd.pathname.replace(/\/$/, "");
const IRC_PORT = ircd.port || (ircd.protocol === "wss:" ? "443" : "80");

export const url =
	`http://127.0.0.1:${PORT}/?host=${encodeURIComponent(HOST)}&port=${IRC_PORT}` +
	`&tls=${ircd.protocol === "wss:"}&nick=${NICK}&join=${encodeURIComponent(CHANNEL)}`;

/** The insets a phone hands the page, in px, so the numbers are checkable. */
const TOP = 47;
const BOTTOM = 34;

/** Shell on, with the platform given; `null` turns it back off. */
function setShell(platform) {
	if (platform === null) {
		return `(() => {
			delete document.documentElement.dataset.shell;
			delete document.documentElement.dataset.platform;
			return "web";
		})()`;
	}

	return `(() => {
		const root = document.documentElement;
		root.dataset.shell = "native";
		root.dataset.platform = ${JSON.stringify(platform)};
		root.style.setProperty("--safe-area-inset-top", "${TOP}px");
		root.style.setProperty("--safe-area-inset-bottom", "${BOTTOM}px");
		return root.dataset.platform;
	})()`;
}

/** px of a computed property, as a number. */
function px(selector, property) {
	return `(() => {
		const el = document.querySelector(${JSON.stringify(selector)});
		return el ? parseFloat(getComputedStyle(el)[${JSON.stringify(property)}]) : NaN;
	})()`;
}

/** The sheet's `bottom`, off an element built for the question. */
const SHEET_BOTTOM = `(() => {
	const el = document.createElement("div");
	el.className = "reaction-picker sheet";
	document.body.append(el);
	const bottom = parseFloat(getComputedStyle(el).bottom);
	el.remove();
	return bottom;
})()`;

export default async function run(page) {
	await page.goto(page.url, {waitForSelector: "#connect form"});

	// A link to an unknown server asks first (helpers/linkTarget.ts).
	await page.waitFor(`document.querySelector("#connect button[type=submit]")`, {
		label: "the link approval form",
	});
	await page.click("#connect button[type=submit]");

	await page.waitFor(`document.querySelector("#chat .messages")`, {
		timeout: 30000,
		label: "the channel to open",
	});
	// The insets, in the shell, on each platform. What the same page is
	// without one is the baseline every check below is read against.
	const webForm = await page.evaluate(px("#form", "paddingBottom"));
	const webViewportTop = await page.evaluate(px("#viewport", "paddingTop"));

	await page.evaluate(setShell("ios"));
	const ios = {
		viewportTop: await page.evaluate(px("#viewport", "paddingTop")),
		viewportBottom: await page.evaluate(px("#viewport", "paddingBottom")),
		form: await page.evaluate(px("#form", "paddingBottom")),
		footer: await page.evaluate(px("#footer", "marginBottom")),
		sheet: await page.evaluate(SHEET_BOTTOM),
	};

	await page.evaluate(setShell("android"));
	const android = {
		viewportTop: await page.evaluate(px("#viewport", "paddingTop")),
		viewportBottom: await page.evaluate(px("#viewport", "paddingBottom")),
		form: await page.evaluate(px("#form", "paddingBottom")),
		footer: await page.evaluate(px("#footer", "marginBottom")),
		sheet: await page.evaluate(SHEET_BOTTOM),
	};

	// The status bar is the same on both: the app starts below it.
	page.check(`iOS starts below the status bar (${ios.viewportTop}px)`, ios.viewportTop === TOP);
	page.check(
		`Android starts below the status bar (${android.viewportTop}px)`,
		android.viewportTop === TOP
	);

	// The bottom is the whole difference, and it lands in one place or the other.
	page.check(`iOS runs to the bottom edge (${ios.viewportBottom}px)`, ios.viewportBottom === 0);
	page.check(`iOS reserves the indicator in the composer (${ios.form}px)`, ios.form === BOTTOM);
	page.check(
		`iOS reserves it under the sidebar's footer (${ios.footer}px)`,
		ios.footer === BOTTOM
	);

	page.check(
		`Android stops above the button bar (${android.viewportBottom}px)`,
		android.viewportBottom === BOTTOM
	);
	page.check(
		`Android's composer keeps its own padding (${android.form}px)`,
		android.form === webForm
	);
	page.check(`Android's footer keeps its own (${android.footer}px)`, android.footer === 0);

	// The sheet is teleported to <body>, so #viewport's padding is not its:
	// on Android it adds the inset itself, on iOS there is nothing to add.
	page.check(
		`the sheet clears Android's button bar (${android.sheet} vs ${ios.sheet})`,
		Number.isFinite(ios.sheet) && android.sheet - ios.sheet === BOTTOM
	);

	await page.evaluate(setShell(null));
	page.check(
		"the page is itself again with the shell off",
		(await page.evaluate(px("#viewport", "paddingTop"))) === webViewportTop
	);

	page.check("no console errors", page.consoleErrors.length === 0);
}
