/**
 * LIST replies (321/322/323, and 334 when the arguments are refused) →
 * `IrcClient.channelList` (channelList.ts), reported to the channel browser
 * as `channel:list`. nefarious2's "wait N seconds" notice is caught in
 * privmsg.ts (`noteListDelay`) before the empty 321/323 pair that follows it.
 *
 * Also home to {@link showSpecial}, the create-or-update helper every
 * `ChanType.SPECIAL` window (ban list, ignore list, …) goes through.
 */

import {ChanType, SpecialChanType} from "../../../../shared/types/chan";
import type {Channel} from "../channel";
import {listDelayOf} from "../channelList";
import type {IrcClient} from "../client";
import type {Handler} from "../types";

/** Payload shape of `msg:special` / `SharedChan.data`. */
export type SpecialData = Record<string, any>;

/**
 * Create the special window for `special` (and, for a per-channel list,
 * `target`), announcing it with `join` and opening it — the user asked for
 * it, unlike a channel a restore burst brings — or, when it already exists,
 * replace its data and dispatch `msg:special` (which the UI answers by
 * navigating to it). Either way the first showing opens the window; it used
 * to open only the second time, which read as the menu item doing nothing.
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
		shouldOpen: true,
	});
	return channel;
}

/**
 * A server notice that is nefarious2's LISTDELAY refusal: the browser shows
 * the wait instead. Returns true when the notice was that.
 */
export function noteListDelay(client: IrcClient, text: string): boolean {
	const seconds = listDelayOf(text);

	if (seconds === undefined) {
		return false;
	}

	client.channelList.delay(seconds);
	client.dispatchChannelList();
	return true;
}

// RPL_LISTSTART: <me> Channel :Users  Name
const listStart: Handler = (client) => {
	const before = client.channelList.status;
	client.channelList.begin();

	if (before !== "loading") {
		client.dispatchChannelList();
	}
};

// RPL_LIST: <me> <channel> <# visible> :<topic>
const listEntry: Handler = (client, msg) => {
	const [, name, count, topic = ""] = msg.params;

	if (!name) {
		return;
	}

	const users = parseInt(count ?? "0", 10) || 0;

	if (client.channelList.add({name, users, topic})) {
		client.dispatchChannelList();
	}
};

// RPL_LISTEND: <me> :End of /LIST
const listEnd: Handler = (client) => {
	const before = client.channelList.status;
	client.channelList.end();

	if (before === "loading") {
		client.dispatchChannelList();
	}
};

// RPL_LISTUSAGE: <me> :<usage line> — the arguments were refused.
const listUsage: Handler = (client, msg) => {
	client.channelList.fail(msg.params[msg.params.length - 1] ?? "");
	client.dispatchChannelList();
};

export default {"321": listStart, "322": listEntry, "323": listEnd, "334": listUsage};
