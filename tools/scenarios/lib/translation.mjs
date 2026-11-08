// Translation ships switched off (client/js/settings.ts `translationEnabled`,
// translate/switch.ts): a scenario about translation switches it on before
// the app boots, with `await page.addInitScript(TRANSLATION_ON)` ahead of its
// first `goto`. The script runs at every document start, so it only sets the
// key when the stored settings do not have it yet: a scenario that switches
// translation off itself, or checks that a choice survives a reload, keeps
// what it stored. tools/scenarios/translate-off.mjs is the scenario about the
// switch itself, and starts without it.

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
	} catch (e) {}
})()`;

// A channel's translation choices open from the channel menu (the header's
// ⋮ → "Translation…"; there is no translate button in the header). The
// helpers below are that path and what the header's lit button used to
// show: whether the open conversation reads in translation.

/** Open the channel menu's "Translation…" panel and wait for it. */
export async function openTranslationPanel(page) {
	await page.click("#chat .header button.menu");
	await page.waitFor(`!!document.querySelector("#context-menu .context-menu-translate")`, {
		timeout: 5000,
		label: "the channel menu offers Translation…",
	});
	await page.click("#context-menu .context-menu-translate");
	await page.waitFor(`!!document.querySelector(".translation-panel")`, {
		timeout: 10000,
		label: "the translation panel opens",
	});
}

/** Close the panel by its ✕ and wait for it to go. */
export async function closeTranslationPanel(page) {
	await page.evaluate(
		`document.querySelector(".translation-panel .header-popover-close").click()`
	);
	await page.waitFor(`!document.querySelector(".translation-panel")`, {
		timeout: 5000,
		label: "the translation panel closes",
	});
}

/** Switch reading for the open conversation on or off through its panel. */
export async function setReadingThroughPanel(page, on) {
	await openTranslationPanel(page);
	// The reading switch is the panel's first radiogroup: Off, then On.
	await page.evaluate(
		`document.querySelectorAll(".translation-panel [role=radiogroup]")[0].querySelectorAll("[role=radio]")[${
			on ? 1 : 0
		}].click()`
	);
	await closeTranslationPanel(page);
}

/** JS source: whether the open conversation reads in translation (the store's entry). */
export const READING_ON = `(() => {
	const store = document.getElementById("app")?.__vue_app__?.config.globalProperties.$store;
	const active = store?.state.activeChannel;

	if (!active) {
		return false;
	}

	const entry =
		store.state.translateChannels[active.network.uuid + "/" + active.channel.name.toLowerCase()];

	return !!(entry && entry.read);
})()`;

/** JS source: whether this conversation offers translation at all (the composer's button shows exactly then). */
export const TRANSLATION_OFFERED = `!!document.querySelector("#translate-once")`;
