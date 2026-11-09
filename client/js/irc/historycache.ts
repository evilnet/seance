/**
 * Recent channel lines kept on this device, so a page load (a reload, an
 * Android PWA brought back after a discard, an app launch) shows each
 * channel's scrollback at once instead of an empty buffer until the
 * server's history answers. Off unless the user turns it on
 * (`keepChannelHistory`, Settings -> General, under Experimental).
 *
 * A placeholder, never evidence: what it restores is shown as a history
 * page and marked `cached` (Channel.cachedIds, MsgRef.cached), nothing that
 * decides what the server still has to send reads it (the catch-up walk's
 * known set and floor, `newestServerRef`, the ATTACH cursor, TARGETS), and
 * the JOIN's first history page replaces it whatever that page holds
 * (history.ts `dropCached`): the cached rows leave the buffer and the page
 * is delivered as it would have been without them. So a line deleted
 * while this device was away shows only until that page lands. When no
 * page can be asked for (no `draft/chathistory`), the rows go at once.
 *
 * {@link MAX_LINES} newest messages, actions and notices per channel (one
 * first page's worth, so the page that replaces them shows as much), none
 * older than {@link MAX_AGE_MS}; lines without a msgid are not kept. One
 * IndexedDB record per channel. Each write merges with what is stored
 * inside one transaction (another tab may have written since we read), and
 * a redaction leaves a content-free tombstone that every merge honours.
 * Redactions are taken by msgid whether or not the line is still loaded
 * (handlers/redact.ts).
 *
 * Off deletes everything kept; removing the network deletes its channels;
 * parting a channel forgets it. Queries are not here: querylog.ts keeps
 * them, with their own lifecycle.
 *
 * Store-free and DOM-free (mocha): the IndexedDB backend is used only where
 * `indexedDB` exists, tests swap in {@link useHistoryCacheBackend}.
 */

import type {SharedMsg} from "../../../shared/types/msg";
import {applyLoggedReaction, fromLogged, type LoggedMsg, toLogged} from "./querylog";

/** Newest lines kept per channel: history.ts `JOIN_PAGE_SIZE`, the page that replaces them. */
export const MAX_LINES = 50;
/** Oldest line kept, and how long a tombstone outlives its line. */
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Trailing write throttle. */
export const SAVE_DELAY_MS = 1500;

/** One channel as stored. */
export interface CachedChannel {
	/** Oldest first. */
	lines: LoggedMsg[];
	/** Redacted msgids → when we learnt of it (ms): never written back. */
	dead?: Record<string, number>;
}

export interface HistoryCacheBackend {
	/** Every channel kept for a network, keyed by casefolded name. */
	load(uuid: string): Promise<Map<string, CachedChannel>>;
	/** Merge `mine` with what is stored, in one transaction ({@link mergeChannel}). */
	merge(uuid: string, target: string, mine: CachedChannel): Promise<void>;
	/** Forget one channel, or (no target) the whole network. */
	remove(uuid: string, target?: string): Promise<void>;
	/** Forget everything kept for every network. */
	clear(): Promise<void>;
}

function timeOf(line: LoggedMsg): number {
	return new Date(line.time).getTime();
}

function idsOf(line: LoggedMsg): string[] {
	return line.msgid ? [line.msgid, ...(line.aka ?? [])] : [...(line.aka ?? [])];
}

/** Drop the dead, the old and the surplus; tombstones expire with their lines. */
export function tidy(channel: CachedChannel, now = Date.now()): CachedChannel {
	const dead: Record<string, number> = {};

	for (const [msgid, at] of Object.entries(channel.dead ?? {})) {
		if (now - at <= MAX_AGE_MS) {
			dead[msgid] = at;
		}
	}

	let lines = channel.lines.filter(
		(l) => now - timeOf(l) <= MAX_AGE_MS && !idsOf(l).some((id) => id in dead)
	);

	if (lines.length > MAX_LINES) {
		lines = lines.slice(lines.length - MAX_LINES);
	}

	return Object.keys(dead).length > 0 ? {lines, dead} : {lines};
}

