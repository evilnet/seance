import storage from "./localStorage";
import {config, createState} from "./settings";
import {migrateStoredSettings} from "./helpers/settingsMigration";
import {Store} from "vuex";
import {State} from "./store";

// Settings live in localStorage only. TheLounge additionally synced them to
// the server (`setting:set` / `setting:all`); there is no server any more, so
// localStorage is the single source of truth.
export function createSettingsStore(store: Store<State>) {
	return {
		namespaced: true,
		state: assignStoredSettings(createState(), loadFromLocalStorage()),
		mutations: {
			set(state, {name, value}) {
				state[name] = value;
			},
		},
		actions: {
			applyAll({state}) {
				for (const settingName in config) {
					config[settingName].apply(store, state[settingName], true);
				}
			},
			/** Settings that arrived switched on, off for an upgraded user who
			 * already chose what they override (helpers/settingsMigration.ts).
			 * boot.ts runs it once the deploy's default theme is known, before
			 * applyAll; what it turns off is stored at once, so the early theme
			 * loader (loading-error-handlers.js) reads the same answer. Only
			 * those keys are added to what was stored: writing the whole state
			 * would store the build's default theme too, and boot.ts gives the
			 * deploy's branded default only to a profile with no stored theme. */
			migrate({commit}, {defaultTheme}: {defaultTheme: string}) {
				const stored = loadFromLocalStorage();
				const migrated = migrateStoredSettings(stored, {
					...createState(),
					theme: defaultTheme,
				});
				let changed = false;

				for (const [name, value] of Object.entries(migrated)) {
					if (!(name in stored)) {
						commit("set", {name, value});
						changed = true;
					}
				}

				if (changed) {
					storage.set("settings", JSON.stringify(migrated));
				}
			},
			update({state, commit}, {name, value}) {
				if (state[name] === value) {
					return;
				}

				const settingConfig = config[name];

				// Trying to update a non existing setting (e.g. a stale key)
				if (!settingConfig) {
					return;
				}

				commit("set", {name, value});
				storage.set("settings", JSON.stringify(state));
				settingConfig.apply(store, value);
			},
		},
	};
}

function loadFromLocalStorage() {
	let storedSettings: Record<string, any> = {};

	try {
		storedSettings = JSON.parse(storage.get("settings") || "{}");
	} catch (e) {
		storage.remove("settings");
	}

	// Only an object holds settings; anything else (`5`, `"x"`, `null`, a
	// list) is a damaged entry and reads as nothing stored.
	if (
		typeof storedSettings !== "object" ||
		storedSettings === null ||
		Array.isArray(storedSettings)
	) {
		return {};
	}

	// Older The Lounge versions converted highlights to an array, turn it back into a string
	if (storedSettings.highlights !== null && typeof storedSettings.highlights === "object") {
		storedSettings.highlights = storedSettings.highlights.join(", ");
	}

	return storedSettings;
}

/**
 * Essentially Object.assign but does not overwrite and only assigns
 * if key exists in both supplied objects and types match
 *
 * @param {object} defaultSettings
 * @param {object} storedSettings
 */
function assignStoredSettings(
	defaultSettings: Record<string, any>,
	storedSettings: Record<string, any>
) {
	const newSettings = {...defaultSettings};

	for (const key in defaultSettings) {
		// Make sure the setting in local storage has the same type that the code expects
		if (
			typeof storedSettings[key] !== "undefined" &&
			typeof defaultSettings[key] === typeof storedSettings[key]
		) {
			newSettings[key] = storedSettings[key];
		}
	}

	return newSettings;
}
