/**
 * Settings backup: everything a person has set up in this browser, as one
 * file they can keep, move to another device or hand to a friend.
 *
 * The file is the localStorage entries that hold preferences — the settings
 * object, the saved networks, sort orders, mutes, ignore lists, trusted media
 * hosts, recent reactions, command aliases, the per-channel translation state,
 * oper notice routing and snomask — wrapped in a small envelope and
 * gzipped with the
 * browser's own `CompressionStream` (no dependency; a plain-JSON file is
 * accepted too, the loader sniffs the gzip magic). Extension:
 * `.seance-settings`.
 *
 * Left out on purpose: `thelounge.sts` (a cache), `thelounge.push*` (this
 * device's push subscriptions, bound to its service worker),
 * `thelounge.mentions` and `thelounge.querylog.*` (logs: conversation, not
 * preference), the server-notice log (IndexedDB, irc/noticelog.ts) and `thelounge.state.*` (where the UI was last). Restoring replaces every covered entry, so a key the file lacks is
 * removed — the file *is* the state afterwards — and the caller reloads the
 * page, which is how every module re-reads its storage.
 *
 * Vue-free so mocha covers it (`test/helpers/settingsBackup.ts`); tests swap
 * the backend with {@link useStorageBackend}.
 */

import storage from "../localStorage";
import {isPlatform, PLATFORM_DEFAULTS, type Platform} from "./platformDefaults";
import {overridesChoice} from "./settingsMigration";
import {withoutPrivateTerms} from "../translate/channelStore";

export const FILE_EXTENSION = ".seance-settings";
export const FORMAT = "seance-settings";
export const VERSION = 2;

/**
 * The file version a key first travelled in. A restore empties the keys the
 * file covers, so an older file must not be read as "this key was empty on
 * that device": a key the format did not carry yet is left alone, because
 * that file could never have held it. Keys from version 1 are not listed.
 */
const KEY_SINCE: Record<string, number> = {"thelounge.translate": 2};

/** Whether a file of `version` says anything about `key` — a missing entry
 * for a key it covers means "not set", and the restore removes it. */
function coveredBy(version: number, key: string): boolean {
	return (KEY_SINCE[key] ?? 1) <= version;
}

/** Whole keys the backup carries. `settings` has no prefix (store-settings.ts). */
export const BACKUP_KEYS: readonly string[] = [
	"settings",
	"thelounge.networks",
	"thelounge.networks.collapsed",
	"thelounge.sort.networks",
	"thelounge.sort.channels",
	"thelounge.muted",
	"thelounge.media.trusted",
	"thelounge.reactions.recent",
	"thelounge.aliases",
	"thelounge.translate",
	"thelounge.oper",
	"thelounge.dnd",
];

/** Key prefixes the backup carries: one entry per network. */
export const BACKUP_PREFIXES: readonly string[] = ["thelounge.ignore."];

export interface SettingsBackup {
	format: typeof FORMAT;
	version: number;
	/** ISO 8601, when the file was made. */
	exportedAt: string;
	/** The deploy's app name, for the person reading the file; not checked. */
	app?: string;
	/** Where the file was made (helpers/platformDefaults.ts). A restore
	 * elsewhere moves a setting that only held that platform's default onto
	 * its own. Absent from files made before it was recorded. */
	platform?: Platform;
	/** localStorage key → its parsed JSON value. */
	entries: Record<string, unknown>;
}

export interface StorageBackend {
	get(key: string): string | null;
	set(key: string, value: string): void;
	remove(key: string): void;
	keys(): string[];
}

let backend: StorageBackend = storage;

/** Swap the persistence backend (tests); `null` restores localStorage. */
export function useStorageBackend(next: StorageBackend | null): void {
	backend = next ?? storage;
}

export function isBackupKey(key: string): boolean {
	return BACKUP_KEYS.includes(key) || BACKUP_PREFIXES.some((p) => key.startsWith(p));
}

/** The covered keys present in storage right now. */
function storedBackupKeys(): string[] {
	return backend.keys().filter(isBackupKey).sort();
}

export interface CollectOptions {
	/** Keep `saslPassword` on the saved networks; off strips it. */
	includePasswords?: boolean;
	/** The live settings object; storage only holds `settings` once one has
	 * been changed, so the caller passes the store's, defaults and all. */
	settings?: Record<string, unknown>;
	app?: string;
	/** Where this backup is made, recorded in the file. */
	platform?: Platform;
	now?: Date;
}

