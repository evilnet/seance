import storage from "./localStorage";
import {config, createState} from "./settings";
import {migrateStoredSettings, readStoredSettings} from "./helpers/settingsMigration";
import {
	assignStoredSettings,
	parseStoredSettings,
	settingsToStore,
	storedChanges,
} from "./helpers/settingsSync";
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
			 * applyAll; what it decides, on or off, is stored at once, so the
			 * early theme loader (loading-error-handlers.js) reads the same
			 * answer from the next launch on. Only
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
				// Onto what is stored, not this tab's whole state: another tab
				// may have changed a setting this one has not caught up with
				// yet (helpers/settingsSync.ts).
				storage.set(
					"settings",
					JSON.stringify(
						settingsToStore(
							parseStoredSettings(storage.get("settings")),
							state,
							createState(),
							name,
							value
						)
					)
				);
				settingConfig.apply(store, value);
			},
			/** Another tab's write (the `storage` event, which fires only in
			 * the other tabs of this origin) is taken here: each setting it
			 * changed is set and applied, as applyAll does, so this tab shows
			 * what a reload would. boot.ts starts it after applyAll, once the
			 * themes are known. A page brought back from the back/forward
			 * cache missed the events in between and reads storage again. */
			watch({state, commit}) {
				const follow = (raw: string | null) => {
					const defaults: Record<string, unknown> = createState();
					const deployTheme = store.state.serverConfiguration?.defaultTheme;

					if (deployTheme) {
						defaults.theme = deployTheme;
					}

					const changes = storedChanges(parseStoredSettings(raw), state, defaults);

					// All set before any is applied: an apply() can read
					// another setting (the theme reads matchSystemAppearance).
					for (const [name, value] of changes) {
						commit("set", {name, value});
					}

					// `auto`, as at boot: nobody here asked for the change,
					// so keepConnected does not prompt.
					for (const [name, value] of changes) {
						config[name].apply(store, value, true);
					}
				};

				window.addEventListener("storage", (ev: StorageEvent) => {
					// `key` is null when another tab cleared all of storage
					// (Auth.signout). What is stored now, not the event's
					// newValue: this tab may have written a change of its own
					// since the other tab's write, and newValue would take
					// it back. Nothing stored (cleared, or the entry
					// removed) reads as defaults.
					if (ev.key === "settings" || ev.key === null) {
						follow(storage.get("settings"));
					}
				});
				window.addEventListener("pageshow", (ev: PageTransitionEvent) => {
					if (ev.persisted) {
						follow(storage.get("settings"));
					}
				});
			},
		},
	};
}

function loadFromLocalStorage() {
	let storedSettings: unknown = {};

	try {
		storedSettings = JSON.parse(storage.get("settings") || "{}");
	} catch (e) {
		storage.remove("settings");
	}

	return readStoredSettings(storedSettings);
}
