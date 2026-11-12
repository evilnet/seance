/**
 * Channel mode lists: 367/368 (+b), 346/347 (+I), 348/349 (+e).
 * Ported from attic/server/plugins/irc-events/modelist.ts (which consumed
 * irc-framework's accumulated `banlist` / `inviteList` events).
 *
 * +b goes to `IrcClient.bans` (banList.ts) and the Bans window. For the other
 * two, entries accumulate per client + channel until the end numeric, which
 * either opens (`join`) or refreshes (`msg:special`) a `ChanType.SPECIAL`
 * window named `<List name> for <channel>`, or reports "<List name> is
 * empty" when nothing came back. nefarious2 sends
 * `<me> <channel> <mask> <setter> <unix time>` for all three lists
 * (`ircd/s_err.c`); the setter and time are optional per RFC 2812. Masks
 * may be extbans (`~a:account`, `~q:~r:*foo*`) and are passed through
 * untouched — the UI renders them as text.
 */

import {t} from "../../i18n/core";
import {SpecialChanType} from "../../../../shared/types/chan";
import {MessageType} from "../../../../shared/types/msg";
import type {Channel} from "../channel";
import type {IrcClient} from "../client";
import type {IrcMessage} from "../message";
import type {Handler} from "../types";
import {showSpecial} from "./list";

/** Row shape `Special/ListExcepts.vue` renders. */
export interface ExceptEntry {
	hostmask: string;
	banned_by: string;
	banned_at?: Date;
}

/** Row shape `Special/ListInvites.vue` renders. */
export interface InviteEntry {
	hostmask: string;
	invited_by: string;
	invited_at?: Date;
}

interface RawEntry {
	mask: string;
	by: string;
	at?: Date;
}

interface ListKind {
	/** Mode letter; keys the accumulation buffer. */
	mode: "I" | "e";
	/** The human name, resolved at use: window title prefix and "is empty"
	 * text. A resolver keeps every t() call a plain literal (the pot ↔
	 * call-site scanner only sees direct calls). */
	label: () => string;
	/** Which special-channel component renders the window. */
	special: SpecialChanType;
	toRow: (entry: RawEntry) => ExceptEntry | InviteEntry;
}

const toExcept = (entry: RawEntry): ExceptEntry => ({
	hostmask: entry.mask,
	banned_by: entry.by,
	banned_at: entry.at,
});

const toInvite = (entry: RawEntry): InviteEntry => ({
	hostmask: entry.mask,
	invited_by: entry.by,
	invited_at: entry.at,
});

const INVITES: ListKind = {
	mode: "I",
	label: () => t("list.kindInvites"),
	special: SpecialChanType.INVITELIST,
	toRow: toInvite,
};
const EXCEPTS: ListKind = {
	mode: "e",
	label: () => t("list.kindExcepts"),
	special: SpecialChanType.EXCEPTLIST,
	toRow: toExcept,
};

/** Per-client accumulation buffers keyed by `<mode>:<casefolded channel>`. */
const buffers = new WeakMap<IrcClient, Map<string, RawEntry[]>>();

function bufferKey(client: IrcClient, kind: ListKind, channel: string): string {
	return `${kind.mode}:${client.casefold(channel)}`;
}

/** Parse the unix-seconds timestamp servers append; undefined if absent/garbage. */
export function parseListTime(param: string | undefined): Date | undefined {
	if (param === undefined || !/^\d+$/.test(param)) {
		return undefined;
	}

	return new Date(Number(param) * 1000);
}

/** Buffer one `<me> <channel> <mask> [<setter> [<time>]]` entry. */
function accumulate(kind: ListKind, client: IrcClient, msg: IrcMessage): void {
	const [, channel, mask, by = "", at] = msg.params;

	if (!channel || !mask) {
		return;
	}

	let perClient = buffers.get(client);

	if (!perClient) {
		perClient = new Map();
		buffers.set(client, perClient);
	}

	const key = bufferKey(client, kind, channel);
	const entries = perClient.get(key) ?? [];
	entries.push({mask, by, at: parseListTime(at)});
	perClient.set(key, entries);
}

/** Take (and clear) the buffered entries for a channel. */
function drain(kind: ListKind, client: IrcClient, channel: string): RawEntry[] {
	const perClient = buffers.get(client);
	const key = bufferKey(client, kind, channel);
	const entries = perClient?.get(key) ?? [];
	perClient?.delete(key);
	return entries;
}

/** End numeric `<me> <channel> :End of ...`: publish the buffered list. */
function finish(kind: ListKind, client: IrcClient, msg: IrcMessage): void {
	const channel = msg.params[1];

	if (!channel) {
		return;
	}

	const data = drain(kind, client, channel).map(kind.toRow);

	if (data.length === 0) {
		let chan: Channel | undefined = client.findChannel(channel);
		let showInActive = false;

		// Tell the lobby when the list is for a channel we are not in.
		if (!chan) {
			chan = client.lobby;
			showInActive = true;
		}

		client.pushMessage(
			chan,
			{
				type: MessageType.ERROR,
				time: client.timeOf(msg),
				text: t("list.isEmpty", {kind: kind.label()}),
				showInActive,
			},
			true
		);
		return;
	}

	const name = t("list.windowTitle", {kind: kind.label(), channel});
	showSpecial(client, name, kind.special, data, channel);
}

const banList: Handler = (client, msg) => {
	const [, channel, mask, by = "", at] = msg.params;

	if (channel && mask) {
		client.bans.addRow(channel, {mask, by, at: parseListTime(at)?.getTime()});
	}
};

// A list nobody asked for is a typed `/mode #chan b`: it opens the window.
const endOfBanList: Handler = (client, msg) => {
	const channel = msg.params[1];

	if (channel) {
		const asked = client.bans.finish(channel, Date.now());
		client.dispatchBans(channel, !asked);
	}
};

const inviteList: Handler = (client, msg) => accumulate(INVITES, client, msg);
const endOfInviteList: Handler = (client, msg) => finish(INVITES, client, msg);
const exceptList: Handler = (client, msg) => accumulate(EXCEPTS, client, msg);
const endOfExceptList: Handler = (client, msg) => finish(EXCEPTS, client, msg);

export default {
	"367": banList,
	"368": endOfBanList,
	"346": inviteList,
	"347": endOfInviteList,
	"348": exceptList,
	"349": endOfExceptList,
};
