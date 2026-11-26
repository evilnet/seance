/**
 * What a device remembers about settings sync
 * (docs/projects/settings-sync.md § The home): which network is its sync
 * home and which account it syncs with there, the pointer it last applied,
 * and its own copy of the document, every entry with its time. Both live
 * under `thelounge.state.*`, which no settings backup carries and which
 * never roams. Every copy of the app on the device (two tabs, the installed
 * app and a tab) reads and writes the same two entries.
 *
 * No store and no DOM (test/sync/engine.ts).
 */

import {dict} from "../helpers/dict";
import type {Entries, Entry} from "./document";
import type {StorageBackend} from "./entries";

export const STATE_KEY = "thelounge.state.sync";
export const COPY_KEY = "thelounge.state.sync.entries";

export interface SyncState {
	/** The home network's uuid on this device, or null: sync is off. */
	home: string | null;
	/** The account this device syncs with at the home. */
	account: string;
	/** The device has merged with the account once: its entries carry times. */
	joined: boolean;
	/** The pointer value last applied or written. */
	pointer: string | null;
	/** When the device last merged with a file or uploaded one. */
	syncedAt: number;
	/** When a file was last uploaded, by this device or another. */
	uploadedAt: number;
	/** When something last changed on this device. */
	changedAt: number;
	/** The device holds something the file does not. */
	dirty: boolean;
	/** No upload before this time (the host asked, or an upload failed). */
	retryAt: number;
	/** A pointer this device would not read: said once, not fetched again. */
	refused: string | null;
	/** A newer format was seen: neither read nor write until the app is updated. */
	blocked: boolean;
	/** Why nothing is uploaded until the next change (`size`), or null. */
	stuck: string | null;
	/** Another account signed in at the home that the user chose not to sync with. */
	pausedFor: string;
	/** The host refused the last upload's type: said once. */
	saidRefusal: boolean;
	/** Networks the user said never to offer sync on, on this device. */
	never: string[];
}

export function defaultState(): SyncState {
	return {
		home: null,
		account: "",
		joined: false,
		pointer: null,
		syncedAt: 0,
		uploadedAt: 0,
		changedAt: 0,
		dirty: false,
		retryAt: 0,
		refused: null,
		blocked: false,
		stuck: null,
		pausedFor: "",
		saidRefusal: false,
		never: [],
	};
}

const text = (value: unknown, fallback: string): string =>
	typeof value === "string" ? value : fallback;
const time = (value: unknown): number =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
const textOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

export function readState(storage: StorageBackend): SyncState {
	let parsed: unknown;

	try {
		parsed = JSON.parse(storage.get(STATE_KEY) ?? "null");
	} catch {
		parsed = null;
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return defaultState();
	}

	const raw = parsed as Record<string, unknown>;
	return {
		home: typeof raw.home === "string" && raw.home !== "" ? raw.home : null,
		account: text(raw.account, ""),
		joined: raw.joined === true,
		pointer: textOrNull(raw.pointer),
		syncedAt: time(raw.syncedAt),
		uploadedAt: time(raw.uploadedAt),
		changedAt: time(raw.changedAt),
		dirty: raw.dirty === true,
		retryAt: time(raw.retryAt),
		refused: textOrNull(raw.refused),
		blocked: raw.blocked === true,
		stuck: textOrNull(raw.stuck),
		pausedFor: text(raw.pausedFor, ""),
		saidRefusal: raw.saidRefusal === true,
		never: Array.isArray(raw.never)
			? raw.never.filter((uuid): uuid is string => typeof uuid === "string")
			: [],
	};
}

export function writeState(storage: StorageBackend, state: SyncState): void {
	storage.set(STATE_KEY, JSON.stringify(state));
}

/** Change some of the stored state; returns the whole of it. */
export function updateState(storage: StorageBackend, patch: Partial<SyncState>): SyncState {
	const next = {...readState(storage), ...patch};
	writeState(storage, next);
	return next;
}

/** The device's copy of the document. */
export function readCopy(storage: StorageBackend): Entries {
	const entries = dict<Entry>();
	let parsed: unknown;

	try {
		parsed = JSON.parse(storage.get(COPY_KEY) ?? "null");
	} catch {
		return entries;
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return entries;
	}

	for (const [id, entry] of Object.entries(parsed as Record<string, unknown>)) {
		if (
			typeof entry === "object" &&
			entry !== null &&
			Number.isSafeInteger((entry as Entry).t)
		) {
			entries[id] = entry as Entry;
		}
	}

	return entries;
}

export function writeCopy(storage: StorageBackend, entries: Entries): void {
	storage.set(COPY_KEY, JSON.stringify(entries));
}

/** Sync off on this device: the home and the copy go, the "never" answers stay. */
export function clearSync(storage: StorageBackend): SyncState {
	const next = {...defaultState(), never: readState(storage).never};
	writeState(storage, next);
	storage.remove(COPY_KEY);
	return next;
}

/** A network was removed from this device: if it was the home, sync is off. */
export function forgetSyncNetwork(storage: StorageBackend, uuid: string): void {
	const state = readState(storage);

	if (state.home === uuid) {
		clearSync(storage);
	}

	const after = readState(storage);

	if (after.never.includes(uuid)) {
		writeState(storage, {...after, never: after.never.filter((u) => u !== uuid)});
	}
}

/** Two account names are one account: services fold case. */
export function sameAccount(a: string, b: string): boolean {
	return a.toLowerCase() === b.toLowerCase();
}
