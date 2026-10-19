/**
 * Per-network oper preferences, in localStorage under `thelounge.oper`:
 * where each kind of server notice goes when the oper changed it from the
 * profile's default (for good, or for a while — "show here for 3 days"),
 * the snomask they chose (re-applied after every oper-up), and whether the
 * connection was opered last time — so a registration that brings no modes
 * (a held bouncer session attached, evilnet/nefarious2#121) asks for them.
 *
 * Preferences, not logs: the settings backup carries the key
 * (helpers/settingsBackup.ts). Kept free of store/DOM imports (mocha);
 * tests swap the backend with {@link useOperPrefsBackend}.
 */

import type {Route} from "../../../shared/types/oper";
import storage from "../localStorage";

export const OPER_PREFS_KEY = "thelounge.oper";

/** A route chosen for a while ("show here for 3 days"), then undone by itself. */
export interface TemporaryRoute {
	route: Route;
	/** Epoch ms when it lapses. */
	until: number;
	/** What `routes` held before (undefined: the profile's default), put back on expiry. */
	revert: Route | undefined;
}

export interface OperPrefs {
	/** Kind → route, only where the oper chose something else than the default. */
	routes?: Record<string, Route>;
	/** The snomask to apply after oper-up (decimal). */
	snomask?: number;
	/** Opered when the last connection ended. */
	wasOper?: boolean;
	/**
	 * Kind → a route in force until a time, over `routes`. Absent in prefs
	 * written before it existed, which load as if it were empty.
	 */
	temporary?: Record<string, TemporaryRoute>;
	/**
	 * The oper's own notes from the investigation cards, by what they are
	 * about: a channel name, an IP, an account (irc/investigate.ts
	 * `noteKey`). Local to this device, like the rest of the prefs.
	 */
	notes?: Record<string, string>;
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

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isRoute = (value: unknown): value is Route =>
	value === "active" || value === "network" || value === "off";

/** Drop `prefs[field]` unless it is an object, and each of its entries that `valid` rejects. */
function keepValid(
	prefs: Record<string, unknown>,
	field: string,
	valid: (value: unknown) => boolean
): void {
	const map = prefs[field];

	if (map === undefined) {
		return;
	}

	if (!isObject(map)) {
		delete prefs[field];
		return;
	}

	for (const [key, value] of Object.entries(map)) {
		if (!valid(value)) {
			delete map[key];
		}
	}
}

function readAll(): Record<string, OperPrefs> {
	try {
		const parsed: unknown = JSON.parse(backend.get(OPER_PREFS_KEY) ?? "{}");

		if (!isObject(parsed)) {
			return {};
		}

		// A restored settings file can carry anything here; a temporary route
		// without a numeric `until` made every sweep throw, for good, and a
		// string snomask went out as typed in `MODE <me> +s`.
		for (const [uuid, prefs] of Object.entries(parsed)) {
			if (!isObject(prefs)) {
				delete parsed[uuid];
				continue;
			}

			if (prefs.snomask !== undefined && !Number.isInteger(prefs.snomask)) {
				delete prefs.snomask;
			}

			if (prefs.wasOper !== undefined && typeof prefs.wasOper !== "boolean") {
				delete prefs.wasOper;
			}

			keepValid(prefs, "routes", (route) => isRoute(route));
			keepValid(prefs, "notes", (note) => typeof note === "string");
			keepValid(
				prefs,
				"temporary",
				(entry) =>
					isObject(entry) &&
					typeof entry.until === "number" &&
					isRoute(entry.route) &&
					(entry.revert === undefined || isRoute(entry.revert))
			);
		}

		return parsed as Record<string, OperPrefs>;
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

function putRoute(prefs: OperPrefs, kind: string, route: Route | undefined): void {
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
}

function putTemporary(prefs: OperPrefs, kind: string, entry: TemporaryRoute | undefined): void {
	const temporary = {...(prefs.temporary ?? {})};

	if (entry === undefined) {
		delete temporary[kind];
	} else {
		temporary[kind] = entry;
	}

	if (Object.keys(temporary).length > 0) {
		prefs.temporary = temporary;
	} else {
		delete prefs.temporary;
	}
}

/** Put back what a lapsed temporary route replaced. Returns whether anything lapsed. */
function revertExpired(prefs: OperPrefs, now: number, only?: string): boolean {
	let changed = false;

	for (const [kind, entry] of Object.entries(prefs.temporary ?? {})) {
		if ((only === undefined || only === kind) && entry.until <= now) {
			putRoute(prefs, kind, entry.revert);
			putTemporary(prefs, kind, undefined);
			changed = true;
		}
	}

	return changed;
}

/**
 * The route for `kind` on this network: a temporary choice still in force,
 * else the oper's choice, else `fallback`. A temporary route that has
 * lapsed is undone here, on the way past.
 */
export function routeFor(uuid: string, kind: string, fallback: Route, now = Date.now()): Route {
	const prefs = getOperPrefs(uuid);
	const temporary = prefs.temporary?.[kind];

	if (temporary) {
		if (temporary.until > now) {
			return temporary.route;
		}

		sweepTemporaryRoutes(uuid, now, kind);
		return getOperPrefs(uuid).routes?.[kind] ?? fallback;
	}

	return prefs.routes?.[kind] ?? fallback;
}

/** The temporary route in force for `kind`, if any. */
export function temporaryRouteFor(
	uuid: string,
	kind: string,
	now = Date.now()
): TemporaryRoute | undefined {
	const entry = getOperPrefs(uuid).temporary?.[kind];
	return entry && entry.until > now ? entry : undefined;
}

/**
 * Choose a route for `kind`; `undefined` (or the default) goes back to the
 * default. A choice made "until I change it" ends any temporary one.
 */
export function setRoute(uuid: string, kind: string, route: Route | undefined): void {
	update(uuid, (prefs) => {
		putTemporary(prefs, kind, undefined);
		putRoute(prefs, kind, route);
	});
}

/**
 * Choose a route for `kind` until `until` (epoch ms), after which what was
 * chosen before comes back. A second temporary choice keeps the first
 * one's point of return.
 */
export function setTemporaryRoute(uuid: string, kind: string, route: Route, until: number): void {
	update(uuid, (prefs) => {
		const previous = prefs.temporary?.[kind];
		const revert = previous ? previous.revert : prefs.routes?.[kind];
		putTemporary(prefs, kind, {route, until, revert});
	});
}

/** Undo every temporary route that has lapsed (one kind, or all). Returns whether any had. */
export function sweepTemporaryRoutes(uuid: string, now = Date.now(), only?: string): boolean {
	let changed = false;
	update(uuid, (prefs) => {
		changed = revertExpired(prefs, now, only);
	});
	return changed;
}

/** Every kind's route back to the profile default, temporary ones included. */
export function resetRoutes(uuid: string): void {
	update(uuid, (prefs) => {
		delete prefs.routes;
		delete prefs.temporary;
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

/** The note kept about `key` (a channel, an IP, an account) on this network, or "". */
export function getNote(uuid: string, key: string): string {
	const notes = getOperPrefs(uuid).notes ?? {};
	const k = key.toLowerCase();

	// Own keys only: `constructor` is a fine nick, and not a note.
	return Object.hasOwn(notes, k) ? notes[k] : "";
}

/** Keep (or, blank, drop) the note about `key`. */
export function setNote(uuid: string, key: string, text: string): void {
	update(uuid, (prefs) => {
		const k = key.toLowerCase();
		const entries = Object.entries(prefs.notes ?? {}).filter(([name]) => name !== k);

		if (text.trim() !== "") {
			entries.push([k, text.trim()]);
		}

		// fromEntries defines keys, so `__proto__` is a key like any other
		const notes = Object.fromEntries(entries);

		if (Object.keys(notes).length > 0) {
			prefs.notes = notes;
		} else {
			delete prefs.notes;
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
