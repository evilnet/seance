// Consent before a large download nobody asked for by name (spec § Models).
// A route can land on a model that is not on the device yet -- the router
// sends a request to the best class whether its model is downloaded or not,
// and the service loads on demand -- so one click on the header's translate
// button could start a 1-2 GB download. Before the first such download of a
// model's copy the user is asked, once: yes is remembered for that copy
// (`CONSENT_KEY`, a `thelounge.state.*` key, so the settings backup never
// carries it), "not now" holds every implicit download back for the rest of
// the session, so a channel full of queued lines asks once and never once
// per line, or once per model the walk falls back to. Settings' own Download
// button is consent already (it shows the size), and a Retry on a line is a
// new question. Vue-free: the service (service.ts) owns one, index.ts hands
// it the dialog and the storage.

import {buildIdFor, listedSize} from "./models";
import type {Device, ModelRef} from "./engine";

/** Where the models the user agreed to download are remembered: their ids. */
export const CONSENT_KEY = "thelounge.state.translateConsent";

/**
 * The id a copy's yes is kept under. The copy of the device the model ran
 * on before it could run on either -- the language model's GPU copy,
 * OPUS-MT's and NLLB-200's CPU copy -- keeps the id its yes always had, so
 * the consents (and Settings' Downloads) given then stand for the download
 * they were given for: the language model's is the build that would be
 * downloaded here (models.ts `buildIdFor`), since a yes to the model on a
 * desktop is not a yes to its small-buffer build, another download of the
 * same size, once the test switch makes that the build. The other device's
 * copy is a download of its own, `<id>@<device>`: a yes to one device's
 * copy never covers the other's.
 */
export function consentId(
	ref: ModelRef,
	device: Device,
	maxBufferBytes: number | null | undefined
): string {
	const before: Device = ref.engine === "llm" ? "gpu" : "cpu";

	if (device !== before) {
		return `${ref.id}@${device}`;
	}

	return device === "gpu" ? buildIdFor(ref, maxBufferBytes) : ref.id;
}

/**
 * The failure a request reports when its route needs a download the user
 * declined: a code, then the model as JSON (`needsDownloadError`), so the
 * reason travels with the line and the composer's strip as a string and
 * is turned into words where the catalog is (helpers/translateErrors.ts).
 */
export const NEEDS_DOWNLOAD = "translation needs a model download";

/** What the reason names: the model's own name and its download size. */
export interface DownloadNeed {
	id: string;
	sizeBytes: number;
	label: ModelRef["label"];
	/** The copy it is about, when the caller knew it. */
	device?: Device;
}

/** `device` names the copy whose size the reason gives; absent, the listed one's. */
export function needsDownloadError(ref: ModelRef, device?: Device): string {
	const sizeBytes = (device && ref.copies[device]?.sizeBytes) ?? listedSize(ref);
	const need: DownloadNeed = {id: ref.id, sizeBytes, label: ref.label};

	if (device) {
		need.device = device;
	}

	return `${NEEDS_DOWNLOAD}: ${JSON.stringify(need)}`;
}

/** The model a `needsDownloadError` names; null for any other message. */
export function parseNeedsDownload(message: string): DownloadNeed | null {
	if (!message.startsWith(`${NEEDS_DOWNLOAD}: `)) {
		return null;
	}

	try {
		const need = JSON.parse(message.slice(NEEDS_DOWNLOAD.length + 2)) as DownloadNeed;

		return need && typeof need.id === "string" && need.label ? need : null;
	} catch {
		return null;
	}
}

/** The remembered yeses, one model id each. */
export interface ConsentStore {
	has(id: string): boolean;
	grant(id: string): void;
	revoke(id: string): void;
}

/** The yeses in memory only: tests, and a service built without storage. */
export function memoryConsent(): ConsentStore {
	const ids = new Set<string>();

	return {
		has: (id) => ids.has(id),
		grant: (id) => void ids.add(id),
		revoke: (id) => void ids.delete(id),
	};
}

