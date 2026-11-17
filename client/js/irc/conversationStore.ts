/**
 * The conversations kept on this device: one store for every window, channel
 * or private, in IndexedDB (`seance-conversations`). It is what a page load
 * shows before, or without, a connection (`IrcClient.restoreWindow`), what
 * "show older" reads first, and the only copy where the server keeps none (a
 * guest, a private chat nobody stores).
 *
 * One record per line, never a conversation written whole: a tab queues what
 * it changed (a line arrived, an edit, a reaction, a deletion, a read point)
 * and flushes it. A line both tabs received has one key, and the second
 * write finds the first; a line is added only when absent, so a late copy
 * never undoes an edit or a reaction another tab applied, and a line that
 * was deleted leaves a short-lived note that keeps a late copy out
 * ({@link ConvRecord.dead}). Two copies of the app cannot overwrite each
 * other.
 *
 * Shape: `convs` holds one {@link ConvRecord} per window (the index: which
 * windows existed, without reading a line); `lines` holds the
 * {@link LineRecord}s under `[conversation, time, key]`, so the newest lines,
 * a page of older ones and a trim are all key ranges. A line's `key` is its
 * msgid, or a best-effort identity without one ({@link lineKey}). An index
 * finds a line by msgid, the msgids of the edits folded into it included.
 *
 * A window the user closed is remembered, not forgotten
 * ({@link ConvRecord.closed}): it is not shown and never opens by itself,
 * and when it is opened again (the channel joined, the private conversation
 * written in or asked for) its lines are there, read.
 *
 * Caps: the newest {@link MAX_LINES} per conversation, oldest out first and
 * never from the middle. No age limit. Removing the network forgets it all;
 * "Clear history" empties one window and keeps what was cleared from coming
 * back ({@link ConvRecord.clearedAt}). When the disk is full, deletions are
 * written by themselves so that they still land, and the oldest half of
 * every long conversation goes to make room.
 *
 * The user can switch it off (Settings → General, `keepPrivateConversations`,
 * the one switch for both kinds): nothing is kept or restored then, and
 * switching it off deletes what was kept. Saved networks only: a network the
 * user never saved has a fresh uuid every page.
 *
 * Reads at boot are asynchronous, the client is not: {@link preloadConversations}
 * reads every network's newest lines before any client exists, and the
 * client's constructor takes its network's share, once ({@link ConversationStore}).
 * A store that goes away reads its share again for the next one.
 *
 * Kept free of store/DOM imports so it runs under mocha, where nothing is
 * kept unless a test swaps in a {@link MemoryBackend}; tests share one
 * between two stores to stand in for two tabs.
 * docs/projects/conversation-store.md.
 */

import {applyReaction} from "../helpers/messageUpdates";
import {openDatabase} from "../idb";
import storage from "../localStorage";
import {MessageType, type MsgReaction, type SharedMsg} from "../../../shared/types/msg";

/** Newest lines kept per conversation. */
export const MAX_LINES = 1000;
/** Lines over the cap before a trim runs (a trim per line would be a scan per line). */
const TRIM_SLACK = 100;
/** Lines put back into each window at page load. */
export const RESTORE_LINES = 100;
/** Trailing write throttle. */
const FLUSH_DELAY_MS = 250;
/** How long the page waits for the boot read before going on without it. */
export const PRELOAD_TIMEOUT_MS = 1000;
/** How long a deleted line's msgid keeps a late copy of it out. */
export const DEAD_FOR_MS = 7 * 24 * 60 * 60 * 1000;
/** Most deleted msgids remembered per conversation. */
const DEAD_MAX = 500;
/** A conversation shorter than this is left alone when the disk is full. */
const EVICT_FLOOR = 100;

/**
 * Changes a page could not write before it went away, per network and tab
 * (`<prefix><uuid>.<tab>`): IndexedDB is asynchronous and a page being
 * unloaded gets no further turn, so they are left in localStorage, which is
 * synchronous, and applied by the next page load ({@link preloadConversations}).
 */
export const JOURNAL_PREFIX = "thelounge.conversations.pending.";
/** The localStorage keys of the private log this store replaced (migrated once). */
export const LEGACY_LOG_PREFIX = "thelounge.querylog.";

export type ConvKind = "channel" | "query";

/** What a window shows that is worth keeping: what was said, and what happened. */
const KEPT_TYPES = new Set<string>([
	MessageType.MESSAGE,
	MessageType.ACTION,
	MessageType.NOTICE,
	MessageType.JOIN,
	MessageType.PART,
	MessageType.QUIT,
	MessageType.KICK,
	MessageType.MODE,
	MessageType.TOPIC,
	MessageType.NICK,
]);

/** A message as kept: everything it renders from, minus what belongs to one page. */
export type StoredMsg = Omit<SharedMsg, "id" | "previews" | "pending" | "supersededBy">;

/** One window. */
export interface ConvRecord {
	/** `<uuid>\n<folded target>`. */
	c: string;
	uuid: string;
	/** The target, casefolded. */
	target: string;
	/** The name as shown. */
	name: string;
	kind: ConvKind;
	/** Epoch ms of the newest line. */
	touched: number;
	/** Epoch ms this device last knew it read up to; absent when never known. */
	read?: number;
	/** The device held everything up to the newest line when last written (Channel.historyFilled). */
	filled?: boolean;
	/**
	 * A channel we were in when last written. Where nothing else holds our
	 * channels (no bouncer, no held session) a page load joins it again, as
	 * a reconnect does.
	 */
	joined?: boolean;
	/** That channel's key, for the join. */
	key?: string;
	/**
	 * The user closed the window: it is not shown and does not open by
	 * itself. Its lines stay for the day it is opened again.
	 */
	closed?: boolean;
	/** Nothing at or before this (epoch ms) is kept or shown again: "Clear history". */
	clearedAt?: number;
	/** Lines kept. */
	n: number;
	/** The newest line the server stamped (the catch-up cursor's bound). */
	last?: {msgid: string; time: number};
	/**
	 * msgids of lines deleted here (REDACT), with when: a copy of one that
	 * another tab had queued, or a journal an earlier page left, does not
	 * bring it back. Forgotten after {@link DEAD_FOR_MS}.
	 */
	dead?: Record<string, number>;
}

/** One line. */
export interface LineRecord {
	c: string;
	/** Epoch ms. */
	t: number;
	/** The msgid, or a best-effort identity ({@link lineKey}). */
	k: string;
	/** `<c>\n<msgid>` for the msgid and for every edit folded in (the lookup index). */
	ids?: string[];
	msg: StoredMsg;
}

/** A change one tab queues. */
export type StoreOp =
	| {
			op: "put";
			target: string;
			name: string;
			kind: ConvKind;
			t: number;
			k: string;
			msg: StoredMsg;
	  }
	| {op: "edit"; target: string; original: string; edit: string}
	| {op: "react"; target: string; msgid: string; text: string; nick: string; remove: boolean}
	| {op: "redact"; target: string; msgid: string; at: number}
	| {op: "gap"; target: string; t: number; k: string; on: boolean}
	| {
			op: "meta";
			target: string;
			name: string;
			kind: ConvKind;
			/** Make the record when there is none (a channel joined, not a query without a line). */
			create?: boolean;
			read?: number;
			filled?: boolean;
			joined?: boolean;
			key?: string;
			/** The window is open again. */
			open?: true;
	  }
	| {op: "clear"; target: string; at: number}
	/** The window was closed, at `at`: what it held is read. Its lines stay. */
	| {op: "close"; target: string; at: number};

