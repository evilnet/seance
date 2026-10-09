/**
 * Per-network oper preferences, in localStorage under `thelounge.oper`:
 * where each kind of server notice goes when the oper changed it from the
 * profile's default, the snomask they chose (re-applied after every
 * oper-up), and whether this connection was opered last time (so the next
 * registration asks the server what it still is).
 *
 * Preferences, not logs: the settings backup carries the key
 * (helpers/settingsBackup.ts). Kept free of store/DOM imports (mocha);
 * tests swap the backend with {@link useOperPrefsBackend}.
 */

import type {Route} from "../../../shared/types/oper";
import storage from "../localStorage";

export const OPER_PREFS_KEY = "thelounge.oper";

export interface OperPrefs {
	/** Kind → route, only where the oper chose something else than the default. */
	routes?: Record<string, Route>;
	/** The snomask to apply after oper-up (decimal). */
	snomask?: number;
	/** Opered when the last connection ended. */
	wasOper?: boolean;
}

interface Backend {
	get(key: string): string | null;
	set(key: string, value: string): void;
}

let backend: Backend = storage;

/** Swap the persistence backend (tests); `null` restores localStorage. */
export function useOperPrefsBackend(next: Backend | null): void {
	backend = next ?? storage;
}

function readAll(): Record<string, OperPrefs> {
	try {
		const parsed: unknown = JSON.parse(backend.get(OPER_PREFS_KEY) ?? "{}");
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, OperPrefs>)
			: {};
	} catch {
		return {};
	}
}

function writeAll(all: Record<string, OperPrefs>): void {
	backend.set(OPER_PREFS_KEY, JSON.stringify(all));
}

function update(uuid: string, change: (prefs: OperPrefs) => void): void {
	const all = readAll();
	const prefs = all[uuid] ?? {};
	change(prefs);

	if (Object.keys(prefs).length === 0) {
		delete all[uuid];
	} else {
		all[uuid] = prefs;
	}

	writeAll(all);
}

export function getOperPrefs(uuid: string): OperPrefs {
	return readAll()[uuid] ?? {};
}

/** The route for `kind` on this network: the oper's choice, else `fallback`. */
export function routeFor(uuid: string, kind: string, fallback: Route): Route {
	return getOperPrefs(uuid).routes?.[kind] ?? fallback;
}

/** Choose a route for `kind`; `undefined` (or the default) goes back to the default. */
export function setRoute(uuid: string, kind: string, route: Route | undefined): void {
	update(uuid, (prefs) => {
		const routes = {...(prefs.routes ?? {})};

		if (route === undefined) {
			delete routes[kind];
		} else {
			routes[kind] = route;
		}

		if (Object.keys(routes).length > 0) {
			prefs.routes = routes;
		} else {
			delete prefs.routes;
		}
	});
}

/** Every kind's route back to the profile default. */
export function resetRoutes(uuid: string): void {
	update(uuid, (prefs) => {
		delete prefs.routes;
	});
}

export function setSnomaskPref(uuid: string, snomask: number | undefined): void {
	update(uuid, (prefs) => {
		if (snomask === undefined) {
			delete prefs.snomask;
		} else {
			prefs.snomask = snomask;
		}
	});
}

export function setWasOper(uuid: string, wasOper: boolean): void {
	if (Boolean(getOperPrefs(uuid).wasOper) === wasOper) {
		return;
	}

	update(uuid, (prefs) => {
		if (wasOper) {
			prefs.wasOper = true;
		} else {
			delete prefs.wasOper;
		}
	});
}

/** The network was removed. */
export function forgetOperPrefs(uuid: string): void {
	const all = readAll();

	if (all[uuid]) {
		delete all[uuid];
		writeAll(all);
	}
}
