// The language selector end to end in a real browser (LanguageSelect.vue):
// picking a locale re-labels the UI and flips <html dir> at once, the pick is
// remembered in the settings blob and drives the pre-paint script in
// client/index.html so the direction is right from the FIRST PAINT of the
// next load — and a production build never offers the dev-only rig locale.
//
// The component has two entry points, and this drives the one each build
// has: the sidebar's globe (Sidebar.vue, development builds only — a
// popover holding LanguageSelect, no navigation and no connection needed)
// in the --dev run, and Settings → Translation (every build, the same
// component with name="locale") in the production run. The connect form
// carried a third until the reading language became the interface's.
//
//   corepack yarn build && python3 -m http.server -d public 8000 &
//   node tools/browser-drive.mjs tools/scenarios/i18n-language-switch.mjs
//
// Two builds, one scenario — the qqx pick needs a development build, the
// dev-only filter needs a production one (the selector filters AVAILABLE by
// devOnly, and a production build folds the rig out of activate()'s
// resolvable set and out of the baked pre-paint list too, so not even a
// stored pick brings it back — which is what the reload half proves):
//
//   NODE_ENV=production corepack yarn build   # DEV=false: qqx not offered
//   node tools/browser-drive.mjs tools/scenarios/i18n-language-switch.mjs
//                                             # → the (e) assertions
//   NODE_ENV=development corepack yarn build  # DEV=true: qqx in the dropdown
//   node tools/browser-drive.mjs tools/scenarios/i18n-language-switch.mjs --dev
//                                             # → the (a)–(d) assertions
//
// (`webpack --mode development` is NOT the development build here: that is
// the mocha test build, whose output lands in test/public. The servable dev
// build is the plain `webpack` of `yarn build` run with NODE_ENV=development
// — the config's own mode and the compile step's baked DEV both follow it.)
//
// No system chromium on the box this was verified on, and unprivileged user
// namespaces are disabled, so the driver runs playwright's headless-shell
// through a wrapper that adds --no-sandbox --disable-dev-shm-usage:
//
//   CHROME_BIN=$PWD/tmp/chrome-headless-wrapper.sh \
//     node tools/browser-drive.mjs tools/scenarios/i18n-language-switch.mjs
//
// The screenshot is copied to tmp/scenarios/i18n-language-switch.png (the
// driver's own --out= also works, its default lands in tmp/browser-drive/).
//
// The sign-in mode's row is checked in the --dev run by swapping the SERVED
// config.json (branding is fetched at boot, so no rebuild is needed), the
// same deploy shape tools/scenarios/sign-in.mjs builds for; the file is
// restored afterwards.
//
// Task 10 extensions:
//  - the truncation pass: qqx doubles every string, so in the --dev run the
//    connect form's controls (right after the pick), then the sidebar rows
//    and the settings tab strip (over a network fabricated through the
//    `init` bus event — dev-build-only window.socket) must show nothing
//    clipped (scrollWidth > clientWidth is a failure);
//  - first-paint attribution: the dir-setter wrapper records
//    document.readyState alongside every write, and the FIRST write must
//    have happened at readyState "loading" — the pre-paint script's write,
//    attributable, not just order-first;
//  - the production run seeds the stored pick (locale=qqx) and proves it
//    activates: dir flips to rtl at first paint and the runtime catalog
//    serves qqx copy — an explicit pick is not gated by devOnly.

