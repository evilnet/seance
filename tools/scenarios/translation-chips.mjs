// What the chat shows for a line translation left alone: nothing. A
// detection skip (the line could not be placed, or is already in the
// reading language) and a line the engine handed back as it was
// (outgoing.ts UNCHANGED) render no row, no chip and no mark under the
// message, on anyone's line or the page's own -- in a channel full of
// them a tag on each was noise. The toolbar's Translate still translates
// any of them. A translated line shows its translation in the original's
// place, with a flipper before it that swaps the two.
//
// Alongside it, the icon split: fa-language marks the translation surfaces
// (the message action's ::before glyph, \\f1ab) while the globe stays the
// language setting -- the sidebar's dev locale toggle still renders 🌐.
//
// No ircd and no engine: the page boots to the connect form, a network is
// fabricated in-page (lib/fake-network.mjs -- the same `init` bus dispatch
// a registration makes) and entries are committed into
// store.state.translations for its rendered messages. The claims are read
// off the real DOM.
//
//   NODE_ENV=development pnpm build    (window.socket is dev-build-only)
//   node tools/browser-drive.mjs tools/scenarios/translation-chips.mjs
//
// The served origin is the dev stack's https://127.0.0.1:8000 (self-signed;
// browser-drive passes --ignore-certificate-errors). Override with SEANCE_BASE.

import {fakeNetworkSnippet} from "./lib/fake-network.mjs";
import {TRANSLATION_ON} from "./lib/translation.mjs";

export const url = `${process.env.SEANCE_BASE || "https://127.0.0.1:8000/"}`;

// The fabricated channel's message ids (fake-network.mjs defaults, baseId
// 0): the three rendered rows in #seance. 22 is the page's own line.
const SKIPPED_MSG = 21;
const OWN_UNCHANGED_MSG = 22;
const UNCHANGED_MSG = 23;

const STORE = `document.getElementById("app").__vue_app__.config.globalProperties.$store`;

/** The shapes reader.ts commits, one entry per call. */
const commit = (id, entry) => `(() => {
	const store = ${STORE};

	if (!store) {
		return false;
	}

	store.commit("translationEntry", {
		id: ${id},
		entry: Object.assign(
			{text: "", from: "de", to: "en", candidates: [], engine: null, error: null, hidden: false},
			${JSON.stringify(entry)}
		),
	});

	return true;
})()`;

// The hover toolbar (Message.vue canAct) only renders for lines the IRC
// layer could address -- the fabricated messages have no msgid, so stamp
// one on to bring .msg-action-translate into the DOM.
const STAMP_MSGIDS = `(() => {
	for (const net of ${STORE}.state.networks) {
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

/** Whether a row shows anything of translation under it. */
const bare = (id) =>
	`!document.querySelector("#msg-${id} .msg-translation") && !document.querySelector("#msg-${id} .msg-translation-chip") && !document.getElementById("msg-${id}").classList.contains("unchanged")`;

/** The muted ink as the browser resolves it, through a probe element. */
const MUTED = `(() => {
	const probe = document.createElement("span");
	probe.style.color = "var(--body-color-muted)";
	document.body.appendChild(probe);
	const muted = getComputedStyle(probe).color;
	probe.remove();
	return muted;
})()`;

/**
 * The icon split as the rendered page tells it. Chrome may serialize a
 * computed content either as the escape (`"\\f1ab"`) or as the literal
 * private-use character, so each claim carries the glyph's code point as a
 * number: the message action's inline .fa-language and the sidebar's
 * dev locale toggle's text.
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

	const action = document.querySelector("#chat .msg-action-translate");
	const locale = document.querySelector("#sidebar .locale-toggle");

	return {
		actionPresent: !!action,
		actionCode: action ? glyphCode(getComputedStyle(action, "::before").content) : null,
		localeText: locale ? locale.textContent.trim() : null,
	};
})()`;

