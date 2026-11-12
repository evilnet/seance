// The inbox: the messages that mentioned you, until you close them, kept per
// device but built from what the server gives every device (live lines, the
// catch-up, read markers), so every device arrives at the same list. See
// docs/projects/inbox.md.
//
// Vue-free and store-free: the store glue is client/js/mentions.ts.

import type {InboxEntry} from "../../../shared/types/mention";
import {MessageType, type SharedMsg} from "../../../shared/types/msg";
import {casefold} from "../irc/casemap";
import {isEditAuthor, type Author} from "../irc/channel";
import {cleanIrcMessage} from "../../../shared/irc";

/** How many entries a device keeps; the oldest go first. */
export const MAX_ENTRIES = 100;
/** How many of those one conversation may hold, so a busy channel cannot push the rest out (a query is one entry). */
export const MAX_PER_CONVERSATION = 20;
/** How long a read mention stays. An unread one stays until it is read. */
export const READ_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** How many dismissals a device remembers. */
export const MAX_DISMISSED = 200;
/** A mention starting further in than this is shown from just before it. */
export const EXCERPT_FROM = 60;
/** How much of the text before the mention the excerpt keeps. */
export const EXCERPT_LEAD = 30;

/**
 * A dismissed entry, remembered so the catch-up does not bring it back,
 * until its conversation is read past it (a channel mention's: and its
 * read entry's keep is over, see pruneRead).
 */
export type Dismissal = {key: string; network: string; target: string; time: string};

/** One conversation's identity: its network and its name under rfc1459 casemapping. */
export function conversationKey(network: string, target: string): string {
	return `${network}/${casefold(target)}`;
}

/**
 * The entry's identity: its msgid, or what identifies the message on a
 * server without `message-tags`. Never a session-local id (irc/ids.ts). A
 * private conversation is one entry, whatever line it shows.
 */
export function entryKey(entry: InboxEntry): string {
	if (entry.query) {
		return `query:${conversationKey(entry.network, entry.target)}`;
	}

	if (entry.msgid) {
		return `${entry.network}/${entry.msgid}`;
	}

	return `${conversationKey(entry.network, entry.target)}/${entry.time}/${entry.from.nick ?? ""}`;
}

/**
 * The text an entry shows: all of it, or for a long line whose mention
 * starts past {@link EXCERPT_FROM} characters, an ellipsis and the text from
 * a word boundary about {@link EXCERPT_LEAD} characters before the mention,
 * so the three lines the pane shows hold the name. `findMention` returns the
 * mention's index in the text without IRC formatting (-1: none), and a cut
 * text is shown without its formatting, which a cut could leave half open.
 */
export function excerptText(text: string, findMention?: (plain: string) => number): string {
	if (!findMention) {
		return text;
	}

	const plain = cleanIrcMessage(text);
	const at = findMention(plain);

	if (at <= EXCERPT_FROM) {
		return text;
	}

	const from = at - EXCERPT_LEAD;
	const space = plain.slice(from, at).search(/\s\S/);
	const start = space === -1 ? from : from + space + 1;
	return "…" + plain.slice(start);
}

export type EntryOptions = {
	/** A private conversation: one entry for the whole of it. */
	query?: boolean;
	/** Where the text mentions us, in the text without formatting (-1: nowhere). */
	findMention?: (plain: string) => number;
};

/** The entry for `msg`, said in `target` on `network`; null for our own or a sourceless line. */
export function entryFor(
	network: string,
	target: string,
	msg: SharedMsg,
	options: EntryOptions = {}
): InboxEntry | null {
	if (msg.self || !msg.from?.nick) {
		return null;
	}

	return {
		network,
		target,
		...(msg.msgid ? {msgid: msg.msgid} : {}),
		...(options.query ? {query: true as const} : {}),
		time: new Date(msg.time).toISOString(),
		type: msg.type ?? MessageType.MESSAGE,
		text: options.query ? msg.text ?? "" : excerptText(msg.text ?? "", options.findMention),
		from: msg.from,
		account: msg.fromAccount ?? null,
	};
}

const timeOf = (e: {time: string}) => new Date(e.time).getTime();

