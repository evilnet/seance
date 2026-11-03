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
 * The stored settings object as the store reads it. Only an object holds
 * settings; anything else (`5`, `"x"`, `null`, a list) is a damaged entry and
 * reads as nothing stored. Older The Lounge versions kept `highlights` as a
 * list, which is joined back into the string the setting is — its strings
 * only: a restored file can hold anything there, and `{}` (no `join`) or an
 * element that cannot become a string threw here and kept the app from
 * starting until its storage was cleared. Any other wrong type is left for
 * the store, which keeps a stored value only when its type matches the
 * default's.
 */
export function readStoredSettings(stored: unknown): Record<string, any> {
	if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
		return {};
	}

	const settings = stored as Record<string, any>;

	if (Array.isArray(settings.highlights)) {
		settings.highlights = settings.highlights
			.filter((word: unknown) => typeof word === "string")
			.join(", ");
	}

	return settings;
}

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
 * (nothing stored) gets the new default, and so does a user who never
 * touched the overridden setting, recorded as `true`: the early theme loader
 * cannot see the deploy's default and guesses from the build's until a
 * stored answer tells it. Returns the stored object with the keys it decided
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

	// Nothing stored: boot.ts stores the whole state for a fresh profile.
	if (Object.keys(stored).length === 0) {
		return {};
	}

	const migrated: Record<string, unknown> = {...stored};

	for (const setting of Object.keys(OVERRIDES)) {
		if (setting in stored || defaults[setting] !== true) {
			continue;
		}

		migrated[setting] = !overridesChoice(setting, migrated, defaults);
	}

	return migrated;
}
