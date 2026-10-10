/**
 * Minimal IndexedDB key/value store shared by the page and (via its own copy)
 * the service worker. Used for the webpush working stash — credentials the
 * service worker needs for quick-reply/mute/renewal — because a service
 * worker cannot read localStorage. Only written when the user enabled push
 * and password remembering; same origin, comparable exposure.
 */
const DB_NAME = "seance-push";
const STORE = "kv";

// Every helper settles, whatever IndexedDB does: a caller awaits it on the
// way to subscribing (webpush.ts), and a promise that never settles there
// holds that network's subscribe — and with a Yes, the push prompt — for
// good. A transaction can abort without an error event (quota), and an open
// can be blocked by another connection holding the database.

function open(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, 1);
		let blocked = false;

		req.onupgradeneeded = () => req.result.createObjectStore(STORE);

		req.onsuccess = () => {
			if (blocked) {
				req.result.close(); // the caller has been told it failed
			} else {
				resolve(req.result);
			}
		};

		req.onerror = () => reject(req.error);

		req.onblocked = () => {
			blocked = true;
			reject(new Error("IndexedDB open blocked"));
		};
	});
}

export async function idbSet(key: string, value: unknown): Promise<void> {
	const db = await open();

	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE, "readwrite");
		tx.objectStore(STORE).put(value, key);

		tx.oncomplete = () => {
			db.close();
			resolve();
		};

		tx.onerror = () => {
			db.close();
			reject(tx.error);
		};

		tx.onabort = () => {
			db.close();
			reject(tx.error);
		};
	});
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
	const db = await open();

	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE);
		const req = tx.objectStore(STORE).get(key);

		tx.onabort = () => {
			db.close();
			reject(tx.error);
		};

		req.onsuccess = () => {
			db.close();
			resolve(req.result as T | undefined);
		};

		req.onerror = () => {
			db.close();
			reject(req.error);
		};
	});
}