/** The ops that take something away: written by themselves when the disk is full. */
const DELETES = new Set<StoreOp["op"]>(["redact", "clear"]);

/** One transaction's view of the database. */
export interface StoreTx {
	getConv(c: string): Promise<ConvRecord | undefined>;
	putConv(rec: ConvRecord): void;
	allConvs(): Promise<ConvRecord[]>;
	getLine(c: string, t: number, k: string): Promise<LineRecord | undefined>;
	/** The line whose msgid, or one of whose folded edits' msgids, is `msgid`. */
	lineById(c: string, msgid: string): Promise<LineRecord | undefined>;
	putLine(rec: LineRecord): void;
	deleteLine(c: string, t: number, k: string): void;
	/** Up to `limit` lines of `c` at or before `upTo` (epoch ms; all when undefined), newest first. */
	newest(c: string, limit: number, upTo?: number): Promise<LineRecord[]>;
	/** Delete the `count` oldest lines of `c`. */
	deleteOldest(c: string, count: number): Promise<void>;
	deleteLines(c: string): void;
	/** Every conversation and line of a network. */
	deleteNetwork(uuid: string): void;
	deleteAll(): void;
	getEpoch(key: string): Promise<number>;
	putEpoch(key: string, value: number): void;
}

export interface ConversationBackend {
	run<T>(mode: "readonly" | "readwrite", fn: (tx: StoreTx) => Promise<T>): Promise<T>;
	/** What {@link preloadConversations} would read, at once, where the backend can say (tests). */
	snapshotNow?(): Snapshot;
}

const convKey = (uuid: string, target: string): string => `${uuid}\n${target}`;
const idKey = (c: string, msgid: string): string => `${c}\n${msgid}`;
const ALL = "*";

function timeOf(value: Date | string): number {
	return (value instanceof Date ? value : new Date(value)).getTime();
}

/**
 * What a line is without its time: sender, kind and what it says. The one
 * identity for lines the server gave no msgid (this store's keys, a window's
 * "is this line shown", ZNC's buffer replay in history.ts). `fold` is the
 * network's casemapping.
 */
export function lineIdentity(
	msg: Pick<SharedMsg, "from" | "type" | "text"> &
		Partial<Pick<SharedMsg, "new_nick" | "target">>,
	fold: (s: string) => string
): string {
	return [
		"",
		fold(msg.from?.nick ?? ""),
		msg.type ?? "",
		msg.text ?? "",
		msg.new_nick ?? "",
		msg.target?.nick ?? "",
	].join("\0");
}

/**
 * A line's key: the msgid where the server gave one. Without, a best-effort
 * {@link lineIdentity}: two copies of the app that got the same line make
 * the same key, as long as the server stamped it (`server-time`). Two equal
 * lines from one sender in the same millisecond are one line here, and
 * without `server-time` each tab stamps its own clock and keeps its own
 * copy: best effort, as far as it goes without msgids.
 */
export function lineKey(
	msg: Pick<SharedMsg, "msgid" | "from" | "type" | "text">,
	fold: (s: string) => string
): string {
	return msg.msgid ?? lineIdentity(msg, fold);
}

/** The copy of `msg` that is kept, or undefined for a line that is not. */
function toStored(msg: SharedMsg): StoredMsg | undefined {
	if (!msg.type || !KEPT_TYPES.has(msg.type) || msg.pending) {
		return undefined;
	}

	if (Number.isNaN(timeOf(msg.time))) {
		return undefined;
	}

	// Someone talking always has text; an event may not.
	const said =
		msg.type === MessageType.MESSAGE ||
		msg.type === MessageType.ACTION ||
		msg.type === MessageType.NOTICE;

	if (said && typeof msg.text !== "string") {
		return undefined;
	}

	const {id: _id, previews: _previews, pending: _pending, supersededBy: _by, ...rest} = msg;

	try {
		// A copy of its own: the UI goes on changing the message it was given
		// (reactions, previews), and the database takes plain data only.
		const copy = structuredClone(rest) as StoredMsg;
		copy.time = new Date(timeOf(msg.time));
		return copy;
	} catch {
		return undefined;
	}
}

/** A kept line as a message without an id. */
function fromStored(stored: StoredMsg): SharedMsg {
	const msg = structuredClone(stored) as SharedMsg;
	msg.id = 0;
	msg.time = new Date(timeOf(stored.time));
	msg.users ??= [];
	return msg;
}

// ------------------------------------------------------------------ snapshot

/** What a page load reads: every window, and the newest lines of each. */
export interface Snapshot {
	/** Per network uuid. */
	convs: Map<string, ConvRecord[]>;
	/** Per conversation key, oldest first. */
	lines: Map<string, LineRecord[]>;
	epochs: Map<string, number>;
}

function emptySnapshot(): Snapshot {
	return {convs: new Map(), lines: new Map(), epochs: new Map()};
}

function addToSnapshot(snapshot: Snapshot, conv: ConvRecord, lines: LineRecord[]): void {
	const list = snapshot.convs.get(conv.uuid);

	if (list) {
		list.push(conv);
	} else {
		snapshot.convs.set(conv.uuid, [conv]);
	}

	snapshot.lines.set(conv.c, lines);
}

/** Read one network's windows and newest lines into `snapshot`. */
async function readNetwork(tx: StoreTx, convs: ConvRecord[], snapshot: Snapshot): Promise<void> {
	for (const conv of convs) {
		const lines = conv.n > 0 ? await tx.newest(conv.c, RESTORE_LINES) : [];
		addToSnapshot(snapshot, conv, lines.reverse());
		snapshot.epochs.set(conv.uuid, await tx.getEpoch(conv.uuid));
	}
}

// ------------------------------------------------------------ memory backend

/**
 * The store in memory, for the tests: two {@link ConversationStore}s on one
 * instance stand in for two tabs, and a store made after another was flushed
 * for a page load.
 */
export class MemoryBackend implements ConversationBackend {
	readonly convs = new Map<string, ConvRecord>();
	/** Lines per conversation, oldest first. */
	readonly lines = new Map<string, LineRecord[]>();
	readonly epochs = new Map<string, number>();
	/** Make the next read-write transaction fail as a full disk does (tests). */
	failNext: "QuotaExceededError" | undefined;

	snapshotNow(): Snapshot {
		const snapshot = emptySnapshot();

		for (const conv of this.convs.values()) {
			addToSnapshot(
				snapshot,
				structuredClone(conv),
				structuredClone((this.lines.get(conv.c) ?? []).slice(-RESTORE_LINES))
			);
		}

		for (const [key, value] of this.epochs) {
			snapshot.epochs.set(key, value);
		}

		return snapshot;
	}

	run<T>(mode: "readonly" | "readwrite", fn: (tx: StoreTx) => Promise<T>): Promise<T> {
		if (mode === "readwrite" && this.failNext) {
			const name = this.failNext;
			this.failNext = undefined;
			return Promise.reject(new DOMException("The quota has been exceeded.", name));
		}

		return fn(this.tx());
	}

	private linesOf(c: string): LineRecord[] {
		let list = this.lines.get(c);

		if (!list) {
			list = [];
			this.lines.set(c, list);
		}

		return list;
	}

