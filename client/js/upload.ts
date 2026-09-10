// File uploads.
//
// TheLounge uploaded to its own Node server (`POST /uploads/new/<token>`).
// Seance has no server, so the file goes straight from the browser to an
// uploader the network runs itself, configured per deploy through
// `uploads` in `config.json` (see docs/resources/branding.md). Without that
// entry the upload button stays hidden and dropped/pasted files are ignored
// after a single "not configured" notice.
//
// Every way in (a drop, a paste, the paperclip's file dialog) lands in
// `Uploader.triggerUpload`, which checks size and type, then shows the files
// to the user through `UploadHost.confirm` (the preview dialog,
// `UploadPreview.vue`) and sends only what they keep. Progress goes out
// through `UploadHost.progress` (the strip above the input in
// `ChatInput.vue`); the request itself rides on `XMLHttpRequest`, the one
// browser API with upload progress events, wrapped back into a `Response`
// so the reply is read the same way whatever carried it.

import {update as updateCursor} from "undate";

import {ChanType} from "../../shared/types/chan";
import {BrandingUploads, DEFAULT_UPLOAD_MAX_BYTES} from "./branding";
import eventbus from "./eventbus";
import {isAnimatedImage} from "./helpers/animatedImage";
import {FILEHOST_SERVICE} from "./irc/authtoken";
import type {IrcClient} from "./irc/client";
import type {TypedStore} from "./store";

export const UPLOADS_NOT_CONFIGURED = "File uploads are not configured in this client.";

/** Where an upload in flight stands; `null` on the host means idle. */
export interface UploadProgress {
	fileName: string;
	/** 1-based position in the current run of uploads, and the run's size. */
	index: number;
	count: number;
	/**
	 * `preparing`: the image is being re-encoded; `sending`: bytes are going
	 * out; `waiting`: everything is sent and the reply is awaited.
	 */
	phase: "preparing" | "sending" | "waiting";
	/** Bytes sent and bytes to send; both 0 while preparing. */
	loaded: number;
	total: number;
}

/**
 * The network's own upload host (IRCv3 `draft/FILEHOST` + `draft/authtoken`,
 * `irc/authtoken.ts`): where to POST, and how to get the one-shot token
 * the request must carry. Chosen over the deploy's `uploads` config when
 * the connected network advertises one — it is the network's service and
 * the upload is attributed to the user's account, with no credentials
 * involved.
 */
export interface FilehostSource {
	/** Absolute URL the file is POSTed to (`draft/FILEHOST` ISUPPORT). */
	endpoint: string;
	/** The channel (or nick) the upload is for; the token is scoped to it. */
	scope?: string;
	/** `TOKEN GENERATE FILEHOST [scope]` on the network; rejects with the FAIL's text. */
	generate(scope?: string): Promise<string>;
}

/** Everything the uploader needs from the app, so it can run without the store. */
export interface UploadHost {
	/** Uploader config from branding; `undefined` when uploads are off. */
	uploads(): BrandingUploads | undefined;
	/** The current network's upload host, when it advertises one (takes precedence). */
	filehost?(): FilehostSource | undefined;
	isConnected(): boolean;
	/** Re-encode images through a canvas before upload (strips EXIF). */
	renderCanvas(): boolean;
	showError(message: string): void;
	insertUrl(url: string): void;
	/**
	 * Show `files` to the user and resolve with the ones they want sent, in
	 * order; an empty list cancels the lot.
	 */
	confirm(files: File[]): Promise<File[]>;
	/** Progress of the upload in flight; `null` once the queue is empty. */
	progress(state: UploadProgress | null): void;
}

/** The dialog's request on the event bus: `upload:confirm`. */
export interface UploadConfirmRequest {
	files: File[];
	/** Called once with the files to send; `[]` cancels. */
	resolve: (files: File[]) => void;
	/** Set by the dialog, synchronously, so a missing dialog fails open. */
	claimed: boolean;
}

export class UploadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UploadError";
	}
}

/** `XMLHttpRequest`, or a stand-in with the same shape (tests). */
export type XhrConstructor = new () => XMLHttpRequest;