/** Read the covered entries into a backup envelope. */
export function collectBackup(options: CollectOptions = {}): SettingsBackup {
	const entries: Record<string, unknown> = {};

	for (const key of storedBackupKeys()) {
		const raw = backend.get(key);

		if (raw === null) {
			continue;
		}

		try {
			entries[key] = JSON.parse(raw);
		} catch (e) {
			// A corrupt entry is not worth failing the whole backup over.
		}
	}

	if (options.settings) {
		entries.settings = {...options.settings};
	}

	if (!options.includePasswords && Array.isArray(entries["thelounge.networks"])) {
		entries["thelounge.networks"] = (entries["thelounge.networks"] as unknown[]).map((net) => {
			if (typeof net !== "object" || net === null) {
				return net;
			}

			const {saslPassword, ...rest} = net as Record<string, unknown>;
			void saslPassword;
			return {...rest, rememberPassword: false};
		});
	}

	// Per-channel translation state travels, but not the terms learnt in
	// private conversations: each is a whole short line the user sent in a
	// query, and the queries' own logs (thelounge.querylog.*) never travel.
	const translate = entries["thelounge.translate"];

	if (typeof translate === "object" && translate !== null && !Array.isArray(translate)) {
		entries["thelounge.translate"] = withoutPrivateTerms(
			translate as Record<string, {terms?: unknown}>
		);
	}

	return {
		format: FORMAT,
		version: VERSION,
		exportedAt: (options.now ?? new Date()).toISOString(),
		...(options.app ? {app: options.app} : {}),
		...(options.platform ? {platform: options.platform} : {}),
		entries,
	};
}

/** Does the backup hold a saved network with a password? */
export function hasPasswords(backup: SettingsBackup): boolean {
	const nets = backup.entries["thelounge.networks"];
	return (
		Array.isArray(nets) &&
		nets.some(
			(net) =>
				typeof net === "object" &&
				net !== null &&
				typeof (net as Record<string, unknown>).saslPassword === "string" &&
				(net as Record<string, unknown>).saslPassword !== ""
		)
	);
}

/** How many saved networks the backup carries. */
export function networkCount(backup: SettingsBackup): number {
	const nets = backup.entries["thelounge.networks"];
	return Array.isArray(nets) ? nets.length : 0;
}

/**
 * The settings object as it should land on `target`: a platform-dependent
 * setting (helpers/platformDefaults.ts) that holds the default of the
 * platform the file was made on is the person's choice of nothing, so it
 * takes `target`'s default — a web backup restored in a shell follows the
 * system, as a fresh install there would — unless switching it on would
 * override a text size or a paired theme the file records as picked
 * (`overridesChoice`, helpers/settingsMigration.ts, against `defaults`: the
 * restoring deploy's), which then stays as it was. A value that differs from
 * the source's default was chosen and is kept. The key stays either way: a
 * settings object without it reads as one saved before the setting existed
 * (helpers/settingsMigration.ts).
 */
function rebaseSettings(
	settings: unknown,
	source: Platform | undefined,
	target: Platform,
	defaults: Record<string, unknown>
): unknown {
	if (!source || typeof settings !== "object" || settings === null || Array.isArray(settings)) {
		return settings;
	}

	const rebased: Record<string, unknown> = {...settings};

	for (const [name, platformDefault] of Object.entries(PLATFORM_DEFAULTS)) {
		const from = platformDefault(source);
		const to = platformDefault(target);

		if (!(name in rebased) || rebased[name] !== from || from === to) {
			continue;
		}

		rebased[name] = to && !overridesChoice(name, rebased, defaults);
	}

	return rebased;
}

/** A restore that did not fit in storage; what it had written is undone. */
export class BackupStorageError extends Error {
	constructor() {
		super("There isn't room on this device to import that file. Nothing was changed.");
	}
}

/**
 * Replace every covered entry with the backup's. Keys the backup does not
 * carry are removed, so the device ends up exactly as the file says — except
 * for keys the file's own version did not cover yet (`coveredBy`), which a
 * restore from an older app leaves as they are, and for the
 * platform-dependent settings, which `platform` (where this restore runs)
 * rebases against this deploy's `defaults` (see rebaseSettings).
 */
