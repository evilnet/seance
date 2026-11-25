/**
 * Settings sync, the part that decides (docs/projects/settings-sync.md):
 * when the home network's connection has read the account's pointer, fetch
 * the file it names if this device has not applied it, join or merge, apply
 * what the file knew newer, and upload when this device knows something the
 * file does not, spaced for the whole account.
 *
 * Everything outside is handed in as a {@link SyncHost}: the storage, the
 * clock, `fetch`, the home network's connection, the stores that reload and
 * the window that shows a notice. So it runs under mocha with fakes
 * (test/sync/engine.ts); sync/index.ts is the page's host.
 *
 * One run at a time. Every trigger (a pointer read, a change on the device,
 * a timer, the upload lock arriving) asks for a run, and a run reads the
 * stored state from scratch: another tab may have moved it.
 */

import {
	diff,
	join,
	MARKER_TTL_MS,
	merge,
	reconcile,
	toDocument,
	type Merged,
	type SyncDocument,
} from "./document";
import {apply, collect, type EntryContext, type StorageBackend} from "./entries";
import {
	acceptableUrl,
	download,
	DownloadError,
	FileError,
	formatPointer,
	isReadable,
	open,
	parsePointer,
	seal,
	upload,
	UploadRefused,
} from "./file";
import {
	clearSync,
	COPY_KEY,
	readCopy,
	readState,
	sameAccount,
	updateState,
	writeCopy,
	type SyncState,
} from "./state";

/** A change goes out this long after the last one: one edit session, one file. */
export const QUIET_MS = 10_000;
/** After any upload, the account's next waits this long: at most 12 an hour. */
export const SPACING_MS = 5 * 60_000;
/** The file is uploaded again this long before the host deletes it. */
export const REFRESH_BEFORE_MS = 7 * 24 * 3600 * 1000;
/** The first wait after a failed download or upload; doubled each time. */
export const RETRY_MS = 60_000;
export const RETRY_MAX_MS = 3600_000;
/** How long before trying again a host that refuses the file's type. */
export const REFUSED_RETRY_MS = 3600_000;

/** The home network's connection, while it is registered and logged in. */
export interface HomeLink {
	/** The services account this connection is logged in as. */
	account: string;
	/**
	 * The account's pointer as this connection last read it: undefined
	 * until it has, "" when the key is not set.
	 */
	pointer: string | undefined;
	/** The network's file host (`draft/FILEHOST`), if it has one. */
	filehost: string | undefined;
	/** Whether this connection can write the pointer as a private key. */
	canWrite: boolean;
	/** A `draft/authtoken` token for the file host. */
	token(): Promise<string>;
	/** Write the pointer; the connection reads it as set from here on. */
	setPointer(value: string): void;
}

/** What the device says once in the home network's window. */
export type Notice =
	| {kind: "alias-added" | "alias-changed" | "alias-removed"; name: string}
	/** The account's file is over the size limit: not read. */
	| {kind: "too-large"}
	/** The pointer names a file that is not on the network's file host: not read. */
	| {kind: "elsewhere"}
	/** The file could not be read with the pointer's key. */
	| {kind: "damaged"}
	/** A newer format: sync waits on this device for an update of the app. */
	| {kind: "newer-version"}
	/** What this device holds is over the size limit: not uploaded. */
	| {kind: "upload-too-large"}
	/** The file host does not take the file. */
	| {kind: "upload-refused"; status: number};

export interface SyncHost {
	storage: StorageBackend;
	now(): number;
	fetch: typeof fetch;
	/** The connection of network `uuid`, when it is registered with an account. */
	link(uuid: string): HomeLink | null;
	/** How the device's stores are read and written for the home `uuid`. */
	context(uuid: string): EntryContext;
	/** Storage keys an apply wrote: the stores behind them reload. */
	applied(keys: string[]): void;
	say(uuid: string, notice: Notice): void;
	/**
	 * The home is signed in as `account`, not the one this device syncs
	 * with (`known`): whether to sync with `account` instead.
	 */
	askOtherAccount(account: string, known: string): Promise<boolean>;
	/** Whether this copy of the app is the one that uploads for the device. */
	isUploader(): boolean;
	/** Run again in `ms`; a later call replaces an earlier one. */
	wake(ms: number): void;
	/** How long the file host keeps a file. */
	retentionMs(): number;
	/** The stored state changed (the settings page follows it). */
	changed?(): void;
}

export class SyncEngine {
	private running = false;
	private again = false;
	private asking = false;
	private failures = 0;
	private idle: Array<() => void> = [];

	constructor(private readonly host: SyncHost) {}

	get state(): SyncState {
		return readState(this.host.storage);
	}

	/** Make `uuid` the sync home, for `account`: the device joins its file, or uploads the first. */
	enable(uuid: string, account: string): void {
		const never = this.state.never.filter((u) => u !== uuid);
		clearSync(this.host.storage);
		this.update({home: uuid, account, never});
		this.run();
	}

	/** Sync off on this device. The account's file stays for its other devices. */
	disable(): void {
		clearSync(this.host.storage);
		this.host.changed?.();
	}

