/**
 * The user's own `/away` text per network, kept across reloads in
 * `thelounge.state.away`: one JSON map of network uuid → the text the
 * `/away` sent (`" "` for a bare `/away`). A reload, like a reconnect,
 * declares it again during registration (`draft/pre-away`, presence.ts
 * `registrationAwayLine`), so nefarious2's bouncer never announces the
 * held session as back. `/back` forgets it, and so does removing the
 * network. `thelounge.state.*` is never carried by the settings backup.
 * The memory is this device's: a `/back` on another device does not reach
 * it.
 *
 * Kept free of store imports so it runs under mocha; tests swap the storage
 * backend with {@link useStorageBackend}.
 */

import storage from "../localStorage";
// Type only: saved-networks.ts imports this module for its forget function.
import type {StorageBackend} from "./saved-networks";
import {dict} from "../helpers/dict";

export const USER_AWAY_KEY = "thelounge.state.away";

let backend: StorageBackend = storage;

/** Swap the persistence backend (tests); `null` restores localStorage. */
export function useStorageBackend(next: StorageBackend | null): void {
	backend = next ?? storage;
}

function readAll(): Record<string, string> {
	let parsed: unknown;

	try {
		parsed = JSON.parse(backend.get(USER_AWAY_KEY) ?? "{}");
	} catch {
		return dict<string>();
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return dict<string>();
	}

	const out = dict<string>();

	for (const [uuid, text] of Object.entries(parsed as Record<string, unknown>)) {
		if (typeof text === "string" && text !== "") {
			out[uuid] = text;
		}
	}

	return out;
}

function writeAll(all: Record<string, string>): void {
	if (Object.keys(all).length === 0) {
		backend.remove(USER_AWAY_KEY);
	} else {
		backend.set(USER_AWAY_KEY, JSON.stringify(all));
	}
}

/** The away text `/away` set on this network, or null when none is in force. */
export function getUserAway(uuid: string): string | null {
	return readAll()[uuid] ?? null;
}

/** `/away <text>`: remember it. */
export function setUserAway(uuid: string, text: string): void {
	const all = readAll();
	all[uuid] = text;
	writeAll(all);
}

/** `/back`, or the network was removed. */
export function forgetUserAway(uuid: string): void {
	const all = readAll();

	if (uuid in all) {
		delete all[uuid];
		writeAll(all);
	}
}

/**
 * Drop the entries of every network not in `keep` (boot: the saved
 * networks and whatever is already connected). A network the user never
 * saved is not reconnected after a reload, so its `/away` would otherwise
 * stay in the map for good.
 */
export function pruneUserAway(keep: Iterable<string>): void {
	const all = readAll();
	const wanted = new Set(keep);
	let changed = false;

	for (const uuid of Object.keys(all)) {
		if (!wanted.has(uuid)) {
			delete all[uuid];
			changed = true;
		}
	}

	if (changed) {
		writeAll(all);
	}
}