export function applyBackup(
	backup: SettingsBackup,
	platform: Platform,
	defaults: Record<string, unknown>
): void {
	const before = new Map(storedBackupKeys().map((key) => [key, backend.get(key)]));
	const written: string[] = [];

	// Write first, remove after: localStorage swallows a full quota, and a
	// restore that removed first left a device with no networks at all.
	for (const [key, value] of Object.entries(backup.entries)) {
		if (!isBackupKey(key)) {
			continue; // never let a file write arbitrary keys
		}

		const restored =
			key === "settings" ? rebaseSettings(value, backup.platform, platform, defaults) : value;
		const json = JSON.stringify(restored);
		backend.set(key, json);

		if (backend.get(key) !== json) {
			for (const done of written) {
				const old = before.get(done);

				if (old === undefined || old === null) {
					backend.remove(done);
				} else {
					backend.set(done, old);
				}
			}

			throw new BackupStorageError();
		}

		written.push(key);
	}

	// Then clear what the file does not carry, among the keys its version
	// covers (KEY_SINCE): a key it could never have carried stays.
	for (const key of before.keys()) {
		if (!written.includes(key) && coveredBy(backup.version, key)) {
			backend.remove(key);
		}
	}
}

export function fileName(app: string, now: Date = new Date()): string {
	const stem =
		app
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "") || "seance";
	return `${stem}-${now.toISOString().slice(0, 10)}${FILE_EXTENSION}`;
}

const GZIP_MAGIC = [0x1f, 0x8b];

function isGzip(bytes: Uint8Array): boolean {
	return bytes.length > 2 && bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1];
}

async function pipe(bytes: Uint8Array, stream: GenericTransformStream): Promise<Uint8Array> {
	const blob = new Blob([bytes as BlobPart]);
	const out = await new Response(blob.stream().pipeThrough(stream)).arrayBuffer();
	return new Uint8Array(out);
}

/** Serialise the envelope: gzipped JSON, or plain JSON where the browser cannot gzip. */
export async function encodeBackup(backup: SettingsBackup): Promise<Uint8Array> {
	const json = new TextEncoder().encode(JSON.stringify(backup));

	if (typeof CompressionStream === "undefined") {
		return json;
	}

	return pipe(json, new CompressionStream("gzip"));
}

/**
 * Why a backup file was refused. Stable identifiers on purpose: this module
 * is Vue-free and carries no English copy — the render site
 * (Settings/General.vue) translates the code into reader-visible wording.
 */
export type BackupFormatErrorCode =
	| "not-settings"
	| "newer-version"
	| "damaged"
	| "no-decompression";

export class BackupFormatError extends Error {
	readonly code: BackupFormatErrorCode;

	constructor(code: BackupFormatErrorCode) {
		super(code);
		this.code = code;
	}
}

function validate(value: unknown): SettingsBackup {
	if (typeof value !== "object" || value === null) {
		throw new BackupFormatError("not-settings");
	}

	const obj = value as Record<string, unknown>;

	if (obj.format !== FORMAT) {
		throw new BackupFormatError("not-settings");
	}

	if (typeof obj.version !== "number" || obj.version > VERSION) {
		throw new BackupFormatError("newer-version");
	}

	if (typeof obj.entries !== "object" || obj.entries === null || Array.isArray(obj.entries)) {
		throw new BackupFormatError("damaged");
	}

	return {
		format: FORMAT,
		version: obj.version,
		exportedAt: typeof obj.exportedAt === "string" ? obj.exportedAt : "",
		...(typeof obj.app === "string" ? {app: obj.app} : {}),
		...(isPlatform(obj.platform) ? {platform: obj.platform} : {}),
		entries: obj.entries as Record<string, unknown>,
	};
}

/** Parse a file made by {@link encodeBackup}; throws {@link BackupFormatError}. */
export async function decodeBackup(bytes: Uint8Array): Promise<SettingsBackup> {
	let json = bytes;

	if (isGzip(bytes)) {
		if (typeof DecompressionStream === "undefined") {
			throw new BackupFormatError("no-decompression");
		}

		try {
			json = await pipe(bytes, new DecompressionStream("gzip"));
		} catch (e) {
			throw new BackupFormatError("damaged");
		}
	}

	let parsed: unknown;

	try {
		parsed = JSON.parse(new TextDecoder().decode(json));
	} catch (e) {
		throw new BackupFormatError("not-settings");
	}

	return validate(parsed);
}