/**
 * At most `cap` of `list` (oldest first), in order: the newest, with what is
 * unread kept ahead of what is read, so a read mention never pushes one out.
 */
function keepNewest(list: InboxEntry[], cap: number): InboxEntry[] {
	if (list.length <= cap) {
		return list;
	}

	const unread = list.filter((e) => !e.read).slice(-cap);
	const room = cap - unread.length;
	const read = room > 0 ? list.filter((e) => e.read).slice(-room) : [];
	const kept = new Set([...unread, ...read]);
	return list.filter((e) => kept.has(e));
}

/**
 * Add `added`, deduplicated by key (the newer line wins, which for a
 * private conversation is the line it shows) and without the dismissed
 * ones, ordered by time; the newest {@link MAX_PER_CONVERSATION} of each
 * conversation and the newest {@link MAX_ENTRIES} overall are kept, what is
 * unread ahead of what is read. A
 * dismissal holds back what it covered, not a later line under the same key
 * (a private conversation's next message).
 */
export function addEntries(
	list: InboxEntry[],
	added: InboxEntry[],
	dismissed: Dismissal[] = []
): InboxEntry[] {
	const gone = new Map<string, number>();

	for (const d of dismissed) {
		gone.set(d.key, Math.max(gone.get(d.key) ?? -Infinity, timeOf(d)));
	}

	const byKey = new Map<string, InboxEntry>();

	for (const entry of [...list, ...added]) {
		const key = entryKey(entry);
		const held = gone.get(key);
		const kept = byKey.get(key);

		if (held !== undefined && timeOf(entry) <= held) {
			continue;
		}

		if (!kept || timeOf(entry) > timeOf(kept)) {
			byKey.set(key, entry);
		} else if (timeOf(entry) === timeOf(kept)) {
			// The same line again (a catch-up): one that has been read stays so.
			byKey.set(key, kept.read ? {...entry, read: true} : entry);
		}
	}

	// Oldest first, lines of the same instant in the order they came (a
	// stable sort).
	const ordered = [...byKey.values()].sort((a, b) => timeOf(a) - timeOf(b));
	const byConversation = new Map<string, InboxEntry[]>();

	for (const entry of ordered) {
		const key = conversationKey(entry.network, entry.target);
		byConversation.set(key, [...(byConversation.get(key) ?? []), entry]);
	}

	const kept = new Set(
		[...byConversation.values()].flatMap((entries) => keepNewest(entries, MAX_PER_CONVERSATION))
	);
	return keepNewest(
		ordered.filter((e) => kept.has(e)),
		MAX_ENTRIES
	);
}

/** What dismissing `entry` remembers. */
export function dismissalOf(entry: InboxEntry): Dismissal {
	return {key: entryKey(entry), network: entry.network, target: entry.target, time: entry.time};
}

/**
 * `dismissed` without the dismissals of `entries` themselves. A dismissal of
 * a later line under the same key (a private conversation's) stays, and goes
 * on holding the older line back.
 */
export function withoutDismissalsOf(dismissed: Dismissal[], entries: InboxEntry[]): Dismissal[] {
	const id = (d: Dismissal) => `${d.key} ${d.time}`;
	const undone = new Set(entries.map((e) => id(dismissalOf(e))));
	return dismissed.filter((d) => !undone.has(id(d)));
}

/** The entries of `target` on `network`. */
export function conversationEntries(
	list: InboxEntry[],
	network: string,
	target: string
): InboxEntry[] {
	const key = conversationKey(network, target);
	return list.filter((e) => conversationKey(e.network, e.target) === key);
}

/**
 * `target` on `network` was read up to `time`: a private conversation's
 * dismissal it covers has nothing left to hold back. A channel mention's
 * stays while a read entry for it could still come back (READ_KEEP_MS).
 */
export function pruneRead(
	list: Dismissal[],
	network: string,
	target: string,
	time: Date,
	now = Date.now()
): Dismissal[] {
	const key = conversationKey(network, target);
	return list.filter(
		(e) =>
			conversationKey(e.network, e.target) !== key ||
			timeOf(e) > time.getTime() ||
			// A channel mention read goes on being listed, read, for as long
			// as a read entry stays: its dismissal must hold it back as long.
			(!e.key.startsWith("query:") && now - timeOf(e) <= READ_KEEP_MS)
	);
}

