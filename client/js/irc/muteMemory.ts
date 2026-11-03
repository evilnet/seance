/**
 * What this device last did to each network's `*` push-mute entry (do not
 * disturb), kept across reloads in `thelounge.state.dndMute`: one JSON map
 * of network uuid → `{ownedUntil, confirmedUntil}` (unix seconds or null).
 * `ownedUntil` is the `*` end this device last wrote, `confirmedUntil` the
 * last of its writes the server echoed back. With them the GET after a
 * reload or a reconnect can tell our own entry from another device's, an
 * entry another device cleared from one we never managed to write
 * (irc/pushMute.ts `onMuteValue`). `thelounge.state.*` is never carried by
 * the settings backup.
 *
 * Kept free of store imports so it runs under mocha; tests swap the storage
 * backend with {@link useStorageBackend}.
 */

import storage from "../localStorage";
// Type only: saved-networks.ts imports this module for its forget function.
import type {StorageBackend} from "./saved-networks";
import {dict} from "../helpers/dict";

export const MUTE_MEMORY_KEY = "thelounge.state.dndMute";

export interface MuteMemory {
	ownedUntil: number | null;
	confirmedUntil: number | null;
}

let backend: StorageBackend = storage;

/** Swap the persistence backend (tests); `null` restores localStorage. */
export function useStorageBackend(next: StorageBackend | null): void {
	backend = next ?? storage;
}

const finite = (v: unknown): number | null =>
	typeof v === "number" && Number.isFinite(v) ? v : null;

function readAll(): Record<string, MuteMemory> {
	let parsed: unknown;

	try {
		parsed = JSON.parse(backend.get(MUTE_MEMORY_KEY) ?? "{}");
	} catch {
		return dict<MuteMemory>();
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return dict<MuteMemory>();
	}

	const out = dict<MuteMemory>();

	for (const [uuid, raw] of Object.entries(parsed as Record<string, unknown>)) {
		if (raw && typeof raw === "object") {
			const r = raw as Record<string, unknown>;
			out[uuid] = {
				ownedUntil: finite(r.ownedUntil),
				confirmedUntil: finite(r.confirmedUntil),
			};
		}
	}

	return out;
}

function writeAll(all: Record<string, MuteMemory>): void {
	if (Object.keys(all).length === 0) {
		backend.remove(MUTE_MEMORY_KEY);
	} else {
		backend.set(MUTE_MEMORY_KEY, JSON.stringify(all));
	}
}

export function getMuteMemory(uuid: string): MuteMemory {
	return readAll()[uuid] ?? {ownedUntil: null, confirmedUntil: null};
}

/**
 * Remember a network's entry; one that says nothing is dropped, and so is
 * any network's whose ends have both passed (an entry is never more than
 * 30 days ahead, so the map stays small without a sweep of its own).
 */
export function setMuteMemory(uuid: string, memory: MuteMemory, nowSec: number): void {
	const all = readAll();
	const live = (v: number | null) => v !== null && v > nowSec;

	for (const [key, m] of Object.entries(all)) {
		if (!live(m.ownedUntil) && !live(m.confirmedUntil)) {
			delete all[key];
		}
	}

	const ownedUntil = finite(memory.ownedUntil);
	const confirmedUntil = finite(memory.confirmedUntil);

	if (ownedUntil === null && confirmedUntil === null) {
		delete all[uuid];
	} else {
		all[uuid] = {ownedUntil, confirmedUntil};
	}

	writeAll(all);
}

/** The network was removed. */
export function forgetMuteMemory(uuid: string): void {
	const all = readAll();

	if (all[uuid]) {
		delete all[uuid];
		writeAll(all);
	}
}