	private tx(): StoreTx {
		const at = (list: LineRecord[], t: number, k: string) =>
			list.findIndex((l) => l.t === t && l.k === k);

		return {
			getConv: (c) => Promise.resolve(structuredClone(this.convs.get(c))),
			putConv: (rec) => void this.convs.set(rec.c, structuredClone(rec)),
			allConvs: () => Promise.resolve(structuredClone([...this.convs.values()])),
			getLine: (c, t, k) => {
				const list = this.linesOf(c);
				return Promise.resolve(structuredClone(list[at(list, t, k)]));
			},
			lineById: (c, msgid) => {
				const id = idKey(c, msgid);
				return Promise.resolve(
					structuredClone(this.linesOf(c).find((l) => l.ids?.includes(id)))
				);
			},
			putLine: (rec) => {
				const list = this.linesOf(rec.c);
				const i = at(list, rec.t, rec.k);
				const copy = structuredClone(rec);

				if (i !== -1) {
					list[i] = copy;
					return;
				}

				let pos = list.length;

				while (
					pos > 0 &&
					(list[pos - 1].t > rec.t ||
						(list[pos - 1].t === rec.t && list[pos - 1].k > rec.k))
				) {
					pos--;
				}

				list.splice(pos, 0, copy);
			},
			deleteLine: (c, t, k) => {
				const list = this.linesOf(c);
				const i = at(list, t, k);

				if (i !== -1) {
					list.splice(i, 1);
				}
			},
			newest: (c, limit, upTo) => {
				const list = this.linesOf(c).filter((l) => upTo === undefined || l.t <= upTo);
				return Promise.resolve(structuredClone(list.slice(-limit).reverse()));
			},
			deleteOldest: (c, count) => {
				this.linesOf(c).splice(0, count);
				return Promise.resolve();
			},
			deleteLines: (c) => void this.lines.delete(c),
			deleteNetwork: (uuid) => {
				for (const key of [...this.convs.keys()]) {
					if (key.startsWith(uuid + "\n")) {
						this.convs.delete(key);
						this.lines.delete(key);
					}
				}
			},
			deleteAll: () => {
				this.convs.clear();
				this.lines.clear();
			},
			getEpoch: (key) => Promise.resolve(this.epochs.get(key) ?? 0),
			putEpoch: (key, value) => void this.epochs.set(key, value),
		};
	}
}

// --------------------------------------------------------- IndexedDB backend

const DB_NAME = "seance-conversations";
const DB_VERSION = 1;
const CONVS = "convs";
const LINES = "lines";
const EPOCHS = "epochs";

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new DOMException("Request failed", "UnknownError"));
	});
}

/** The one connection, kept open; opened again when the browser closes it. */
let connection: Promise<IDBDatabase> | undefined;

function database(): Promise<IDBDatabase> {
	connection ??= openDatabase(DB_NAME, DB_VERSION, (db) => {
		if (!db.objectStoreNames.contains(CONVS)) {
			db.createObjectStore(CONVS, {keyPath: "c"});
		}

		if (!db.objectStoreNames.contains(LINES)) {
			const lines = db.createObjectStore(LINES, {keyPath: ["c", "t", "k"]});
			lines.createIndex("ids", "ids", {multiEntry: true});
		}

		if (!db.objectStoreNames.contains(EPOCHS)) {
			db.createObjectStore(EPOCHS);
		}
	}).then(
		(db) => {
			const drop = () => {
				connection = undefined;
			};

			// WebKit closes the connection of a suspended installed app; a
			// newer build of the page asks for it with `versionchange`.
			db.onclose = drop;

			db.onversionchange = () => {
				drop();
				db.close();
			};

			return db;
		},
		(err: unknown) => {
			connection = undefined;
			throw err;
		}
	);
	return connection;
}

const linesRange = (c: string, upTo?: number): IDBKeyRange =>
	IDBKeyRange.bound([c, -Infinity, ""], [c, upTo ?? Infinity, "￿"]);

function view(tx: IDBTransaction): StoreTx {
	const convs = tx.objectStore(CONVS);
	const lines = tx.objectStore(LINES);
	const epochs = tx.objectStore(EPOCHS);

	return {
		getConv: (c) => request(convs.get(c) as IDBRequest<ConvRecord | undefined>),
		putConv: (rec) => void convs.put(rec),
		allConvs: () => request(convs.getAll() as IDBRequest<ConvRecord[]>),
		getLine: (c, t, k) => request(lines.get([c, t, k]) as IDBRequest<LineRecord | undefined>),
		lineById: (c, msgid) =>
			request(lines.index("ids").get(idKey(c, msgid)) as IDBRequest<LineRecord | undefined>),
		putLine: (rec) => void lines.put(rec),
		deleteLine: (c, t, k) => void lines.delete([c, t, k]),
		newest: (c, limit, upTo) =>
			new Promise<LineRecord[]>((resolve, reject) => {
				const out: LineRecord[] = [];
				const req = lines.openCursor(linesRange(c, upTo), "prev");

				req.onsuccess = () => {
					const cursor = req.result;

					if (!cursor || out.length >= limit) {
						resolve(out);
						return;
					}

					out.push(cursor.value as LineRecord);
					cursor.continue();
				};

				req.onerror = () =>
					reject(req.error ?? new DOMException("Request failed", "UnknownError"));
			}),
		async deleteOldest(c, count) {
			const keys = await request(lines.getAllKeys(linesRange(c), count));

			for (const key of keys) {
				lines.delete(key);
			}
		},
		deleteLines: (c) => void lines.delete(linesRange(c)),
		deleteNetwork(uuid) {
			convs.delete(IDBKeyRange.bound(`${uuid}\n`, `${uuid}\n￿`));
			lines.delete(
				IDBKeyRange.bound([`${uuid}\n`, -Infinity, ""], [`${uuid}\n￿`, Infinity, "￿"])
			);
		},
		deleteAll() {
			convs.clear();
			lines.clear();
		},
		getEpoch: async (key) =>
			(await request(epochs.get(key) as IDBRequest<number | undefined>)) ?? 0,
		putEpoch: (key, value) => void epochs.put(value, key),
	};
}

/**
 * IndexedDB, one connection for the page. Read-write transactions on the
 * same stores run one after another, across tabs and the installed app,
 * which is what makes a read-modify-write safe.
 */
const indexedDbBackend: ConversationBackend = {
	async run<T>(mode: "readonly" | "readwrite", fn: (tx: StoreTx) => Promise<T>): Promise<T> {
		let db = await database();
		let tx: IDBTransaction;

		try {
			tx = db.transaction([CONVS, LINES, EPOCHS], mode);
		} catch {
			// The connection was closed under us: once more, on a new one.
			connection = undefined;
			db = await database();
			tx = db.transaction([CONVS, LINES, EPOCHS], mode);
		}

		const done = new Promise<void>((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onerror = () =>
				reject(tx.error ?? new DOMException("Transaction failed", "AbortError"));
			tx.onabort = () =>
				reject(tx.error ?? new DOMException("Transaction aborted", "AbortError"));
		});
		let result: T;

		try {
			result = await fn(view(tx));
		} catch (err: unknown) {
			try {
				tx.abort();
			} catch {
				// already finished
			}

			await done.catch(() => undefined);
			throw err;
		}

		await done;
		return result;
	},
};

