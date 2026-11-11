/**
 * Private conversations kept on this device, per saved network, under
 * `thelounge.querylog.<network uuid>`.
 *
 * A channel's scrollback comes back after a reload from `draft/chathistory`,
 * a private conversation does not: nothing reopens its window, and a server
 * that stores no private history (or a connection without an account) has
 * nothing to fill it with. So the recent lines of every query are kept here
 * and the windows come back with them when the network is created
 * (`IrcClient` restores them as placeholders, `restoredQueries`).
 *
 * It is a cycle, not an archive: {@link MAX_MESSAGES} newest lines per query,
 * the {@link MAX_QUERIES} most recently active queries per network, and at
 * most {@link MAX_CHARS} of JSON per network — the oldest conversation goes
 * first when it does not fit. Closing a query forgets it; removing the
 * network forgets them all ({@link forgetNetworkLog}). Only messages,
 * actions and notices are kept, never a pending copy; an edit rewrites the
 * line it replaces, a redaction removes the line, reactions follow.
 *
 * The user can switch it off (Settings → General, `keepPrivateConversations`,
 * applied through {@link setQueryLogEnabled}): nothing is kept or restored
 * then, and switching it off deletes what was kept — on a shared machine
 * the conversations must not outlive the choice.
 *
 * Kept free of store/DOM imports so it runs under mocha; tests swap the
 * storage backend with {@link useStorageBackend}. Not carried by the
 * settings backup (settingsBackup.ts): it is conversation, not preference.
 */

import storage from "../localStorage";
import {MessageType, MsgReaction, SharedMsg} from "../../../shared/types/msg";

export const QUERY_LOG_PREFIX = "thelounge.querylog.";
/** Newest lines kept per query. */
export const MAX_MESSAGES = 200;
/** Most recently active queries kept per network. */
export const MAX_QUERIES = 30;
/** JSON length budget per network (localStorage is ~5M characters per origin, shared). */
export const MAX_CHARS = 300_000;
/** Trailing write throttle: a busy conversation must not write once per line. */
export const SAVE_DELAY_MS = 1000;

const LOGGED_TYPES = new Set<string>([MessageType.MESSAGE, MessageType.ACTION, MessageType.NOTICE]);

/** The subset of the localStorage wrapper this module needs. */
export interface StorageBackend {
	get(key: string): string | null;
	set(key: string, value: string): void;
	remove(key: string): void;
	/** Every key stored (to delete logs of networks no client holds). */
	keys?(): string[];
}

let backend: StorageBackend = storage;

/** Swap the persistence backend (tests); `null` restores localStorage. */
export function useStorageBackend(next: StorageBackend | null): void {
	backend = next ?? storage;
}

/** One line as stored: what the message renders from, dates as ISO strings. */
export interface LoggedMsg {
	msgid?: string;
	/** msgids of edits folded into this line (history dedupe). */
	aka?: string[];
	time: string;
	type: string;
	nick?: string;
	text: string;
	self?: boolean;
	highlight?: boolean;
	replyTo?: string;
	editedAt?: string;
	fromAccount?: string;
	reactions?: MsgReaction[];
}

interface LoggedQuery {
	name: string;
	/** Epoch ms of the newest line. */
	touched: number;
	/**
	 * Epoch ms this device last knew the query read up to (its read marker);
	 * 0 for a query never read here. Absent in a log written before it was
	 * kept, where nothing is known to be unread.
	 */
	read?: number;
	messages: LoggedMsg[];
}

/** Every live log, so a page going away can write them all ({@link flushQueryLogs}). */
const live = new Set<{readonly uuid: string; flush(): void; clear(): void}>();

/** Write every pending log now (the page is being hidden or unloaded). */
export function flushQueryLogs(): void {
	for (const log of live) {
		log.flush();
	}
}

let enabled = true;

/**
 * The user's choice (`keepPrivateConversations`). Off: nothing is logged,
 * written or restored from here on, and every log already kept — in
 * memory and on disk, for every network, open or not — is deleted.
 */