import {copyFileSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {FAKE_NETWORK_SNIPPET, fakeNetworkSnippet} from "./lib/fake-network.mjs";

const BASE = process.env.SEANCE_HTTP ?? "http://localhost:8000/";

export const url = BASE;

// The development build's entry point: the sidebar globe and its popover.
const GLOBE = `#sidebar button.locale-toggle`;
const DEV_SELECT = `#locale-popover select`;
// Every build's entry point: Settings → Translation.
const SETTINGS_SELECT = `#settings .translate-target select`;
const SETTINGS_LABEL = `#settings .translate-target > span`;

// The English copy is read from the compiled catalog, never spelled out
// here: messages.pot is the only source of English copy, so a reworded
// label must not need a scenario edit (and must not pass against a stale
// literal). The label asserted to change is the globe's own tooltip in the
// dev run and the settings row's in the production one.
const EN = JSON.parse(readFileSync("client/locales/en.json", "utf8"));
const RLE = "\u202B"; // U+202B RIGHT-TO-LEFT EMBEDDING: qqx wraps every string in it

const DIR = `document.documentElement.dir`;
const LANG = `document.documentElement.lang`;
const GLOBE_LABEL = `document.querySelector(${JSON.stringify(
	GLOBE
)})?.getAttribute("aria-label") ?? ""`;
const SETTINGS_LABEL_TEXT = `(document.querySelector(${JSON.stringify(
	SETTINGS_LABEL
)}) ?? {textContent: ""}).textContent`;
const valueOf = (sel) => `document.querySelector(${JSON.stringify(sel)})?.value ?? null`;
const optionsOf = (sel) =>
	`Array.from(document.querySelectorAll(${JSON.stringify(`${sel} option`)})).map((o) => o.value)`;
const autoTextOf = (sel) =>
	`(document.querySelector(${JSON.stringify(
		`${sel} option[value="auto"]`
	)}) ?? {textContent: ""}).textContent`;
const STORED_LOCALE = `JSON.parse(localStorage.getItem("settings") ?? "{}").locale ?? null`;
/** The "System default (X)" option as English renders it. */
const autoLabel = (language) => EN["settings.locale.auto"].replace("{language}", language);

/** Sign-in deploy config swapped into the served config.json for one check. */
const SIGN_IN_CONFIG = JSON.stringify(
	{
		appName: "TestNet",
		defaultNetwork: {
			name: "TestNet",
			host: "127.0.0.1",
			port: 8067,
			tls: false,
			channels: ["#seance"],
			nick: "guest????",
		},
		features: {signIn: true, allowCustomServer: false, multiNetwork: false},
	},
	null,
	"\t"
);

/** Pick a language the way the dropdown does: set + `change`, which is what
 * a native <select> fires (a real mouse cannot open the OS popup headlessly;
 * the same dispatch the font-size scenario uses for its range input). */
const pick = (page, sel, tag) =>
	page.evaluate(
		`(() => {
			const el = document.querySelector(${JSON.stringify(sel)});
			el.value = ${JSON.stringify(tag)};
			el.dispatchEvent(new Event("change", {bubbles: true}));
		})()`
	);

/** Open the dev-only sidebar popover. Picking closes it again (Sidebar.vue
 * `onLocalePick`), so every look at the select opens it first. */
const openGlobe = async (page) => {
	if (!(await page.evaluate(`!!document.querySelector(${JSON.stringify(DEV_SELECT)})`))) {
		await page.click(GLOBE);
		await page.waitFor(`!!document.querySelector(${JSON.stringify(DEV_SELECT)})`, {
			label: "the globe's language popover",
		});
	}
};

/** Settings → Translation, the entry point a production build has. */
const openSettingsTranslation = async (page) => {
	if (!(await page.evaluate(`!!document.querySelector("#settings")`))) {
		await page.click(`#footer button.settings`);
		await page.waitFor(`!!document.querySelector(".settings-menu button.translation")`, {
			label: "settings open",
		});
	}

	await page.click(`.settings-menu button.translation`);
	await page.waitFor(`!!document.querySelector(${JSON.stringify(SETTINGS_SELECT)})`, {
		label: "the Translation tab's language select",
	});
};

/** A cold reload: `Page.reload` on the same URL, polling on through the
 * document swap (evaluate fails while the old document is torn down;
 * reload-on-settings.mjs explains the dance). */
const reload = async (page, waitForSelector) => {
	await page.evaluate(`(() => { window.__preReload = true; })()`);
	await page.send("Page.reload");
	const started = Date.now();

	for (;;) {
		try {
			if (
				await page.evaluate(
					`!window.__preReload && !!document.querySelector(${JSON.stringify(
						waitForSelector
					)})`
				)
			) {
				return;
			}
		} catch {
			// the document is being replaced
		}

		if (Date.now() - started > 20000) {
			throw new Error(`timed out waiting for ${waitForSelector} after reload`);
		}

		await page.sleep(150);
	}
};

/** Installed before any page script, on every new document: wraps the
 * <html> `dir` setter so the scenario can prove the direction was set by the
 * pre-paint script — the first write in the document, before bundle.js, at
 * readyState "loading" (attributed, not just order-first). Only writes to
 * the documentElement are recorded: Vue also patches `dir="auto"` onto
 * message/textarea elements as a DOM prop while mounting, and those are
 * per-element rendering, not the document's direction. */
const DIR_HISTORY_HOOK = `(() => {
	window.__dirHistory = [];
	const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "dir");

	if (!desc || !desc.set) {
		return;
	}

	Object.defineProperty(HTMLElement.prototype, "dir", {
		get: desc.get,
		set(value) {
			if (this === document.documentElement) {
				window.__dirHistory.push({dir: String(value), readyState: document.readyState});
			}

			desc.set.call(this, value);
		},
		configurable: true,
		enumerable: desc.enumerable,
	});
})()`;

/** Elements of `selector` whose content overflows their box — a clipped
 * control (qqx doubles every string; nothing in the wave-A chrome may
 * overflow). Returns human-readable offenders, empty when clean. */
const CLIPPED = (selector) =>
	`(() => {
		const bad = [];
		for (const el of document.querySelectorAll(${JSON.stringify(selector)})) {
			if (el.scrollWidth > el.clientWidth + 1) {
				bad.push(
					(el.id ? "#" + el.id : el.tagName.toLowerCase()) +
						" [" + String(el.textContent ?? "").trim().slice(0, 40) + "]"
				);
			}
		}
		return bad;
	})()`;

const assertNothingClipped = async (page, selector, label) => {
	const bad = (await page.evaluate(CLIPPED(selector))) ?? [];
	page.check(
		`${label} — nothing clipped in ${selector}${bad.length > 0 ? `: ${bad.join("; ")}` : ""}`,
		bad.length === 0
	);
};

export default async function run(page) {
	const devBuild = page.flags.has("--dev");

	// Before the first navigation, so it covers the reloads too.
	await page.addInitScript(DIR_HISTORY_HOOK);

	// (a) On "/" with no connection and no navigation: the language control
	// this build offers is there, visible, and nothing dialed out.
	await page.goto(page.url, {waitForSelector: "#connect form"});

	if (devBuild) {
		const globe = await page.rect(GLOBE);
		page.check(
			"development build shows the sidebar's language globe",
			!!globe && globe.width > 0 && globe.height > 0
		);
		await openGlobe(page);
	} else {
		await openSettingsTranslation(page);
	}

	const SELECT = devBuild ? DEV_SELECT : SETTINGS_SELECT;
	const LABEL_TEXT = devBuild ? GLOBE_LABEL : SETTINGS_LABEL_TEXT;
	const EN_LABEL = devBuild ? EN["sidebar.language"] : EN["translate.settings.languageLabel"];
	const select = await page.rect(SELECT);
	page.check("language select is present and visible", !!select && select.width > 0);
	page.check(
		"no connection was dialed",
		page.wsFrames.length === 0 && page.consoleErrors.length === 0
	);

	if (devBuild) {
		// The (a)–(d) flow: pick qqx, watch the flip, reload, watch it stick.
		const values = await page.evaluate(optionsOf(SELECT));
		page.check("development build offers qqx", values.includes("qqx"));
		page.check("direction starts ltr", (await page.evaluate(DIR)) === "ltr");
		const before = await page.evaluate(LABEL_TEXT);
		page.check("the control's label starts as the English copy", before === EN_LABEL);
		page.check(
			"auto option names the resolved tag",
			(await page.evaluate(autoTextOf(SELECT))) === autoLabel("English")
		);

		// (b) Picking qqx: rtl, and a known label goes pseudo-localized.
		await pick(page, SELECT, "qqx");
		await page.waitFor(`${DIR} === "rtl"`, {label: "html dir flips to rtl"});
		page.check("documentElement.lang is qqx", (await page.evaluate(LANG)) === "qqx");
		const after = await page.evaluate(LABEL_TEXT);
		page.check(
			"the control's label is no longer the English copy",
			after !== EN_LABEL && before !== after
		);
		page.check("the label is pseudo-localized (RLE-wrapped)", after.includes(RLE));
		// The pick closed the popover (onLocalePick); open it again to read
		// the re-rendered options.
		await openGlobe(page);
		page.check(
			"auto option re-rendered for qqx",
			(await page.evaluate(autoTextOf(SELECT))).includes("qqx")
		);
		page.check(
			"pick stored in the settings blob",
			(await page.evaluate(STORED_LOCALE)) === "qqx"
		);

		// (b2) Truncation pass, part 1: qqx doubles every string — with the
		// form freshly relabeled, none of its controls may clip their copy.
		await assertNothingClipped(
			page,
			`#connect form button`,
			"truncation: connect form buttons"
		);
		await assertNothingClipped(
			page,
			`#connect form select`,
			"truncation: connect form selects"
		);
		await assertNothingClipped(page, `#connect form input`, "truncation: connect form inputs");
		await assertNothingClipped(page, `#connect form label`, "truncation: connect form labels");

		// (c) Reload: the pick survived and the direction was right from the
		// first paint — __dirHistory[0] is the pre-paint script's write, which
		// runs before bundle.js at readyState "loading" (attributed, not just
		// order-first).
		await reload(page, GLOBE);
		await openGlobe(page);
		page.check("pick survived the reload", (await page.evaluate(STORED_LOCALE)) === "qqx");
		page.check("select still shows qqx", (await page.evaluate(valueOf(SELECT))) === "qqx");
		page.check("direction still rtl after reload", (await page.evaluate(DIR)) === "rtl");
		page.check("html lang still qqx", (await page.evaluate(LANG)) === "qqx");
		const first = await page.evaluate(`(window.__dirHistory ?? [])[0]`);
		page.check(
			"dir was rtl from first paint (pre-paint, before bundle.js)",
			!!first && first.dir === "rtl"
		);
		page.check(
			"the first dir write happened at readyState loading (pre-paint attribution)",
			!!first && first.readyState === "loading"
		);
		const history = await page.evaluate(`window.__dirHistory ?? []`);
		page.check(
			"every dir write in the reloaded document stayed rtl",
			history.length > 0 && history.every((write) => write.dir === "rtl")
		);

		// (d) The screenshot deliverable: the remembered RTL connect form.
		const shot = await page.screenshot("i18n-language-switch");
		mkdirSync("tmp/scenarios", {recursive: true});
		copyFileSync(shot, "tmp/scenarios/i18n-language-switch.png");

		// The control belongs to the app, not to the connect form: a sign-in
		// deploy (no custom server, no connect fields) still reaches it. Swap
		// the served branding (fetched at boot, no rebuild), reload, restore.
		const originalConfig = readFileSync("public/config.json", "utf8");

		try {
			writeFileSync("public/config.json", SIGN_IN_CONFIG + "\n");
			await reload(page, `#connect form.sign-in`);
			const signInGlobe = await page.rect(GLOBE);
			page.check(
				"sign-in mode reaches the language control too",
				!!signInGlobe && signInGlobe.width > 0 && signInGlobe.height > 0
			);
			await openGlobe(page);
			page.check(
				"sign-in mode kept the pick",
				(await page.evaluate(valueOf(SELECT))) === "qqx"
			);
		} finally {
			writeFileSync("public/config.json", originalConfig);
		}

		// Close the popover: it sits over the top of the sidebar and the
		// truncation pass below measures the rows under it.
		await page.click(GLOBE);
		await page.waitFor(`!document.querySelector(${JSON.stringify(DEV_SELECT)})`, {
			label: "the popover closed",
		});

		// (f) Truncation pass, part 2: the sidebar rows, the settings tab
		// strip and the connection bar under qqx. The sidebar needs rows, so
		// networks are fabricated through the `init` bus event
		// (lib/fake-network.mjs) — that helper rides window.socket, which
		// only the development build exposes.
		const faked = await page.evaluate(FAKE_NETWORK_SNIPPET);
		page.check(
			"truncation fixture: the fabricated network rendered (window.socket present)",
			faked === true
		);

		if (!faked) {
			// Fail loud: a production build (or a regression dropping the
			// window.socket exposure) must not silently skip the pass — the
			// same rule i18n-rtl-layout.mjs applies to its whole run.
			throw new Error(
				"truncation pass part 2 needs window.socket (the init fabrication) — " +
					"run against the development build (client/js/socket.ts exposes it only there)"
			);
		}

		await page.waitFor(`!!document.querySelector(".channel-list-item[data-type='lobby']")`, {
			label: "the fabricated network's lobby row",
		});
		await assertNothingClipped(page, `.channel-list-item`, "truncation: sidebar rows");

		await page.click(`#footer button.settings`);
		await page.waitFor(`!!document.querySelector(".settings-menu")`, {label: "settings open"});
		await assertNothingClipped(page, `.settings-menu button`, "truncation: settings tab strip");
		await assertNothingClipped(
			page,
			`.settings-modal-footer button, .settings-modal-header button`,
			"truncation: settings modal header/footer buttons"
		);
		const truncShot = await page.screenshot("i18n-language-switch-truncation");
		copyFileSync(truncShot, "tmp/scenarios/i18n-language-switch-truncation.png");

		// Settings is a modal; nothing behind the backdrop is clickable —
		// leave through Done before touching anything else.
		await page.click(".settings-modal-done");
		await page.waitFor(`!!document.querySelector("#input")`, {label: "back in the channel"});

		// The connection bar is wave-A chrome too, and the connected TestNet
		// can never show it — dispatch a second, dead network and open one
		// of its channels: "Disconnected from …" plus its Connect button.
		const dead = await page.evaluate(
			fakeNetworkSnippet({
				uuid: "fake-dead-0000",
				name: "GhostNet",
				nick: "wraith",
				channel: "#ghost",
				query: "shade",
				connected: false,
				baseId: 10,
			})
		);
		page.check("truncation fixture: the dead network rendered", dead === true);
		await page.waitFor(`!!document.querySelector(".channel-list-item[data-name='#ghost']")`, {
			label: "the dead network's channel row",
		});
		await page.click(`.channel-list-item[data-name='#ghost']`);
		await page.waitFor(`!!document.querySelector(".connection-bar")`, {
			label: "the connection bar on the dead channel",
		});
		page.check(
			"connection bar: the strip's copy is localized (RLE-wrapped)",
			await page.evaluate(
				`document.querySelector(".connection-bar-label")?.textContent.includes("\\u202B")`
			)
		);
		await assertNothingClipped(page, `.connection-bar`, "truncation: connection bar strip");
		await assertNothingClipped(
			page,
			`.connection-bar button`,
			"truncation: connection bar buttons"
		);
		const barShot = await page.screenshot("i18n-language-switch-connection-bar");
		copyFileSync(barShot, "tmp/scenarios/i18n-language-switch-connection-bar.png");
	} else {
		// The (e) assertions: a production build never offers a dev-only
		// locale. It does offer every shipped one, so the list is checked for
		// its shape (auto first, the shipped tags present) and for qqx's
		// absence, not against a fixed roster that grows with every language.
		const values = await page.evaluate(optionsOf(SELECT));
		page.check("the first option is the automatic one", values[0] === "auto");
		page.check(
			"the shipped locales are offered",
			values.includes("en") && values.includes("ar") && values.includes("de")
		);
		page.check("qqx is absent from the dropdown", !values.includes("qqx"));
		page.check("direction starts ltr", (await page.evaluate(DIR)) === "ltr");
		page.check(
			"auto option names the resolved tag",
			(await page.evaluate(autoTextOf(SELECT))) === autoLabel("English")
		);
		page.check(
			"the row label is the English copy",
			(await page.evaluate(LABEL_TEXT)) === EN_LABEL
		);
		await page.screenshot("i18n-language-switch-prod");

		// (f) A stored dev-only pick does NOT activate in a production
		// build — it used to, and the rig's fold made that a hole: a
		// settings backup restored from a development machine would have
		// pinned the whole interface to the pseudo-locale. The build folds
		// qqx out of activate()'s resolvable set, the baked pre-paint list
		// leaves it out (readAvailableLocales drops DEV_ONLY_TAGS), and the
		// page comes up in English, left to right, as if nothing were
		// stored.
		await page.evaluate(`localStorage.setItem("settings", JSON.stringify({locale: "qqx"}))`);
		// The route is /settings/translation by now (router.push is a
		// replace), so the reload lands back on the tab the label lives in.
		await reload(page, SELECT);
		page.check(
			"prod: a stored qqx pick leaves the direction alone",
			(await page.evaluate(DIR)) === "ltr"
		);
		page.check(
			"prod: a stored qqx pick never becomes the document language",
			(await page.evaluate(LANG)) !== "qqx"
		);
		page.check(
			"prod: the pre-paint script wrote no direction for it",
			((await page.evaluate(`(window.__dirHistory ?? []).length`)) ?? 0) === 0 ||
				(await page.evaluate(`(window.__dirHistory ?? []).every((w) => w.dir !== "rtl")`))
		);
		const prodLabel = await page.evaluate(LABEL_TEXT);
		page.check(
			"prod: the runtime catalog stayed English",
			!prodLabel.includes(RLE) && prodLabel === EN_LABEL
		);
		await page.screenshot("i18n-language-switch-prod-qqx");
	}

	page.check("no console errors", page.consoleErrors.length === 0);
}