/** Nothing kept: what a page without IndexedDB (and mocha, by default) gets. */
const noBackend: ConversationBackend = {
	run: (mode, fn) => new MemoryBackend().run(mode, fn),
};

/** What {@link preloadConversations} read; a network's share goes to its first store. */
let preloaded: Snapshot | undefined;
/** Networks whose share was taken and has not been read again since. */
const taken = new Set<string>();
let enabled = true;

function defaultBackend(): ConversationBackend {
	return typeof globalThis.indexedDB === "undefined" ? noBackend : indexedDbBackend;
}

let backend: ConversationBackend = defaultBackend();

/** Swap the persistence backend (tests); `null` restores the default. */
export function useConversationBackend(next: ConversationBackend | null): void {
	backend = next ?? defaultBackend();
	preloaded = undefined;
	taken.clear();
}

// ------------------------------------------------------------- the op logic

/** Forget deletions older than {@link DEAD_FOR_MS}, and the oldest beyond {@link DEAD_MAX}. */
function pruneDead(rec: ConvRecord, now: number): void {
	if (!rec.dead) {
		return;
	}

	let entries = Object.entries(rec.dead).filter(([, at]) => now - at <= DEAD_FOR_MS);

	if (entries.length > DEAD_MAX) {
		entries = entries.sort((a, b) => a[1] - b[1]).slice(entries.length - DEAD_MAX);
	}

	if (entries.length > 0) {
		rec.dead = Object.fromEntries(entries);
	} else {
		delete rec.dead;
	}
}

/**
 * Apply one tab's queued changes inside a transaction. `epochs` is what the
 * tab last knew: when another tab deleted the network, or everything (the
 * setting went off), since, the queue is dropped and the new epochs are
 * returned for the tab to carry on with.
 */
export async function applyOps(
	tx: StoreTx,
	uuid: string,
	epochs: {all: number; net: number},
	ops: StoreOp[],
	now = Date.now()
): Promise<{stale: boolean; all: number; net: number}> {
	const all = await tx.getEpoch(ALL);
	const net = await tx.getEpoch(uuid);

	if (all !== epochs.all || net !== epochs.net) {
		return {stale: true, all, net};
	}

	const convs = new Map<string, ConvRecord | null>();
	const dirty = new Set<string>();

	const conv = async (target: string): Promise<ConvRecord | undefined> => {
		const c = convKey(uuid, target);

		if (!convs.has(c)) {
			convs.set(c, (await tx.getConv(c)) ?? null);
		}

		return convs.get(c) ?? undefined;
	};

	const make = (target: string, name: string, kind: ConvKind): ConvRecord => {
		const rec: ConvRecord = {
			c: convKey(uuid, target),
			uuid,
			target,
			name,
			kind,
			touched: 0,
			n: 0,
		};
		convs.set(rec.c, rec);
		dirty.add(rec.c);
		return rec;
	};

	for (const op of ops) {
		const c = convKey(uuid, op.target);

		switch (op.op) {
			case "put": {
				const rec = (await conv(op.target)) ?? make(op.target, op.name, op.kind);
				const msgid = op.msg.msgid;

				if (rec.clearedAt !== undefined && op.t <= rec.clearedAt) {
					break;
				}

				if (msgid && rec.dead?.[msgid] !== undefined) {
					break; // deleted here: a late copy does not bring it back
				}

				const held = msgid ? await tx.lineById(c, msgid) : await tx.getLine(c, op.t, op.k);

				if (held) {
					break; // added only when absent: the kept copy has the edits and reactions
				}

				tx.putLine({
					c,
					t: op.t,
					k: op.k,
					...(msgid ? {ids: [idKey(c, msgid)]} : {}),
					msg: op.msg,
				});
				rec.n++;
				rec.name = op.name;
				rec.touched = Math.max(rec.touched, op.t);

				if (msgid && (!rec.last || rec.last.time < op.t)) {
					rec.last = {msgid, time: op.t};
				}

				dirty.add(c);
				break;
			}

			case "edit": {
				// The edit's own line first: once its msgid is folded into the
				// original, the lookup would find the original.
				const edit = await tx.lineById(c, op.edit);
				const original = await tx.lineById(c, op.original);
				const rec = await conv(op.target);

				// Folded in already (the other tab), or one of them is not kept.
				if (
					!original ||
					!edit ||
					!rec ||
					(edit.t === original.t && edit.k === original.k)
				) {
					break;
				}

				tx.deleteLine(c, edit.t, edit.k);
				rec.n = Math.max(0, rec.n - 1);
				dirty.add(c);
				original.msg.text = edit.msg.text;
				// An edit can turn a message into an action (`/me`) and back.
				original.msg.type = edit.msg.type;
				original.msg.editedAt = edit.msg.editedAt ?? edit.msg.time;
				original.ids = [...(original.ids ?? []), idKey(c, op.edit)];
				tx.putLine(original);
				break;
			}

			case "react": {
				const line = await tx.lineById(c, op.msgid);

				if (line) {
					const before = JSON.stringify(line.msg.reactions ?? []);
					applyReaction(line.msg as SharedMsg, op.text, op.nick, op.remove);

					if (JSON.stringify(line.msg.reactions ?? []) !== before) {
						if (!line.msg.reactions) {
							delete line.msg.reactions;
						}

						tx.putLine(line);
					}
				}

				break;
			}

			case "redact": {
				const line = await tx.lineById(c, op.msgid);
				const rec = await conv(op.target);

				if (line) {
					tx.deleteLine(c, line.t, line.k);
				}

				// Remembered whether or not the line is here yet: its copy may
				// still be on its way from another tab, or in a journal.
				if (rec) {
					rec.n = Math.max(0, rec.n - (line ? 1 : 0));
					rec.dead = {...rec.dead, [op.msgid]: op.at};
					dirty.add(c);
				}

				break;
			}

			case "gap": {
				const line = await tx.getLine(c, op.t, op.k);

				if (line && !!line.msg.gapBefore !== op.on) {
					if (op.on) {
						line.msg.gapBefore = true;
					} else {
						delete line.msg.gapBefore;
					}

					tx.putLine(line);
				}

				break;
			}

			case "meta": {
				let rec = await conv(op.target);

				if (!rec) {
					if (!op.create) {
						break;
					}

					rec = make(op.target, op.name, op.kind);
				}

				if (op.read !== undefined && (rec.read ?? -1) < op.read) {
					rec.read = op.read;
					dirty.add(c);
				}

				if (op.filled !== undefined && !!rec.filled !== op.filled) {
					rec.filled = op.filled;
					dirty.add(c);
				}

				if (op.joined !== undefined && !!rec.joined !== op.joined) {
					rec.joined = op.joined;
					dirty.add(c);
				}

				if (op.key !== undefined && (rec.key ?? "") !== op.key) {
					if (op.key) {
						rec.key = op.key;
					} else {
						delete rec.key;
					}

					dirty.add(c);
				}

				if (op.open && rec.closed) {
					delete rec.closed;
					rec.name = op.name;
					dirty.add(c);
				}

				break;
			}

			case "clear": {
				const rec = await conv(op.target);

				if (rec) {
					tx.deleteLines(c);
					rec.n = 0;
					rec.clearedAt = Math.max(rec.clearedAt ?? 0, op.at);
					dirty.add(c);
				}

				break;
			}

			case "close": {
				const rec = await conv(op.target);

				if (!rec) {
					break;
				}

				rec.closed = true;
				rec.joined = false;
				delete rec.key;

				rec.read = Math.max(rec.read ?? 0, op.at);

				dirty.add(c);
				break;
			}
		}
	}

	for (const c of dirty) {
		const rec = convs.get(c);

		if (!rec) {
			continue;
		}

		if (rec.n > MAX_LINES + TRIM_SLACK) {
			await tx.deleteOldest(c, rec.n - MAX_LINES);
			rec.n = MAX_LINES;
		}

		pruneDead(rec, now);
		tx.putConv(rec);
	}

	return {stale: false, all, net};
}