export function setQueryLogEnabled(on: boolean): void {
	enabled = on;

	if (on) {
		return;
	}

	for (const log of live) {
		log.clear();
	}

	for (const key of backend.keys?.() ?? []) {
		if (key.startsWith(QUERY_LOG_PREFIX)) {
			backend.remove(key);
		}
	}
}

/** Drop a network's log (the network was removed). */
export function forgetNetworkLog(uuid: string): void {
	for (const log of live) {
		if (log.uuid === uuid) {
			log.clear();
		}
	}

	backend.remove(QUERY_LOG_PREFIX + uuid);
}

function timeOf(value: Date | string): number {
	return (value instanceof Date ? value : new Date(value)).getTime();
}

function isoOf(value: Date | string): string {
	return (value instanceof Date ? value : new Date(value)).toISOString();
}

export function toLogged(msg: SharedMsg): LoggedMsg | undefined {
	// Always typed when it is someone talking (handlers/privmsg.ts); an
	// untyped line in a query is the client's own status text.
	const type = msg.type;

	if (!type || !LOGGED_TYPES.has(type) || msg.pending || typeof msg.text !== "string") {
		return undefined;
	}

	if (Number.isNaN(timeOf(msg.time))) {
		return undefined;
	}

	const out: LoggedMsg = {time: isoOf(msg.time), type, text: msg.text};

	if (msg.msgid) {
		out.msgid = msg.msgid;
	}

	if (msg.from?.nick) {
		out.nick = msg.from.nick;
	}

	if (msg.self) {
		out.self = true;
	}

	if (msg.highlight) {
		out.highlight = true;
	}

	if (msg.replyTo) {
		out.replyTo = msg.replyTo;
	}

	if (msg.editedAt) {
		out.editedAt = isoOf(msg.editedAt);
	}

	if (msg.fromAccount) {
		out.fromAccount = msg.fromAccount;
	}

	if (msg.reactions?.length) {
		out.reactions = msg.reactions.map((r) => ({...r, nicks: [...r.nicks]}));
	}

	return out;
}

export function fromLogged(entry: LoggedMsg): SharedMsg {
	const msg: SharedMsg = {
		id: 0,
		time: new Date(entry.time),
		type: entry.type as MessageType,
		text: entry.text,
		users: [],
	};

	if (entry.msgid) {
		msg.msgid = entry.msgid;
	}

	if (entry.nick) {
		msg.from = {nick: entry.nick, mode: ""};
	}

	if (entry.self) {
		msg.self = true;
	}

	if (entry.highlight) {
		msg.highlight = true;
	}

	if (entry.replyTo) {
		msg.replyTo = entry.replyTo;
	}

	if (entry.editedAt) {
		msg.editedAt = new Date(entry.editedAt);
	}

	if (entry.fromAccount) {
		msg.fromAccount = entry.fromAccount;
	}

	if (entry.reactions?.length) {
		msg.reactions = entry.reactions.map((r) => ({...r, nicks: [...r.nicks]}));
	}

	return msg;
}

/**
 * Add or take `nick`'s reaction `text` on a stored line (`fold` is the
 * network's casemapping). False when nothing changed. Shared with
 * historycache.ts.
 */
export function applyLoggedReaction(
	line: LoggedMsg,
	text: string,
	nick: string,
	remove: boolean,
	fold: (s: string) => string
): boolean {
	const reactions = line.reactions ?? [];
	let reaction = reactions.find((r) => r.text === text);

	if (remove) {
		if (!reaction) {
			return false;
		}

		reaction.nicks = reaction.nicks.filter((n) => fold(n) !== fold(nick));

		if (reaction.nicks.length === 0) {
			reactions.splice(reactions.indexOf(reaction), 1);
		}
	} else {
		if (!reaction) {
			reaction = {text, nicks: []};
			reactions.push(reaction);
		}

		if (reaction.nicks.some((n) => fold(n) === fold(nick))) {
			return false;
		}

		reaction.nicks.push(nick);
	}

	if (reactions.length > 0) {
		line.reactions = reactions;
	} else {
		delete line.reactions;
	}

	return true;
}