export interface UploadFileOptions {
	/**
	 * Fetch implementation. When given it carries the request; otherwise an
	 * `XMLHttpRequest` (`xhr`, or the global one) does, for its progress
	 * events, and the global `fetch` is the last resort.
	 */
	fetch?: typeof fetch;
	/** `XMLHttpRequest` class to use instead of the global one. */
	xhr?: XhrConstructor;
	/**
	 * Upload progress, in bytes; only an XHR transport reports it. Asking for
	 * it makes the browser preflight the request (see `xhrFetch`).
	 */
	onProgress?: (loaded: number, total: number) => void;
	/**
	 * The endpoint refused the preflight that progress events require, and
	 * the upload was retried as a plain POST without them. Callers remember
	 * this so later uploads to the same endpoint skip the doomed preflight.
	 */
	onProgressUnavailable?: () => void;
	signal?: AbortSignal;
	/** Names of `config.fields` to leave out of this attempt. */
	omitFields?: ReadonlySet<string>;
}

/** Statuses a `Response` may not carry a body with. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * `fetch(url, init)` over an `XMLHttpRequest`, for the upload progress
 * events fetch does not have. Honours `method`, `headers` (a plain record),
 * `credentials: "include"`, `body` and `signal`, and resolves with a
 * `Response` built from the status and text; a network failure rejects with
 * the same `TypeError("Failed to fetch")` fetch throws, an abort with an
 * `AbortError`.
 *
 * The upload listener is attached only when `onProgress` is given: an XHR
 * with upload listeners is never a "simple" request, so the browser sends a
 * CORS preflight (`OPTIONS`) first — which uploaders built for curl and
 * ShareX do not answer (litterbox says 405) — and the request dies before a
 * byte goes out. Without the listener the multipart POST needs no preflight.
 */
export function xhrFetch(
	url: string,
	init: RequestInit,
	options: {XHR: XhrConstructor; onProgress?: (loaded: number, total: number) => void}
): Promise<Response> {
	return new Promise((resolve, reject) => {
		const abortError = () => new DOMException("The operation was aborted.", "AbortError");

		if (init.signal?.aborted) {
			reject(abortError());
			return;
		}

		const xhr = new options.XHR();
		xhr.open(init.method ?? "GET", url);
		xhr.withCredentials = init.credentials === "include";

		for (const [name, value] of Object.entries(init.headers ?? {})) {
			xhr.setRequestHeader(name, value);
		}

		const {onProgress} = options;

		if (onProgress !== undefined) {
			xhr.upload.onprogress = (event) => {
				if (event.lengthComputable) {
					onProgress(event.loaded, event.total);
				}
			};
		}

		xhr.onload = () => {
			const status = xhr.status;

			if (status < 200 || status > 599) {
				reject(new TypeError("Failed to fetch"));
				return;
			}

			const body = NULL_BODY_STATUSES.has(status) ? null : xhr.responseText;
			resolve(new Response(body, {status, statusText: xhr.statusText}));
		};

		xhr.onerror = () => reject(new TypeError("Failed to fetch"));
		xhr.ontimeout = () => reject(new TypeError("Failed to fetch"));
		xhr.onabort = () => reject(abortError());

		init.signal?.addEventListener("abort", () => xhr.abort(), {once: true});

		xhr.send((init.body ?? null) as XMLHttpRequestBodyInit | null);
	});
}

/**
 * `xhrFetch` with the progress fallback: a request that fails before any
 * progress event was seen is retried without the upload listener — that is
 * what a refused preflight looks like, and the plain POST needs none — and
 * `onProgressUnavailable` tells the caller. A failure after bytes went out,
 * or with no progress asked for, is reported as it is.
 */
async function xhrSend(
	url: string,
	init: RequestInit,
	options: UploadFileOptions,
	XHR: XhrConstructor
): Promise<Response> {
	const wanted = options.onProgress;

	if (wanted === undefined) {
		return xhrFetch(url, init, {XHR});
	}

	let progressSeen = false;

	const onProgress = (loaded: number, total: number) => {
		progressSeen = true;
		wanted(loaded, total);
	};

	try {
		return await xhrFetch(url, init, {XHR, onProgress});
	} catch (e: unknown) {
		if (progressSeen || !(e instanceof TypeError)) {
			throw e;
		}

		options.onProgressUnavailable?.();

		return xhrFetch(url, init, {XHR});
	}
}

/** Effective size limit for a config, in bytes. */
export function uploadMaxSize(config: BrandingUploads | undefined): number {
	return config?.maxSizeBytes ?? DEFAULT_UPLOAD_MAX_BYTES;
}