	/** Never offer sync on `uuid` on this device. */
	never(uuid: string): void {
		const state = this.state;

		if (!state.never.includes(uuid)) {
			this.update({never: [...state.never, uuid]});
		}
	}

	/** Something roaming may have changed on the device: date it, then run. */
	localChange(): void {
		this.scan();
		this.run();
	}

	/** Ask for a run; one is started unless one is under way. */
	run(): void {
		if (this.running) {
			this.again = true;
			return;
		}

		this.running = true;
		void this.loop();
	}

	/** Resolves once no run is under way (tests). */
	settled(): Promise<void> {
		return this.running ? new Promise((resolve) => this.idle.push(resolve)) : Promise.resolve();
	}

	private async loop(): Promise<void> {
		try {
			do {
				this.again = false;

				try {
					await this.step();
				} catch (e) {
					// A bug or a full disk must not stop every later run.
					// eslint-disable-next-line no-console
					console.error("settings sync", e);
				}
			} while (this.again);
		} finally {
			this.running = false;

			for (const resolve of this.idle.splice(0)) {
				resolve();
			}
		}
	}

	private update(patch: Partial<SyncState>): SyncState {
		const next = updateState(this.host.storage, patch);
		this.host.changed?.();
		return next;
	}

	/** Date what changed on the device since its copy was written. */
	private scan(): void {
		const state = this.state;

		if (!state.home || !state.joined) {
			return;
		}

		const {storage} = this.host;
		const result = diff(
			readCopy(storage),
			collect(this.host.context(state.home)),
			this.host.now()
		);

		if (result.changed) {
			writeCopy(storage, result.entries);
			this.update({dirty: true, changedAt: this.host.now(), stuck: null});
		}
	}

	private backoff(): number {
		const wait = Math.min(RETRY_MS * 2 ** this.failures, RETRY_MAX_MS);
		this.failures++;
		return wait;
	}

	private async step(): Promise<void> {
		let state = this.state;

		if (!state.home) {
			return;
		}

		const home = state.home;
		const link = this.host.link(home);

		if (!link || !link.account) {
			return;
		}

		if (!sameAccount(link.account, state.account)) {
			await this.otherAccount(home, link.account, state);
			return;
		}

		if (state.pausedFor) {
			state = this.update({pausedFor: ""});
		}

		const value = link.pointer;

		if (value === undefined) {
			return; // not read on this connection yet
		}

		if (value === "") {
			if (!state.joined) {
				this.first(home);
			} else if (state.pointer !== null) {
				// The key is gone: the next upload sets it again.
				this.update({pointer: null, dirty: true});
			}
		} else if (value !== state.pointer && value !== state.refused) {
			if (!(await this.take(home, link, value))) {
				return;
			}
		}

		state = this.state;

		if (state.home !== home || !state.joined || state.blocked) {
			return;
		}

		this.scan();
		state = this.state;
		const now = this.host.now();

		if (!state.dirty && value !== "" && value === state.pointer) {
			const pointer = parsePointer(value);

			if (
				pointer &&
				isReadable(pointer) &&
				now - pointer.changedAt >= this.host.retentionMs() - REFRESH_BEFORE_MS
			) {
				state = this.update({dirty: true});
			}
		}

		if (!state.dirty || state.stuck) {
			return;
		}

		const due = Math.max(
			state.changedAt + QUIET_MS,
			state.uploadedAt > 0 ? state.uploadedAt + SPACING_MS : 0,
			state.retryAt
		);

		if (now < due) {
			this.host.wake(due - now);
			return;
		}

		if (!this.host.isUploader() || !link.canWrite || !link.filehost) {
			return;
		}

		await this.upload(home, link, value);
	}

	/** The first device of an account: everything it holds that is not a default goes up. */
	private first(home: string): void {
		const ctx = this.host.context(home);
		const now = this.host.now();
		const joined = join({}, collect(ctx), now);
		writeCopy(this.host.storage, reconcile(joined.entries, collect(ctx)));
		this.update({joined: true, dirty: true, changedAt: now, syncedAt: now, pointer: null});
	}

	private async otherAccount(home: string, account: string, state: SyncState): Promise<void> {
		if (sameAccount(state.pausedFor, account) || this.asking) {
			return;
		}

		this.asking = true;
		let yes = false;

		try {
			yes = await this.host.askOtherAccount(account, state.account);
		} finally {
			this.asking = false;
		}

		if (this.state.home !== home) {
			return;
		}

		if (yes) {
			// Another account's file: this device joins it as a new one.
			this.enable(home, account);
		} else {
			this.update({pausedFor: account});
		}
	}

	/** The home's window is told once; the pointer is not fetched again. */
	private refuse(home: string, value: string, notice: Notice): void {
		this.update({refused: value});
		this.host.say(home, notice);
	}