/**
 * What a write leaves on disk: this tab's lines win for the msgids it
 * holds (its edits and reactions are newer than its own last write), lines
 * only the stored copy has (another tab's) are kept, tombstones are the
 * union of both, and the result is tidied.
 */
export function mergeChannel(
	stored: CachedChannel | undefined,
	mine: CachedChannel,
	now = Date.now()
): CachedChannel {
	const dead = {...stored?.dead, ...mine.dead};
	const held = new Set(mine.lines.flatMap(idsOf));
	const theirs = (stored?.lines ?? []).filter((l) => !idsOf(l).some((id) => held.has(id)));
	const lines = [...mine.lines, ...theirs].sort((a, b) => timeOf(a) - timeOf(b));
	return tidy({lines, dead}, now);
}

function validChannel(value: unknown): value is CachedChannel {
	const c = value as CachedChannel;
	return (
		typeof c === "object" &&
		c !== null &&
		Array.isArray(c.lines) &&
		c.lines.every(
			(l) =>
				typeof l?.time === "string" &&
				typeof l.type === "string" &&
				typeof l.text === "string" &&
				typeof l.msgid === "string" &&
				!Number.isNaN(new Date(l.time).getTime())
		)
	);
}

// ---------------------------------------------------------------- IndexedDB

const DB_NAME = "seance-history";
const STORE = "channels";
/** Key separator: a network uuid never holds it. */
const SEP = "\n";

function keyOf(uuid: string, target: string): string {
	return uuid + SEP + target;
}

function rangeOf(uuid: string): IDBKeyRange {
	return IDBKeyRange.bound(uuid + SEP, uuid + SEP + "￿");
}

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, 1);
		// A cache: a future schema drops and rebuilds the store, never migrates.
		req.onupgradeneeded = () => {
			const db = req.result;

			if (db.objectStoreNames.contains(STORE)) {
				db.deleteObjectStore(STORE);
			}

			db.createObjectStore(STORE);
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new DOMException("Request failed", "UnknownError"));
		req.onblocked = () => reject(new Error("IndexedDB open blocked"));
	});
}

/** One transaction; settles and closes the database however it ends. */
function transact(mode: IDBTransactionMode, run: (store: IDBObjectStore) => void): Promise<void> {
	return openDb().then(
		(db) =>
			new Promise<void>((resolve, reject) => {
				let settled = false;

				const finish = (error?: Error) => {
					if (settled) {
						return;
					}

					settled = true;
					db.close();

					if (error) {
						reject(error);
					} else {
						resolve();
					}
				};

				try {
					const tx = db.transaction(STORE, mode);
					tx.oncomplete = () => finish();
					tx.onerror = () =>
						finish(tx.error ?? new DOMException("Transaction aborted", "AbortError"));
					tx.onabort = () =>
						finish(tx.error ?? new DOMException("Transaction aborted", "AbortError"));
					run(tx.objectStore(STORE));
				} catch (err: unknown) {
					finish(err instanceof Error ? err : new Error(String(err)));
				}
			})
	);
}

const indexedDbBackend: HistoryCacheBackend = {
	async load(uuid) {
		const out = new Map<string, CachedChannel>();
		await transact("readonly", (store) => {
			const req = store.openCursor(rangeOf(uuid));
			req.onsuccess = () => {
				const cursor = req.result;

				if (!cursor) {
					return;
				}

				const target = (cursor.key as string).slice(uuid.length + SEP.length);

				if (validChannel(cursor.value)) {
					out.set(target, cursor.value);
				}

				cursor.continue();
			};
		});
		return out;
	},
	async merge(uuid, target, mine) {
		await transact("readwrite", (store) => {
			const key = keyOf(uuid, target);
			const req = store.get(key);
			req.onsuccess = () => {
				const stored = validChannel(req.result) ? req.result : undefined;
				const merged = mergeChannel(stored, mine);

				if (merged.lines.length === 0 && !merged.dead) {
					store.delete(key);
				} else {
					store.put(merged, key);
				}
			};
		});
	},
	async remove(uuid, target) {
		await transact("readwrite", (store) => {
			store.delete(target === undefined ? rangeOf(uuid) : keyOf(uuid, target));
		});
	},
	async clear() {
		await transact("readwrite", (store) => {
			store.clear();
		});
	},
};