export default async function run(page) {
	// Translation ships switched off (settings.ts translationEnabled).
	await page.addInitScript(TRANSLATION_ON);
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

	const muted = await page.evaluate(MUTED);
	const ownInk = `getComputedStyle(document.querySelector("#msg-${OWN_UNCHANGED_MSG} .content")).color`;

	// Before any verdict, the own line reads dimmed like every own line.
	page.check("an own line is dimmed before the verdict", (await page.evaluate(ownInk)) === muted);

	const injected = [
		await page.evaluate(
			commit(SKIPPED_MSG, {status: "skipped", candidates: ["fr", "nl"], reason: "unsure"})
		),
		await page.evaluate(
			commit(OWN_UNCHANGED_MSG, {status: "failed", from: "pl", error: "came back unchanged"})
		),
		await page.evaluate(
			commit(UNCHANGED_MSG, {status: "failed", error: "came back unchanged"})
		),
		await page.evaluate(STAMP_MSGIDS),
	];
	page.check(
		"the translation entries injected",
		injected.every((v) => v === true)
	);
	// Give Vue its tick: a row that would render has rendered by then.
	await page.evaluate(
		`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`
	);

	page.check(
		"a line the detector could not place shows nothing",
		await page.evaluate(bare(SKIPPED_MSG))
	);
	page.check(
		"someone's line handed back unchanged shows nothing",
		await page.evaluate(bare(UNCHANGED_MSG))
	);
	page.check(
		"an own line handed back unchanged shows nothing and stays dimmed",
		(await page.evaluate(bare(OWN_UNCHANGED_MSG))) && (await page.evaluate(ownInk)) === muted
	);

	await page.evaluate(commit(SKIPPED_MSG, {status: "skipped", from: "en", reason: "same"}));
	await page.evaluate(
		`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`
	);
	page.check(
		"a line already in the reading language shows nothing",
		await page.evaluate(bare(SKIPPED_MSG))
	);
	await page.screenshot("translation-chips-bare");

	// A translated line shows the translation in the original's place, no
	// row of its own, with the flipper before it; one tap swaps them.
	await page.evaluate(
		commit(UNCHANGED_MSG, {status: "done", text: "a translated line", engine: "llm"})
	);
	await page.waitFor(`!!document.querySelector("#msg-${UNCHANGED_MSG} .msg-translate-flip")`, {
		label: "the translated line's flipper",
	});

	const row = `document.getElementById("msg-${UNCHANGED_MSG}")`;
	const replaced = await page.evaluate(`(() => {
		const r = ${row};
		return {
			text: r.querySelector(".content .msg-translated").textContent.trim(),
			rows: r.querySelectorAll(".msg-translation").length,
			title: r.querySelector(".msg-translate-flip").title,
			flips: document.querySelectorAll("#chat .msg-translate-flip").length,
		};
	})()`);
	console.log("replaced", JSON.stringify(replaced));
	page.check(
		"the translation stands in the original's place",
		replaced.text === "a translated line"
	);
	page.check("no translation row under the line", replaced.rows === 0);
	page.check("exactly one flipper on the page", replaced.flips === 1);
	page.check(
		'the flipper says where it came from ("Translated from German. Show the original")',
		replaced.title === "Translated from German. Show the original"
	);
	await page.screenshot("translation-chips-replaced");

	page.check(
		"the marker is no button",
		(await page.evaluate(`${row}.querySelector(".msg-translate-flip").tagName`)) === "SPAN"
	);
	await page.evaluate(`${row}.querySelector(".msg-flippable").click()`);
	await page.waitFor(`!${row}.querySelector(".msg-translated")`, {
		label: "a tap on the text swapped the original back",
	});
	page.check(
		"the original is back, the marker kept and dimmed",
		(await page.evaluate(
			`${row}.querySelector(".content").textContent.includes("a much longer line")`
		)) &&
			(await page.evaluate(
				`${row}.querySelector(".msg-translate-flip").classList.contains("original")`
			))
	);
	await page.evaluate(`${row}.querySelector(".msg-flippable").click()`);
	await page.waitFor(`!!${row}.querySelector(".msg-translated")`, {
		label: "a second tap brought the translation back",
	});
	await page.evaluate(`${row}.querySelector(".msg-flippable").click()`);
	await page.waitFor(`!${row}.querySelector(".msg-translated")`, {
		label: "and a third swapped the original back again",
	});

	const icons = await page.evaluate(ICONS);
	console.log("icons", JSON.stringify(icons, null, 1));

	page.check("the message action is on the page", icons.actionPresent === true);
	page.check("the message action's icon draws the language glyph", icons.actionCode === 0xf1ab);
	page.check("the sidebar's dev locale toggle is still the globe", icons.localeText === "🌐");

	await page.screenshot("translation-chips");
	page.check("no console errors", page.consoleErrors.length === 0);
}
