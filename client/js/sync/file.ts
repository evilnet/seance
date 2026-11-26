/**
 * The settings sync file and its pointer (docs/projects/settings-sync.md
 * § The shape). The file is the document as JSON, gzipped, then encrypted
 * with AES-GCM under 32 random bytes made for that one upload: a 12-byte IV
 * followed by the ciphertext. The pointer is the value of the account's
 * private metadata key {@link SYNC_KEY}:
 * `<version> <url> <key> <changedAt>`.
 *
 * What a device accepts (§ What a device accepts) is decided here: the size
 * limits, as the file streams in and as it unpacks, and which URL a pointer
 * may name. No storage, no store, no DOM (test/sync/file.ts).
 */

import {normalizeHost} from "../helpers/urlHost";
import {DocumentError, parseDocument, VERSION, type SyncDocument} from "./document";

export const SYNC_KEY = "seance/sync";
/** A device stops downloading past this, and does not upload more. */
export const MAX_FILE_BYTES = 1024 * 1024;
/** A device stops unpacking past this, and does not pack more. */
export const MAX_UNPACKED_BYTES = 4 * 1024 * 1024;
/** nefarious2's `max-value-bytes`. */
export const MAX_POINTER_BYTES = 300;

const IV_BYTES = 12;
const KEY_BYTES = 32;
/** Bound into the encryption, so a file is only ever read as this format. */
const ASSOCIATED = new TextEncoder().encode("seance-sync 1");

/** Why a file was not read or not made. Identifiers; the page has the words. */
export type FileErrorCode =
	/** Over a size limit, as a file or unpacked. */
	| "too-large"
	/** Not decryptable with the pointer's key, or not a document inside. */
	| "damaged"
	/** A format this build does not know yet. */
	| "newer-version"
	/** The browser cannot gzip or encrypt. */
	| "unsupported";

export class FileError extends Error {
	readonly code: FileErrorCode;

	constructor(code: FileErrorCode) {
		super(code);
		this.code = code;
	}
}

export interface Pointer {
	version: number;
	url: string;
	/** base64url of the file's key. */
	key: string;
	/** Unix ms the file was written. */
	changedAt: number;
}

/**
 * A pointer value read. `null` for anything that is not one. A version this
 * build does not know comes back with that version alone: the rest of the
 * value is not ours to read.
 */
export function parsePointer(value: string): Pointer | {version: number} | null {
	const words = value.split(" ");

	if (!/^[1-9]\d{0,5}$/.test(words[0] ?? "")) {
		return null;
	}

	const version = Number(words[0]);

	if (version > VERSION) {
		return {version};
	}

	if (words.length !== 4 || !/^[A-Za-z0-9_-]{43}$/.test(words[2])) {
		return null;
	}

	if (!/^[1-9]\d{0,15}$/.test(words[3])) {
		return null;
	}

	const changedAt = Number(words[3]);

	if (!Number.isSafeInteger(changedAt)) {
		return null;
	}

	try {
		new URL(words[1]);
	} catch {
		return null;
	}

	return {version, url: words[1], key: words[2], changedAt};
}

export const isReadable = (pointer: Pointer | {version: number}): pointer is Pointer =>
	"url" in pointer;

/** The value written for a file; `null` when it does not fit the key. */
export function formatPointer(pointer: Omit<Pointer, "version">): string | null {
	const value = `${VERSION} ${pointer.url} ${pointer.key} ${pointer.changedAt}`;

	if (pointer.url.includes(" ") || new TextEncoder().encode(value).length > MAX_POINTER_BYTES) {
		return null;
	}

	return value;
}

/**
 * Whether a file's URL is one a device fetches: on the home network's own
 * file host and nowhere else, over https (plain http only where that host
 * itself is plain http, which a client takes on an unencrypted connection
 * alone: a development server).
 */
export function acceptableUrl(url: string, filehost: string | undefined): boolean {
	if (!filehost) {
		return false;
	}

	let file: URL;
	let host: URL;

	try {
		file = new URL(url);
		host = new URL(filehost);
	} catch {
		return false;
	}

	if (file.protocol !== "https:" && !(file.protocol === "http:" && host.protocol === "http:")) {
		return false;
	}

	return (
		file.username === "" &&
		file.password === "" &&
		normalizeHost(file.hostname) === normalizeHost(host.hostname) &&
		file.port === host.port
	);
}

function toBase64Url(bytes: Uint8Array): string {
	let binary = "";

	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}

	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
	const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
	const bytes = new Uint8Array(binary.length);

	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}

	return bytes;
}

/** Read `stream` to the end; past `limit` bytes it stops with `too-large`. */
async function drain(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;

	for (;;) {
		const {done, value} = await reader.read();

		if (done) {
			break;
		}

		total += value.byteLength;

		if (total > limit) {
			await reader.cancel().catch(() => undefined);
			throw new FileError("too-large");
		}

		chunks.push(value);
	}

	const out = new Uint8Array(total);
	let at = 0;

	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.byteLength;
	}

	return out;
}

function through(
	bytes: Uint8Array,
	stream: GenericTransformStream,
	limit: number
): Promise<Uint8Array> {
	return drain(
		new Blob([bytes as BlobPart]).stream().pipeThrough(stream) as ReadableStream<Uint8Array>,
		limit
	);
}

/** Whether this browser can make and read the file at all. */
export function fileSupported(): boolean {
	return (
		typeof CompressionStream !== "undefined" &&
		typeof DecompressionStream !== "undefined" &&
		typeof crypto !== "undefined" &&
		typeof crypto.subtle !== "undefined"
	);
}

function aesKey(raw: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, [usage]);
}