function validEntry(value: unknown): value is LoggedMsg {
	const e = value as LoggedMsg;
	return (
		typeof e === "object" &&
		e !== null &&
		typeof e.time === "string" &&
		typeof e.type === "string" &&
		typeof e.text === "string" &&
		!Number.isNaN(new Date(e.time).getTime())
	);
}

function parse(raw: string | null): LoggedQuery[] {
	if (!raw) {
		return [];
	}

	try {
		const data = JSON.parse(raw) as {v?: unknown; queries?: unknown};

		if (data?.v !== 1 || !Array.isArray(data.queries)) {
			return [];
		}

		return (data.queries as unknown[])
			.filter(
				(q): q is LoggedQuery =>
					typeof (q as LoggedQuery)?.name === "string" &&
					Array.isArray((q as LoggedQuery).messages)
			)
			.map((q) => ({
				name: q.name,
				touched: typeof q.touched === "number" ? q.touched : 0,
				...(typeof q.read === "number" ? {read: q.read} : {}),
				messages: q.messages.filter(validEntry),
			}));
	} catch {
		return [];
	}
}

/**
 * One network's log. `fold` is the network's casemapping (a query is found
 * whatever case its nick arrives in); `persist` says whether the network is
 * saved — a network the user never saved has a fresh uuid every page, so
 * its log is kept in memory only.
 */