	/**
	 * Read the file `value` names and take what it knows newer. False when
	 * the run should stop here (a newer format, a download to try again).
	 */
	private async take(home: string, link: HomeLink, value: string): Promise<boolean> {
		const pointer = parsePointer(value);

		if (!pointer) {
			this.refuse(home, value, {kind: "damaged"});
			return true;
		}

		if (!isReadable(pointer)) {
			this.block(home);
			return false;
		}

		if (!acceptableUrl(pointer.url, link.filehost)) {
			this.refuse(home, value, {kind: "elsewhere"});
			return true;
		}

		let doc: SyncDocument | null = null;

		try {
			doc = await open(await download(pointer.url, this.host.fetch), pointer.key);
		} catch (e) {
			if (e instanceof FileError) {
				if (e.code === "newer-version") {
					this.block(home);
					return false;
				}

				if (e.code === "unsupported") {
					return false;
				}

				this.refuse(home, value, {kind: e.code === "too-large" ? "too-large" : "damaged"});
				return true;
			}

			if (!(e instanceof DownloadError && e.gone)) {
				this.host.wake(this.backoff());
				return false;
			}
			// The host no longer has the file: this device's entries are what is left.
		}

		const state = this.state;
		const now = this.host.now();

		if (state.home !== home || this.host.link(home)?.pointer !== value) {
			this.again = true;
			return false;
		}

		this.failures = 0;
		const {storage} = this.host;
		const ctx = this.host.context(home);
		const fresh = !state.joined || now - state.syncedAt > MARKER_TTL_MS;
		let merged: Merged;

		if (fresh) {
			merged = join(doc?.entries ?? {}, collect(ctx), now);
		} else {
			this.scan();
			merged = merge(readCopy(storage), doc?.entries ?? {}, now);
		}

		const {changes, keys} = apply(ctx, merged.entries, merged.taken);
		writeCopy(storage, reconcile(merged.entries, collect(ctx)));
		const ahead = merged.ahead || doc === null;
		this.update({
			joined: true,
			pointer: doc ? value : null,
			refused: doc ? null : value,
			blocked: false,
			syncedAt: now,
			uploadedAt: Math.max(state.uploadedAt, Math.min(pointer.changedAt, now)),
			dirty: ahead,
			changedAt: ahead && !this.state.dirty ? now : this.state.changedAt,
		});

		for (const change of changes) {
			if (!change.id.startsWith("alias:")) {
				continue;
			}

			const kind =
				change.before === undefined
					? "alias-added"
					: change.after === undefined
					? "alias-removed"
					: "alias-changed";
			const alias = (change.after ?? change.before) as {name?: unknown} | undefined;
			const name = typeof alias?.name === "string" ? alias.name : change.id.slice(6);
			this.host.say(home, {kind, name});
		}

		if (keys.length > 0) {
			this.host.applied(keys);
		}

		return true;
	}

	private block(home: string): void {
		if (!this.state.blocked) {
			this.update({blocked: true});
			this.host.say(home, {kind: "newer-version"});
		}
	}

	private async upload(home: string, link: HomeLink, value: string): Promise<void> {
		const {storage} = this.host;
		const raw = storage.get(COPY_KEY);
		let sealed: {bytes: Uint8Array; key: string};

		try {
			sealed = await seal(toDocument(readCopy(storage), this.host.now()));
		} catch (e) {
			if (e instanceof FileError && e.code === "too-large") {
				this.update({stuck: "size"});
				this.host.say(home, {kind: "upload-too-large"});
			}

			return;
		}

		let url: string;

		try {
			url = await upload(sealed.bytes, link.filehost!, await link.token(), this.host.fetch);
		} catch (e) {
			const now = this.host.now();

			if (e instanceof UploadRefused && e.status === 429) {
				this.update({retryAt: now + (e.retryAfterMs ?? RETRY_MS)});
			} else if (e instanceof UploadRefused && e.status >= 400 && e.status < 500) {
				// 415: the host does not take this type (until its operator adds it).
				if (!this.state.saidRefusal) {
					this.host.say(home, {kind: "upload-refused", status: e.status});
				}

				this.update({retryAt: now + REFUSED_RETRY_MS, saidRefusal: true});
			} else {
				this.update({retryAt: now + this.backoff()});
			}

			this.again = true; // to arm the wake
			return;
		}

		const now = this.host.now();
		const pointer = acceptableUrl(url, link.filehost)
			? formatPointer({url, key: sealed.key, changedAt: now})
			: null;

		if (pointer === null) {
			// A URL other devices would not fetch, or one the key cannot hold.
			if (!this.state.saidRefusal) {
				this.host.say(home, {kind: "elsewhere"});
			}

			this.update({retryAt: now + REFUSED_RETRY_MS, saidRefusal: true});
			return;
		}

		const current = this.host.link(home);

		// Another device moved the pointer meanwhile, or the connection went:
		// merge with what is there first.
		if (
			this.state.home !== home ||
			!current ||
			!current.canWrite ||
			current.pointer !== value
		) {
			this.again = true;
			return;
		}

		current.setPointer(pointer);
		this.failures = 0;
		const dirty = storage.get(COPY_KEY) !== raw;
		this.update({
			pointer,
			refused: null,
			dirty,
			uploadedAt: now,
			syncedAt: now,
			retryAt: 0,
			saidRefusal: false,
		});

		if (dirty) {
			this.again = true;
		}
	}
}
