/**
 * The user's own avatars on this device: the recent ones per network (the
 * Settings → Account strip, to switch back in one tap), each upload's
 * picture kept with it, so it can be uploaded again before the network's
 * image host deletes it (nefarious2's FILEHOST host keeps files 30 days by
 * default; `avatars.retentionDays` in config.json says otherwise) and after
 * it did. Plus the probe that tells the user their avatar stopped loading.
 *
 * Pictures live in IndexedDB (`seance-avatars`); a page without it keeps
 * them in memory. The probe's tally is in localStorage
 * (`thelounge.state.avatarProbe`, never carried by the settings backup).
 * Kept free of store and DOM imports so it runs under mocha.
 */

import storage from "../localStorage";

export type RecentAvatar = {
	/** Random id. */
	id: string;
	/** The network's uuid. */
	uuid: string;
	/** The value written to the `avatar` key. */
	url: string;
	/** When it was written (ms). For an upload, when the host got the file. */
	setAt: number;
	/** Uploaded by this device to the network's image host (and so may expire). */
	uploaded: boolean;
	/** The picture as uploaded, to upload again. */
	blob?: Blob;
};

/** Recent avatars kept per network. */
export const RECENT_MAX = 8;
export const DEFAULT_RETENTION_DAYS = 30;
/** An upload is sent again once it is this close to the host's deletion. */
export const REFRESH_MARGIN_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RecentBackend {
	all(): Promise<RecentAvatar[]>;
	put(rec: RecentAvatar): Promise<void>;
	delete(id: string): Promise<void>;
}

export class MemoryRecentBackend implements RecentBackend {
	private recs = new Map<string, RecentAvatar>();

	all(): Promise<RecentAvatar[]> {
		return Promise.resolve([...this.recs.values()]);
	}

	put(rec: RecentAvatar): Promise<void> {
		this.recs.set(rec.id, rec);
		return Promise.resolve();
	}

	delete(id: string): Promise<void> {
		this.recs.delete(id);
		return Promise.resolve();
	}
}

const DB_NAME = "seance-avatars";
const STORE = "recent";

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
	});
}

let opening: Promise<IDBDatabase> | undefined;

function database(): Promise<IDBDatabase> {
	opening ??= new Promise<IDBDatabase>((resolve, reject) => {
		const open = indexedDB.open(DB_NAME, 1);
		open.onupgradeneeded = () => {
			open.result.createObjectStore(STORE, {keyPath: "id"});
		};
		open.onsuccess = () => {
			const db = open.result;
			db.onversionchange = () => {
				db.close();
				opening = undefined;
			};
			resolve(db);
		};
		open.onerror = () => {
			opening = undefined;
			reject(open.error ?? new Error("IndexedDB open failed"));
		};
	});
	return opening;
}

async function store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
	return (await database()).transaction(STORE, mode).objectStore(STORE);
}

const indexedDbBackend: RecentBackend = {
	async all() {
		return (await request((await store("readonly")).getAll())) as RecentAvatar[];
	},
	async put(rec) {
		await request((await store("readwrite")).put(rec));
	},
	async delete(id) {
		await request((await store("readwrite")).delete(id));
	},
};

function defaultBackend(): RecentBackend {
	return typeof globalThis.indexedDB === "undefined"
		? new MemoryRecentBackend()
		: indexedDbBackend;
}

let backend: RecentBackend = defaultBackend();

/** Swap the persistence backend (tests); `null` restores the default. */
export function useRecentBackend(next: RecentBackend | null): void {
	backend = next ?? defaultBackend();
}