/**
 * The disk is full: the oldest half of every conversation longer than
 * {@link EVICT_FLOOR} goes, on every network. The server gives back what it
 * keeps; what only this device had and was oldest is the price of going on.
 */
async function evict(tx: StoreTx): Promise<void> {
	for (const rec of await tx.allConvs()) {
		if (rec.n > EVICT_FLOOR) {
			const drop = Math.floor(rec.n / 2);
			await tx.deleteOldest(rec.c, drop);
			rec.n -= drop;
			tx.putConv(rec);
		}
	}
}

/**
 * `ops` without what takes something away, and without the lines those ops
 * took away: for writing after the deletions went in by themselves, where a
 * line that arrived and was deleted or cleared in the same batch
 * would otherwise land after its deletion.
 */
function withoutDeleted(ops: StoreOp[]): StoreOp[] {
	const emptied = new Map<string, number>();
	const redacted = new Set<string>();

	ops.forEach((op, i) => {
		if (op.op === "clear") {
			emptied.set(op.target, i);
		} else if (op.op === "redact") {
			redacted.add(`${op.target}\n${op.msgid}`);
		}
	});

	return ops.filter((op, i) => {
		if (DELETES.has(op.op)) {
			return false;
		}

		if (op.op !== "put") {
			return true;
		}

		return (
			i > (emptied.get(op.target) ?? -1) &&
			!(op.msg.msgid && redacted.has(`${op.target}\n${op.msg.msgid}`))
		);
	});
}

function isQuotaError(err: unknown): boolean {
	return (err as {name?: string} | null)?.name === "QuotaExceededError";
}

// ------------------------------------------------------------------- journal

/** Dates survive JSON as `{$d: epoch ms}`. */
function encodeJournal(value: unknown): string {
	return JSON.stringify(
		value,
		function (this: Record<string, unknown>, key: string, encoded: unknown): unknown {
			const raw = this[key];
			return raw instanceof Date ? {$d: raw.getTime()} : encoded;
		}
	);
}

function decodeJournal(raw: string): unknown {
	return JSON.parse(raw, (_key, value: unknown) => {
		const date = (value as {$d?: unknown} | null)?.$d;
		return typeof date === "number" ? new Date(date) : value;
	});
}

function journalKeys(): string[] {
	try {
		return (storage.keys?.() ?? []).filter((key) => key.startsWith(JOURNAL_PREFIX));
	} catch {
		return [];
	}
}

/**
 * Apply what earlier pages left in the journal, then delete it. Its lines
 * are older than whatever happened since: one deleted, cleared or closed
 * meanwhile stays so (`applyOps` keeps them out), and a network removed or
 * the setting switched off since drops the journal whole (its epochs).
 */
async function applyJournals(): Promise<void> {
	for (const key of journalKeys()) {
		try {
			const entry = decodeJournal(storage.get(key) ?? "null") as {
				uuid?: string;
				epochs?: {all: number; net: number};
				ops?: StoreOp[];
			} | null;

			if (entry?.uuid && entry.epochs && Array.isArray(entry.ops)) {
				const {uuid, epochs, ops} = entry;
				await backend.run("readwrite", (tx) => applyOps(tx, uuid, epochs, ops));
			}
		} catch {
			// Unreadable, or the write failed: those lines are lost here.
		}

		storage.remove(key);
	}
}

const TAB = Math.random().toString(36).slice(2, 10);

// ----------------------------------------------------------------- migration

interface LegacyMsg {
	msgid?: string;
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

interface LegacyQuery {
	name: string;
	touched: number;
	read?: number;
	messages: LegacyMsg[];
}

/** Read one `thelounge.querylog.<uuid>` value; anything malformed is nothing. */
function parseLegacyLog(raw: string | null): LegacyQuery[] {
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
				(q): q is LegacyQuery =>
					typeof (q as LegacyQuery)?.name === "string" &&
					Array.isArray((q as LegacyQuery).messages)
			)
			.map((q) => ({
				name: q.name,
				touched: typeof q.touched === "number" ? q.touched : 0,
				...(typeof q.read === "number" ? {read: q.read} : {}),
				messages: q.messages.filter(
					(e) =>
						typeof e === "object" &&
						e !== null &&
						typeof e.time === "string" &&
						typeof e.type === "string" &&
						typeof e.text === "string" &&
						!Number.isNaN(new Date(e.time).getTime())
				),
			}));
	} catch {
		return [];
	}
}

function legacyKeys(): string[] {
	try {
		return (storage.keys?.() ?? []).filter((key) => key.startsWith(LEGACY_LOG_PREFIX));
	} catch {
		return [];
	}
}

function dropLegacyLogs(): void {
	for (const key of legacyKeys()) {
		try {
			storage.remove(key);
		} catch {
			// no storage
		}
	}
}

const lower = (s: string): string => s.toLowerCase();

/**
 * Move the private log of before this store (`thelounge.querylog.<uuid>`)
 * in, then delete it. Lines are keyed, so two tabs migrating at once write
 * the same records. The nick is folded the plain way (the network's
 * casemapping is not known yet); the first line that arrives finds the
 * window by its own folding and, where that differs, starts a record of its
 * own beside it, which the store reads as one window.
 */
async function migrateLegacyLogs(): Promise<void> {
	for (const key of legacyKeys()) {
		const uuid = key.slice(LEGACY_LOG_PREFIX.length);
		const queries = parseLegacyLog(storage.get(key));
		const ops: StoreOp[] = [];

		for (const query of queries) {
			const target = lower(query.name);

			for (const entry of query.messages) {
				const msg: StoredMsg = {
					time: new Date(entry.time),
					type: entry.type as MessageType,
					text: entry.text,
					users: [],
					...(entry.msgid ? {msgid: entry.msgid} : {}),
					...(entry.nick ? {from: {nick: entry.nick, mode: ""}} : {}),
					...(entry.self ? {self: true} : {}),
					...(entry.highlight ? {highlight: true} : {}),
					...(entry.replyTo ? {replyTo: entry.replyTo} : {}),
					...(entry.editedAt ? {editedAt: new Date(entry.editedAt)} : {}),
					...(entry.fromAccount ? {fromAccount: entry.fromAccount} : {}),
					...(entry.reactions?.length ? {reactions: entry.reactions} : {}),
				};
				ops.push({
					op: "put",
					target,
					name: query.name,
					kind: "query",
					t: msg.time.getTime(),
					k: lineKey(msg, lower),
					msg,
				});
			}

			if (query.messages.length > 0 && query.read !== undefined) {
				ops.push({
					op: "meta",
					target,
					name: query.name,
					kind: "query",
					read: query.read,
				});
			}
		}

		await backend.run("readwrite", async (tx) => {
			const epochs = {all: await tx.getEpoch(ALL), net: await tx.getEpoch(uuid)};
			await applyOps(tx, uuid, epochs, ops);

			// The msgids of edits the old log had folded in: found again as
			// the line they became (history dedupe).
			for (const query of queries) {
				const c = convKey(uuid, lower(query.name));

				for (const entry of query.messages) {
					if (!entry.msgid || !entry.aka?.length) {
						continue;
					}

					const line = await tx.lineById(c, entry.msgid);

					if (line) {
						const ids = new Set([
							...(line.ids ?? []),
							...entry.aka.map((a) => idKey(c, a)),
						]);
						line.ids = [...ids];
						tx.putLine(line);
					}
				}
			}
		});

		storage.remove(key);
	}
}

