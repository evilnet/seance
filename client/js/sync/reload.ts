/**
 * The stores that roam, told to read their storage again
 * (docs/projects/settings-sync.md § Applying what arrives): settings sync
 * writes another device's change to this device's localStorage, and the
 * running app takes it from there. The same reload runs on the `storage`
 * event, so two tabs stay in step for these stores too.
 *
 * Settings are not here: sync writes them through the settings store, which
 * applies them. Oper preferences are read from storage where they are used.
 */

import {reloadAvatarPrefs} from "../avatars/prefs";
import {reloadDnd} from "../dnd";
import {reloadFavorites} from "../favorites";
import {reloadTrustedMedia} from "../helpers/mediaTrust";
import {reloadIgnoreLists} from "../ignore";
import {collator} from "../i18n/collation";
import {reloadMutes} from "../mute";
import {applyStoredChannelOrder} from "../sort";
import {store} from "../store";
import {loadAll} from "../translate/channelStore";

const aliasListeners = new Set<() => void>();

/** Hear the stored aliases change under this page (Settings → Aliases). Returns the unsubscribe. */
export function onAliasesReloaded(listener: () => void): () => void {
	aliasListeners.add(listener);
	return () => aliasListeners.delete(listener);
}

/**
 * Each store's reload, by the key it keeps. `follows`: the store hears the
 * `storage` event by itself already (another tab's write).
 */
const RELOADS: Array<{match: (key: string) => boolean; reload: () => void; follows?: true}> = [
	{match: (key) => key === "thelounge.muted", reload: reloadMutes},
	{match: (key) => key.startsWith("thelounge.ignore."), reload: reloadIgnoreLists},
	{match: (key) => key === "thelounge.media.trusted", reload: reloadTrustedMedia},
	{match: (key) => key === "thelounge.avatars", reload: reloadAvatarPrefs},
	{
		match: (key) => key === "thelounge.sort.channels",
		reload() {
			for (const network of store.state.networks) {
				applyStoredChannelOrder(network, collator());
			}
		},
	},
	{
		match: (key) => key === "thelounge.translate",
		reload: () => store.commit("translateChannelsLoaded", loadAll()),
	},
	{
		match: (key) => key === "thelounge.aliases",
		reload() {
			for (const listener of aliasListeners) {
				listener();
			}
		},
	},
	{match: (key) => key === "thelounge.favorites", reload: reloadFavorites, follows: true},
	{match: (key) => key === "thelounge.dnd", reload: reloadDnd, follows: true},
];

/** Storage keys were written under the running app: their stores read them again. */
export function reloadStored(keys: readonly string[]): void {
	for (const entry of RELOADS) {
		if (keys.some((key) => entry.match(key))) {
			entry.reload();
		}
	}
}

let listening = false;

/** Follow another tab's writes for the stores that do not by themselves. */
export function followOtherTabs(): void {
	if (listening) {
		return;
	}

	listening = true;
	window.addEventListener("storage", (ev: StorageEvent) => {
		for (const entry of RELOADS) {
			// `key` is null when the other tab cleared all of storage.
			if (!entry.follows && (ev.key === null || entry.match(ev.key))) {
				entry.reload();
			}
		}
	});
}