/**
 * Whether `type` is one the endpoint takes. Entries are exact MIME types or
 * `type/*` wildcards; no `accept` list at all means anything goes.
 */
export function acceptsType(config: BrandingUploads, type: string): boolean {
	if (!config.accept?.length) {
		return true;
	}

	const actual = type.toLowerCase();

	return config.accept.some((entry) => {
		const allowed = entry.trim().toLowerCase();

		return allowed.endsWith("/*")
			? actual.startsWith(allowed.slice(0, -1))
			: allowed === actual;
	});
}

/** Build the multipart `POST` for `file` as the configured endpoint expects it. */
export function buildUploadRequest(
	file: File,
	config: BrandingUploads,
	omitFields: ReadonlySet<string> = new Set()
): RequestInit {
	const body = new FormData();
	body.append(config.fieldName ?? "file", file, file.name);

	for (const [name, value] of Object.entries(config.fields ?? {})) {
		if (!omitFields.has(name)) {
			body.append(name, value);
		}
	}

	const headers: Record<string, string> = {};

	for (const [name, value] of Object.entries(config.headers ?? {})) {
		// The browser must set the multipart boundary itself.
		if (name.toLowerCase() !== "content-type") {
			headers[name] = value;
		}
	}

	return {
		method: "POST",
		body,
		headers,
		credentials: config.withCredentials ? "include" : "omit",
		mode: "cors",
	};
}

