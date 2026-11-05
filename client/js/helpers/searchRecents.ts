/**
 * The searches this device has run lately, newest first, shown under the
 * search panel's empty field (Windows/SearchResults.vue). A search counts once
 * it was meant: Enter in the field, or a hit opened from it. What typing
 * searches on its own along the way is not kept.
 *
 * Only on this device, in localStorage; nothing here touches the store or the
 * DOM, and the backend is swappable, so mocha covers it
 * (test/helpers/searchRecents.ts).
 */

import storage from "../localStorage";

export const STORAGE_KEY = "thelounge.search.recent";

/** How many are remembered. */
export const MAX_RECENT = 10;

/** The subset of the localStorage wrapper this module needs. */
export interface StorageBackend {
	get(key: string): string | null;
	set(key: string, value: string): void;
	remove(key: string): void;
}

let backend: StorageBackend = storage;

/** Swap the persistence backend (tests); `null` restores localStorage. */
export function useStorageBackend(next: StorageBackend | null): void {
	backend = next ?? storage;
}

/** `query` in front of `list`, once, and the tail cut to `limit`. Blank is ignored. */
export function mergeRecent(list: string[], query: string, limit = MAX_RECENT): string[] {
	const q = query.trim().replace(/\s+/g, " ");

	if (!q) {
		return list.slice(0, limit);
	}

	return [q, ...list.filter((entry) => entry !== q)].slice(0, limit);
}

/** The stored list, newest first. Anything unreadable is treated as empty. */
export function recentSearches(): string[] {
	const raw = backend.get(STORAGE_KEY);

	if (!raw) {
		return [];
	}

	try {
		const parsed: unknown = JSON.parse(raw);

		if (!Array.isArray(parsed)) {
			throw new Error("not a list");
		}

		return parsed
			.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
			.slice(0, MAX_RECENT);
	} catch {
		backend.remove(STORAGE_KEY);
		return [];
	}
}

/** Remember `query`; returns the new list. */
export function rememberSearch(query: string): string[] {
	const next = mergeRecent(recentSearches(), query);

	if (next.length) {
		backend.set(STORAGE_KEY, JSON.stringify(next));
	}

	return next;
}

export function forgetSearches(): void {
	backend.remove(STORAGE_KEY);
}