/** Nothing kept: a page without IndexedDB, and mocha by default. */
const noBackend: HistoryCacheBackend = {
	load: () => Promise.resolve(new Map()),
	merge: () => Promise.resolve(),
	remove: () => Promise.resolve(),
	clear: () => Promise.resolve(),
};

function defaultBackend(): HistoryCacheBackend {
	return typeof globalThis.indexedDB === "undefined" ? noBackend : indexedDbBackend;
}

let backend: HistoryCacheBackend = defaultBackend();

/** Swap the persistence backend (tests); `null` restores the default. */
export function useHistoryCacheBackend(next: HistoryCacheBackend | null): void {
	backend = next ?? defaultBackend();
}

// ------------------------------------------------------------------ state

let enabled = false;
const live = new Set<HistoryCache>();

/**
 * The user's choice (`keepChannelHistory`). Off: nothing is kept or
 * restored from here on, and everything already kept is deleted.
 */
export function setHistoryCacheEnabled(on: boolean): void {
	enabled = on;

	if (!on) {
		for (const cache of live) {
			cache.reset();
		}

		void backend.clear().catch(() => undefined);
	}
}

/** Write every pending cache now (the page is being hidden or unloaded). */
export function flushHistoryCaches(): void {
	for (const cache of live) {
		cache.flush();
	}
}

/** The network was removed: its channels go with it. */
export function forgetNetworkHistory(uuid: string): void {
	for (const cache of live) {
		if (cache.uuid === uuid) {
			cache.reset();
		}
	}

	void backend.remove(uuid).catch(() => undefined);
}

/**
 * One network's cache. `fold` is its casemapping; `persist` says whether the
 * network is saved (an unsaved one has a fresh uuid every page: nothing it
 * writes could ever be read back).
 */
export class HistoryCache {
	private channels = new Map<string, CachedChannel>();
	private dirty = new Set<string>();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private loaded = false;
	/** Bumped by {@link reset}: a read begun before it is thrown away. */
	private generation = 0;
	/** Channels forgotten while a read was running: what it finds of them is stale. */
	private forgotten = new Set<string>();

	constructor(
		readonly uuid: string,
		private readonly fold: (s: string) => string,
		private readonly persist: () => boolean = () => true
	) {
		live.add(this);
	}

	dispose(): void {
		this.flush();
		live.delete(this);
	}

	/**
	 * Read what the last page left, merged with anything learnt since
	 * (lines appended, redactions taken while the read was running).
	 * Resolves with each channel's lines, oldest first, as messages.
	 */
	async load(): Promise<Map<string, SharedMsg[]>> {
		let stored = new Map<string, CachedChannel>();
		const generation = this.generation;
		this.forgotten.clear();

		if (enabled && this.persist()) {
			try {
				stored = await backend.load(this.uuid);
			} catch {
				stored = new Map();
			}
		}

		// Switched off, or the network removed, while the read ran: what it
		// read was deleted meanwhile and must not come back.
		if (generation !== this.generation || !enabled) {
			return new Map();
		}

		for (const target of this.forgotten) {
			stored.delete(target);
		}

		const out = new Map<string, SharedMsg[]>();

		for (const [target, channel] of stored) {
			const mine = this.channels.get(target);
			const merged = mine ? mergeChannel(channel, mine) : tidy(channel);
			this.channels.set(target, merged);

			// Lines or tombstones past MAX_AGE_MS go from the disk too, not
			// only from memory: a quiet channel is never written otherwise.
			if (
				merged.lines.length !== channel.lines.length ||
				Object.keys(merged.dead ?? {}).length !== Object.keys(channel.dead ?? {}).length
			) {
				this.dirty.add(target);
			}

			if (merged.lines.length > 0) {
				out.set(target, merged.lines.map(fromLogged));
			}
		}

		this.loaded = true;

		if (this.dirty.size > 0) {
			this.schedule();
		}

		return out;
	}

