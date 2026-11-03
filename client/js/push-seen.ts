/**
 * The "seen" ring: msgids this live page has already received over its own
 * WebSocket.
 *
 * Server pushes reach the device even while an idle-but-attached bouncer
 * session exists (the ircd's FEAT_WEBPUSH_IDLE opens the HOLDING-only
 * gate), so a backgrounded tab's messages can arrive twice: once over the
 * WebSocket, once via FCM. The page records the msgid of every pushable
 * message it takes (a live page owns its notifications — its own rules in
 * socket-events/msg.ts decide what the user sees); the service worker's
 * push handler drops any push whose msgid is already here. No live page,
 * no record — the push shows. A frozen page never writes, which is
 * exactly when the push is wanted.
 *
 * IndexedDB, not localStorage: the worker must be able to read it. One
 * ring under the same DB the worker already uses (seance-push/kv), capped;
 * a lost entry costs at worst one duplicate notification.
 */

const DB_NAME = "seance-push";
const STORE = "kv";
const KEY = "seen";
const CAP = 200;

/** Serialized so two rapid messages can't interleave read-modify-write
 * and lose a msgid from the ring (worst case otherwise: one duplicate). */
let chain: Promise<void> = Promise.resolve();

function open(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, 1);

		req.onupgradeneeded = () => {
			if (!req.result.objectStoreNames.contains(STORE)) {
				req.result.createObjectStore(STORE);
			}
		};

		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new DOMException("Request failed", "UnknownError"));
	});
}

/**
 * Record a msgid as taken by this page. Best effort: any failure (no
 * IndexedDB, quota, private mode) leaves the ring short one entry, which
 * only re-opens the door for the push duplicate.
 */
export function recordSeenMsgid(msgid: string | undefined | null): void {
	if (!msgid) {
		return;
	}

	chain = chain
		.then(async () => {
			const db = await open();

			await new Promise<void>((resolve, reject) => {
				const tx = db.transaction(STORE, "readwrite");
				const store = tx.objectStore(STORE);
				const get = store.get(KEY);

				get.onsuccess = () => {
					const prev = Array.isArray(get.result) ? (get.result as string[]) : [];

					if (!prev.includes(msgid)) {
						store.put([...prev, msgid].slice(-CAP), KEY);
					}
				};

				tx.oncomplete = () => resolve();
				tx.onerror = () =>
					reject(tx.error ?? new DOMException("Transaction aborted", "AbortError"));
				tx.onabort = () =>
					reject(tx.error ?? new DOMException("Transaction aborted", "AbortError"));
			});
			db.close();
		})
		.catch(() => undefined);
}
