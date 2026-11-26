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
	SKEW_MS,
	toDocument,
	type Entries,
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
/** The file is uploaded again this long before the host deletes it (half its keep, if shorter). */
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
	/** Ask the server for the pointer again; settles once it has answered. */
	reread?(): Promise<void>;
}

/**
 * How a sync the user asked for ended: a file went up, there was nothing
 * to send, the home is not connected, or the upload did not go through.
 */
export type SyncNowResult = "sent" | "upToDate" | "offline" | "failed";

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
	/**
	 * Run `upload` while no other copy of the app on the device uploads
	 * (a lock held only for the upload); undefined, without running it,
	 * when another copy holds the lock.
	 */
	exclusively<T>(upload: () => Promise<T>): Promise<T | undefined>;
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
	/** The user asked for a sync: the next upload does not wait its turn. */
	private urgent = false;
	private outcome: "sent" | "failed" | null = null;
	/** The last run found the account's file applied and nothing to send. */
	private upToDate = false;
	/**
	 * The pointer this copy's connection said that a run acted on. The
	 * device's tabs share the stored state, but each reads the pointer on
	 * its own connection: a value this tab's connection still says, after
	 * another tab took a newer one, is not news and is not taken again.
	 */
	private handled: string | undefined = undefined;
	/** The pointer this copy last wrote, and the one it wrote over. */
	private wrote: {pointer: string; over: string} | null = null;
	/** Writes of this copy's the server did not keep, since one went through. */
	private lostSets = 0;
	/** The account this copy was told not to sync with, while its home stays on it. */
	private declined = "";
	private idle: Array<() => void> = [];

	constructor(private readonly host: SyncHost) {
		// A newer format blocked an older build: this one may read it.
		if (this.state.blocked) {
			this.update({blocked: false, refused: null});
		}
	}

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

	/**
	 * The user asked to sync now: read the pointer again, take what another
	 * device sent, and upload what this one holds without the quiet spell,
	 * the spacing or a wait an earlier refusal set. One upload at most.
	 */
	async syncNow(): Promise<SyncNowResult> {
		const home = this.state.home;
		const link = home ? this.host.link(home) : null;

		if (!link) {
			return "offline";
		}

		try {
			await link.reread?.();
		} catch {
			// No answer in time: sync with the pointer as last read.
		}

		await this.settled();
		this.outcome = null;
		this.upToDate = false;
		this.urgent = true;
		this.failures = 0;

		// A file refused before (a download a proxy answered) is read again.
		this.handled = undefined;

		if (this.state.refused !== null) {
			this.update({refused: null});
		}

		this.run();
		await this.settled();
		this.urgent = false;

		if (this.outcome) {
			return this.outcome;
		}

		return this.upToDate && !this.state.dirty ? "upToDate" : "failed";
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
		const ctx = this.host.context(state.home);
		const copy = readCopy(storage);
		let local = collect(ctx);
		const adopt = Object.keys(copy).filter((id) => copy[id].u && local.owns(id));

		if (adopt.length > 0) {
			// Entries an older build kept without taking them: this build
			// knows them now, so it takes them rather than reading what it
			// holds as a choice made now.
			const {keys} = apply(ctx, copy, adopt);
			local = collect(ctx);
			const adopted: Entries = {};

			for (const id of adopt) {
				adopted[id] = copy[id];
			}

			Object.assign(copy, reconcile(adopted, local));
			writeCopy(storage, copy);

			if (keys.length > 0) {
				this.host.applied(keys);
			}
		}

		const result = diff(copy, local, this.host.now());

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

		this.declined = "";

		if (state.pausedFor) {
			state = this.update({pausedFor: ""});
		}

		const value = link.pointer;

		if (value === undefined) {
			return; // not read on this connection yet
		}

		if (this.wrote && value !== this.wrote.pointer) {
			if (value === this.wrote.over) {
				// The server kept what it had (a full key list, a rate limit):
				// wait longer each time, so a server that refuses every write
				// is not sent a file every five minutes.
				const wait = Math.min(RETRY_MS * 2 ** this.lostSets, RETRY_MAX_MS);
				this.lostSets++;
				state = this.update({retryAt: Math.max(state.retryAt, this.host.now() + wait)});
			} else {
				this.lostSets = 0; // another device's write went through
			}

			this.wrote = null;
		}

		const news = value !== this.handled || !state.joined;

		if (value === "") {
			if (!state.joined) {
				this.first(home);
			} else if (news && (state.pointer !== null || state.blocked)) {
				// The key is gone: the next upload sets it again.
				this.update({pointer: null, dirty: true, blocked: false});
			}

			this.handled = value;
		} else if (news && value !== state.pointer && value !== state.refused) {
			if (!(await this.take(home, link, value))) {
				return;
			}

			this.handled = value;
		}

		state = this.state;

		if (state.home !== home || !state.joined || state.blocked) {
			return;
		}

		this.scan();
		state = this.state;
		const now = this.host.now();

		if (!state.dirty && value !== "" && value === state.pointer) {
			const at = this.refreshAt(value);

			if (at !== null && now >= at) {
				state = this.update({dirty: true});
			} else if (at !== null) {
				this.host.wake(at - now);
			}
		}

		if (!state.dirty || state.stuck) {
			this.upToDate = !state.dirty && (value === "" || value === state.pointer);
			return;
		}

		// One upload for one ask: a failed one arms the wake like any other.
		const urgent = this.urgent;
		this.urgent = false;
		const due = Math.max(
			state.changedAt + QUIET_MS,
			state.uploadedAt > 0 ? state.uploadedAt + SPACING_MS : 0,
			state.retryAt
		);

		if (!urgent && now < due) {
			this.host.wake(due - now);
			return;
		}

		if (!link.canWrite || !link.filehost) {
			return;
		}

		const ran = await this.host.exclusively(() =>
			this.upload(home, link, value, urgent, state.uploadedAt)
		);

		if (ran === undefined) {
			// Another copy of the app on the device is uploading: its
			// upload moves the shared state, and this one looks again.
			this.host.wake(QUIET_MS);
		}
	}

	/**
	 * When the file `value` names is uploaded again before the host deletes
	 * it, or null when the host keeps files (`retentionDays` 0).
	 */
	private refreshAt(value: string): number | null {
		const pointer = parsePointer(value);
		const keep = this.host.retentionMs();

		if (!pointer || !isReadable(pointer) || keep <= 0) {
			return null;
		}

		return pointer.changedAt + keep - Math.min(REFRESH_BEFORE_MS, keep / 2);
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
		// Another tab still on the first account clears the stored pause:
		// this one does not ask again while its home stays on this account.
		if (
			sameAccount(state.pausedFor, account) ||
			sameAccount(this.declined, account) ||
			this.asking
		) {
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
			this.declined = account;
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

		if (pointer && !isReadable(pointer)) {
			this.block(home);
			return false;
		}

		if (!link.filehost) {
			// Nothing to say whose file it is yet: read it once the network says.
			return false;
		}

		let doc: SyncDocument | null = null;
		let refusal: Notice | null = null;

		if (!pointer) {
			refusal = {kind: "damaged"};
		} else if (!acceptableUrl(pointer.url, link.filehost)) {
			refusal = {kind: "elsewhere"};
		} else {
			try {
				doc = await open(await download(pointer.url, this.host.fetch), pointer.key);
			} catch (e) {
				if (e instanceof FileError) {
					if (e.code === "newer-version") {
						this.block(home);
						// Not downloaded again on every run; a newer build reads it.
						this.update({refused: value});
						return false;
					}

					if (e.code === "unsupported") {
						return false;
					}

					refusal = {kind: e.code === "too-large" ? "too-large" : "damaged"};
				} else if (!(e instanceof DownloadError && e.gone)) {
					this.host.wake(this.backoff());
					return false;
				}
				// The host no longer has the file: this device's entries are what is left.
			}
		}

		if (refusal) {
			this.refuse(home, value, refusal);

			// A device that has joined keeps what it has. One that has not
			// joins as if the file were gone: else sync is on and does nothing.
			if (this.state.joined) {
				return true;
			}
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

		if (merged.deferred > 0) {
			// Another device's clock runs ahead: take the file once its
			// entries' time is near, and send nothing over it before then.
			this.host.wake(merged.deferred - SKEW_MS - now + 1);
			return false;
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
			// A pointer refused says nothing true about the account's uploads.
			uploadedAt:
				pointer && !refusal
					? Math.max(state.uploadedAt, Math.min(pointer.changedAt, now))
					: state.uploadedAt,
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

	private async upload(
		home: string,
		link: HomeLink,
		value: string,
		urgent: boolean,
		uploadedAt: number
	): Promise<true> {
		const {storage} = this.host;
		const before = this.state;

		// Another copy uploaded while this one waited for the lock.
		if (before.home !== home || !before.dirty || before.uploadedAt !== uploadedAt) {
			this.urgent = urgent;
			this.again = true;
			return true;
		}

		const raw = storage.get(COPY_KEY);
		let sealed: {bytes: Uint8Array; key: string};

		try {
			sealed = await seal(toDocument(readCopy(storage), this.host.now()));
		} catch (e) {
			if (e instanceof FileError && e.code === "too-large") {
				this.update({stuck: "size"});
				this.host.say(home, {kind: "upload-too-large"});
			}

			this.outcome = "failed";
			return true;
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

			this.outcome = "failed";
			this.again = true; // to arm the wake
			return true;
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
			this.outcome = "failed";
			this.again = true; // to arm the wake
			return true;
		}

		const current = this.host.link(home);
		const after = this.state;

		// Another device moved the pointer meanwhile, the connection went or
		// changed account, or sync was switched off and on: start over from
		// what is there.
		if (
			after.home !== home ||
			!after.joined ||
			!current ||
			!current.canWrite ||
			!sameAccount(current.account, after.account) ||
			current.pointer !== value
		) {
			// What the user asked for is still owed after the merge.
			this.urgent = urgent;
			this.again = true;
			return true;
		}

		current.setPointer(pointer);
		this.handled = pointer;
		this.wrote = {pointer, over: value};
		this.outcome = "sent";
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

		return true;
	}
}
