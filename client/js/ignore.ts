// Per-network ignore list, persisted in localStorage.
//
// TheLounge kept `network.ignoreList` on the server and consulted it in the
// PRIVMSG/NOTICE handler. Here each network's list lives under
// `thelounge.ignore.<networkUuid>`; `/ignore`, `/unignore` and `/ignorelist`
// (client/js/irc/commands/) edit it and `client/js/irc/handlers/privmsg.ts`
// drops messages from anyone it matches.

import storage from "./localStorage";
import {compareHostmask, Hostmask, parseHostmask} from "./irc/hostmask";

export interface IgnoreEntry extends Hostmask {
	/** Epoch milliseconds the entry was added. */
	when: number;
}

export function ignoreStorageKey(networkUuid: string): string {
	return `thelounge.ignore.${networkUuid}`;
}

function isEntry(value: unknown): value is IgnoreEntry {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const entry = value as Record<string, unknown>;
	return (
		typeof entry.nick === "string" &&
		typeof entry.ident === "string" &&
		typeof entry.hostname === "string" &&
		typeof entry.when === "number"
	);
}

function readEntries(key: string): IgnoreEntry[] {
	const raw = storage.get(key);

	if (!raw) {
		return [];
	}

	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
	} catch (e) {
		storage.remove(key);
		return [];
	}
}

export class IgnoreList {
	readonly networkUuid: string;
	private entries: IgnoreEntry[];

	constructor(networkUuid: string) {
		this.networkUuid = networkUuid;
		this.entries = readEntries(ignoreStorageKey(networkUuid));
	}

	/** Entries in insertion order (do not mutate; use `add`/`remove`). */
	get list(): readonly IgnoreEntry[] {
		return this.entries;
	}

	/** Whether an existing entry matches this exact-or-wildcard mask. */
	isIgnored(mask: Hostmask): boolean {
		return this.entries.some((entry) => compareHostmask(entry, mask));
	}

	/**
	 * Whether `/unignore <nick>` would take an entry off the list: one
	 * naming this nick with any ident and host. A user caught only by a mask
	 * on their host (`*!*@host`) is not, since removing that needs the mask.
	 * The nick menus offer Unignore on this, so it runs exactly the command
	 * that works.
	 */
	ignoresNick(nick: string): boolean {
		return this.isIgnored(parseHostmask(nick));
	}

	/** Whether messages from `nick!user@host` should be dropped. */
	matches(nick: string, user = "", host = ""): boolean {
		return this.isIgnored({nick, ident: user, hostname: host});
	}

	/**
	 * Add `nick[!ident][@host]`. Returns the new entry, or `undefined` when
	 * an existing entry already covers it.
	 */
	add(hostmask: string): IgnoreEntry | undefined {
		const mask = parseHostmask(hostmask);

		if (this.isIgnored(mask)) {
			return undefined;
		}

		const entry: IgnoreEntry = {...mask, when: Date.now()};
		this.entries.push(entry);
		this.save();
		return entry;
	}

	/** Remove the first entry matching `hostmask`; returns it, if any. */
	remove(hostmask: string): IgnoreEntry | undefined {
		const mask = parseHostmask(hostmask);
		const idx = this.entries.findIndex((entry) => compareHostmask(entry, mask));

		if (idx === -1) {
			return undefined;
		}

		const [entry] = this.entries.splice(idx, 1);
		this.save();
		return entry;
	}

	/** Reload from storage (tests, or another tab having written it). */
	reload(): void {
		this.entries = readEntries(ignoreStorageKey(this.networkUuid));
	}

	private save(): void {
		const key = ignoreStorageKey(this.networkUuid);

		if (this.entries.length === 0) {
			storage.remove(key);
		} else {
			storage.set(key, JSON.stringify(this.entries));
		}
	}
}

const lists = new Map<string, IgnoreList>();

/** The (cached) ignore list of a network. */
export function ignoreListFor(networkUuid: string): IgnoreList {
	let list = lists.get(networkUuid);

	if (!list) {
		list = new IgnoreList(networkUuid);
		lists.set(networkUuid, list);
	}

	return list;
}
