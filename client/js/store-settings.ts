import storage from "./localStorage";
import {config, createState} from "./settings";
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

/** Set once the ps theme's old default frame rate has been let go (loadFromLocalStorage). */
export const PS_DEFAULT_60_KEY = "thelounge.state.psDefault60";

function loadFromLocalStorage() {
	let storedSettings: Record<string, any> = {};

	try {
		storedSettings = JSON.parse(storage.get("settings") || "{}");
	} catch (e) {
		storage.remove("settings");
	}

	if (!storedSettings) {
		return {};
	}

	// Older The Lounge versions converted highlights to an array, turn it back into a string
	if (storedSettings.highlights !== null && typeof storedSettings.highlights === "object") {
		storedSettings.highlights = storedSettings.highlights.join(", ");
	}

	// The ps theme drew at 24 frames a second by default until 2026-10-08, and
	// the settings object is stored whole once any setting changes, so a stored
	// "24" is almost always that old default: it gives way to the new one, once.
	// A "24" chosen after this has run stays.
	if (storage.get(PS_DEFAULT_60_KEY) !== "1") {
		if (storedSettings.psAnimation === "24") {
			delete storedSettings.psAnimation;
		}

		storage.set(PS_DEFAULT_60_KEY, "1");
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
