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
