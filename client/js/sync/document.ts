/**
 * The settings sync document and its merge (docs/projects/settings-sync.md
 * § The merge): everything that roams, as one map of entries. An entry is
 * one choice (a setting, an alias, a mute, a favorite, the order of a list)
 * with the time it was made; a removed entry stays as a removal marker with
 * its time. Two copies merge entry by entry, the newer time winning: a
 * last-writer-wins map.
 *
 * A device keeps its own copy (sync/state.ts), in which an entry may also
 * carry `l`: what this device holds for it where that is not the entry's
 * value, because this build could not take the value (an alias it finds
 * invalid, a theme it does not ship). Such an entry is kept and written back
 * as received, and is not read as a change made here.
 *
 * Pure: no storage, no store, no DOM (test/sync/document.ts).
 */

import {dict} from "../helpers/dict";

export const FORMAT = "seance-sync";
/** The document's shape. A new entry is not a new version. */
export const VERSION = 1;
/** How long a removal marker is kept. */
export const MARKER_TTL_MS = 90 * 24 * 3600 * 1000;
/** How far ahead of this device's clock an entry may be dated and still be taken. */
export const SKEW_MS = 60_000;
/**
 * An entry dated up to this far ahead is kept, but waits on the reader until
 * its time comes (`d`, {@link Merged.deferred}); one dated further ahead is
 * not taken.
 */
export const DEFER_MS = 24 * 3600 * 1000;

export interface Entry {
	/** Unix ms of the choice, on the device that made it. */
	t: number;
	/** The value; absent on a removal marker. */
	v?: unknown;
	/**
	 * Device copy only: what this device holds instead (`{}`: nothing),
	 * where it could not take `v`. Never uploaded.
	 */
	l?: {v?: unknown};
	/**
	 * Device copy only: this build did not know the id when the entry came,
	 * so the device never took it. Once a build knows it, it is taken
	 * (sync/engine.ts), not read as a change made here. Never uploaded.
	 */
	u?: true;
	/**
	 * Device copy only: the entry is dated ahead of this device's clock, so
	 * it is kept and uploaded as received but not taken until its time
	 * comes (sync/engine.ts). Never uploaded as a mark.
	 */
	d?: true;
}

export type Entries = Record<string, Entry>;

export interface SyncDocument {
	format: typeof FORMAT;
	version: number;
	entries: Entries;
}

/** Why a document was not read. */
export type DocumentErrorCode = "not-sync" | "newer-version" | "damaged";

export class DocumentError extends Error {
	readonly code: DocumentErrorCode;

	constructor(code: DocumentErrorCode) {
		super(code);
		this.code = code;
	}
}

/** JSON with every object's keys in order: two equal values give one string. */
export function canonical(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonical(item)).join(",")}]`;
	}

	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		const parts = Object.keys(record)
			.filter((key) => record[key] !== undefined)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`);
		return `{${parts.join(",")}}`;
	}

	return JSON.stringify(value) ?? "null";
}

export function sameValue(a: unknown, b: unknown): boolean {
	return a === b || canonical(a) === canonical(b);
}

export const isMarker = (entry: {v?: unknown}): boolean => !Object.hasOwn(entry, "v");

/** What a device holds for an entry: its own view where it has one. */
const held = (entry: Entry): {v?: unknown} => entry.l ?? entry;

function wellFormed(value: unknown): value is Entry {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}

	const t = (value as {t?: unknown}).t;
	return typeof t === "number" && Number.isSafeInteger(t) && t > 0;
}

/** An entry as it travels: its time and its value, nothing of the device's. */
function bare(entry: Entry): Entry {
	return isMarker(entry) ? {t: entry.t} : {t: entry.t, v: entry.v};
}

/** Whether `a` is a strictly more recent choice than `b`; an equal time goes
 * to the later text, so every device picks the same one. */
export function newer(a: Entry, b: Entry): boolean {
	if (a.t !== b.t) {
		return a.t > b.t;
	}

	const textA = isMarker(a) ? "" : canonical(a.v);
	const textB = isMarker(b) ? "" : canonical(b.v);
	return textA > textB;
}

