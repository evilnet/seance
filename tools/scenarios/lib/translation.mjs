// Translation ships switched off (client/js/settings.ts `translationEnabled`,
// translate/switch.ts): a scenario about translation switches it on before
// the app boots, with `await page.addInitScript(TRANSLATION_ON)` ahead of its
// first `goto`. The script runs at every document start, so it only sets the
// key when the stored settings do not have it yet: a scenario that switches
// translation off itself, or checks that a choice survives a reload, keeps
// what it stored. tools/scenarios/translate-off.mjs is the scenario about the
// switch itself, and starts without it.
//
// Settings keeps the engines, devices and downloads under a collapsed
// "Advanced: engines and storage" (TranslationOptions.vue), whose open state
// is a per-device convenience: the script leaves it open unless a scenario
// stored otherwise, so the scenarios that drive those controls find them.

export const TRANSLATION_ON = `(() => {
	try {
		let settings = {};

		try {
			const parsed = JSON.parse(localStorage.getItem("settings") || "{}");

			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				settings = parsed;
			}
		} catch (e) {}

		if (!("translationEnabled" in settings)) {
			settings.translationEnabled = true;
			localStorage.setItem("settings", JSON.stringify(settings));
		}

		if (localStorage.getItem("thelounge.state.translateAdvancedOpen") === null) {
			localStorage.setItem("thelounge.state.translateAdvancedOpen", "1");
		}
	} catch (e) {}
})()`;

// A conversation's translation sheet (TranslationSheet.vue) opens from the
// composer's language chip, or from the channel menu (the header's ⋮ →
// "Translation…"), which opens it on its switches with the language list
// closed. The helpers below are the menu's path.

/** The open translation sheet. */
export const SHEET = ".translation-sheet";

/** Open the channel menu's "Translation…" sheet and wait for it. */
export async function openTranslationSheet(page) {
	await page.click("#chat .header button.menu");
	await page.waitFor(`!!document.querySelector("#context-menu .context-menu-translate")`, {
		timeout: 5000,
		label: "the channel menu offers Translation…",
	});
	await page.click("#context-menu .context-menu-translate");
	await page.waitFor(`!!document.querySelector("${SHEET}")`, {
		timeout: 10000,
		label: "the translation sheet opens",
	});
}

/** Close the sheet by its ✕ and wait for it to go. */
export async function closeTranslationSheet(page) {
	await page.evaluate(`document.querySelector("${SHEET} .language-sheet-close").click()`);
	await page.waitFor(`!document.querySelector("${SHEET}")`, {
		timeout: 5000,
		label: "the translation sheet closes",
	});
}

/** Switch reading for the open conversation on or off through its sheet. */
export async function setReadingThroughSheet(page, on) {
	await openTranslationSheet(page);
	await page.evaluate(`(() => {
		const box = document.querySelector("${SHEET} .language-sheet-read-box");

		if (box.checked !== ${on}) {
			box.click();
		}
	})()`);
	await closeTranslationSheet(page);
}

/**
 * JS source: whether the open conversation reads in translation: translation
 * on, and the conversation not excluded (translate/switch.ts `readsHere`).
 */
export const READING_ON = `(() => {
	const store = document.getElementById("app")?.__vue_app__?.config.globalProperties.$store;
	const active = store?.state.activeChannel;

	if (!active || store.state.settings.translationEnabled !== true) {
		return false;
	}

	const entry =
		store.state.translateChannels[active.network.uuid + "/" + active.channel.name.toLowerCase()];

	return !(entry && entry.exclude);
})()`;

/** JS source: whether this conversation offers translation at all (the composer's button shows exactly then). */
export const TRANSLATION_OFFERED = `!!document.querySelector("#translate-once")`;

// "Show your translation" (Settings → Advanced, settings.ts
// `translatePreview`) pinned to "As you type": Automatic waits for Return
// where the draft's route is the language model (outgoing.ts
// `previewsWhileTyping`), so a scenario about the live preview pins it
// rather than depend on which model the fake routes a pair to. Run after
// TRANSLATION_ON; a scenario that stores its own choice keeps it.
export const PREVIEW_AS_TYPED = `(() => {
	try {
		const settings = JSON.parse(localStorage.getItem("settings") || "{}");

		if (settings && typeof settings === "object" && !("translatePreview" in settings)) {
			settings.translatePreview = "typing";
			localStorage.setItem("settings", JSON.stringify(settings));
		}
	} catch (e) {}
})()`;
