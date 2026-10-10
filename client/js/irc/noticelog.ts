/**
 * Server notices and WALLOPS kept on the device. The server never replays
 * them, and an installed PWA on Android is discarded whenever the user
 * switches away: whatever lives only in memory — the lobby's routine lines,
 * the important ones shown in a channel — is gone on the way back. So every
 * routed notice (not the ones routed `off`) is appended here, written to
 * IndexedDB per network, and on the next page load put back into the lobby
 * as one history page (`IrcClient.restoreNotices`, the way querylog.ts brings
 * private conversations back). The oper panel's Notices tab searches the
 * same ring. docs/projects/oper-tools.md.
 *
 * A cycle, not an archive: the newest {@link MAX_ENTRIES} lines or
 * {@link MAX_AGE_MS} of them, whichever is less. Saved networks only (an
 * ad-hoc `/connect` has nowhere to come back to). Removing the network
 * deletes its store; the settings backup never carries it.
 *
 * Kept free of store/DOM imports (mocha): the IndexedDB backend is used
 * only where `indexedDB` exists, tests swap in {@link useNoticeLogBackend}.
 */

import type {SnoticeInfo} from "../../../shared/types/oper";

export const MAX_ENTRIES = 2000;
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const SAVE_DELAY_MS = 1000;

/** One logged line. */
export interface LoggedNotice {
	/** Epoch ms (the server sends no time; it is ours). */
	time: number;
	/** `snotice` for a server notice, `wallops` for the WALLOPS family. */
	type: "snotice" | "wallops";
	/** The text as shown (a server notice without its `*** Notice -- `). */
	text: string;
	/** WALLOPS: who sent it. */
	from?: string;
	snotice: SnoticeInfo;
}

export interface NoticeLogBackend {
	load(uuid: string): Promise<LoggedNotice[] | undefined>;
	save(uuid: string, entries: LoggedNotice[]): Promise<void>;
	remove(uuid: string): Promise<void>;
}

const DB_NAME = "seance-notices";
const STORE = "networks";

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, 1);
		req.onupgradeneeded = () => req.result.createObjectStore(STORE);
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

function transact<T>(
	mode: IDBTransactionMode,
	run: (store: IDBObjectStore) => IDBRequest<T> | void
): Promise<T | undefined> {
	return openDb().then(
		(db) =>
			new Promise<T | undefined>((resolve, reject) => {
				const tx = db.transaction(STORE, mode);
				const req = run(tx.objectStore(STORE));

				tx.oncomplete = () => {
					db.close();
					resolve(req ? req.result : undefined);
				};

				tx.onerror = () => {
					db.close();
					reject(tx.error);
				};
			})
	);
}

const indexedDbBackend: NoticeLogBackend = {
	load: (uuid) =>
		transact<LoggedNotice[]>(
			"readonly",
			(store) => store.get(uuid) as IDBRequest<LoggedNotice[]>
		),
	async save(uuid, entries) {
		await transact("readwrite", (store) => {
			store.put(entries, uuid);
		});
	},
	async remove(uuid) {
		await transact("readwrite", (store) => {
			store.delete(uuid);
		});
	},
};

/** Nothing kept: what a page without IndexedDB (and mocha) gets. */
const noBackend: NoticeLogBackend = {
	load: () => Promise.resolve(undefined),
	save: () => Promise.resolve(),
	remove: () => Promise.resolve(),
};

let backend: NoticeLogBackend =
	typeof globalThis.indexedDB === "undefined" ? noBackend : indexedDbBackend;

/** Swap the persistence backend (tests); `null` restores the default. */
export function useNoticeLogBackend(next: NoticeLogBackend | null): void {
	backend = next ?? (typeof globalThis.indexedDB === "undefined" ? noBackend : indexedDbBackend);
}

/** Drop the oldest beyond the cap and anything older than a day. */
export function trim(entries: LoggedNotice[], now = Date.now()): LoggedNotice[] {
	const fresh = entries.filter((e) => now - e.time <= MAX_AGE_MS);
	return fresh.length > MAX_ENTRIES ? fresh.slice(fresh.length - MAX_ENTRIES) : fresh;
}

export class NoticeLog {
	private entries: LoggedNotice[] = [];
	private timer: ReturnType<typeof setTimeout> | null = null;
	private loaded = false;
	private readonly uuid: string;
	private readonly persist: () => boolean;

	/**
	 * @param uuid the network.
	 * @param persist whether the network is saved (asked at write time: it may
	 *   be saved after it connected).
	 */
	constructor(uuid: string, persist: () => boolean) {
		this.uuid = uuid;
		this.persist = persist;
	}

	/** Read what the last page left. Resolves with those lines (oldest first). */
	async load(): Promise<LoggedNotice[]> {
		let stored: LoggedNotice[] = [];

		try {
			stored = trim((await backend.load(this.uuid)) ?? []);
		} catch {
			stored = [];
		}

		// Lines appended while the store was being read come after it.
		this.entries = trim([...stored, ...this.entries]);
		this.loaded = true;
		return stored;
	}

	append(entry: LoggedNotice): void {
		this.entries.push(entry);

		if (this.entries.length > MAX_ENTRIES + 100) {
			this.entries = trim(this.entries);
		}

		this.scheduleSave();
	}

	/** Every kept line, oldest first. */
	all(): LoggedNotice[] {
		return trim(this.entries);
	}

	private scheduleSave(): void {
		if (this.timer !== null) {
			return;
		}

		this.timer = setTimeout(() => {
			this.timer = null;
			this.save();
		}, SAVE_DELAY_MS);
	}

	/** Write now (the connection is going away, the page is hiding). */
	flush(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
			this.save();
		}
	}

	private save(): void {
		// Until the store is read, a write would replace what it holds.
		if (!this.loaded || !this.persist()) {
			return;
		}

		this.entries = trim(this.entries);
		void backend.save(this.uuid, this.entries).catch(() => undefined);
	}
}

/** The network was removed: its notices go with it. */
export function forgetNoticeLog(uuid: string): void {
	void backend.remove(uuid).catch(() => undefined);
}