/**
 * The time a change made now is dated: the device's clock, or one
 * millisecond past the newest entry it holds if that is later, so a change
 * made after seeing a value beats it however slow the clock.
 */
export function stampAfter(entries: Entries, now: number): number {
	let newest = 0;

	// One dated ahead of the clock does not count: after a clock that ran
	// ahead is put right, every later change would be dated ahead too.
	for (const id in entries) {
		if (entries[id].t <= now + SKEW_MS) {
			newest = Math.max(newest, entries[id].t);
		}
	}

	return Math.max(now, newest + 1);
}

const expired = (entry: Entry, now: number): boolean =>
	isMarker(entry) && entry.t < now - MARKER_TTL_MS;

/** Read a decoded file: its well-formed entries, or a {@link DocumentError}. */
export function parseDocument(value: unknown): SyncDocument {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new DocumentError("not-sync");
	}

	const record = value as Record<string, unknown>;

	if (record.format !== FORMAT) {
		throw new DocumentError("not-sync");
	}

	if (typeof record.version !== "number" || !Number.isInteger(record.version)) {
		throw new DocumentError("damaged");
	}

	if (record.version > VERSION) {
		throw new DocumentError("newer-version");
	}

	const raw = record.entries;

	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new DocumentError("damaged");
	}

	const entries = dict<Entry>();

	for (const [id, entry] of Object.entries(raw)) {
		if (wellFormed(entry)) {
			entries[id] = bare(entry);
		}
	}

	return {format: FORMAT, version: record.version, entries};
}

/** The document a device uploads: its entries as they travel, expired markers left out. */
export function toDocument(entries: Entries, now: number): SyncDocument {
	const out = dict<Entry>();

	for (const id of Object.keys(entries).sort()) {
		if (!expired(entries[id], now)) {
			out[id] = bare(entries[id]);
		}
	}

	return {format: FORMAT, version: VERSION, entries: out};
}

export interface Merged {
	entries: Entries;
	/** Ids whose entry came from the file: the device applies them. */
	taken: string[];
	/** The device holds something the file does not: it uploads. */
	ahead: boolean;
	/**
	 * The earliest time of an entry kept as deferred (`d`: dated past `now`
	 * + {@link SKEW_MS} but within {@link DEFER_MS}), or 0. The rest of the
	 * file is taken now; such an entry is taken once its time is near.
	 */
	deferred: number;
}

/** Whether `entry` is dated too far ahead to take now; then `waits` says if it is kept. */
const ahead = (entry: Entry, now: number) => ({
	early: entry.t > now + SKEW_MS,
	waits: entry.t <= now + DEFER_MS,
});

/** The earliest `t` of the entries kept as deferred, or 0. */
export function deferredUntil(entries: Entries): number {
	let first = 0;

	for (const id in entries) {
		if (entries[id].d) {
			first = first ? Math.min(first, entries[id].t) : entries[id].t;
		}
	}

	return first;
}

/**
 * Merge the file's entries into the device's. Nothing of the file's dated
 * more than {@link SKEW_MS} after `now` is taken. Expired markers are
 * dropped from the result, and neither side's count as a difference.
 */
export function merge(mine: Entries, theirs: Entries, now: number): Merged {
	const entries = dict<Entry>();
	const taken: string[] = [];
	let isAhead = false;

	for (const id in mine) {
		entries[id] = mine[id];
	}

	for (const id in theirs) {
		const theirEntry = theirs[id];

		if (!wellFormed(theirEntry)) {
			continue;
		}

		const myEntry = entries[id];

		if (myEntry && !newer(theirEntry, myEntry)) {
			continue;
		}

		const {early, waits} = ahead(theirEntry, now);

		if (!early) {
			entries[id] = bare(theirEntry);
			taken.push(id);
		} else if (waits) {
			// Kept and passed on as received; taken when its time comes.
			entries[id] = {...bare(theirEntry), d: true};
		}
	}

	for (const id of Object.keys(entries)) {
		const entry = entries[id];

		if (expired(entry, now)) {
			delete entries[id];
			continue;
		}

		const theirEntry = theirs[id];

		if (!theirEntry || !wellFormed(theirEntry) || newer(entry, theirEntry)) {
			isAhead = true;
		}
	}

	return {
		entries,
		taken: taken.filter((id) => id in entries),
		ahead: isAhead,
		deferred: deferredUntil(entries),
	};
}