// ---------------------------------------------------------------- the boot

/**
 * Read every network's windows and newest lines, once, before any client is
 * made (boot.ts): the client's constructor then takes its share without
 * waiting. Conversations of a network that is no longer saved are deleted on
 * the way (`known`), what earlier pages left in the journal is applied, and
 * the private log this store replaced is moved in. Never rejects; resolves
 * without a snapshot when the read fails or takes longer than
 * {@link PRELOAD_TIMEOUT_MS}: a store made without one says so
 * ({@link ConversationStore.blind}) and nothing it shows is taken for whole.
 */
export async function preloadConversations(known?: () => string[]): Promise<void> {
	if (!enabled) {
		dropLegacyLogs();
		journalKeys().forEach((key) => storage.remove(key));
		return;
	}

	const used = backend;
	const read = (async () => {
		await migrateLegacyLogs();
		await applyJournals();

		return used.run("readwrite", async (tx) => {
			const snapshot = emptySnapshot();
			// An empty list is not trusted to mean "none saved": removing a
			// network deletes its lines there and then.
			const names = known?.() ?? [];
			const keep = names.length > 0 ? new Set(names) : undefined;
			const gone = new Set<string>();
			const convs = (await tx.allConvs()).filter((conv) => {
				if (keep && !keep.has(conv.uuid)) {
					gone.add(conv.uuid);
					return false;
				}

				return true;
			});

			await readNetwork(tx, convs, snapshot);
			gone.forEach((uuid) => tx.deleteNetwork(uuid));
			snapshot.epochs.set(ALL, await tx.getEpoch(ALL));
			return snapshot;
		});
	})();

	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), PRELOAD_TIMEOUT_MS);
	});

	try {
		const snapshot = await Promise.race([read, timeout]);

		if (snapshot && used === backend && enabled) {
			preloaded = snapshot;
			taken.clear();
		}
	} catch {
		// No snapshot: the windows start empty.
	} finally {
		clearTimeout(timer);
		read.catch(() => undefined);
	}
}

/**
 * Network `uuid`'s share of the snapshot, for the one store that takes it:
 * a second store of the same network (a client made again after `/quit`)
 * must not start from what the page loaded with. Undefined when there is
 * none to give: never read, or taken and not read again yet.
 */
function takeSnapshot(uuid: string): Snapshot | undefined {
	if (!enabled || taken.has(uuid)) {
		return undefined;
	}

	if (preloaded) {
		taken.add(uuid);
		return preloaded;
	}

	// A backend that can say at once is always current (tests).
	return backend.snapshotNow?.();
}

/** Read network `uuid` again into the snapshot (its store went away). */
async function rereadNetwork(uuid: string): Promise<void> {
	if (!preloaded || !enabled) {
		taken.delete(uuid);
		return;
	}

	const used = backend;
	const into = preloaded;

	try {
		const fresh = await used.run("readonly", async (tx) => {
			const snapshot = emptySnapshot();
			const convs = (await tx.allConvs()).filter((conv) => conv.uuid === uuid);
			await readNetwork(tx, convs, snapshot);
			snapshot.epochs.set(uuid, await tx.getEpoch(uuid));
			snapshot.epochs.set(ALL, await tx.getEpoch(ALL));
			return snapshot;
		});

		if (preloaded !== into || used !== backend) {
			return;
		}

		for (const conv of into.convs.get(uuid) ?? []) {
			into.lines.delete(conv.c);
		}

		into.convs.set(uuid, fresh.convs.get(uuid) ?? []);
		fresh.lines.forEach((lines, c) => into.lines.set(c, lines));
		fresh.epochs.forEach((value, key) => into.epochs.set(key, value));
		taken.delete(uuid);
	} catch {
		// Not read: the next store of this network starts blind.
	}
}

// ------------------------------------------------------------ the instance

/** What a client knows of one of its windows without reading a line. */
export interface ConvMeta {
	name: string;
	kind: ConvKind;
	touched: number;
	read?: number;
	filled: boolean;
	joined: boolean;
	key?: string;
	closed: boolean;
	clearedAt?: number;
	/** Lines kept, as far as this page knows. */
	n: number;
	last?: {msgid: string; time: number};
}

/** Every live store, so a page going away can write them all. */
const live = new Set<ConversationStore>();

/**
 * One network's conversations, for its client. Built synchronously from the
 * boot snapshot ({@link preloadConversations}); every change is queued and
 * written on a short trailing throttle. `fold` is the network's casemapping;
 * `persist` says whether the network is saved.
 */
export class ConversationStore {
	/**
	 * Made without a snapshot of what the device holds (the boot read was
	 * slow or failed, or another store of this network had taken it and it
	 * was not read again in time): windows start empty though lines may be
	 * kept, so nothing shown is taken for whole (history.ts marks the gap).
	 */
	readonly blind: boolean;
	private readonly metas = new Map<string, ConvMeta>();
	/** The snapshot's lines per folded target, oldest first. */
	private readonly restored = new Map<string, LineRecord[]>();
	private queue: StoreOp[] = [];
	/** Handed to the database, not confirmed yet. */
	private inflight: StoreOp[] = [];
	private journaled = false;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private writing: Promise<void> = Promise.resolve();
	private epochs = {all: 0, net: 0};
	private readonly used: ConversationBackend;

	constructor(
		readonly uuid: string,
		private readonly fold: (s: string) => string,
		private readonly persist: () => boolean = () => true
	) {
		this.used = backend;
		const kept = enabled && this.persist();
		const snapshot = kept ? takeSnapshot(uuid) : undefined;
		this.blind = kept && !snapshot;

		if (snapshot) {
			this.epochs = {
				all: snapshot.epochs.get(ALL) ?? 0,
				net: snapshot.epochs.get(uuid) ?? 0,
			};

			// The same window under two foldings (a migrated log, a casemapping
			// that changed): one window, the lines of both.
			for (const conv of snapshot.convs.get(uuid) ?? []) {
				const folded = this.fold(conv.name);
				const lines = snapshot.lines.get(conv.c) ?? [];
				const meta = this.metas.get(folded);

				if (meta) {
					meta.touched = Math.max(meta.touched, conv.touched);
					meta.n += conv.n;
					meta.closed = meta.closed && !!conv.closed;
					const merged = [...(this.restored.get(folded) ?? []), ...lines].sort(
						(a, b) => a.t - b.t
					);
					this.restored.set(folded, merged.slice(-RESTORE_LINES));
					continue;
				}

				this.metas.set(folded, {
					name: conv.name,
					kind: conv.kind,
					touched: conv.touched,
					read: conv.read,
					filled: !!conv.filled,
					joined: !!conv.joined,
					key: conv.key,
					closed: !!conv.closed,
					clearedAt: conv.clearedAt,
					n: conv.n,
					last: conv.last,
				});
				this.restored.set(folded, lines);
			}
		} else if (this.blind) {
			this.resync();
		}

		live.add(this);
	}

