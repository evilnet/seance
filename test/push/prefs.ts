/**
 * The prefs mirror (client/js/push-prefs.ts): what the page writes into the
 * seance-push/kv IndexedDB store is exactly what the worker reads back at
 * push time (client/service-worker.js `idbGet("prefs")`) — the UI language
 * tag rides beside the markdown setting, and what is already there survives
 * a partial update (the locale's apply() and the markdown setting mirror
 * independently, at boot and on every change).
 */
import {expect} from "chai";
import {afterEach, beforeEach, describe, it} from "mocha";
import {useIDBFactory} from "../../client/js/idb";
import {mirrorPushPrefs, PREFS_KEY} from "../../client/js/push-prefs";

describe("push prefs mirror", function () {
	/** Minimal IndexedDB: the one API shape client/js/idb.ts uses, Map-backed.
	 * The fake answers asynchronously the way the real one fires
	 * (onsuccess/oncomplete never within the calling turn). */
	let kv: Map<string, unknown>;

	beforeEach(function () {
		kv = new Map<string, unknown>();
		const store = {
			get(key: string): {result?: unknown; onsuccess?: () => void; onerror?: () => void} {
				const req: {result?: unknown; onsuccess?: () => void; onerror?: () => void} = {};

				queueMicrotask(() => {
					req.result = kv.get(key);
					req.onsuccess?.();
				});

				return req;
			},
			put(value: unknown, key: string): Record<string, never> {
				kv.set(key, value);

				return {};
			},
		};
		const db = {
			createObjectStore(): typeof store {
				return store;
			},
			transaction(): {
				objectStore(): typeof store;
				oncomplete?: () => void;
				onerror?: () => void;
			} {
				const tx: {
					objectStore(): typeof store;
					oncomplete?: () => void;
					onerror?: () => void;
				} = {
					objectStore: () => store,
				};

				// A put settles one tick out, after tx.oncomplete was assigned.
				queueMicrotask(() => tx.oncomplete?.());

				return tx;
			},
			close(): void {},
		};
		const fakeFactory = {
			open(): {result?: unknown; onsuccess?: () => void; onupgradeneeded?: () => void} {
				const req: {
					result?: unknown;
					onsuccess?: () => void;
					onupgradeneeded?: () => void;
				} = {};

				queueMicrotask(() => {
					req.result = db;
					req.onupgradeneeded?.();
					req.onsuccess?.();
				});

				return req;
			},
		};

		useIDBFactory(fakeFactory as unknown as IDBFactory);
	});

	afterEach(function () {
		useIDBFactory(null);
	});

	it("persists the locale into the prefs kv entry, keeping what is there", async function () {
		await mirrorPushPrefs({markdown: true});
		await mirrorPushPrefs({locale: "qqx"});

		expect(kv.get(PREFS_KEY)).to.deep.equal({markdown: true, locale: "qqx"});
	});
});
