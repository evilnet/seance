/**
 * Settings backup: everything a person has set up in this browser, as one
 * file they can keep, move to another device or hand to a friend.
 *
 * The file is the localStorage entries that hold preferences — the settings
 * object, the saved networks, sort orders, mutes, ignore lists, trusted media
 * hosts, recent reactions, command aliases, oper notice routing and snomask —
 * wrapped in a small envelope and
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

export const FILE_EXTENSION = ".seance-settings";
export const FORMAT = "seance-settings";
export const VERSION = 1;

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
	"thelounge.oper",
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

	return {
		format: FORMAT,
		version: VERSION,
		exportedAt: (options.now ?? new Date()).toISOString(),
		...(options.app ? {app: options.app} : {}),
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
 * Replace every covered entry with the backup's. Keys the backup does not
 * carry are removed, so the device ends up exactly as the file says.
 */
export function applyBackup(backup: SettingsBackup): void {
	for (const key of storedBackupKeys()) {
		backend.remove(key);
	}

	for (const [key, value] of Object.entries(backup.entries)) {
		if (!isBackupKey(key)) {
			continue; // never let a file write arbitrary keys
		}

		backend.set(key, JSON.stringify(value));
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

export class BackupFormatError extends Error {}

function validate(value: unknown): SettingsBackup {
	if (typeof value !== "object" || value === null) {
		throw new BackupFormatError("This isn't a settings file.");
	}

	const obj = value as Record<string, unknown>;

	if (obj.format !== FORMAT) {
		throw new BackupFormatError("This isn't a settings file.");
	}

	if (typeof obj.version !== "number" || obj.version > VERSION) {
		throw new BackupFormatError("This file was made by a newer version.");
	}

	if (typeof obj.entries !== "object" || obj.entries === null || Array.isArray(obj.entries)) {
		throw new BackupFormatError("This file is damaged.");
	}

	return {
		format: FORMAT,
		version: obj.version,
		exportedAt: typeof obj.exportedAt === "string" ? obj.exportedAt : "",
		...(typeof obj.app === "string" ? {app: obj.app} : {}),
		entries: obj.entries as Record<string, unknown>,
	};
}

/** Parse a file made by {@link encodeBackup}; throws {@link BackupFormatError}. */
export async function decodeBackup(bytes: Uint8Array): Promise<SettingsBackup> {
	let json = bytes;

	if (isGzip(bytes)) {
		if (typeof DecompressionStream === "undefined") {
			throw new BackupFormatError("This browser can't read compressed files.");
		}

		try {
			json = await pipe(bytes, new DecompressionStream("gzip"));
		} catch (e) {
			throw new BackupFormatError("This file is damaged.");
		}
	}

	let parsed: unknown;

	try {
		parsed = JSON.parse(new TextDecoder().decode(json));
	} catch (e) {
		throw new BackupFormatError("This isn't a settings file.");
	}

	return validate(parsed);
}