export class QueryLog {
	private queries: LoggedQuery[] | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		readonly uuid: string,
		private readonly fold: (s: string) => string,
		private readonly persist: () => boolean = () => true
	) {
		live.add(this);
	}

	/** Stop tracking (the client is gone); pending lines are written first. */
	dispose(): void {
		this.flush();
		live.delete(this);
	}

	/** Names of the logged queries, most recently active first. */
	names(): string[] {
		return enabled ? this.load().map((q) => q.name) : [];
	}

	/** The logged lines of `name`, oldest first, as messages without ids. */
	messages(name: string): SharedMsg[] {
		return this.find(name)?.messages.map(fromLogged) ?? [];
	}

	/** msgids of edits folded into logged lines of `name` (history dedupe),
	 * each with the index in {@link messages} of the line it now is. */
	aliases(name: string): Array<[msgid: string, index: number]> {
		return (
			this.find(name)?.messages.flatMap((m, i) =>
				(m.aka ?? []).map((a): [string, number] => [a, i])
			) ?? []
		);
	}

	/** Epoch ms of the newest line logged for `name`, if it has a log. */
	newestAt(name: string): number | undefined {
		return this.find(name)?.touched;
	}

	/** The time query `name` was last known read up to, if it was. */
	readUpTo(name: string): Date | undefined {
		const read = this.find(name)?.read;
		return read === undefined ? undefined : new Date(read);
	}

	/** Query `name` was read up to `time` (its read marker moved). */
	setRead(name: string, time: Date): void {
		const query = enabled ? this.find(name) : undefined;

		if (query && (query.read ?? 0) < time.getTime()) {
			query.read = time.getTime();
			this.changed();
		}
	}

	/** Keep `msg` (a line shown in query `name`); anything not a message is ignored. */
	append(name: string, msg: SharedMsg): void {
		const entry = enabled ? toLogged(msg) : undefined;

		if (!entry) {
			return;
		}

		const query = this.findOrCreate(name);

		if (entry.msgid && query.messages.some((m) => this.hasMsgid(m, entry.msgid!))) {
			return;
		}

		// By time: a history page brings older lines after newer ones.
		const t = timeOf(entry.time);
		let at = query.messages.length;

		while (at > 0 && timeOf(query.messages[at - 1].time) > t) {
			at--;
		}

		query.messages.splice(at, 0, entry);

		if (query.messages.length > MAX_MESSAGES) {
			query.messages.splice(0, query.messages.length - MAX_MESSAGES);
		}

		query.touched = Math.max(query.touched, t);
		this.changed();
	}

	/** The line `editMsgid` replaces `originalMsgid`: rewrite the original, drop the edit's own line. */
	edit(name: string, originalMsgid: string, editMsgid: string): void {
		const query = this.find(name);
		const edit = query?.messages.find((m) => m.msgid === editMsgid);
		const original = query?.messages.find((m) => this.hasMsgid(m, originalMsgid));

		if (!query || !edit || !original || edit === original) {
			return;
		}

		original.text = edit.text;
		// An edit can turn a message into an action (`/me`) and back.
		original.type = edit.type;
		original.editedAt = edit.time;
		original.aka = [...(original.aka ?? []), editMsgid];
		query.messages.splice(query.messages.indexOf(edit), 1);
		this.changed();
	}

	/** A redaction: the line is not kept. */
	redact(name: string, msgid: string): void {
		const query = this.find(name);
		const index = query?.messages.findIndex((m) => this.hasMsgid(m, msgid)) ?? -1;

		if (query && index !== -1) {
			query.messages.splice(index, 1);
			this.changed();
		}
	}

	/** A reaction added or taken off a logged line. */
	react(name: string, msgid: string, text: string, nick: string, remove: boolean): void {
		const line = this.find(name)?.messages.find((m) => this.hasMsgid(m, msgid));

		if (line && applyLoggedReaction(line, text, nick, remove, this.fold)) {
			this.changed();
		}
	}

	/** The query was closed: forget it. */
	forget(name: string): void {
		const queries = this.load();
		const index = queries.findIndex((q) => this.fold(q.name) === this.fold(name));

		if (index !== -1) {
			queries.splice(index, 1);
			this.changed();
		}
	}

	/** Forget everything, in memory and on disk. */
	clear(): void {
		this.cancel();
		this.queries = [];
		backend.remove(this.key);
	}

	/** Write now if anything is pending. */
	flush(): void {
		if (this.timer !== null) {
			this.cancel();
			this.save();
		}
	}

	private get key(): string {
		return QUERY_LOG_PREFIX + this.uuid;
	}

	private hasMsgid(line: LoggedMsg, msgid: string): boolean {
		return line.msgid === msgid || (line.aka?.includes(msgid) ?? false);
	}

	private load(): LoggedQuery[] {
		if (this.queries === null) {
			this.queries = parse(backend.get(this.key)).sort((a, b) => b.touched - a.touched);
		}

		return this.queries;
	}

	private find(name: string): LoggedQuery | undefined {
		const folded = this.fold(name);
		return this.load().find((q) => this.fold(q.name) === folded);
	}

	private findOrCreate(name: string): LoggedQuery {
		let query = this.find(name);

		if (!query) {
			query = {name, touched: 0, read: 0, messages: []};
			this.load().push(query);
		}

		return query;
	}

	private changed(): void {
		if (this.timer === null) {
			this.timer = setTimeout(() => {
				this.timer = null;
				this.save();
			}, SAVE_DELAY_MS);
		}
	}

	private cancel(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	private save(): void {
		if (!enabled || !this.persist()) {
			return;
		}

		const queries = this.load()
			.filter((q) => q.messages.length > 0)
			.sort((a, b) => b.touched - a.touched)
			.slice(0, MAX_QUERIES);
		this.queries = queries;

		// Oldest conversations out until it fits; the newest one alone is
		// cut from its old end.
		let json = JSON.stringify({v: 1, queries});

		while (json.length > MAX_CHARS && queries.length > 0) {
			if (queries.length > 1) {
				queries.pop();
			} else {
				const only = queries[0];
				only.messages.splice(0, Math.max(1, Math.ceil(only.messages.length / 4)));

				if (only.messages.length === 0) {
					queries.pop();
				}
			}

			json = JSON.stringify({v: 1, queries});
		}

		if (queries.length === 0) {
			backend.remove(this.key);
			return;
		}

		backend.set(this.key, json);
	}
}