/** What a device holds now, and how to read it. */
export interface Local {
	/** Every entry this device holds, by id. */
	current: Record<string, unknown>;
	/** Whether this build knows the id: only those are compared. */
	owns(id: string): boolean;
	/** Whether a value is the device's default: nobody chose it. */
	isDefault(id: string, value: unknown): boolean;
}

/**
 * Date what changed on the device since its copy was written: a value that
 * differs from the copy's is a choice made now, an entry gone is a removal.
 * A value still at its default with no entry behind it was never chosen and
 * stays out. Entries this build does not know are left as they are.
 */
export function diff(
	entries: Entries,
	local: Local,
	now: number
): {entries: Entries; changed: boolean} {
	const out = dict<Entry>();
	const t = stampAfter(entries, now);
	let changed = false;

	for (const id in entries) {
		out[id] = entries[id];
	}

	for (const id of Object.keys(local.current)) {
		if (!local.owns(id)) {
			continue;
		}

		const value = local.current[id];
		const entry = out[id];
		const view = entry ? held(entry) : undefined;

		if (view && !isMarker(view)) {
			if (!sameValue(view.v, value)) {
				out[id] = {t, v: value};
				changed = true;
			}
		} else if (!local.isDefault(id, value)) {
			out[id] = {t, v: value};
			changed = true;
		}
	}

	for (const id of Object.keys(out)) {
		if (!local.owns(id) || Object.hasOwn(local.current, id)) {
			continue;
		}

		if (!isMarker(held(out[id]))) {
			out[id] = {t};
			changed = true;
		}
	}

	return {entries: out, changed};
}

/**
 * A device joining an account (§ A device joining): nothing on it says when
 * a choice was made, so the account's side wins. Where both hold an entry
 * the account's stands; an entry only the device holds is added, dated now;
 * what the account removed stays removed.
 */
export function join(theirs: Entries, local: Local, now: number): Merged {
	const entries = dict<Entry>();
	const taken: string[] = [];
	let isAhead = false;

	for (const id in theirs) {
		const entry = theirs[id];

		if (!wellFormed(entry)) {
			continue;
		}

		const {early, waits} = ahead(entry, now);

		if (early && waits) {
			entries[id] = {...bare(entry), d: true};
		} else if (!early && !expired(entry, now)) {
			entries[id] = bare(entry);
			taken.push(id);
		}
	}

	const t = stampAfter(entries, now);

	for (const id of Object.keys(local.current)) {
		if (!local.owns(id) || id in entries || local.isDefault(id, local.current[id])) {
			continue;
		}

		entries[id] = {t, v: local.current[id]};
		isAhead = true;
	}

	return {entries, taken, ahead: isAhead, deferred: deferredUntil(entries)};
}

/**
 * After the device applied `entries`: note, on each entry this build knows,
 * what the device holds where that is not the entry's value, so the next
 * {@link diff} does not read the difference as a change made here; and mark
 * each entry it does not know as never taken (`u`).
 */
export function reconcile(entries: Entries, local: Local): Entries {
	const out = dict<Entry>();

	for (const id in entries) {
		const entry = bare(entries[id]);
		out[id] = entry;

		if (entries[id].d) {
			entry.d = true; // not taken yet: what the device holds is its own
		}

		if (!local.owns(id)) {
			entry.u = true;
			continue;
		}

		const has = Object.hasOwn(local.current, id);
		const value = local.current[id];

		if (isMarker(entry)) {
			// A default is what a removed setting reads as.
			if (has && !local.isDefault(id, value)) {
				entry.l = {v: value};
			}
		} else if (!has) {
			entry.l = {};
		} else if (!sameValue(entry.v, value)) {
			entry.l = {v: value};
		}
	}

	return out;
}
