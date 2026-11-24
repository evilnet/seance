/**
 * Favorites: the conversations the user starred (a channel's or a private
 * conversation's menu, helpers/contextMenu.ts), shown in their own block at
 * the top of the sidebar across networks and taken out of their network's
 * list (helpers/sidebarOrder.ts). Kept in `thelounge.favorites` as one JSON
 * array in the order the block shows them: network uuid, the conversation's
 * name as it was starred, and whether it is a channel or a query, which a
 * placeholder needs to know how to open it again (`/join` or `/query`).
 *
 * A favorite outlives its window: closing or parting the conversation, or a
 * network not connected on this page, leaves a placeholder in the block. It
 * goes when it is unstarred, or with its network (saved-networks.ts `remove`).
 *
 * Names compare as the network folds them (`CASEMAPPING`; rfc1459 where it is
 * not known, as before its 005), so on an ascii network `nick[` and `nick{`
 * are two favorites. Every mapping folds the ascii letters, so two entries
 * equal under ascii folding are one: that is a favorite's key
 * ({@link favoriteKey}), unique in the list. Its window is found as the
 * network folds names too (helpers/sidebarOrder.ts).
 *
 * Kept free of store and DOM imports so it runs under mocha; tests swap the
 * storage backend with {@link useStorageBackend}.
 */

import {shallowRef, type Ref} from "vue";
import storage from "./localStorage";
import {casefold, type CaseMapping} from "./irc/casemap";

export const FAVORITES_KEY = "thelounge.favorites";
/** `"true"` while the block is collapsed; absent when open. */
export const FAVORITES_COLLAPSED_KEY = "thelounge.favorites.collapsed";

export type FavoriteType = "channel" | "query";

export interface Favorite {
	/** The network's uuid (saved-networks.ts). */
	network: string;
	/** The channel or nick, as it was when starred. */
	name: string;
	type: FavoriteType;
}

/** The subset of the localStorage wrapper this module needs. */
export interface StorageBackend {
	get(key: string): string | null;
	set(key: string, value: string): void;
	remove(key: string): void;
}

let backend: StorageBackend = storage;

/** One favorite's key in the list: its network and its name, ascii-folded. */
export function favoriteKey(network: string, name: string): string {
	return `${network}\n${casefold(name, "ascii")}`;
}

function same(a: Favorite, network: string, name: string, mapping: CaseMapping): boolean {
	return a.network === network && casefold(a.name, mapping) === casefold(name, mapping);
}

/** What is stored, kept to well-formed entries, the first of any duplicate. */
export function parseFavorites(raw: string | null): Favorite[] {
	let parsed: unknown;

	try {
		parsed = JSON.parse(raw ?? "[]");
	} catch {
		return [];
	}

	if (!Array.isArray(parsed)) {
		return [];
	}

	const out: Favorite[] = [];

	for (const entry of parsed as unknown[]) {
		if (!entry || typeof entry !== "object") {
			continue;
		}

		const e = entry as Record<string, unknown>;

		if (
			typeof e.network !== "string" ||
			e.network === "" ||
			typeof e.name !== "string" ||
			e.name === "" ||
			(e.type !== "channel" && e.type !== "query")
		) {
			continue;
		}

		if (out.some((f) => same(f, e.network as string, e.name as string, "ascii"))) {
			continue;
		}

		out.push({network: e.network, name: e.name, type: e.type});
	}

	return out;
}

const state = shallowRef<readonly Favorite[]>(parseFavorites(backend.get(FAVORITES_KEY)));

/** Every favorite, in the block's order; replaced (never mutated) on a change. */
export const favorites: Readonly<Ref<readonly Favorite[]>> = state;

const collapsed = shallowRef(backend.get(FAVORITES_COLLAPSED_KEY) === "true");

/** Whether the block shows its header only (FavoriteList.vue). */
export const favoritesCollapsed: Readonly<Ref<boolean>> = collapsed;

/** Swap the persistence backend (tests); `null` restores localStorage. */
export function useStorageBackend(next: StorageBackend | null): void {
	backend = next ?? storage;
	reloadFavorites();
}

/** Read what is stored again: another tab wrote it (the `storage` event). */
export function reloadFavorites(): void {
	state.value = parseFavorites(backend.get(FAVORITES_KEY));
	collapsed.value = backend.get(FAVORITES_COLLAPSED_KEY) === "true";
}

export function setFavoritesCollapsed(value: boolean): void {
	if (value) {
		backend.set(FAVORITES_COLLAPSED_KEY, "true");
	} else {
		backend.remove(FAVORITES_COLLAPSED_KEY);
	}

	collapsed.value = value;
}

function write(next: Favorite[]): void {
	if (next.length === 0) {
		backend.remove(FAVORITES_KEY);
	} else {
		backend.set(FAVORITES_KEY, JSON.stringify(next));
	}

	state.value = next;
}

export function isFavorite(
	network: string,
	name: string,
	mapping: CaseMapping = "rfc1459"
): boolean {
	return state.value.some((f) => same(f, network, name, mapping));
}

/** Star a conversation: it joins the end of the block. Starred already: nothing. */
export function addFavorite(
	network: string,
	name: string,
	type: FavoriteType,
	mapping: CaseMapping = "rfc1459"
): void {
	if (isFavorite(network, name, mapping)) {
		return;
	}

	write([...state.value, {network, name, type}]);
}

/** Unstar one favorite, as it is stored (the row's, or the menu's window's). */
export function removeFavorite(favorite: Pick<Favorite, "network" | "name">): void {
	const key = favoriteKey(favorite.network, favorite.name);
	const next = state.value.filter((f) => favoriteKey(f.network, f.name) !== key);

	if (next.length !== state.value.length) {
		write(next);
	}
}

/**
 * Move the favorite at `from` to `to` (indexes into {@link favorites}), as a
 * drag in the block does. An index out of range changes nothing.
 */
export function moveFavorite(from: number, to: number): void {
	const list = [...state.value];

	if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) {
		return;
	}

	const [moved] = list.splice(from, 1);
	list.splice(to, 0, moved);
	write(list);
}

/** A network removed: its favorites go with it (saved-networks.ts `remove`). */
export function forgetNetworkFavorites(network: string): void {
	const next = state.value.filter((f) => f.network !== network);

	if (next.length !== state.value.length) {
		write(next);
	}
}

// Another tab (the installed app and a browser tab, two tabs) starred or
// moved one: follow it. Not under mocha, which has no window.
if (typeof window !== "undefined") {
	window.addEventListener("storage", (ev: StorageEvent) => {
		if (ev.key === FAVORITES_KEY || ev.key === FAVORITES_COLLAPSED_KEY || ev.key === null) {
			reloadFavorites();
		}
	});
}