	/** Keep `msg`, a line shown in channel `name`. */
	append(name: string, msg: SharedMsg): void {
		const entry = enabled ? toLogged(msg) : undefined;

		if (!entry?.msgid) {
			return;
		}

		const channel = this.channelFor(name);

		if (channel.dead && entry.msgid in channel.dead) {
			return;
		}

		if (channel.lines.some((l) => idsOf(l).includes(entry.msgid!))) {
			return;
		}

		// By time: a history page brings older lines after newer ones.
		const t = timeOf(entry);
		let at = channel.lines.length;

		while (at > 0 && timeOf(channel.lines[at - 1]) > t) {
			at--;
		}

		channel.lines.splice(at, 0, entry);

		if (channel.lines.length > MAX_LINES) {
			channel.lines.splice(0, channel.lines.length - MAX_LINES);
		}

		this.changed(name);
	}

	/** The line `editMsgid` replaces `originalMsgid`: rewrite the original, drop the edit's own line. */
	edit(name: string, originalMsgid: string, editMsgid: string): void {
		const channel = this.find(name);
		const edit = channel?.lines.find((l) => l.msgid === editMsgid);
		const original = channel?.lines.find((l) => idsOf(l).includes(originalMsgid));

		if (!channel || !edit || !original || edit === original) {
			return;
		}

		original.text = edit.text;
		original.type = edit.type;
		original.editedAt = edit.time;
		original.aka = [...(original.aka ?? []), editMsgid];
		channel.lines.splice(channel.lines.indexOf(edit), 1);
		this.changed(name);
	}

	/**
	 * A redaction: the line goes, loaded or not, and its msgid is
	 * tombstoned so no other copy (another tab's, a stored one read later)
	 * brings it back.
	 */
	redact(name: string, msgid: string): void {
		if (!msgid) {
			return;
		}

		const channel = this.channelFor(name);
		channel.dead = {...channel.dead, [msgid]: Date.now()};
		channel.lines = channel.lines.filter((l) => !idsOf(l).includes(msgid));
		this.changed(name);
	}

	/** A reaction added or taken off a kept line. */
	react(name: string, msgid: string, text: string, nick: string, remove: boolean): void {
		const line = this.find(name)?.lines.find((l) => idsOf(l).includes(msgid));

		if (line && applyLoggedReaction(line, text, nick, remove, this.fold)) {
			this.changed(name);
		}
	}

	/** The channel was left: forget it. */
	forget(name: string): void {
		const target = this.fold(name);
		this.channels.delete(target);
		this.dirty.delete(target);
		this.forgotten.add(target);
		void backend.remove(this.uuid, target).catch(() => undefined);
	}

	/** Drop everything in memory (the disk is the caller's). */
	reset(): void {
		this.generation++;
		this.cancel();
		this.channels.clear();
		this.dirty.clear();
	}

	flush(): void {
		if (this.timer !== null) {
			this.cancel();
			this.save();
		}
	}

	/** The lines kept for `name` (tests and diagnostics). */
	lines(name: string): readonly LoggedMsg[] {
		return this.find(name)?.lines ?? [];
	}

	private find(name: string): CachedChannel | undefined {
		return this.channels.get(this.fold(name));
	}

	private channelFor(name: string): CachedChannel {
		const target = this.fold(name);
		let channel = this.channels.get(target);

		if (!channel) {
			channel = {lines: []};
			this.channels.set(target, channel);
		}

		return channel;
	}

	private changed(name: string): void {
		this.dirty.add(this.fold(name));
		this.schedule();
	}

	private schedule(): void {
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
		// Not before the store is read: load() folds what it finds into memory
		// and schedules the write then.
		if (!this.loaded || !enabled || !this.persist()) {
			return;
		}

		for (const target of this.dirty) {
			const channel = this.channels.get(target);

			if (channel) {
				const tidied = tidy(channel);
				this.channels.set(target, tidied);
				void backend.merge(this.uuid, target, tidied).catch(() => undefined);
			}
		}

		this.dirty.clear();
	}
}