	private get on(): boolean {
		return enabled && this.persist() && this.used === backend;
	}

	/**
	 * Stop tracking (the client is gone): pending changes are written, and
	 * the network is read again for the store that comes after this one.
	 */
	dispose(): void {
		live.delete(this);
		void this.flush().then(() => rereadNetwork(this.uuid));
	}

	/** Forget everything in memory and drop the queue (the data is being deleted). */
	reset(): void {
		this.cancel();
		this.queue = [];
		this.inflight = [];
		this.unjournal();
		this.metas.clear();
		this.restored.clear();
	}

	/** Take the database's epochs as they are now. */
	resync(): void {
		void this.used
			.run("readonly", async (tx) => {
				this.epochs = {all: await tx.getEpoch(ALL), net: await tx.getEpoch(this.uuid)};
			})
			.catch(() => undefined);
	}

	/** The windows the last page left open, most recently active first. */
	windows(): ConvMeta[] {
		return this.on
			? [...this.metas.values()]
					.filter((meta) => !meta.closed)
					.sort((a, b) => b.touched - a.touched)
			: [];
	}

	/** What is kept of `name`, a closed window's too. */
	meta(name: string): ConvMeta | undefined {
		return this.on ? this.metas.get(this.fold(name)) : undefined;
	}

	/**
	 * The newest msgid line kept on this network, over every window, the
	 * closed ones too (closing the busiest window must not pull the cursor
	 * back).
	 */
	newestStamped(): {msgid: string; time: number} | undefined {
		let best: {msgid: string; time: number} | undefined;

		for (const meta of this.on ? this.metas.values() : []) {
			if (meta.last && (!best || meta.last.time > best.time)) {
				best = meta.last;
			}
		}

		return best;
	}

	/** The lines the snapshot holds for `name`, oldest first, as messages without ids. */
	restoredMessages(name: string): SharedMsg[] {
		return (this.restored.get(this.fold(name)) ?? []).map((line) => fromStored(line.msg));
	}

	/** msgids of edits folded into the restored lines of `name`, each with
	 * the index in {@link restoredMessages} of the line it now is. */
	restoredAliases(name: string): Array<[msgid: string, index: number]> {
		const out: Array<[string, number]> = [];

		(this.restored.get(this.fold(name)) ?? []).forEach((line, index) => {
			for (const id of line.ids ?? []) {
				const msgid = id.slice(line.c.length + 1);

				if (msgid !== line.msg.msgid) {
					out.push([msgid, index]);
				}
			}
		});

		return out;
	}

	/** Whether the device holds lines older than the restored ones of `name`. */
	hasOlder(name: string): boolean {
		const meta = this.meta(name);
		return !!meta && meta.n > (this.restored.get(this.fold(name))?.length ?? 0);
	}

	/**
	 * Up to `limit` kept lines of `name` at or before `upTo`, oldest first.
	 * The caller drops what it already shows.
	 */
	async older(name: string, upTo: Date, limit: number): Promise<SharedMsg[]> {
		if (!this.on || !this.metas.has(this.fold(name))) {
			return [];
		}

		await this.flush();

		try {
			const lines = await this.used.run("readonly", (tx) =>
				tx.newest(convKey(this.uuid, this.fold(name)), limit, upTo.getTime())
			);
			return lines.reverse().map((line) => fromStored(line.msg));
		} catch {
			return [];
		}
	}

	/** Keep `msg` (a line shown in `name`); what is not worth keeping is ignored. */
	append(name: string, kind: ConvKind, msg: SharedMsg): void {
		const stored = this.on ? toStored(msg) : undefined;

		if (!stored) {
			return;
		}

		const t = timeOf(stored.time);
		const meta = this.touch(name, kind);

		if (meta.clearedAt !== undefined && t <= meta.clearedAt) {
			return;
		}

		this.opened(name, kind, meta);
		meta.touched = Math.max(meta.touched, t);
		meta.n++;

		if (stored.msgid && (!meta.last || meta.last.time < t)) {
			meta.last = {msgid: stored.msgid, time: t};
		}

		this.push({
			op: "put",
			target: this.fold(name),
			name,
			kind,
			t,
			k: lineKey(stored, this.fold),
			msg: stored,
		});
	}

	/** The line `edit` replaces `original`: rewrite the original, drop the edit's own line. */
	edit(name: string, original: string, edit: string): void {
		if (this.on) {
			this.push({op: "edit", target: this.fold(name), original, edit});
		}
	}

	/** A deletion: the line is not kept (best effort: a device that never hears of it keeps it). */
	redact(name: string, msgid: string): void {
		if (this.on) {
			this.push({op: "redact", target: this.fold(name), msgid, at: Date.now()});
		}
	}

	/** A reaction added or taken off a kept line. */
	react(name: string, msgid: string, text: string, nick: string, remove: boolean): void {
		if (this.on) {
			this.push({op: "react", target: this.fold(name), msgid, text, nick, remove});
		}
	}

	/** The line at `time` with `key` has, or no longer has, lines missing before it. */
	setGap(name: string, time: Date, key: string, on: boolean): void {
		if (this.on) {
			this.push({op: "gap", target: this.fold(name), t: time.getTime(), k: key, on});
		}
	}

	/** `name` was read up to `time`. */
	setRead(name: string, kind: ConvKind, time: Date): void {
		const meta = this.meta(name);

		if (meta && (meta.read ?? -1) < time.getTime()) {
			meta.read = time.getTime();
			this.push({op: "meta", target: this.fold(name), name, kind, read: meta.read});
		}
	}

	/** Whether `name` holds everything up to its newest line (Channel.historyFilled). */
	setFilled(name: string, kind: ConvKind, filled: boolean): void {
		const meta = this.meta(name);
		// A store made blind cannot vouch for what it never saw.
		const value = filled && !this.blind;

		if (meta && meta.filled !== value) {
			meta.filled = value;
			this.push({op: "meta", target: this.fold(name), name, kind, filled: value});
		}
	}

	/**
	 * We are in channel `name` (with `key`), or no longer: where nothing
	 * else holds our channels, a page load joins what it was in.
	 */
	setJoined(name: string, joined: boolean, key = ""): void {
		if (!this.on) {
			return;
		}

		const meta = joined ? this.touch(name, "channel") : this.meta(name);

		if (!meta) {
			return;
		}

		if (joined) {
			this.opened(name, "channel", meta);
		}

		if (meta.joined !== joined || (joined && (meta.key ?? "") !== key)) {
			meta.joined = joined;
			meta.key = joined && key ? key : undefined;
			this.push({
				op: "meta",
				target: this.fold(name),
				name,
				kind: "channel",
				create: joined,
				joined,
				key: meta.key ?? "",
			});
		}
	}

