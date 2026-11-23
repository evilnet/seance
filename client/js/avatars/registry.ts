/**
 * What this page knows of each user's avatar, per network: the `avatar`
 * metadata value the server sent (subscribed, the join burst, a GET), and
 * the services account the user was last seen logged in as (extended-join,
 * account-notify, a line's account-tag), which the "always show this
 * person's avatar" trust is keyed on (prefs.ts).
 *
 * The IRC layer writes it (handlers/metadata.ts, IrcClient), the UI reads
 * it (Avatar.vue). It is reactive and kept free of store and DOM imports so
 * it runs under mocha. Nothing here is persisted: a page load hears the
 * values again in the join burst.
 */

import {reactive} from "vue";
import {casefold} from "../irc/casemap";

export type AvatarEntry = {
	/** The value as the server sent it; `""` = known to have none. */
	value: string;
	/** Services account, when known; `null` = known not logged in. */
	account?: string | null;
};

type Network = {
	fold: (nick: string) => string;
	users: Map<string, AvatarEntry>;
};

/** Entries created for an account before any value was heard. */
const unknownValue = new Set<string>();

const networks = reactive(new Map<string, Network>()) as Map<string, Network>;

function network(uuid: string): Network {
	let net = networks.get(uuid);

	if (!net) {
		networks.set(uuid, {fold: (s) => casefold(s), users: new Map()});
		// The reactive proxy, so later writes are seen.
		net = networks.get(uuid)!;
	}

	return net;
}

function entry(uuid: string, nick: string): AvatarEntry {
	const net = network(uuid);
	const key = net.fold(nick);
	let found = net.users.get(key);

	if (!found) {
		net.users.set(key, {value: ""});
		found = net.users.get(key)!;
		// Created to hold an account only: the value is not known yet.
		unknownValue.add(`${uuid}\n${key}`);
	}

	return found;
}

/** How this network compares nicks (IrcClient's CASEMAPPING). */
export function bindNetwork(uuid: string, fold: (nick: string) => string): void {
	network(uuid).fold = fold;
}

/** The server said `nick`'s avatar is `value` (`""`: none). */
export function setAvatarValue(uuid: string, nick: string, value: string): void {
	const e = entry(uuid, nick);
	unknownValue.delete(`${uuid}\n${network(uuid).fold(nick)}`);

	if (e.value !== value) {
		e.value = value;
	}
}

/** `nick` is logged in as `account` (`null`: not logged in). */
export function noteAccount(uuid: string, nick: string, account: string | null): void {
	const e = entry(uuid, nick);

	if (e.account !== account) {
		e.account = account;
	}
}

/** What is known of `nick`, or undefined when nothing is. */
export function avatarOf(uuid: string, nick: string): AvatarEntry | undefined {
	const net = networks.get(uuid);

	if (!net) {
		return undefined;
	}

	return net.users.get(net.fold(nick));
}

/** Whether the server has told us `nick`'s avatar (set or not) on this page. */
export function avatarKnown(uuid: string, nick: string): boolean {
	const net = networks.get(uuid);

	if (!net) {
		return false;
	}

	const key = net.fold(nick);
	return net.users.has(key) && !unknownValue.has(`${uuid}\n${key}`);
}

/** NICK: the entry follows the user. */
export function renameAvatar(uuid: string, from: string, to: string): void {
	const net = networks.get(uuid);

	if (!net) {
		return;
	}

	const oldKey = net.fold(from);
	const newKey = net.fold(to);
	const found = net.users.get(oldKey);

	if (oldKey === newKey) {
		return;
	}

	net.users.delete(newKey);
	unknownValue.delete(`${uuid}\n${newKey}`);

	if (found) {
		net.users.delete(oldKey);
		net.users.set(newKey, found);

		if (unknownValue.delete(`${uuid}\n${oldKey}`)) {
			unknownValue.add(`${uuid}\n${newKey}`);
		}
	}
}

/** QUIT, or no channel is shared any more: the nick may be someone else's next. */
export function forgetAvatar(uuid: string, nick: string): void {
	const net = networks.get(uuid);

	if (!net) {
		return;
	}

	const key = net.fold(nick);
	net.users.delete(key);
	unknownValue.delete(`${uuid}\n${key}`);
}

/** A new registration, avatars switched off, or the network removed. */
export function clearAvatars(uuid: string): void {
	const net = networks.get(uuid);

	if (!net) {
		return;
	}

	for (const key of net.users.keys()) {
		unknownValue.delete(`${uuid}\n${key}`);
	}

	net.users.clear();
}
