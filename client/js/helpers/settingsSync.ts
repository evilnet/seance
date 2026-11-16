import {readStoredSettings} from "./settingsMigration";

// Every copy of the app on this origin (two tabs, the installed app and a
// browser tab) shares one stored `settings` object and keeps its own copy in
// memory. Each copy writes only the setting it changed, onto what is stored
// (settingsToStore), and takes the others' writes as they land (storedChanges,
// store-settings.ts `watch`). Before, a copy wrote its whole in-memory object,
// and one that had not seen another's change put the old value back.
// No store and no DOM here, so mocha can load it (test/helpers/settingsSync.ts).

type Settings = Record<string, unknown>;

/** The stored `settings` entry, as localStorage holds it, read the way the
 * store reads it: no entry, JSON that does not parse and JSON that is not an
 * object all hold nothing (readStoredSettings). */
export function parseStoredSettings(raw: string | null): Record<string, any> {
	if (raw === null) {
		return {};
	}

	try {
		return readStoredSettings(JSON.parse(raw));
	} catch {
		return {};
	}
}

/** A stored value counts only when it has the type the code expects: the
 * type of the setting's default. */
function usable(stored: Settings, defaults: Settings, key: string): boolean {
	return typeof stored[key] !== "undefined" && typeof stored[key] === typeof defaults[key];
}

/**
 * The settings a copy of the app shows for what is stored: each setting
 * `defaults` knows takes its stored value when that has the default's type,
 * and the default otherwise. Keys this build does not know are left out.
 */
export function assignStoredSettings(defaults: Settings, stored: Settings): Settings {
	const settings: Settings = {...defaults};

	for (const key in defaults) {
		if (usable(stored, defaults, key)) {
			settings[key] = stored[key];
		}
	}

	return settings;
}

/**
 * What `update` writes when this copy changes `name` to `value`: what is
 * stored, so a copy that has not caught up with another's change cannot undo
 * it, and this copy's own value for anything stored without a usable value.
 *
 * The result is a whole settings object, one key for every setting this build
 * knows, as before: the upgrade migration (settingsMigration.ts
 * `migrateStoredSettings`) reads a stored object without a key as one saved
 * before that setting existed, and boot.ts gives the deploy's branded theme
 * only to a profile with no stored `theme`. Keys this build does not know are
 * dropped, as before: removed settings are migrated from the stored object
 * (settings.ts `migrateReadingToLocale`, saved-networks.ts
 * `migrateGlobalNotify`) until the store's first write takes them away.
 */
export function settingsToStore(
	stored: Settings,
	state: Settings,
	defaults: Settings,
	name: string,
	value: unknown
): Settings {
	const settings: Settings = {};

	for (const key in defaults) {
		settings[key] = usable(stored, defaults, key) ? stored[key] : state[key];
	}

	settings[name] = value;
	return settings;
}

/** Settings are JSON: a list (translateAlsoRead) read back from storage is a
 * new array, equal by content. */
function sameSetting(a: unknown, b: unknown): boolean {
	if (a === b) {
		return true;
	}

	return (
		typeof a === "object" &&
		typeof b === "object" &&
		a !== null &&
		b !== null &&
		JSON.stringify(a) === JSON.stringify(b)
	);
}

/**
 * The settings another copy's write changes here: every setting whose usable
 * stored value differs from this copy's `state`.
 *
 * An emptied entry (another copy signed out and cleared storage, or restored
 * a file with no settings) takes every setting back to its default, as a
 * reload would. Keeping this copy's values instead would write them back with
 * its next change and undo the clear.
 *
 * A setting missing from a stored object that holds others keeps this copy's
 * value: the write came from a copy on another build that does not know the
 * setting (settingsToStore drops what a build does not know), and taking it
 * as a reset would switch the setting off here too. This copy's next write
 * stores it again, as settingsToStore fills it from `state`.
 *
 * `defaults` is what a fresh profile gets on this deploy: createState() with
 * the deploy's default theme, which boot.ts stores for a profile that has
 * none.
 */
export function storedChanges(
	stored: Settings,
	state: Settings,
	defaults: Settings
): Array<[string, unknown]> {
	const emptied = Object.keys(stored).length === 0;
	const changes: Array<[string, unknown]> = [];

	for (const key in defaults) {
		const value = usable(stored, defaults, key)
			? stored[key]
			: emptied
			? defaults[key]
			: state[key];

		if (!sameSetting(value, state[key])) {
			changes.push([key, value]);
		}
	}

	return changes;
}