	/** "Clear history": the lines go, and nothing at or before `at` comes back. */
	clear(name: string, at: Date): void {
		const meta = this.meta(name);

		if (!meta) {
			return;
		}

		meta.n = 0;
		meta.clearedAt = Math.max(meta.clearedAt ?? 0, at.getTime());
		this.restored.delete(this.fold(name));
		this.push({op: "clear", target: this.fold(name), at: meta.clearedAt});
	}

	/**
	 * The window was closed: it is not shown or opened by itself from here
	 * on, and its lines stay for the day it is opened again (a channel
	 * joined, a private conversation written in or asked for). What it held
	 * is read: none of it counts as new then.
	 */
	close(name: string, at = new Date()): void {
		const folded = this.fold(name);
		const meta = this.meta(name);

		if (!meta) {
			return;
		}

		meta.closed = true;
		meta.joined = false;
		meta.key = undefined;

		meta.read = Math.max(meta.read ?? 0, at.getTime());
		this.push({op: "close", target: folded, at: meta.read});
		// What the window showed since the snapshot is read again, for when
		// it is opened later on this page.
		void this.flush().then(() => this.reread(folded));
	}

	/** The user opened `name` again: it is shown from here on, a reload included. */
	reopen(name: string, kind: ConvKind): void {
		const meta = this.meta(name);

		if (meta) {
			this.opened(name, kind, meta);
		}
	}

	/** Write now if anything is pending; resolves when it is written. */
	flush(): Promise<void> {
		this.cancel();

		if (this.queue.length > 0) {
			const ops = this.queue;
			this.queue = [];
			this.inflight.push(...ops);
			this.writing = this.writing.then(() => this.write(ops));
		}

		return this.writing;
	}

	/**
	 * Leave what is not written yet in the journal, synchronously (the page
	 * may be gone before the database answers; {@link JOURNAL_PREFIX}).
	 */
	journal(): void {
		const ops = [...this.inflight, ...this.queue];

		if (!this.on || ops.length === 0) {
			return;
		}

		try {
			storage.set(
				this.journalKey,
				encodeJournal({uuid: this.uuid, epochs: this.epochs, ops})
			);
			this.journaled = true;
		} catch {
			// no storage, or full: the asynchronous write is all there is
		}
	}

	private get journalKey(): string {
		return `${JOURNAL_PREFIX}${this.uuid}.${TAB}`;
	}

	private unjournal(): void {
		if (this.journaled) {
			this.journaled = false;
			storage.remove(this.journalKey);
		}
	}

	/** The newest kept lines of one closed window, read again. */
	private async reread(folded: string): Promise<void> {
		try {
			const lines = await this.used.run("readonly", (tx) =>
				tx.newest(convKey(this.uuid, folded), RESTORE_LINES)
			);

			if (this.metas.get(folded)?.closed) {
				this.restored.set(folded, lines.reverse());
			}
		} catch {
			// the snapshot's lines stand
		}
	}

	private touch(name: string, kind: ConvKind): ConvMeta {
		const folded = this.fold(name);
		let meta = this.metas.get(folded);

		if (!meta) {
			meta = {name, kind, touched: 0, filled: false, joined: false, closed: false, n: 0};
			this.metas.set(folded, meta);
		}

		return meta;
	}

	/** A window that was closed is open again. */
	private opened(name: string, kind: ConvKind, meta: ConvMeta): void {
		if (meta.closed) {
			meta.closed = false;
			meta.name = name;
			this.push({op: "meta", target: this.fold(name), name, kind, open: true});
		}
	}

	private push(op: StoreOp): void {
		this.queue.push(op);

		if (this.timer === null) {
			this.timer = setTimeout(() => {
				this.timer = null;
				void this.flush();
			}, FLUSH_DELAY_MS);
		}
	}

	private cancel(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	private async write(ops: StoreOp[]): Promise<void> {
		try {
			await this.commit(ops);
		} finally {
			this.inflight = this.inflight.filter((op) => !ops.includes(op));

			if (this.inflight.length === 0 && this.queue.length === 0) {
				this.unjournal();
			}
		}
	}

	/**
	 * One transaction, in the order things happened. When it fails because
	 * the disk is full, what takes something away is written by itself (a
	 * deletion, a clear or a close must land all the same), room is made,
	 * and the rest is tried once more.
	 */
	private async commit(ops: StoreOp[]): Promise<void> {
		if (!this.on) {
			return;
		}

		const apply = async (batch: StoreOp[]): Promise<boolean> => {
			if (batch.length === 0) {
				return false;
			}

			const result = await this.used.run("readwrite", (tx) =>
				applyOps(tx, this.uuid, this.epochs, batch)
			);
			// Stale: another tab deleted this network's lines, or everything.
			// What was queued is dropped; later lines are kept again.
			this.epochs = {all: result.all, net: result.net};
			return result.stale;
		};

		try {
			try {
				await apply(ops);
			} catch (err: unknown) {
				if (!isQuotaError(err)) {
					throw err;
				}

				if (!(await apply(ops.filter((op) => DELETES.has(op.op))))) {
					await this.used.run("readwrite", evict);
					await apply(withoutDeleted(ops));
				}
			}
		} catch {
			// A failed write (a dropped connection, a disk still full) loses
			// these lines on the device; the server's history brings back
			// what it has.
		}
	}
}

// ------------------------------------------------------- module-level calls

/**
 * Write every pending change now (the page is being hidden or unloaded).
 * What is not written yet goes to the journal first, synchronously: a page
 * that is gone before the database answers loses nothing, and one that
 * lives on takes its journal away again when the write lands.
 */
export function flushConversationStores(): Promise<void> {
	for (const store of live) {
		store.journal();
	}

	return Promise.all([...live].map((store) => store.flush())).then(() => undefined);
}

/**
 * The user's choice (`keepPrivateConversations`). Off: nothing is kept,
 * written or restored from here on, and everything already kept, for every
 * network, open or not, is deleted. Another tab's write that was in flight
 * is dropped by the epoch it carries.
 */
export function setConversationsEnabled(on: boolean): void {
	if (on === enabled) {
		if (!on) {
			dropLegacyLogs();
		}

		return;
	}

	enabled = on;

	if (on) {
		// Whatever another tab cleared meanwhile: this one starts from now.
		for (const store of live) {
			store.resync();
		}

		return;
	}

	preloaded = undefined;
	taken.clear();
	dropLegacyLogs();
	journalKeys().forEach((key) => storage.remove(key));

	for (const store of live) {
		store.reset();
	}

	void backend
		.run("readwrite", async (tx) => {
			tx.deleteAll();
			tx.putEpoch(ALL, (await tx.getEpoch(ALL)) + 1);
		})
		.catch(() => undefined);
}

/** Drop a network's conversations (the network was removed). */
export function forgetNetworkConversations(uuid: string): void {
	for (const store of live) {
		if (store.uuid === uuid) {
			store.reset();
		}
	}

	if (preloaded) {
		for (const conv of preloaded.convs.get(uuid) ?? []) {
			preloaded.lines.delete(conv.c);
		}

		preloaded.convs.delete(uuid);
	}

	try {
		storage.remove(LEGACY_LOG_PREFIX + uuid);
	} catch {
		// no storage
	}

	void backend
		.run("readwrite", async (tx) => {
			tx.deleteNetwork(uuid);
			tx.putEpoch(uuid, (await tx.getEpoch(uuid)) + 1);
		})
		.catch(() => undefined);
}
