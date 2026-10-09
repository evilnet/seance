import {themePartner} from "./themeAppearance";

// Settings that arrive switched on can override a choice the user already
// made. Each one here is paired with the setting it stands in for:
// matchSystemTextSize replaces the font-size step, matchSystemAppearance the
// picked theme's light/dark half.
const OVERRIDES: Record<string, string> = {
	matchSystemTextSize: "fontSize",
	matchSystemAppearance: "theme",
};

/**
 * Would switching `setting` on override a choice `settings` records? A
 * `fontSize` or `theme` that differs from its default is one the user
 * picked; matchSystemAppearance overrides only a theme that has a light/dark
 * partner (helpers/themeAppearance.ts), since an unpaired theme is shown as
 * chosen either way. `defaults.theme` is the deploy's default (config.json
 * `theme`), not the build's: boot.ts stores the branded default before the
 * user picks anything.
 *
 * The one rule for every place that turns these settings on for someone who
 * did not ask: the migration below, a settings restore on another platform
 * (helpers/settingsBackup.ts), and the early theme loader
 * (loading-error-handlers.js, which cannot import and repeats it).
 */
export function overridesChoice(
	setting: string,
	settings: Record<string, unknown>,
	defaults: Record<string, unknown>
): boolean {
	const overridden = OVERRIDES[setting];

	if (!overridden || !(overridden in settings)) {
		return false;
	}

	const value = settings[overridden];

	if (value === defaults[overridden]) {
		return false;
	}

	return overridden !== "theme" || (typeof value === "string" && themePartner(value) !== null);
}

/**
 * Starts a new on-by-default setting switched off for a user whose stored
 * settings predate it and who already chose what it would override
 * (overridesChoice).
 *
 * `update()` stores the whole settings object on every change, so a stored
 * object without the new key was saved before the setting existed. The
 * caller (store-settings.ts `migrate`, run by boot.ts once branding has
 * loaded) passes the deploy's default theme in `defaults`. A fresh install
 * (nothing stored) and a user who never touched the overridden setting get
 * the new default. Returns the stored object with the keys it turned off
 * added.
 */
export function migrateStoredSettings(
	stored: unknown,
	defaults: Record<string, unknown>
): Record<string, unknown> {
	// A damaged entry (a number, a string, a list) holds no settings.
	if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
		return {};
	}

	const migrated: Record<string, unknown> = {...stored};

	for (const setting of Object.keys(OVERRIDES)) {
		if (setting in stored || defaults[setting] !== true) {
			continue;
		}

		if (overridesChoice(setting, migrated, defaults)) {
			migrated[setting] = false;
		}
	}

	return migrated;
}
