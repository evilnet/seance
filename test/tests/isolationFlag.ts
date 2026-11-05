/**
 * The isolation flag (client/js/isolationFlag.ts): what the page writes into
 * seance-push/kv under `isolate` is what the root service worker reads on a
 * navigation (client/service-worker.js `isolationWanted`, pinned in
 * test/tests/service-worker.ts), and the message it posts is the one the
 * worker takes. The mirror reads the flag the worker served this document
 * by before its first write, and writes in order.
 */
import {expect} from "chai";
import {afterEach, describe, it} from "mocha";
import {useIDBFactory} from "../../client/js/idb";
import {ISOLATION_KEY, IsolationMirror, type IsolationMessage} from "../../client/js/isolationFlag";

/** Map-backed IndexedDB, the one API shape client/js/idb.ts uses, answering
 * asynchronously as the real one does. `broken` fails every open. */
function fakeIDB(kv: Map<string, unknown>, broken = false): IDBFactory {
	const store = {
		get(key: string): {result?: unknown; onsuccess?: () => void} {
			const req: {result?: unknown; onsuccess?: () => void} = {};

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
		createObjectStore: () => store,
		transaction() {
			const tx: {objectStore(): typeof store; oncomplete?: () => void} = {
				objectStore: () => store,
			};

			queueMicrotask(() => tx.oncomplete?.());

			return tx;
		},
		close(): void {},
	};

	return {
		open() {
			const req: {
				result?: unknown;
				error?: Error;
				onsuccess?: () => void;
				onerror?: () => void;
				onupgradeneeded?: () => void;
			} = {};

			queueMicrotask(() => {
				if (broken) {
					req.error = new Error("IndexedDB is not available");
					req.onerror?.();
					return;
				}

				req.result = db;
				req.onupgradeneeded?.();
				req.onsuccess?.();
			});

			return req;
		},
	} as unknown as IDBFactory;
}

describe("isolation flag mirror", function () {
	afterEach(function () {
		useIDBFactory(null);
	});

	it("reads the flag this document was served by before writing its own", async function () {
		const kv = new Map<string, unknown>([[ISOLATION_KEY, false]]);
		const posted: IsolationMessage[] = [];

		useIDBFactory(fakeIDB(kv));

		const mirror = new IsolationMirror((message) => posted.push(message));
		const written = mirror.set(true);

		// The worker served this load with translation off.
		expect(await mirror.served).to.equal(false);
		await written;
		expect(kv.get(ISOLATION_KEY)).to.equal(true);
		expect(posted).to.deep.equal([{type: "isolation", on: true}]);
	});

	it("reads no flag as off: the worker never isolated this document", async function () {
		useIDBFactory(fakeIDB(new Map()));

		expect(await new IsolationMirror(() => {}).served).to.equal(false);
	});

	it("reads a stored on as on", async function () {
		useIDBFactory(fakeIDB(new Map([[ISOLATION_KEY, true]])));

		expect(await new IsolationMirror(() => {}).served).to.equal(true);
	});

	it("writes in order, each write told to the worker after it is stored", async function () {
		const kv = new Map<string, unknown>();
		const seen: [boolean, unknown][] = [];

		useIDBFactory(fakeIDB(kv));

		const mirror = new IsolationMirror((message) =>
			seen.push([message.on, kv.get(ISOLATION_KEY)])
		);

		void mirror.set(true);
		void mirror.set(false);
		await mirror.set(true);

		expect(seen).to.deep.equal([
			[true, true],
			[false, false],
			[true, true],
		]);
		expect(kv.get(ISOLATION_KEY)).to.equal(true);
	});

	it("still tells the worker when IndexedDB fails, and knows nothing of the served flag", async function () {
		const posted: IsolationMessage[] = [];

		useIDBFactory(fakeIDB(new Map(), true));

		const mirror = new IsolationMirror((message) => posted.push(message));

		await mirror.set(true);

		expect(await mirror.served).to.equal(null);
		expect(posted).to.deep.equal([{type: "isolation", on: true}]);
	});
});
