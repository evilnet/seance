/**
 * Channel bans in menus: who may set them, the dialog (components/
 * BanDialog.vue) and the Ban… entries that open it, and the menu an address
 * in a join, part or quit line opens. docs/resources/client-features.md
 * § Channel bans.
 */

import eventbus from "../eventbus";
import {t} from "../i18n/core";
import {formatRelativeTime} from "../i18n/dates";
import socket from "../socket";
import {ChanType} from "../../../shared/types/chan";
import type {BanChange, BanChangeOutcome, BanEntry} from "../../../shared/types/ban-list";
import type {ClientChan, ClientNetwork} from "../types";
import {banSetter} from "./channelBans";
import type {ContextMenuItem} from "./contextMenu";
import {operTargetItems} from "./operMenu";

/** What the ban dialog is opened with. */
export interface BanDialogRequest {
	network: string;
	channel: string;
	/** Who it is about, when it is about someone. */
	nick?: string;
	/** `ident@host` as a line showed it: right even for someone long gone. */
	address?: string;
	/** The ban to edit; without it the dialog adds one. */
	edit?: BanEntry;
}

export function openBanDialog(request: BanDialogRequest): void {
	eventbus.emit("ban:dialog", request);
}

/**
 * Whether `modes` (ours in a channel, highest first) can kick and ban:
 * half-op and up where the network has half-ops, else op and up.
 */
export function holdsChannelPower(symbols: string[], modes: string[] | undefined): boolean {
	const floor = symbols.includes("%") ? symbols.indexOf("%") : symbols.indexOf("@");
	const mine = modes?.length ? symbols.indexOf(modes[0]) : -1;
	return floor !== -1 && mine !== -1 && mine <= floor;
}

/** The channel called `name`, joined or not, as this network's list has it. */
function findChannel(network: ClientNetwork, name: string): ClientChan | undefined {
	const lower = name.toLowerCase();
	return network.channels.find(
		(chan) => chan.type === ChanType.CHANNEL && chan.name.toLowerCase() === lower
	);
}

/** Whether we can change the bans of `channel` on `network`. */
export function canSetBans(network: ClientNetwork, channel: string): boolean {
	const me = findChannel(network, channel)?.users.find((u) => u.nick === network.nick);
	return holdsChannelPower(network.serverOptions.PREFIX.symbols, me?.modes);
}

/** `Ban…`, for a user or an address in `channel`. */
export function banItem(
	network: ClientNetwork,
	channel: string,
	label: string,
	target: {nick?: string; address?: string}
): ContextMenuItem {
	return {
		label,
		type: "item",
		class: "action-ban",
		action: () => openBanDialog({network: network.uuid, channel, ...target}),
	};
}

/**
 * The menu an address opens: Ban from the channel for an op, what an opered
 * network does with any address (operTargetItems: Check, Who, G-line, Shun),
 * and Copy for everyone. `chan` is the conversation the line is in.
 */
export function addressMenuItems(
	network: ClientNetwork,
	chan: ClientChan,
	address: string,
	nick?: string
): ContextMenuItem[] {
	const items = operTargetItems(network, chan.id, "host", address);

	if (chan.type === ChanType.CHANNEL && canSetBans(network, chan.name)) {
		const label = t("menu.banFrom", {channel: chan.name});
		items.splice(2, 0, banItem(network, chan.name, label, {nick, address}));
	}

	return items;
}

export function openAddressMenu(
	event: MouseEvent,
	network: ClientNetwork,
	chan: ClientChan,
	address: string,
	nick?: string
): void {
	eventbus.emit("contextmenu:items", {
		event,
		items: addressMenuItems(network, chan, address, nick),
	});
}

export interface BanChangeReply {
	outcome: BanChangeOutcome;
	text?: string;
}

let next = 0;
const waiting = new Map<string, (reply: BanChangeReply) => void>();

socket.on("channel:bans:changed", ({id, outcome, text}) => {
	const resolve = waiting.get(id);

	if (resolve) {
		waiting.delete(id);
		resolve({outcome, text});
	}
});

/** Make a change to a channel's bans and hear how it went (irc/banList.ts). */
export function changeChannelBans(network: string, change: BanChange): Promise<BanChangeReply> {
	const id = `bans${++next}`;

	return new Promise((resolve) => {
		waiting.set(id, resolve);
		socket.emit("channel:bans:change", {network, id, change});
	});
}

/** `Set by alice, 3 days ago`: a row of the Bans window, the top of the edit dialog. */
export function banSetText(row: BanEntry): string {
	const who = banSetter(row.by) || t("bans.theServer");

	return row.at
		? t("bans.setByWhen", {who, when: formatRelativeTime(row.at)})
		: t("bans.setBy", {who});
}
