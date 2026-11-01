// The translation chips' one accent look (client/css/style.css): the
// detection mark a reader left alone (.msg-translation-skipped-tag inside
// .msg-translation-skipped) and the unchanged-failure chip (the same class
// inside .msg-translation-failed, a fas fa-equals icon) both wear the same
// accent border and ink as .msg-translation-chip, and neither keeps the old
// muted grey or the old 0.75 dim. The unchanged line's original is the line
// to read, so it wears the translation's ink (#chat .msg.unchanged .content)
// over the own-line dimming an untranslated `.self` row keeps.
//
// Alongside it, the icon split: fa-language marks the translation surfaces
// (the channel header's toggle and the message action's ::before glyph, both
// \\f1ab) while the globe stays the language setting — the sidebar's dev
// locale toggle still renders 🌐. The inline icons only draw because
// style.css carries their content on top of the bundled @font-face.
//
// No ircd and no engine: the page boots to the connect form, a network is
// fabricated in-page (lib/fake-network.mjs -- the same `init` bus dispatch
// a registration makes) and two entries are committed into
// store.state.translations for two of its rendered messages, one
// detection-skipped and one failed with "came back unchanged". The claims
// are read off the real DOM as computed styles.
//
//   corepack yarn build    (dev build: window.socket is dev-build-only)
//   node tools/browser-drive.mjs tools/scenarios/translation-chips.mjs
//
// The served origin is the dev stack's https://127.0.0.1:8000 (self-signed;
// browser-drive passes --ignore-certificate-errors). Override with SEANCE_BASE.

import {fakeNetworkSnippet} from "./lib/fake-network.mjs";

export const url = `${process.env.SEANCE_BASE || "https://127.0.0.1:8000/"}`;

// The fabricated channel's message ids (fake-network.mjs defaults, baseId
// 0): two of the three rendered rows in #seance. The unchanged one is the
// page's own line ("short one"), dimmed by `.self` until the verdict lands,
// so the ink claim below is about the one row where it shows.
const SKIPPED_MSG = 21;
const UNCHANGED_MSG = 22;

const INJECT = `(() => {
	const root = document.getElementById("app");
	const store = root && root.__vue_app__ && root.__vue_app__.config.globalProperties.$store;

	if (!store) {
		return false;
	}

	// The shapes reader.ts commits: a detection skip (the reading language
	// was not among the detector's candidates) and the unchanged failure
	// (client/js/translate/outgoing.ts UNCHANGED).
	store.commit("translationEntry", {
		id: ${SKIPPED_MSG},
		entry: {
			status: "skipped",
			text: "",
			from: "de",
			to: "en",
			candidates: ["fr", "nl"],
			engine: null,
			error: null,
			hidden: false,
			reason: "unsure",
		},
	});
	store.commit("translationEntry", {
		id: ${UNCHANGED_MSG},
		entry: {
			status: "failed",
			text: "",
			from: "de",
			to: "en",
			candidates: [],
			engine: null,
			error: "came back unchanged",
			hidden: false,
		},
	});

	// The hover toolbar (Message.vue canAct) only renders for lines the IRC
	// layer could address — the fabricated messages have no msgid, so stamp
	// one on to bring .msg-action-translate into the DOM.
	for (const net of store.state.networks) {
		for (const chan of net.channels) {
			for (const msg of chan.messages) {
				if (!msg.msgid) {
					msg.msgid = "seance-fake-" + msg.id;
				}
			}
		}
	}
	return true;
})()`;

/**
 * The two tags and the accent chip as computed styles, or null while any of
 * them is missing. The muted grey the tag used to wear is resolved the way
 * the browser resolves it (a probe element), so the "not muted any more"
 * claim needs no hard-coded rgb string.
 */
const STYLES = `(() => {
	const skipped = document.querySelector(
		"#chat .msg-translation-skipped .msg-translation-skipped-tag"
	);
	const unchanged = document.querySelector(
		"#chat .msg-translation-failed .msg-translation-skipped-tag"
	);
	const chip = document.querySelector("#chat .msg-translation-chip");

	if (!skipped || !unchanged || !chip) {
		return null;
	}

	const probe = document.createElement("span");
	probe.style.color = "var(--body-color-muted)";
	document.body.appendChild(probe);
	const muted = getComputedStyle(probe).color;
	probe.style.color = "var(--body-color)";
	const ink = getComputedStyle(probe).color;
	probe.remove();

	const unchangedRow = unchanged.closest(".msg");
	const skippedRow = skipped.closest(".msg");

	const s = getComputedStyle(skipped);
	const u = getComputedStyle(unchanged);
	const c = getComputedStyle(chip);

	return {
		skippedBorder: s.borderTopColor,
		unchangedBorder: u.borderTopColor,
		chipBorder: c.borderTopColor,
		skippedOpacity: s.opacity,
		unchangedOpacity: u.opacity,
		muted,
		ink,
		unchangedRowIsOwn: !!unchangedRow && unchangedRow.classList.contains("self"),
		unchangedRowClass: !!unchangedRow && unchangedRow.classList.contains("unchanged"),
		unchangedOriginal: unchangedRow
			? getComputedStyle(unchangedRow.querySelector(".content")).color
			: null,
		skippedRowClass: !!skippedRow && skippedRow.classList.contains("unchanged"),
		chipCount: document.querySelectorAll("#chat .msg-translation-chip").length,
		hasEquals: !!unchanged.querySelector(".fa-equals"),
		unchangedTitle: unchanged.getAttribute("title"),
	};
})()`;