function newId(): string {
	const bytes = new Uint8Array(8);
	globalThis.crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** This network's recent avatars, newest first. Never rejects (an empty list instead). */
export async function recentAvatars(uuid: string): Promise<RecentAvatar[]> {
	try {
		return (await backend.all())
			.filter((rec) => rec.uuid === uuid)
			.sort((a, b) => b.setAt - a.setAt);
	} catch {
		return [];
	}
}

/**
 * Note that `url` is now the avatar on `uuid`: moved to the front of the
 * list (an entry with the same URL is replaced, keeping its picture when
 * none is given), and the oldest beyond {@link RECENT_MAX} dropped.
 */
export async function rememberAvatar(
	rec: Omit<RecentAvatar, "id"> & {id?: string}
): Promise<RecentAvatar> {
	const list = await recentAvatars(rec.uuid);
	const same = list.find((r) => r.url === rec.url);
	const saved: RecentAvatar = {
		...rec,
		id: rec.id ?? same?.id ?? newId(),
		blob: rec.blob ?? same?.blob,
	};

	try {
		await backend.put(saved);

		const rest = list.filter((r) => r.id !== saved.id);

		for (const old of rest.slice(RECENT_MAX - 1)) {
			await backend.delete(old.id);
		}
	} catch {
		// Not kept: the avatar is still set; only the strip and refresh miss it.
	}

	return saved;
}

export async function forgetRecentAvatar(id: string): Promise<void> {
	try {
		await backend.delete(id);
	} catch {
		// nothing to do
	}
}

/** The network was removed: its pictures and probe tally go with it. */
export async function forgetNetworkAvatars(uuid: string): Promise<void> {
	forgetProbe(uuid);

	for (const rec of await recentAvatars(uuid)) {
		await forgetRecentAvatar(rec.id);
	}
}

/**
 * Whether `rec`, the avatar now set, should be uploaded again: it is this
 * device's upload, its picture is kept, and the host deletes it within
 * {@link REFRESH_MARGIN_DAYS}.
 */
export function refreshDue(
	rec: RecentAvatar | undefined,
	now: number,
	retentionDays = DEFAULT_RETENTION_DAYS
): boolean {
	if (!rec || !rec.uploaded || !rec.blob || retentionDays <= 0) {
		return false;
	}

	const margin = Math.min(REFRESH_MARGIN_DAYS, retentionDays / 2);
	return now - rec.setAt >= (retentionDays - margin) * DAY_MS;
}

// --------------------------------------------------------------- the probe

export const PROBE_KEY = "thelounge.state.avatarProbe";
/** Failures must span this long before the avatar counts as unavailable. */
export const PROBE_SPAN_MS = 30 * 60 * 1000;

type ProbeTally = {url: string; fails: number; firstFailAt: number};

type StorageBackend = {
	get(key: string): string | null;
	set(key: string, value: string): void;
	remove(key: string): void;
};

let probeStorage: StorageBackend = storage;

export function useProbeStorage(next: StorageBackend | null): void {
	probeStorage = next ?? storage;
}

function readTallies(): Record<string, ProbeTally> {
	try {
		const parsed: unknown = JSON.parse(probeStorage.get(PROBE_KEY) ?? "{}");
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, ProbeTally>)
			: {};
	} catch {
		return {};
	}
}

function writeTallies(all: Record<string, ProbeTally>): void {
	if (Object.keys(all).length === 0) {
		probeStorage.remove(PROBE_KEY);
	} else {
		probeStorage.set(PROBE_KEY, JSON.stringify(all));
	}
}

function forgetProbe(uuid: string): void {
	const all = readTallies();

	if (uuid in all) {
		delete all[uuid];
		writeTallies(all);
	}
}

/**
 * Record a probe of our avatar on `uuid` (`ok`: it loaded). A browser
 * cannot tell a deleted file from a network blip, an ad blocker or a host
 * that is down for a minute, so the avatar counts as unavailable only after
 * failures at least {@link PROBE_SPAN_MS} apart (probes are made only while
 * the device is online). A load, or another URL, starts over.
 */
export function noteProbe(uuid: string, url: string, ok: boolean, now: number): boolean {
	const all = readTallies();
	const tally = all[uuid];

	if (ok) {
		if (tally) {
			delete all[uuid];
			writeTallies(all);
		}

		return false;
	}

	const next: ProbeTally =
		tally && tally.url === url
			? {...tally, fails: tally.fails + 1}
			: {url, fails: 1, firstFailAt: now};
	all[uuid] = next;
	writeTallies(all);
	return isUnavailable(next, now);
}

function isUnavailable(tally: ProbeTally | undefined, now: number): boolean {
	return !!tally && tally.fails >= 2 && now - tally.firstFailAt >= PROBE_SPAN_MS;
}

/** Whether the avatar `url` on `uuid` is known not to load (see {@link noteProbe}). */
export function avatarUnavailable(uuid: string, url: string, now: number): boolean {
	const tally = readTallies()[uuid];
	return !!tally && tally.url === url && isUnavailable(tally, now);
}
