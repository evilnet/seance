/**
 * The page's word to the root service worker on whether to make the app's
 * documents cross-origin isolated (client/service-worker.js
 * `isolationWanted`). Isolation is translation's alone -- the CPU models'
 * threads -- and the worker cannot read localStorage, so the page mirrors
 * whether translation is on into the IndexedDB store the worker already
 * uses (seance-push/kv, key `isolate`), at boot and on every change, and
 * tells a running worker with an `isolation` message. No flag is off.
 *
 * Vue-free and store-free, so mocha loads it (test/tests/isolationFlag.ts);
 * translate/index.ts `startIsolationMirror` drives it from `translationOn()`.
 */
import {idbGet, idbSet} from "./idb";

/** The key in seance-push/kv (service-worker.js ISOLATION_KEY). */
export const ISOLATION_KEY = "isolate";

/** What the worker's message handler takes. */
export interface IsolationMessage {
	type: "isolation";
	on: boolean;
}

/**
 * Mirrors translation's on/off into the worker's flag, one write at a time
 * and in order, each told to the worker once stored (or once the store
 * failed: a worker that cannot read the flag treats it as off, but one that
 * is told keeps the value it was told). Before its first write it reads the
 * flag as this page found it -- what the worker read when it served this
 * document -- so the page can tell a load served unisolated because
 * translation was off from one that should have been isolated and is not.
 */
export class IsolationMirror {
	/**
	 * The flag as it stood when this page loaded: true when the worker
	 * served the document meaning to isolate it. Null when it could not be
	 * read.
	 */
	readonly served: Promise<boolean | null>;
	private queue: Promise<void>;

	constructor(private post: (message: IsolationMessage) => void) {
		this.served = idbGet<unknown>(ISOLATION_KEY).then(
			(stored) => stored === true,
			() => null
		);
		this.queue = this.served.then(() => undefined);
	}

	/** Store `on` and tell the worker; resolves once both are done. */
	set(on: boolean): Promise<void> {
		this.queue = this.queue.then(async () => {
			try {
				await idbSet(ISOLATION_KEY, on);
			} catch (error) {
				// No IndexedDB (private mode, quota): the worker reads no
				// flag, which is off, until it is told otherwise.
			}

			this.post({type: "isolation", on});
		});

		return this.queue;
	}
}