function absoluteUrl(candidate: string, base: string): string | undefined {
	try {
		const url = new URL(candidate.trim(), base);
		return /^https?:$/.test(url.protocol) ? url.href : undefined;
	} catch (e) {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The string at `path` in a parsed JSON body, or `undefined`.
 *
 * A plain top-level key is tried first, so a key that happens to contain a
 * dot keeps working; otherwise the path is split and walked through objects
 * and arrays alike (`results.0.filePath`).
 */
export function lookupResponsePath(body: unknown, path: string): string | undefined {
	const literal: unknown = isRecord(body) ? body[path] : undefined;

	if (typeof literal === "string") {
		return literal;
	}

	let value: unknown = body;

	for (const segment of path.split(".")) {
		if (Array.isArray(value)) {
			const index = Number(segment);
			value = Number.isInteger(index) ? value[index] : undefined;
		} else if (isRecord(value)) {
			value = value[segment];
		} else {
			return undefined;
		}
	}

	return typeof value === "string" ? value : undefined;
}

/** The uploader's own failure message for a parsed body, if it gave one. */
function responseError(body: unknown, config: BrandingUploads): string | undefined {
	const message = lookupResponsePath(body, config.responseErrorKey ?? "error");
	return message !== undefined && message.length > 0 ? message : undefined;
}

/**
 * Extract the public URL from an uploader response body: JSON at the
 * configured key or path (default `url`), or a plain-text body that is a URL.
 * Relative URLs resolve against the endpoint. Throws `UploadError` otherwise.
 */
export function parseUploadResponse(body: string, config: BrandingUploads): string {
	const key = config.responseUrlKey ?? "url";
	let parsed: unknown;

	try {
		parsed = JSON.parse(body);
	} catch (e) {
		parsed = undefined;
	}

	if (isRecord(parsed) || Array.isArray(parsed)) {
		const value = lookupResponsePath(parsed, key);

		if (value !== undefined) {
			const url = absoluteUrl(value, config.endpoint);

			if (url !== undefined) {
				return url;
			}
		}

		const message = responseError(parsed, config);

		if (message !== undefined) {
			throw new UploadError(message);
		}

		throw new UploadError(`Upload failed: the uploader did not return a "${key}" URL`);
	}

	if (typeof parsed === "string") {
		body = parsed;
	}

	const url = /^\s*https?:\/\/\S+\s*$/i.test(body)
		? absoluteUrl(body, config.endpoint)
		: undefined;

	if (url === undefined) {
		throw new UploadError("Upload failed: the uploader did not return a URL");
	}

	return url;
}

/**
 * Which of the config's `optionalFields` this error message blames, so the
 * upload can be retried without them.
 *
 * The name is matched by its words, since a service complains about "EXIF
 * metadata" rather than about `strip_exif` — the same heuristic poxchat uses
 * for its own strip fallback.
 */
export function fieldsBlamedBy(
	message: string,
	config: BrandingUploads,
	alreadyOmitted: ReadonlySet<string> = new Set()
): string[] {
	const text = message.toLowerCase();

	return (config.optionalFields ?? []).filter((name) => {
		if (alreadyOmitted.has(name) || config.fields?.[name] === undefined) {
			return false;
		}

		return name
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.some((word) => word.length >= 3 && text.includes(word));
	});
}

/**
 * Upload one file and resolve with its public URL; rejects with
 * `UploadError`. An upload the server refuses on account of an optional form
 * field is retried without it.
 */
export async function uploadFile(
	file: File,
	config: BrandingUploads,
	options: UploadFileOptions = {}
): Promise<string> {
	const omitFields = new Set(options.omitFields ?? []);

	for (;;) {
		try {
			return await uploadAttempt(file, config, {...options, omitFields});
		} catch (e: unknown) {
			// Each pass drops at least one field, so this terminates.
			const blamed =
				e instanceof UploadError ? fieldsBlamedBy(e.message, config, omitFields) : [];

			if (blamed.length === 0) {
				throw e;
			}

			for (const name of blamed) {
				omitFields.add(name);
			}
		}
	}
}

/** One `POST` of `file`, without the retry. */
async function uploadAttempt(
	file: File,
	config: BrandingUploads,
	options: UploadFileOptions
): Promise<string> {
	const XHR = options.xhr ?? (typeof XMLHttpRequest === "function" ? XMLHttpRequest : undefined);
	let doFetch: typeof fetch | undefined = options.fetch;

	if (doFetch === undefined && XHR !== undefined) {
		doFetch = (url, init) => xhrSend(String(url), init ?? {}, options, XHR);
	}

	if (doFetch === undefined && typeof fetch === "function") {
		doFetch = fetch;
	}

	if (doFetch === undefined) {
		throw new UploadError("Upload failed: fetch is not available");
	}

	const init: RequestInit = {
		...buildUploadRequest(file, config, options.omitFields),
		signal: options.signal,
	};
	let response: Response;

	try {
		response = await doFetch(config.endpoint, init);
	} catch (e: unknown) {
		if (e instanceof Error && e.name === "AbortError") {
			throw new UploadError("Upload cancelled");
		}

		const reason = e instanceof Error ? e.message : String(e);
		throw new UploadError(`Upload failed: ${reason}`);
	}

	let body = "";

	try {
		body = await response.text();
	} catch (e) {
		body = "";
	}

	if (!response.ok) {
		let message = `Upload failed: HTTP ${response.status}`;

		try {
			message = responseError(JSON.parse(body), config) ?? message;
		} catch (e) {
			// Not JSON; keep the status line.
		}

		throw new UploadError(message);
	}

	return parseUploadResponse(body, config);
}

/**
 * Upload `file` to the network's own host (`draft/FILEHOST`): a
 * `TOKEN GENERATE` on the IRC connection for a one-shot bearer token, then
 * the raw file as the POST body with `Content-Type`,
 * `Content-Disposition` and `Authorization: Bearer`, answered by
 * `201 Created` + `Location` (the draft) or a JSON `url` (paste hosts).
 * Resolves with the public URL; rejects with `UploadError`.
 *
 * The `Authorization` header makes every such request a preflighted one,
 * so the host must answer `OPTIONS` (the draft requires it) — there is no
 * plain-POST fallback here, unlike the multipart uploaders.
 */
export async function uploadFilehost(
	file: File,
	source: FilehostSource,
	options: UploadFileOptions = {}
): Promise<string> {
	let token: string;

	try {
		token = await source.generate(source.scope);
	} catch (e: unknown) {
		const reason = e instanceof Error ? e.message : String(e);
		throw new UploadError(`Upload refused by the network: ${reason}`);
	}

	const XHR = options.xhr ?? (typeof XMLHttpRequest === "function" ? XMLHttpRequest : undefined);
	let doFetch: typeof fetch | undefined = options.fetch;

	if (doFetch === undefined && XHR !== undefined) {
		doFetch = (url, init) =>
			xhrFetch(String(url), init ?? {}, {XHR, onProgress: options.onProgress});
	}

	if (doFetch === undefined && typeof fetch === "function") {
		doFetch = fetch;
	}

	if (doFetch === undefined) {
		throw new UploadError("Upload failed: fetch is not available");
	}

	const headers: Record<string, string> = {
		Authorization: `Bearer ${token}`,
		"Content-Type": file.type || "application/octet-stream",
	};

	if (file.name) {
		// RFC 6266: a quoted ASCII name plus the UTF-8 form for the rest.
		const ascii = file.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
		headers[
			"Content-Disposition"
		] = `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`;
	}

	let response: Response;

	try {
		response = await doFetch(source.endpoint, {
			method: "POST",
			headers,
			body: file,
			signal: options.signal,
		});
	} catch (e: unknown) {
		if (e instanceof Error && e.name === "AbortError") {
			throw new UploadError("Upload cancelled");
		}

		const reason = e instanceof Error ? e.message : String(e);
		throw new UploadError(`Upload failed: ${reason}`);
	}

	let body = "";

	try {
		body = await response.text();
	} catch (e) {
		body = "";
	}

	if (!response.ok) {
		let message = `Upload failed: HTTP ${response.status}`;

		try {
			const parsed: unknown = JSON.parse(body);
			const text = isRecord(parsed) ? parsed.message ?? parsed.error : undefined;

			if (typeof text === "string" && text.length > 0) {
				message = `Upload failed: ${text}`;
			}
		} catch (e) {
			// Not JSON; keep the status line.
		}

		throw new UploadError(message);
	}

	const location = response.headers.get("Location");
	const fromHeader = location ? absoluteUrl(location, source.endpoint) : undefined;

	if (fromHeader !== undefined) {
		return fromHeader;
	}

	// No Location we can read (an opaque CORS response, or a host that only
	// answers with JSON): the body's `url`, as the multipart path reads it.
	return parseUploadResponse(body, {endpoint: source.endpoint});
}

/**
 * What the "remove metadata" setting will do to `file`: `strip` (redrawn
 * through a canvas), `off` (setting off), `animated` (an animated WebP, APNG
 * or AVIF: the canvas would keep one frame, so it goes up whole),
 * `unsupported` (GIF and SVG, likewise sent as they are) or `not-image`.
 */
export type MetadataPlan = "strip" | "off" | "animated" | "unsupported" | "not-image";

export async function metadataPlan(file: File, stripSetting: boolean): Promise<MetadataPlan> {
	const type = file.type.toLowerCase();

	if (!type.startsWith("image/")) {
		return "not-image";
	}

	if (type.includes("svg") || type === "image/gif") {
		return "unsupported";
	}

	if (await isAnimatedImage(file)) {
		return "animated";
	}

	return stripSetting ? "strip" : "off";
}

/** Extensions a canvas-encoded blob's type can come back as, first is canonical. */
const EXTENSIONS_BY_TYPE: Readonly<Record<string, readonly string[]>> = {
	"image/png": ["png"],
	"image/jpeg": ["jpg", "jpeg"],
	"image/webp": ["webp"],
};

/**
 * `name` with an extension matching `type`, for a re-encoded image. A canvas
 * asked for a format it cannot write answers with PNG (Safari for WebP,
 * every browser for AVIF), and the file should not claim otherwise. Unknown
 * types and names that already fit are left alone.
 */
export function fileNameForType(name: string, type: string): string {
	const extensions = EXTENSIONS_BY_TYPE[type.toLowerCase()];

	if (extensions === undefined) {
		return name;
	}

	const dot = name.lastIndexOf(".");
	const hasExtension = dot > 0 && dot < name.length - 1;
	const current = hasExtension ? name.slice(dot + 1).toLowerCase() : "";

	if (extensions.includes(current)) {
		return name;
	}

	return `${hasExtension ? name.slice(0, dot) : name}.${extensions[0]}`;
}

/** Insert `url` at the cursor of the chat input, padded with spaces. */
export function insertUploadUrl(url: string): void {
	const textbox = document.getElementById("input");

	if (!(textbox instanceof HTMLTextAreaElement)) {
		throw new Error("Could not find textbox in upload");
	}

	const initStart = textbox.selectionStart;

	// Get the text before the cursor, and add a space if it's not in the beginning
	const headToCursor = initStart > 0 ? textbox.value.substring(0, initStart) + " " : "";

	// Get the remaining text after the cursor
	const cursorToTail = textbox.value.substring(initStart);

	// Construct the value until the point where we want the cursor to be
	const textBeforeTail = headToCursor + url + " ";

	updateCursor(textbox, textBeforeTail + cursorToTail);

	// Set the cursor after the link and a space
	textbox.selectionStart = textbox.selectionEnd = textBeforeTail.length;

	// What gets sent is the store's `channel.pendingMessage`, which follows
	// the textarea's `input` event; the execCommand-based insertion above
	// does not fire one reliably (it depends on what had focus), so say it.
	textbox.dispatchEvent(new Event("input", {bubbles: true}));
}

/**
 * The app's `UploadHost`: branding, connection state and errors via the
 * store; the confirmation through the `upload:confirm` bus event that
 * `UploadPreview.vue` answers, and progress into `store.state.uploadProgress`
 * for the strip in `ChatInput.vue`.
 */
export function storeUploadHost(
	store: TypedStore,
	clientForNetwork: (uuid: string) => IrcClient | undefined = () => undefined
): UploadHost {
	return {
		uploads: () => store.state.branding.uploads,
		filehost() {
			const active = store.state.activeChannel;
			const client = active ? clientForNetwork(active.network.uuid) : undefined;
			const endpoint = client?.filehostUrl();

			if (!client || !endpoint) {
				return undefined;
			}

			const scope =
				active?.channel.type === ChanType.CHANNEL ? active.channel.name : undefined;

			return {
				endpoint,
				scope,
				generate: (s) => client.generateToken(FILEHOST_SERVICE, s),
			};
		},
		isConnected: () => store.state.isConnected,
		renderCanvas: () => store.state.settings.uploadCanvas,
		showError: (message) => store.commit("currentUserVisibleError", message),
		insertUrl: insertUploadUrl,
		confirm: (files) =>
			new Promise((resolve) => {
				const request: UploadConfirmRequest = {files, resolve, claimed: false};
				eventbus.emit("upload:confirm", request);

				// No dialog mounted to ask: behave as before and just send.
				if (!request.claimed) {
					resolve(files);
				}
			}),
		progress: (state) => store.commit("uploadProgress", state),
	};
}

export class Uploader {
	host: UploadHost | null;
	fileQueue: File[] = [];
	/** Controller of the upload in flight, if any. */
	controller: AbortController | null = null;
	fetchImpl: typeof fetch | undefined;
	xhrImpl: XhrConstructor | undefined;
	/** The "not configured" notice is shown once per page, not per drop. */
	warnedUnconfigured = false;

	overlay: HTMLDivElement | null = null;

	private drain: Promise<void> | null = null;
	/** One confirmation dialog at a time: a second drop waits for the first's answer. */
	private confirming: Promise<unknown> = Promise.resolve();
	/** Files sent so far in this run of the queue, and how many it holds in all. */
	private runDone = 0;
	private runCount = 0;
	/**
	 * Endpoints that refused the preflight progress events need (see
	 * `xhrFetch`): later uploads to them go out as plain POSTs at once, and
	 * the strip shows an indeterminate bar. Per page, not persisted.
	 */
	private progressBlocked = new Set<string>();

	onDragEnter = (e: DragEvent) => this.dragEnter(e);
	onDragOver = (e: DragEvent) => this.dragOver(e);
	onDragLeave = (e: DragEvent) => this.dragLeave(e);
	onDrop = (e: DragEvent) => this.drop(e);
	onPaste = (e: ClipboardEvent) => this.paste(e);

	constructor(
		host: UploadHost | null = null,
		fetchImpl?: typeof fetch,
		xhrImpl?: XhrConstructor
	) {
		this.host = host;
		this.fetchImpl = fetchImpl;
		this.xhrImpl = xhrImpl;
	}

	init() {
		// Nothing to subscribe to: uploads go straight to the configured endpoint.
	}

	mounted(host: UploadHost | null = this.host) {
		this.host = host;
		this.overlay = document.getElementById("upload-overlay") as HTMLDivElement;

		document.addEventListener("dragenter", this.onDragEnter);
		document.addEventListener("dragover", this.onDragOver);
		document.addEventListener("dragleave", this.onDragLeave);
		document.addEventListener("drop", this.onDrop);
		document.addEventListener("paste", this.onPaste);
	}

	unmounted() {
		document.removeEventListener("dragenter", this.onDragEnter);
		document.removeEventListener("dragover", this.onDragOver);
		document.removeEventListener("dragleave", this.onDragLeave);
		document.removeEventListener("drop", this.onDrop);
		document.removeEventListener("paste", this.onPaste);
	}

	dragOver(event: DragEvent) {
		if (event.dataTransfer?.types.includes("Files")) {
			// Prevent dragover event completely and do nothing with it
			// This stops the browser from trying to guess which cursor to show
			event.preventDefault();
		}
	}

	dragEnter(event: DragEvent) {
		// relatedTarget is the target where we entered the drag from
		// when dragging from another window, the target is null, otherwise its a DOM element
		if (!event.relatedTarget && event.dataTransfer?.types.includes("Files")) {
			event.preventDefault();

			if (this.host?.uploads() || this.host?.filehost?.()) {
				this.overlay?.classList.add("is-dragover");
			}
		}
	}

	dragLeave(event: DragEvent) {
		// If relatedTarget is null, that means we are no longer dragging over the page
		if (!event.relatedTarget) {
			event.preventDefault();
			this.overlay?.classList.remove("is-dragover");
		}
	}

	drop(event: DragEvent) {
		if (!event.dataTransfer?.types.includes("Files")) {
			return;
		}

		// Always swallow the drop: the browser would otherwise navigate away
		// to the dropped file, configured uploader or not.
		event.preventDefault();
		this.overlay?.classList.remove("is-dragover");

		let files: (File | null)[];

		if (event.dataTransfer.items) {
			files = Array.from(event.dataTransfer.items)
				.filter((item) => item.kind === "file")
				.map((item) => item.getAsFile());
		} else {
			files = Array.from(event.dataTransfer.files);
		}

		void this.triggerUpload(files);
	}

	paste(event: ClipboardEvent) {
		const items = event.clipboardData?.items;
		const files: (File | null)[] = [];

		if (!items) {
			return;
		}

		for (let i = 0; i < items.length; i++) {
			if (items[i].kind === "file") {
				files.push(items[i].getAsFile());
			}
		}

		if (files.length === 0) {
			return;
		}

		event.preventDefault();
		void this.triggerUpload(files);
	}

	/**
	 * Offer files for upload: the ones within the size and type limits are
	 * shown to the user (`host.confirm`) and those they keep are queued.
	 * Resolves once the queue has drained (every file uploaded or reported),
	 * so callers can await the outcome.
	 */
	async triggerUpload(files: (File | null)[]): Promise<void> {
		if (!files.length || !this.host) {
			return;
		}

		const host = this.host;
		// The network's own host wins; the deploy's uploader is the fallback.
		const filehost = host.filehost?.();
		const config = filehost ? undefined : host.uploads();

		if (!config && !filehost) {
			if (!this.warnedUnconfigured) {
				this.warnedUnconfigured = true;
				host.showError(UPLOADS_NOT_CONFIGURED);
			}

			return;
		}

		if (!host.isConnected()) {
			host.showError("You are currently disconnected, unable to initiate upload process.");

			return;
		}

		// A FILEHOST says what it takes only in its OPTIONS reply; the host
		// answers 413/415 itself, so only the deploy's limits apply here.
		const maxFileSize = config ? uploadMaxSize(config) : DEFAULT_UPLOAD_MAX_BYTES;
		const accepted: File[] = [];

		for (const file of files) {
			if (!file) {
				continue;
			}

			if (file.size > maxFileSize) {
				host.showError(`File ${file.name} is over the maximum allowed size`);
				continue;
			}

			// Refuse here rather than letting the endpoint answer: the boxlabs
			// preset points at an image staging service, so a dropped video
			// should say so plainly.
			if (config && !acceptsType(config, file.type)) {
				const acceptedTypes = (config.accept ?? []).join(", ");
				host.showError(
					`File ${file.name} is not a type this uploader accepts (${acceptedTypes})`
				);
				continue;
			}

			accepted.push(file);
		}

		if (accepted.length === 0) {
			return this.drain ?? undefined;
		}

		// Dialogs are serialised so a second drop cannot interleave with the
		// first's; a cancelled one is a resolved, empty list.
		const asked = this.confirming.then(() => host.confirm(accepted));
		this.confirming = asked.catch(() => undefined);
		const chosen = await asked;

		if (chosen.length === 0) {
			return this.drain ?? undefined;
		}

		this.fileQueue.push(...chosen);
		this.runCount += chosen.length;

		if (this.drain === null) {
			this.drain = this.drainQueue().finally(() => {
				this.drain = null;
			});
		}

		return this.drain;
	}

	private async drainQueue(): Promise<void> {
		try {
			let file = this.fileQueue.shift();

			while (file !== undefined) {
				this.runDone += 1;
				await this.uploadOne(file, this.runDone);
				file = this.fileQueue.shift();
			}
		} finally {
			this.runDone = 0;
			this.runCount = 0;
			this.host?.progress(null);
		}
	}

	private async uploadOne(file: File, index: number): Promise<void> {
		const host = this.host;
		const filehost = host?.filehost?.();
		const config = filehost ? undefined : host?.uploads();

		if (!host || (!config && !filehost)) {
			return;
		}

		const controller = new AbortController();
		this.controller = controller;

		const report = (phase: UploadProgress["phase"], loaded: number, total: number) =>
			host.progress({fileName: file.name, index, count: this.runCount, phase, loaded, total});

		try {
			report("preparing", 0, 0);

			if ((await metadataPlan(file, host.renderCanvas())) === "strip") {
				file = await this.renderImage(file);
			}

			let url: string;

			if (filehost) {
				// The draft makes OPTIONS mandatory, so the preflight that
				// progress events (and the Authorization header) need is fine.
				report("sending", 0, file.size);
				url = await uploadFilehost(file, filehost, {
					fetch: this.fetchImpl,
					xhr: this.xhrImpl,
					signal: controller.signal,
					onProgress: (loaded, total) =>
						report(loaded >= total ? "waiting" : "sending", loaded, total),
				});
			} else if (config) {
				// No progress for an endpoint that cannot answer the preflight it
				// needs, whether the config said so or this page found out.
				const wantsProgress =
					config.progress !== false && !this.progressBlocked.has(config.endpoint);
				// Total 0 keeps the strip indeterminate when no byte counts will come.
				report("sending", 0, wantsProgress ? file.size : 0);

				url = await uploadFile(file, config, {
					fetch: this.fetchImpl,
					xhr: this.xhrImpl,
					signal: controller.signal,
					onProgress: wantsProgress
						? (loaded, total) =>
								report(loaded >= total ? "waiting" : "sending", loaded, total)
						: undefined,
					onProgressUnavailable: () => {
						this.progressBlocked.add(config.endpoint);
						report("sending", 0, 0);
					},
				});
			} else {
				return;
			}

			host.insertUrl(url);
		} catch (e: unknown) {
			// A cancel the user asked for is not an error to report.
			if (!controller.signal.aborted) {
				host.showError(e instanceof Error ? e.message : String(e));
			}
		} finally {
			if (this.controller === controller) {
				this.controller = null;
			}
		}
	}

	/**
	 * Re-draw an image through a canvas, dropping its metadata; falls back to
	 * the original file. The result carries the type the canvas actually
	 * wrote (a browser that cannot encode the source format answers with
	 * PNG) and an extension to match.
	 */
	renderImage(file: File): Promise<File> {
		return new Promise((resolve) => {
			const fileReader = new FileReader();

			fileReader.onabort = () => resolve(file);
			fileReader.onerror = () => fileReader.abort();

			fileReader.onload = () => {
				const img = new Image();

				img.onerror = () => resolve(file);

				img.onload = () => {
					const canvas = document.createElement("canvas");
					canvas.width = img.width;
					canvas.height = img.height;
					const ctx = canvas.getContext("2d");

					if (!ctx) {
						resolve(file);
						return;
					}

					ctx.drawImage(img, 0, 0);

					canvas.toBlob((blob) => {
						if (!blob) {
							resolve(file);
							return;
						}

						const type = blob.type || file.type;
						resolve(new File([blob], fileNameForType(file.name, type), {type}));
					}, file.type);
				};

				img.src = String(fileReader.result);
			};

			fileReader.readAsDataURL(file);
		});
	}

	abort() {
		this.fileQueue = [];

		if (this.controller) {
			this.controller.abort();
			this.controller = null;
		}
	}
}

const instance = new Uploader();

export default {
	abort: () => instance.abort(),
	initialize: () => instance.init(),
	/**
	 * Attach the drag/drop/paste listeners, reading config and state from
	 * `store`; `clientForNetwork` (irc/manager.ts, which this Vue-free file
	 * must not import) finds the connection a FILEHOST token comes from.
	 */
	mounted: (store: TypedStore, clientForNetwork?: (uuid: string) => IrcClient | undefined) =>
		instance.mounted(storeUploadHost(store, clientForNetwork)),
	unmounted: () => instance.unmounted(),
	triggerUpload: (files: (File | null)[]) => void instance.triggerUpload(files),
};
