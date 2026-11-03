/**
 * When each network was last in sync with the account's shared presence on
 * this device, kept across reloads in `thelounge.state.presenceSync`: one
 * JSON map of network uuid → Unix ms of the last line received on a
 * connection that had read the shared state (and so heard every change
 * through its subscription). presence.ts `shareUnread` holds a login away
 * until its read only when this is missing or older than
 * {@link SYNC_WINDOW_MS}: then the device may have missed a change made
 * elsewhere — the global Away — and declaring its own state would show the
 * account back. A reload or a quick reconnect is inside the window and
 * declares its state as it always did, so a present device's reload is not
 * an away blip either.
 *
 * Dated by the last line in, not by the close: a socket the OS killed in the
 * background reports its close only when the page wakes up, long after it
 * last heard anything. Written at most every {@link STAMP_EVERY_MS} (and at
 * the close), so a page that is reloaded or killed outright leaves a time
 * that is at most that stale. `thelounge.state.*` is never carried by the
 * settings backup; the entry is forgotten with the network.
 *
 * Kept free of store imports so it runs under mocha; tests swap the storage
 * backend with {@link useStorageBackend}.
 */

import storage from "../localStorage";
// Type only: saved-networks.ts imports this module for its forget function.
import type {StorageBackend} from "./saved-networks";
import {dict} from "../helpers/dict";

export const PRESENCE_SYNC_KEY = "thelounge.state.presenceSync";

/**
 * How long out of sync a device may have been and still trust its own
 * state: a reload, or a reconnect (the retry wait is capped near 60 s).
 * A change another device makes inside it still shows at this one's login.
 */
export const SYNC_WINDOW_MS = 120_000;

/** How often a live, in-sync connection writes its time down. */
export const STAMP_EVERY_MS = 15_000;

let backend: StorageBackend = storage;

/** Swap the persistence backend (tests); `null` restores localStorage. */
export function useStorageBackend(next: StorageBackend | null): void {
	backend = next ?? storage;
}

function readAll(): Record<string, number> {
	let parsed: unknown;

	try {
		parsed = JSON.parse(backend.get(PRESENCE_SYNC_KEY) ?? "{}");
	} catch {
		return dict<number>();
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return dict<number>();
	}

	const out = dict<number>();

	for (const [uuid, at] of Object.entries(parsed as Record<string, unknown>)) {
		if (typeof at === "number" && Number.isFinite(at)) {
			out[uuid] = at;
		}
	}

	return out;
}

function writeAll(all: Record<string, number>): void {
	if (Object.keys(all).length === 0) {
		backend.remove(PRESENCE_SYNC_KEY);
	} else {
		backend.set(PRESENCE_SYNC_KEY, JSON.stringify(all));
	}
}

/** When `uuid` was last in sync on this device, or null. */
export function lastInSync(uuid: string): number | null {
	return readAll()[uuid] ?? null;
}

/** Remember that `uuid` was in sync at `at`. */
export function setInSync(uuid: string, at: number): void {
	const all = readAll();
	all[uuid] = at;
	writeAll(all);
}

/** The network was removed. */
export function forgetPresenceSync(uuid: string): void {
	const all = readAll();

	if (uuid in all) {
		delete all[uuid];
		writeAll(all);
	}
}

/** Whether a device last in sync at `at` may have missed a change by `now`. */
export function mayHaveMissed(at: number | null, now: number): boolean {
	return at === null || now - at > SYNC_WINDOW_MS;
}
