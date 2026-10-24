// The inbox: the messages that mentioned you and are not read yet, kept per
// device but built from what the server gives every device (live lines, the
// catch-up, read markers), so every device arrives at the same list. See
// docs/projects/inbox.md.
//
// Vue-free and store-free: the store glue is client/js/mentions.ts.

import type {InboxEntry} from "../../../shared/types/mention";
import {MessageType, type SharedMsg} from "../../../shared/types/msg";
import {casefold} from "../irc/casemap";
import {cleanIrcMessage} from "../../../shared/irc";

/** How many entries a device keeps; the oldest go first. */
export const MAX_ENTRIES = 100;
/** How many of those one conversation may hold, so a busy query cannot push the rest out. */
export const MAX_PER_CONVERSATION = 20;
/** How many dismissals a device remembers. */
export const MAX_DISMISSED = 200;
/** A mention starting further in than this is shown from just before it. */
export const EXCERPT_FROM = 60;
/** How much of the text before the mention the excerpt keeps. */
export const EXCERPT_LEAD = 30;

/**
 * A dismissed entry, remembered so the catch-up does not bring it back,
 * until its conversation is read past it.
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
	};
}

const timeOf = (e: {time: string}) => new Date(e.time).getTime();

/**
 * Add `added`, deduplicated by key (the newer line wins, which for a
 * private conversation is the line it shows) and without the dismissed
 * ones, ordered by time; the newest {@link MAX_PER_CONVERSATION} of each
 * conversation and the newest {@link MAX_ENTRIES} overall are kept. A
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

		if (!kept || timeOf(entry) >= timeOf(kept)) {
			byKey.set(key, entry);
		}
	}

	// Oldest first, lines of the same instant in the order they came (a
	// stable sort); counted from the newest end.
	const ordered = [...byKey.values()].sort((a, b) => timeOf(a) - timeOf(b));
	const perConversation = new Map<string, number>();
	const dropped = new Set<InboxEntry>();

	for (let i = ordered.length - 1; i >= 0; i--) {
		const key = conversationKey(ordered[i].network, ordered[i].target);
		const count = (perConversation.get(key) ?? 0) + 1;
		perConversation.set(key, count);

		if (count > MAX_PER_CONVERSATION) {
			dropped.add(ordered[i]);
		}
	}

	return ordered.filter((e) => !dropped.has(e)).slice(-MAX_ENTRIES);
}

/**
 * `target` on `network` was read up to `time`: drop what it covers. Works
 * for entries and dismissals alike (a dismissal past the read point has
 * nothing left to hold back).
 */
export function pruneRead<T extends {network: string; target: string; time: string}>(
	list: T[],
	network: string,
	target: string,
	time: Date
): T[] {
	const key = conversationKey(network, target);
	return list.filter(
		(e) => conversationKey(e.network, e.target) !== key || timeOf(e) > time.getTime()
	);
}

/**
 * The message `msgid` in `target` on `network` is gone: drop the entry that
 * shows it, in that conversation only (a REDACT or an edit elsewhere naming
 * it must not reach it). With `by` (an edit, which only its author may
 * make), only when `by` sent it.
 */
export function dropMessage(
	list: InboxEntry[],
	network: string,
	target: string,
	msgid: string,
	by?: string
): InboxEntry[] {
	const key = conversationKey(network, target);
	return list.filter(
		(e) =>
			conversationKey(e.network, e.target) !== key ||
			e.msgid !== msgid ||
			(by !== undefined && casefold(e.from.nick ?? "") !== casefold(by))
	);
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
