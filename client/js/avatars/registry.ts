/**
 * What this page knows of each user's avatar, per network: the `avatar`
 * metadata value the server sent (subscribed, the join burst, a GET), and
 * the services account the user was last seen logged in as (extended-join,
 * account-notify, a line's account-tag), which the "always show this
 * person's avatar" trust is keyed on (prefs.ts).
 *
 * The IRC layer writes it (handlers/metadata.ts, IrcClient), the UI reads
 * it (Avatar.vue). It is reactive and kept free of store and DOM imports so
 * it runs under mocha.
 *
 * A saved network's values are kept between launches
 * (`thelounge.avatars.seen.<uuid>`, the last {@link SEEN_LIMIT} with a
 * picture) and a new connection keeps the ones it has: both come back as
 * not known, so they are drawn at once and asked again (the join burst, or
 * a GET when a line arrives) rather than dropped to the initial and back.
 */

import {reactive} from "vue";
import storage from "../localStorage";
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
	/** Whether this network's values are kept between launches (a saved network). */
	keep: () => boolean;
};

/** How many users' values a network keeps between launches. */
export const SEEN_LIMIT = 300;

/** How long after a change the kept values are written. */
const SAVE_DELAY_MS = 2_000;

export const SEEN_KEY_PREFIX = "thelounge.avatars.seen.";

type StorageBackend = {
	get(key: string): string | null;
	set(key: string, value: string): void;
	remove(key: string): void;
};

let backend: StorageBackend = storage;
/** Networks whose kept values have been read back on this page. */
const loadedSeen = new Set<string>();
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Entries created for an account before any value was heard. */
const unknownValue = new Set<string>();

const networks = reactive(new Map<string, Network>()) as Map<string, Network>;

function network(uuid: string): Network {
	let net = networks.get(uuid);

	if (!net) {
		networks.set(uuid, {fold: (s) => casefold(s), users: new Map(), keep: () => false});
		// The reactive proxy, so later writes are seen.
		net = networks.get(uuid)!;
	}

	return net;
}

/** Swap the persistence backend (tests); `null` restores localStorage. */
export function useSeenBackend(next: StorageBackend | null): void {
	backend = next ?? storage;
	loadedSeen.clear();

	for (const timer of saveTimers.values()) {
		clearTimeout(timer);
	}

	saveTimers.clear();
}

function changed(uuid: string): void {
	const net = networks.get(uuid);

	if (!net?.keep() || saveTimers.has(uuid)) {
		return;
	}

	saveTimers.set(
		uuid,
		setTimeout(() => {
			saveTimers.delete(uuid);
			saveSeen(uuid);
		}, SAVE_DELAY_MS)
	);
}

/** Write the network's kept values now (also what the delayed save runs). */
export function saveSeen(uuid: string): void {
	const net = networks.get(uuid);

	if (!net?.keep()) {
		return;
	}

	const kept = [...net.users]
		.filter(([, e]) => e.value !== "")
		.slice(-SEEN_LIMIT)
		.map(([key, e]) => (e.account ? [key, e.value, e.account] : [key, e.value]));

	if (kept.length === 0) {
		backend.remove(SEEN_KEY_PREFIX + uuid);
	} else {
		backend.set(SEEN_KEY_PREFIX + uuid, JSON.stringify(kept));
	}
}

function loadSeen(uuid: string, net: Network): void {
	const raw = backend.get(SEEN_KEY_PREFIX + uuid);

	if (!raw) {
		return;
	}

	try {
		const parsed: unknown = JSON.parse(raw);

		if (!Array.isArray(parsed)) {
			throw new Error("not a list");
		}

		for (const row of parsed) {
			if (!Array.isArray(row) || typeof row[0] !== "string" || typeof row[1] !== "string") {
				continue;
			}

			const [key, value, account] = row as [string, string, unknown];

			if (key === "" || value === "" || net.users.has(key)) {
				continue;
			}

			net.users.set(key, typeof account === "string" ? {value, account} : {value});
			unknownValue.add(`${uuid}\n${key}`);
		}
	} catch {
		backend.remove(SEEN_KEY_PREFIX + uuid);
	}
}

/** The network was removed: its kept values go. */
export function forgetSeen(uuid: string): void {
	loadedSeen.delete(uuid);
	clearTimeout(saveTimers.get(uuid));
	saveTimers.delete(uuid);
	backend.remove(SEEN_KEY_PREFIX + uuid);
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

/**
 * How this network compares nicks (IrcClient's CASEMAPPING), and whether
 * its values are kept between launches; the kept ones are read back here.
 */
export function bindNetwork(
	uuid: string,
	fold: (nick: string) => string,
	keep: () => boolean = () => false
): void {
	const net = network(uuid);
	net.fold = fold;
	net.keep = keep;

	if (keep() && !loadedSeen.has(uuid)) {
		loadedSeen.add(uuid);
		loadSeen(uuid, net);
	}
}

/**
 * A new connection: what is known stays drawn but counts as not known, so
 * the join burst or a GET says it again.
 */
export function markAvatarsStale(uuid: string): void {
	const net = networks.get(uuid);

	if (!net) {
		return;
	}

	for (const key of net.users.keys()) {
		unknownValue.add(`${uuid}\n${key}`);
	}
}

/** The server said `nick`'s avatar is `value` (`""`: none). */
export function setAvatarValue(uuid: string, nick: string, value: string): void {
	const e = entry(uuid, nick);
	unknownValue.delete(`${uuid}\n${network(uuid).fold(nick)}`);

	if (e.value !== value) {
		e.value = value;
		changed(uuid);
	}
}

/** `nick` is logged in as `account` (`null`: not logged in). */
export function noteAccount(uuid: string, nick: string, account: string | null): void {
	const e = entry(uuid, nick);

	if (e.account !== account) {
		e.account = account;
		changed(uuid);
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

	changed(uuid);
}

/** QUIT, or no channel is shared any more: the nick may be someone else's next. */
export function forgetAvatar(uuid: string, nick: string): void {
	const net = networks.get(uuid);

	if (!net) {
		return;
	}

	const key = net.fold(nick);

	if (net.users.delete(key)) {
		changed(uuid);
	}

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
	changed(uuid);
}
