/**
 * LIST replies (321/322/323) → the "Channel List" special window, as
 * attic/server/plugins/irc-events/list.ts did: a status line while loading,
 * then the channels sorted by user count (capped at {@link MAX_CHANS}).
 *
 * Also home to {@link showSpecial}, the create-or-update helper every
 * `ChanType.SPECIAL` window (channel list, ignore list) goes through.
 */

import {t, tCount} from "../../i18n/core";
import {ChanType, SpecialChanType} from "../../../../shared/types/chan";
import type {Channel} from "../channel";
import type {IrcClient} from "../client";
import type {Handler} from "../types";

export const MAX_CHANS = 500;

export interface ChannelListEntry {
	channel: string;
	num_users: number;
	topic: string;
}

/** What `Special/ListChannels.vue` renders: a status line or the rows. */
export type ChannelListData = {text: string} | ChannelListEntry[];

/** Payload shape of `msg:special` / `SharedChan.data`. */
export type SpecialData = Record<string, any>;

const caches = new WeakMap<IrcClient, ChannelListEntry[]>();

function cacheFor(client: IrcClient): ChannelListEntry[] {
	let cache = caches.get(client);

	if (!cache) {
		cache = [];
		caches.set(client, cache);
	}

	return cache;
}

/** Forget any partially received list (called by `/list`). */
export function resetChannelList(client: IrcClient): void {
	caches.delete(client);
}

/**
 * Create the special window for `special` (and, for a per-channel list,
 * `target`), announcing it with `join` and not opening it — or, when it
 * already exists, replace its data and dispatch `msg:special` (which the UI
 * answers by navigating to it).
 *
 * The window is found by what it shows, never by `name`: the title is
 * translated, so the same list run again in another locale would otherwise
 * open a second window (findings F15). `name` is what a new window is
 * called; an existing one keeps the title it was opened with, there being
 * no bus event for a rename.
 */
export function showSpecial(
	client: IrcClient,
	name: string,
	special: SpecialChanType,
	data: SpecialData,
	target?: string
): Channel {
	// Channel names are case-insensitive, and so is the list's identity.
	const specialTarget = target === undefined ? undefined : client.casefold(target);
	const existing = client.channels.find(
		(chan) => chan.shared.special === special && chan.specialTarget === specialTarget
	);

	if (existing) {
		existing.shared.data = data;
		client.dispatch("msg:special", {chan: existing.id, data});
		return existing;
	}

	const {channel, index} = client.createChannel(name, ChanType.SPECIAL);
	channel.shared.special = special;
	channel.specialTarget = specialTarget;
	channel.shared.data = data;
	client.dispatch("join", {
		network: client.uuid,
		chan: channel.snapshot(),
		index,
		shouldOpen: false,
	});
	return channel;
}

function updateListStatus(client: IrcClient, data: ChannelListData): void {
	showSpecial(client, t("list.channelList"), SpecialChanType.CHANNELLIST, data);
}

// RPL_LISTSTART: <me> Channel :Users  Name
const listStart: Handler = (client) => {
	resetChannelList(client);
	updateListStatus(client, {text: t("list.loading")});
};

// RPL_LIST: <me> <channel> <# visible> :<topic>
const listEntry: Handler = (client, msg) => {
	const [, channel, count, topic = ""] = msg.params;

	if (!channel) {
		return;
	}

	const cache = cacheFor(client);
	cache.push({channel, num_users: parseInt(count ?? "0", 10) || 0, topic});
	updateListStatus(client, {text: tCount("list.loaded", cache.length)});
};

// RPL_LISTEND: <me> :End of /LIST
const listEnd: Handler = (client) => {
	const channels = cacheFor(client)
		.sort((a, b) => b.num_users - a.num_users)
		.slice(0, MAX_CHANS);
	resetChannelList(client);
	updateListStatus(client, channels);
};

export default {"321": listStart, "322": listEntry, "323": listEnd};