/**
 * The icon split as the rendered page tells it. Chrome may serialize a
 * computed content either as the escape (`"\\f1ab"`) or as the literal
 * private-use character, so each claim carries the glyph's code point as a
 * number: the header toggle's ::before, the message action's inline
 * .fa-language, the unchanged chip's .fa-equals, and the sidebar's dev
 * locale toggle's text.
 */
const ICONS = `(() => {
	const glyphCode = (content) => {
		if (typeof content !== "string" || content.length < 2) {
			return null;
		}
		const bare =
			content.charAt(0) === '"' ? content.slice(1, content.length - 1) : content;
		if (bare.length === 1) {
			const cp = bare.codePointAt(0);
			// FontAwesome solids live in the private-use area.
			return cp >= 0xe000 && cp <= 0xf8ff ? cp : null;
		}
		if (bare.charAt(0) === "\\\\" && bare.length > 1) {
			let hex = "";
			for (let i = 1; i < bare.length; i++) {
				const c = bare.charAt(i);
				if (/[0-9a-fA-F]/.test(c)) {
					hex += c;
				} else {
					break;
				}
			}
			return hex ? parseInt(hex, 16) : null;
		}
		return null;
	};

	const toggle = document.querySelector("#chat button.translate");
	const action = document.querySelector("#chat .msg-action-translate");
	const locale = document.querySelector("#sidebar .locale-toggle");
	const equals = document.querySelector("#chat .msg-translation-failed .fa-equals");

	return {
		togglePresent: !!toggle,
		toggleContent: toggle ? getComputedStyle(toggle, "::before").content : null,
		toggleCode: toggle ? glyphCode(getComputedStyle(toggle, "::before").content) : null,
		actionPresent: !!action,
		actionCode: action ? glyphCode(getComputedStyle(action, "::before").content) : null,
		equalsCode: equals ? glyphCode(getComputedStyle(equals, "::before").content) : null,
		localeText: locale ? locale.textContent.trim() : null,
	};
})()`;

export default async function run(page) {
	await page.goto(page.url, {waitForSelector: "#connect form"});
	page.check("the app booted to the connect form", (await page.count("#connect form")) === 1);

	// Fabricate a connected TestNet with #seance open. window.socket is
	// dev-build-only, so a false here means the build is not a development
	// one and every assertion after this would be about nothing.
	const fabricated = await page.evaluate(fakeNetworkSnippet());
	page.check("a development build fabricated the network", fabricated === true);
	await page.waitFor(`!!document.querySelector("#chat")`, {label: "the chat window"});
	await page.waitFor(`document.querySelectorAll("#chat .msg").length >= 3`, {
		label: "the fabricated channel's messages",
	});

	// Before any verdict, the own line reads dimmed like every own line.
	const ownBefore = await page.evaluate(
		`getComputedStyle(document.querySelector("#msg-${UNCHANGED_MSG} .content")).color`
	);

	page.check("the translation entries injected", (await page.evaluate(INJECT)) === true);
	await page.waitFor(`(${STYLES}) !== null`, {
		label: "both chips and the accent chip rendered",
	});

	const s = await page.evaluate(STYLES);
	console.log("chips", JSON.stringify(s, null, 1));

	page.check("exactly one accent chip on the page", s.chipCount === 1);
	page.check(
		"the detection mark's border is the chip's accent border",
		s.skippedBorder === s.chipBorder
	);
	page.check(
		"the unchanged chip's border is the chip's accent border",
		s.unchangedBorder === s.chipBorder
	);
	page.check(
		"neither tag kept the old muted grey",
		s.skippedBorder !== s.muted && s.unchangedBorder !== s.muted
	);
	page.check(
		"the old 0.75 dim is gone from both tags",
		s.skippedOpacity === "1" && s.unchangedOpacity === "1"
	);
	page.check("the unchanged chip is the equals icon", s.hasEquals === true);
	page.check("the unchanged line is the page's own", s.unchangedRowIsOwn === true);
	page.check("an own line is dimmed before the verdict", ownBefore === s.muted);
	page.check("the unchanged line's row carries the class", s.unchangedRowClass === true);
	page.check(
		"the unchanged line's original wears the translation's ink, not the own-line dim",
		s.unchangedOriginal === s.ink && s.unchangedOriginal !== s.muted
	);
	page.check("a detection skip is not marked unchanged", s.skippedRowClass === false);
	page.check(
		'the unchanged chip is titled "Not translated"',
		s.unchangedTitle === "Not translated"
	);

	const icons = await page.evaluate(ICONS);
	console.log("icons", JSON.stringify(icons, null, 1));

	page.check("the header's translate toggle is on the page", icons.togglePresent === true);
	page.check(
		"the header toggle draws the language glyph, not the globe",
		icons.toggleCode === 0xf1ab
	);
	page.check("the message action is on the page", icons.actionPresent === true);
	page.check("the message action's icon draws the language glyph", icons.actionCode === 0xf1ab);
	page.check(
		"the unchanged chip's equals icon draws through the bundled face",
		icons.equalsCode === 0xf52c
	);
	page.check("the sidebar's dev locale toggle is still the globe", icons.localeText === "🌐");

	await page.screenshot("translation-chips");
	page.check("no console errors", page.consoleErrors.length === 0);
}