/** Pack and encrypt `doc` under a fresh key. Throws `too-large` over a limit. */
export async function seal(doc: SyncDocument): Promise<{bytes: Uint8Array; key: string}> {
	if (!fileSupported()) {
		throw new FileError("unsupported");
	}

	const json = new TextEncoder().encode(JSON.stringify(doc));

	if (json.byteLength > MAX_UNPACKED_BYTES) {
		throw new FileError("too-large");
	}

	const packed = await through(json, new CompressionStream("gzip"), MAX_FILE_BYTES);
	const raw = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const sealed = new Uint8Array(
		await crypto.subtle.encrypt(
			{name: "AES-GCM", iv, additionalData: ASSOCIATED},
			await aesKey(raw, "encrypt"),
			packed as BufferSource
		)
	);

	if (IV_BYTES + sealed.byteLength > MAX_FILE_BYTES) {
		throw new FileError("too-large");
	}

	const bytes = new Uint8Array(IV_BYTES + sealed.byteLength);
	bytes.set(iv, 0);
	bytes.set(sealed, IV_BYTES);
	return {bytes, key: toBase64Url(raw)};
}

/** Decrypt and unpack a file made by {@link seal}; throws a {@link FileError}. */
export async function open(bytes: Uint8Array, key: string): Promise<SyncDocument> {
	if (!fileSupported()) {
		throw new FileError("unsupported");
	}

	if (bytes.byteLength > MAX_FILE_BYTES) {
		throw new FileError("too-large");
	}

	let packed: Uint8Array;

	try {
		packed = new Uint8Array(
			await crypto.subtle.decrypt(
				{
					name: "AES-GCM",
					iv: bytes.subarray(0, IV_BYTES) as BufferSource,
					additionalData: ASSOCIATED,
				},
				await aesKey(fromBase64Url(key), "decrypt"),
				bytes.subarray(IV_BYTES) as BufferSource
			)
		);
	} catch {
		throw new FileError("damaged");
	}

	let json: Uint8Array;

	try {
		json = await through(packed, new DecompressionStream("gzip"), MAX_UNPACKED_BYTES);
	} catch (e) {
		throw e instanceof FileError ? e : new FileError("damaged");
	}

	try {
		return parseDocument(JSON.parse(new TextDecoder().decode(json)));
	} catch (e) {
		throw new FileError(
			e instanceof DocumentError && e.code === "newer-version" ? "newer-version" : "damaged"
		);
	}
}

/** A download that did not give a file. `gone`: the host no longer has it. */
export class DownloadError extends Error {
	readonly gone: boolean;

	constructor(message: string, gone = false) {
		super(message);
		this.gone = gone;
	}
}

/**
 * Fetch a file, stopping past {@link MAX_FILE_BYTES}. Sent with nothing of
 * the page's: no credentials, no referrer.
 */
export async function download(url: string, doFetch: typeof fetch): Promise<Uint8Array> {
	let response: Response;

	try {
		response = await doFetch(url, {
			credentials: "omit",
			referrerPolicy: "no-referrer",
			cache: "no-store",
		});
	} catch (e) {
		throw new DownloadError(e instanceof Error ? e.message : String(e));
	}

	if (!response.ok) {
		throw new DownloadError(
			`HTTP ${response.status}`,
			response.status === 404 || response.status === 410
		);
	}

	const length = Number(response.headers.get("Content-Length") ?? "0");

	if (length > MAX_FILE_BYTES) {
		throw new FileError("too-large");
	}

	if (!response.body) {
		const bytes = new Uint8Array(await response.arrayBuffer());

		if (bytes.byteLength > MAX_FILE_BYTES) {
			throw new FileError("too-large");
		}

		return bytes;
	}

	return drain(response.body as ReadableStream<Uint8Array>, MAX_FILE_BYTES);
}

/** An upload the host refused. */
export class UploadRefused extends Error {
	readonly status: number;
	/** How long the host asked us to wait (a 429), in ms. */
	readonly retryAfterMs: number | null;

	constructor(status: number, retryAfterMs: number | null) {
		super(`HTTP ${status}`);
		this.status = status;
		this.retryAfterMs = retryAfterMs;
	}
}

/** PASTE's filehost.php answers a 429 with `Retry-After: 600`, which a
 * cross-origin page cannot read unless the host exposes the header. */
export const DEFAULT_RETRY_AFTER_MS = 600_000;

/**
 * POST a sealed file to the network's file host (`draft/FILEHOST`: the raw
 * body, the `draft/authtoken` token as the bearer) and resolve with its URL.
 */
export async function upload(
	bytes: Uint8Array,
	endpoint: string,
	token: string,
	doFetch: typeof fetch
): Promise<string> {
	const response = await doFetch(endpoint, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/octet-stream",
		},
		body: new Blob([bytes as BlobPart], {type: "application/octet-stream"}),
		credentials: "omit",
		referrerPolicy: "no-referrer",
	});

	if (!response.ok) {
		const seconds = Number(response.headers.get("Retry-After") ?? "");
		const asked = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
		throw new UploadRefused(
			response.status,
			response.status === 429 ? asked ?? DEFAULT_RETRY_AFTER_MS : asked
		);
	}

	const location = response.headers.get("Location");

	if (location) {
		try {
			return new URL(location, endpoint).toString();
		} catch {
			// Fall through to the body.
		}
	}

	try {
		const body: unknown = JSON.parse(await response.text());
		const url = (body as {url?: unknown} | null)?.url;

		if (typeof url === "string") {
			return new URL(url, endpoint).toString();
		}
	} catch {
		// No URL anywhere.
	}

	throw new UploadRefused(response.status, null);
}