/** The yeses in a key-value storage (localStorage, `CONSENT_KEY`), a JSON list of ids. */
export function storedConsent(
	backend: {get(key: string): string | null; set(key: string, value: string): void},
	key = CONSENT_KEY
): ConsentStore {
	const read = (): string[] => {
		try {
			const parsed: unknown = JSON.parse(backend.get(key) ?? "[]");

			return Array.isArray(parsed)
				? parsed.filter((id): id is string => typeof id === "string")
				: [];
		} catch {
			return [];
		}
	};

	return {
		has: (id) => read().includes(id),
		grant(id) {
			const ids = read();

			if (!ids.includes(id)) {
				backend.set(key, JSON.stringify([...ids, id]));
			}
		},
		revoke(id) {
			const ids = read();

			if (ids.includes(id)) {
				backend.set(key, JSON.stringify(ids.filter((other) => other !== id)));
			}
		},
	};
}

/**
 * The question and its answers. `ask` is the dialog: true for Download,
 * false for Not now (or a dialog that closed without an answer).
 */
export class DownloadConsent {
	/** Declined this session, by model id: never asked again until `forgetDeclines`. */
	private declinedIds = new Set<string>();
	/**
	 * The yeses of this session, beside the store: a storage that cannot
	 * write (blocked site data, a private window's full quota) would
	 * otherwise forget a yes the moment it was given, and the route that
	 * asked would ask again, for ever.
	 */
	private grantedIds = new Set<string>();
	/** One question per model at a time: every request waiting on it shares the answer. */
	private pending = new Map<string, Promise<boolean>>();
	/** One dialog at a time across models: the next waits for the last to be answered. */
	private chain: Promise<unknown> = Promise.resolve();

	private readonly askUser: (ref: ModelRef, device: Device) => Promise<boolean>;
	private readonly store: ConsentStore;

	constructor(askUser: (ref: ModelRef, device: Device) => Promise<boolean>, store: ConsentStore) {
		this.askUser = askUser;
		this.store = store;
	}

	granted(id: string): boolean {
		return this.grantedIds.has(id) || this.store.has(id);
	}

	declined(id: string): boolean {
		return this.declinedIds.has(id);
	}

	/**
	 * Something was declined this session: an implicit download is no longer
	 * asked about, a route falls back to what needs none (service.ts).
	 */
	get anyDeclined(): boolean {
		return this.declinedIds.size > 0;
	}

	/** An explicit act (Settings' Download): yes, and no decline stands. */
	grant(id: string): void {
		this.grantedIds.add(id);
		this.store.grant(id);
		this.declinedIds.delete(id);
	}

	/** The model was deleted: its next download is a new question. */
	revoke(id: string): void {
		this.grantedIds.delete(id);
		this.store.revoke(id);
	}

	/** A Retry on a line: the session's "not now" is over, the next route asks again. */
	forgetDeclines(): void {
		this.declinedIds.clear();
	}

	/**
	 * Ask about `ref`'s copy for `device`, at most once at a time per id and
	 * one dialog at a time overall. `ref.id` is the id the answer is kept
	 * under (`consentId`: the caller puts it in place); `device` is for the
	 * dialog, which names that copy's size. `stillNeeded` is asked again when
	 * the question's turn comes: a copy that was downloaded meanwhile
	 * (Settings, another question's yes for it) is no longer worth a dialog,
	 * and the answer is then yes without anything stored.
	 */
	ask(ref: ModelRef, device: Device, stillNeeded: () => boolean): Promise<boolean> {
		const waiting = this.pending.get(ref.id);

		if (waiting) {
			return waiting;
		}

		const answer = this.chain.then(async () => {
			if (this.granted(ref.id)) {
				return true;
			}

			if (this.declined(ref.id) || this.anyDeclined) {
				return false;
			}

			if (!stillNeeded()) {
				return true;
			}

			const yes = await this.askUser(ref, device).catch(() => false);

			if (yes) {
				this.grantedIds.add(ref.id);
				this.store.grant(ref.id);
			} else {
				this.declinedIds.add(ref.id);
			}

			return yes;
		});

		this.chain = answer.catch(() => undefined);
		this.pending.set(ref.id, answer);

		void answer
			.finally(() => {
				if (this.pending.get(ref.id) === answer) {
					this.pending.delete(ref.id);
				}
			})
			.catch(() => undefined);

		return answer;
	}
}