/** `target` on `network` was read up to `time`: what that covers is read, and stays. */
export function markRead(
	list: InboxEntry[],
	network: string,
	target: string,
	time: Date
): InboxEntry[] {
	const key = conversationKey(network, target);
	return list.map((e) =>
		e.read || conversationKey(e.network, e.target) !== key || timeOf(e) > time.getTime()
			? e
			: {...e, read: true as const}
	);
}

/** Without the read entries older than {@link READ_KEEP_MS}. */
export function dropExpired(list: InboxEntry[], now: number): InboxEntry[] {
	return list.filter((e) => !e.read || now - timeOf(e) <= READ_KEEP_MS);
}

/**
 * The message `msgid` in `target` on `network` is gone: drop the entry that
 * shows it, in that conversation only (a REDACT or an edit elsewhere naming
 * it must not reach it). With `by` (an edit, which only its author may
 * make), only when `by` sent it, by the timeline's rule (`isEditAuthor`).
 */
export function dropMessage(
	list: InboxEntry[],
	network: string,
	target: string,
	msgid: string,
	by?: Author
): InboxEntry[] {
	const key = conversationKey(network, target);
	return list.filter(
		(e) =>
			conversationKey(e.network, e.target) !== key ||
			e.msgid !== msgid ||
			(by !== undefined && !wroteIt(e, by))
	);
}

/** Whether `by` sent the line `entry` shows. */
function wroteIt(entry: InboxEntry, by: Author): boolean {
	const nick = entry.from.nick;

	if (entry.account === undefined) {
		// Stored before the account was kept: the nick is all there is.
		return nick !== undefined && casefold(nick) === casefold(by.nick ?? "");
	}

	return isEditAuthor({nick, account: entry.account ?? undefined}, by, casefold);
}

export type InboxGroup = {
	/** {@link conversationKey}: one per conversation. */
	key: string;
	network: string;
	target: string;
	/** Oldest first, as the conversation reads. */
	entries: InboxEntry[];
};

/** The entries by conversation, the conversation with the newest mention first. */
export function groupByConversation(list: InboxEntry[]): InboxGroup[] {
	const groups = new Map<string, InboxGroup>();

	for (const entry of [...list].sort((a, b) => timeOf(a) - timeOf(b))) {
		const key = conversationKey(entry.network, entry.target);
		let group = groups.get(key);

		if (!group) {
			group = {key, network: entry.network, target: entry.target, entries: []};
			groups.set(key, group);
		}

		group.entries.push(entry);
	}

	const newest = (g: InboxGroup) => timeOf(g.entries[g.entries.length - 1]);
	return [...groups.values()].sort((a, b) => newest(b) - newest(a));
}

function isEntry(value: unknown): value is InboxEntry {
	const e = value as Record<string, unknown> | null;
	return (
		!!e &&
		typeof e.network === "string" &&
		typeof e.target === "string" &&
		typeof e.time === "string" &&
		!Number.isNaN(new Date(e.time).getTime()) &&
		typeof e.text === "string" &&
		!!e.from &&
		typeof e.from === "object"
	);
}

function isDismissal(value: unknown): value is Dismissal {
	const d = value as Record<string, unknown> | null;
	return (
		!!d &&
		typeof d.key === "string" &&
		typeof d.network === "string" &&
		typeof d.target === "string" &&
		typeof d.time === "string"
	);
}

function parseList<T>(raw: string | null | undefined, valid: (v: unknown) => v is T): T[] {
	try {
		const parsed: unknown = JSON.parse(raw || "[]");
		return Array.isArray(parsed) ? parsed.filter(valid) : [];
	} catch {
		return [];
	}
}

/**
 * The stored list. Entries in the old shape (session-local `chanId`/`msgId`,
 * which point nowhere after a reload) are dropped, not migrated.
 */
export const parseStored = (raw: string | null | undefined) => parseList(raw, isEntry);

export const parseDismissed = (raw: string | null | undefined) => parseList(raw, isDismissal);
