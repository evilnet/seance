/**
 * WsTransport — IRCv3-over-WebSocket line transport (nefarious2 `ircv3.2-upgrade`,
 * see docs/resources/nefarious2-websocket.md). One IRC line per WebSocket message,
 * no CRLF; inbound frames split defensively; IRC PING answered here; reconnect with
 * capped exponential backoff + jitter; `probe()` for sockets the OS may have killed
 * silently. Nothing else is interpreted — parsing, CAP, ISUPPORT etc. live above this. Uses only the global `WebSocket` (browsers,
 * Node >= 22); inject a constructor via `WebSocketImpl` for tests.
 *
 * The retry schedule spaces *automatic* retries. Anything that asks for a
 * connection from outside — `connect()` from the foreground poke or a click,
 * `redial()`, a socket lost while `probe()` was waiting for the answer —
 * restarts it: the user is at the screen, and the delay that had built up
 * while the app was away (up to the cap) is not theirs to wait out. A
 * connection that stayed up past STABLE_CONNECTION_MS restarts it too.
 * Waits at the cap never fall under three quarters of it: nefarious2's
 * IPcheck refuses the fourth connection from an address when each gap is
 * 40 s or less (IPCHECK_CLONE_LIMIT / _PERIOD) and a refusal renews the
 * window, so a cadence under 40 s could never get back in.
 *
 * The server's connection throttle is the server's to report, not ours to
 * model (docs/projects/reconnect-throttle.md). A server that says it
 * throttled us (`ERROR … throttled`, handlers/error.ts → {@link
 * WsTransport.throttled}) gets the wait it names, or {@link
 * UNREACHED_RETRY_MS}. One that refuses us before the WebSocket opens says
 * nothing a page can read, and neither does a network that is not ready
 * yet, which is far more common: a dial that fails before it opens is
 * retried quickly ({@link QUICK_RETRY_MS}), and after those
 * {@link UNREACHED_RETRY_MS} and a little jitter pass before the next
 * automatic one: past the 40 s window, so a refused dial cannot keep the
 * server's window open. Those long waits are {@link WsTransport.holding}:
 * the foreground poke leaves them be, and only Connect now cuts them.
 *
 * IPcheck counts per address, not per dialer: two networks or tabs on one
 * host whose long waits interleave would keep the window open for each
 * other. So every dial notes its time per host in localStorage
 * ({@link LAST_DIAL_KEY}, shared by the page's networks and its tabs), and
 * a long wait for a dial that never opened ends no sooner than
 * {@link UNREACHED_RETRY_MS} after the host's last dial, whoever made it.
 */

/**
 * The part of `WebSocket` that {@link WsTransport} uses, and all a socket
 * underneath it has to provide: the browser's `WebSocket` is one, the app
 * shell's TCP socket (shellSocket.ts) another.
 */
import type {UntrustedCertificate} from "./shellSocket";
import storage from "../localStorage";

export interface LineSocket {
	readonly readyState: number;
	readonly OPEN: number;
	readonly protocol: string;
	binaryType: string;
	addEventListener(type: "open", listener: () => void): void;
	addEventListener(type: "message", listener: (ev: {data: unknown}) => void): void;
	addEventListener(type: "error", listener: (ev: unknown) => void): void;
	addEventListener(
		type: "close",
		// `final`: a failure the next dial would repeat (ShellSocket's
		// untrusted certificate); no retry. A WebSocket never sets it.
		listener: (ev: {code: number; reason: string; wasClean: boolean; final?: boolean}) => void
	): void;
	send(data: string): void;
	close(code?: number, reason?: string): void;
}

export type LineSocketCtor = new (url: string, protocols?: string | string[]) => LineSocket;

export interface ReconnectOptions {
	enabled: boolean;
	initialDelayMs: number;
	maxDelayMs: number;
	factor: number;
	jitter: boolean;
}

export interface TransportOptions {
	url: string;
	/** Offered `Sec-WebSocket-Protocol` list. Default `["text.ircv3.net"]`. */
	subprotocols?: string[];
	/** Default: enabled, 1 s → 60 s, ×2, with jitter. */
	reconnect?: ReconnectOptions;
	/**
	 * Max UTF-8 bytes per outbound line. Default 500: IRC's own limit is 512
	 * and nefarious2 rejects a longer message body as excess flood (it also
	 * used to drop the connection on frames >= 528 bytes, #98, fixed 2026-08-28).
	 */
	maxLineBytes?: number;
	/** Socket constructor to use instead of `globalThis.WebSocket`. */
	WebSocketImpl?: LineSocketCtor;
}

/** Why a retry waits, when it is not the schedule's own wait. */
export type RetryReason = "throttled" | "offline";

export type TransportEvent =
	| {type: "open"; subprotocol: string}
	| {type: "line"; line: string}
	| {
			type: "close";
			code: number;
			reason: string;
			wasClean: boolean;
			willReconnect: boolean;
			delayMs?: number;
	  }
	// `certificate`: the app shell refused the server's certificate (ShellSocket).
	| {type: "error"; message: string; certificate?: UntrustedCertificate}
	// `reason`: the server said it throttled us, or the device has no network.
	| {
			type: "reconnecting";
			attempt: number;
			delayMs: number;
			reason?: RetryReason;
			// A long wait pushed back past another dial to the same host.
			spaced?: boolean;
	  }
	// The scheduled retry is starting now (its wait from "reconnecting" is over).
	| {type: "retry"; attempt: number};

export type TransportState = "closed" | "connecting" | "open" | "reconnect-wait";

/** The device reports no network (`navigator.onLine`; only its false is trustworthy). */
export function isOffline(): boolean {
	return (globalThis.navigator as {onLine?: boolean} | undefined)?.onLine === false;
}

const DEFAULTS = {
	subprotocols: ["text.ircv3.net"],
	reconnect: {enabled: true, initialDelayMs: 1000, maxDelayMs: 60_000, factor: 2, jitter: true},
	maxLineBytes: 500,
};
const STABLE_CONNECTION_MS = 30_000; // open at least this long → backoff resets
const MAX_ATTEMPTS = 100; // the attempt counter stops growing here
export const PROBE_TIMEOUT_MS = 10_000; // probe(): no inbound data for this long → the socket is dead
/** A dial that has not opened by then is abandoned and retried with the
 * usual backoff: a phone whose radio was off can leave a WebSocket in
 * CONNECTING for a minute or more, during which connect() is a no-op. */
export const CONNECT_TIMEOUT_MS = 15_000;
/**
 * The wait after a dial that never opened, and after a server's throttle
 * that named no wait: nefarious2's IPcheck window (40 s) and a margin, so
 * the next dial is past it whatever refused this one.
 */
export const UNREACHED_RETRY_MS = 42_000;
/** Up to this much is added to {@link UNREACHED_RETRY_MS}: networks and tabs that failed together do not retry together. */
export const UNREACHED_JITTER_MS = 5_000;
/**
 * The wait while the device reports no network (`navigator.onLine` false):
 * the app's `online` event dials as soon as it is back (foreground.ts), so
 * this only backs that up, in case the event never comes.
 */
export const OFFLINE_RETRY_MS = 30_000;
/** The quick retries after dials that failed before opening, before the long wait. */
export const QUICK_RETRY_MS = [1_000, 2_000, 4_000] as const;
/** localStorage key: host name → epoch ms of its last dial, from any network or tab. */
export const LAST_DIAL_KEY = "thelounge.lastDial";
const PING_RE = /^(?:@\S+ )?(?::\S+ )?PING(?: (.*))?$/i; // [tags] [prefix] PING [params]

export class WsTransport {
	private readonly opts: Required<Omit<TransportOptions, "WebSocketImpl">> &
		Pick<TransportOptions, "WebSocketImpl">;
	private readonly listeners = new Set<(ev: TransportEvent) => void>();
	private readonly decoder = new TextDecoder();
	private ws: LineSocket | null = null;
	private _state: TransportState = "closed";
	private attempt = 0;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private closedByUs = false;
	private openedAt: number | null = null; // null = not open (0 is a real fake-clock time)
	/** The server said it throttled us: the retry after this socket waits this long. */
	private throttleMs: number | null = null;
	/** Dials in a row that failed before opening, of the {@link QUICK_RETRY_MS} allowed. */
	private quickFailures = 0;
	/**
	 * The pending retry is a long wait ({@link holding}): the server's
	 * throttle, or the one after dials that never opened, which is also
	 * spaced from the host's other dials ({@link spacingWait}).
	 */
	private hold: "throttled" | "unreached" | null = null;
	private connectingSince = 0;
	private connectTimer: ReturnType<typeof setTimeout> | null = null;
	private probeTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(opts: TransportOptions) {
		this.opts = {...DEFAULTS, ...opts};
	}

	get state(): TransportState {
		return this._state;
	}

	/** Subscribe to transport events; returns the unsubscribe function. */
	on(listener: (ev: TransportEvent) => void): () => void {
		this.listeners.add(listener);
		return () => void this.listeners.delete(listener);
	}

	/**
	 * Open the socket. No-op while connecting/open; in reconnect-wait it
	 * retries now. A request from outside restarts the retry schedule: if
	 * this dial fails, the next wait is the first delay, not the one the
	 * automatic retries had worked up to.
	 */
	connect(): void {
		if (this._state === "connecting" || this._state === "open") {
			return;
		}

		this.attempt = 0;
		this.dial();
	}

	/**
	 * The server said it throttled us (`ERROR … throttled`): the retry after
	 * this socket closes waits `delayMs`, or {@link UNREACHED_RETRY_MS}.
	 */
	throttled(delayMs?: number): void {
		this.throttleMs = delayMs ?? UNREACHED_RETRY_MS;
	}

	/** A long wait is pending: the foreground poke leaves it be, Connect now does not. */
	holding(): boolean {
		return this._state === "reconnect-wait" && this.hold !== null;
	}

	/** Open the socket now, on whatever attempt count the schedule is at. */
	private dial(): void {
		this.clearTimer();
		this.closedByUs = false;
		this.throttleMs = null;
		this.hold = null;
		// A superseded socket's open says nothing about this one.
		this.openedAt = null;
		const Impl: LineSocketCtor | undefined = this.opts.WebSocketImpl ?? globalThis.WebSocket;

		if (typeof Impl !== "function") {
			throw new Error("WsTransport: no WebSocket implementation available");
		}

		this._state = "connecting";
		noteDial(this.opts.url);
		let ws: LineSocket;

		try {
			ws = new Impl(this.opts.url, this.opts.subprotocols);
		} catch (err: unknown) {
			// Synchronous failure (bad URL, blocked port): same path as a failed open.
			this.emit({type: "error", message: errorMessage(err)});
			this.handleClosed(1006, "", false);
			return;
		}

		// Every handler checks `ws === this.ws` so a superseded socket stays silent.
		this.ws = ws;
		this.connectingSince = Date.now();
		this.connectTimer = setTimeout(() => {
			this.connectTimer = null;

			if (ws === this.ws && this._state === "connecting") {
				this.ws = null; // its late events are ignored
				ws.close();
				this.handleClosed(1006, "connect timed out", false, "timeout");
			}
		}, CONNECT_TIMEOUT_MS);
		ws.binaryType = "arraybuffer";
		ws.addEventListener("open", () => {
			if (ws === this.ws) {
				this.clearConnectTimer();
				this._state = "open";
				this.openedAt = Date.now();
				this.emit({type: "open", subprotocol: ws.protocol});
			}
		});
		ws.addEventListener("message", (ev) => {
			if (ws === this.ws) {
				this.handleMessage(ev.data);
			}
		});
		ws.addEventListener("error", (ev) => {
			if (ws === this.ws) {
				const certificate = (ev as {certificate?: UntrustedCertificate} | null)
					?.certificate;
				this.emit({
					type: "error",
					message: errorMessage(ev),
					...(certificate ? {certificate} : {}),
				});
			}
		});
		ws.addEventListener("close", (ev) => {
			if (ws === this.ws) {
				this.ws = null;
				this.handleClosed(ev.code, ev.reason, ev.wasClean, undefined, ev.final === true);
			}
		});
	}

	/** Send one IRC line (no CRLF). RangeError on bad input, Error if not open. */
	send(line: string): void {
		if (/[\r\n\0]/.test(line)) {
			throw new RangeError("WsTransport: line must not contain CR, LF or NUL");
		}

		const bytes = new TextEncoder().encode(line).byteLength;

		if (bytes > this.opts.maxLineBytes) {
			throw new RangeError(
				`WsTransport: line is ${bytes} bytes, limit ${this.opts.maxLineBytes}`
			);
		}

		if (this._state !== "open" || !this.ws) {
			throw new Error("WsTransport: not open");
		}

		this.ws.send(line);
	}

	/**
	 * Ask the server for a sign of life. A backgrounded mobile browser's
	 * socket is often gone without a close event; if nothing arrives within
	 * PROBE_TIMEOUT_MS the socket is dropped and treated like an unclean
	 * close, retried at once as a socket that closed during a probe is. No-op
	 * unless open.
	 */
	probe(timeoutMs = PROBE_TIMEOUT_MS): void {
		if (this._state !== "open" || !this.ws || this.probeTimer !== null) {
			return;
		}

		this.ws.send("PING :probe");
		this.probeTimer = setTimeout(() => {
			this.probeTimer = null;
			const ws = this.ws;

			if (ws && this._state === "open") {
				this.ws = null; // its late close event is ignored
				ws.close();
				this.handleClosed(1006, "no reply to PING", false, "probe");
			}
		}, timeoutMs);
	}

	/** How long the current dial has been in flight (0 unless connecting). */
	connectingForMs(): number {
		return this._state === "connecting" ? Date.now() - this.connectingSince : 0;
	}

	/**
	 * Abandon an in-flight dial and start a fresh one now. For the foreground
	 * poke: a socket left CONNECTING while the OS had the radio off may never
	 * open, and connect() alone would wait for it.
	 */
	redial(): void {
		if (this._state !== "connecting") {
			this.connect();
			return;
		}

		const ws = this.ws;

		this.clearConnectTimer();
		this.ws = null; // the abandoned socket's events are ignored
		this._state = "closed";

		try {
			ws?.close();
		} catch (err: unknown) {
			// a socket that never opened may refuse to close; nothing to do
		}

		this.connect();
	}

	/**
	 * Give up on the current socket (open or still dialling) without giving
	 * up on the connection: it is closed and reported as lost — close code
	 * 1006 with `reason` — and the usual reconnect follows. For a caller
	 * that must not go on with this socket (a SASL exchange that timed out)
	 * but has no reason to stay down. No-op unless connecting or open.
	 */
	abandon(reason: string): void {
		if (this._state !== "connecting" && this._state !== "open") {
			return;
		}

		const ws = this.ws;

		this.ws = null; // its late events are ignored

		try {
			ws?.close();
		} catch (err: unknown) {
			// a socket that never opened may refuse to close; nothing to do
		}

		this.handleClosed(1006, reason, false);
	}

	/** Close deliberately: no reconnect is scheduled for this closure. */
	close(code = 1000, reason = ""): void {
		this.closedByUs = true;
		this.clearTimer();
		this.clearProbe();
		this.clearConnectTimer();
		this._state = "closed";
		this.ws?.close(code, reason); // the "close" event follows asynchronously
	}

	/** Abort a pending reconnect (state becomes "closed"). */
	cancelReconnect(): void {
		this.clearTimer();

		if (this._state === "reconnect-wait") {
			this._state = "closed";
		}
	}

	private handleMessage(data: unknown): void {
		this.clearProbe(); // anything inbound is proof of life
		let text: string;

		if (typeof data === "string") {
			text = data;
		} else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
			text = this.decoder.decode(data); // binary.ircv3.net is still UTF-8 IRC
		} else {
			return; // Blob cannot happen with binaryType = "arraybuffer"
		}

		// Spec says one line per frame; split defensively and drop empties.
		for (const line of text.split(/\r\n|\r|\n/)) {
			if (line.length === 0) {
				continue;
			}

			const ping = PING_RE.exec(line);
			const ws = this.ws;

			if (ping && ws && ws.readyState === ws.OPEN) {
				// Parameter is echoed verbatim, including a leading ":".
				ws.send(ping[1] === undefined ? "PONG" : `PONG ${ping[1]}`);
			}

			this.emit({type: "line", line});
		}
	}

	/** `cause`: the transport gave up itself — a dial that hung, a probe with no answer. */
	private handleClosed(
		code: number,
		reason: string,
		wasClean: boolean,
		cause?: "timeout" | "probe",
		final = false
	): void {
		// A socket that dies while we are probing it (the foreground poke
		// asked "are you alive?" and the OS answered with the close, or
		// nothing answered) is the user waiting at the screen: retry at once.
		const probing = cause === "probe" || this.probeTimer !== null;

		this.clearProbe();
		this.clearConnectTimer();

		// A connection that stayed up restarts the schedule — and so does
		// the probe, whatever the count had reached: a phone whose
		// connections are each shorter than the stable mark would otherwise
		// never see it reset. Either loss earns one immediate retry: that is
		// a phone coming back from the background (or a proxy hiccup), not a
		// server refusing us, and the usual first delay is a second spent
		// staring at the screen. A retry that fails backs off from there.
		const wasStable =
			this.openedAt !== null && Date.now() - this.openedAt >= STABLE_CONNECTION_MS;
		// A dial that failed before it opened may have been the server
		// refusing us (IPcheck, before the WebSocket upgrade, reads as any
		// failure) or a network not ready yet. A refusal comes at once: one
		// that hung until the timeout was the signal, and one made with the
		// radio off never reached a server; both keep the usual backoff.
		const opened = this.openedAt !== null;
		const offline = isOffline();
		const unreached = !opened && cause !== "timeout" && !offline;

		if (opened) {
			this.quickFailures = 0;
		}

		const serverWait = this.throttleMs;
		this.throttleMs = null;

		const atOnce = (wasStable || probing) && serverWait === null;

		if (atOnce) {
			this.attempt = 0;
		}

		this.openedAt = null;
		const retry = !this.closedByUs && !final && this.opts.reconnect.enabled;
		let delayMs: number | undefined;
		let why: RetryReason | undefined;

		if (retry) {
			delayMs = this.nextDelay(); // counts the attempt either way

			if (atOnce) {
				delayMs = 0;
			}

			// The server's own word replaces the schedule (and spends the
			// quick retries); else a dial that never opened is retried
			// quickly, then waits past the window that may have refused it.
			if (serverWait !== null) {
				delayMs = serverWait;
				why = "throttled";
				this.quickFailures = QUICK_RETRY_MS.length;
				this.hold = "throttled";
			} else if (unreached && this.quickFailures < QUICK_RETRY_MS.length) {
				delayMs = QUICK_RETRY_MS[this.quickFailures++];
			} else if (unreached) {
				delayMs = UNREACHED_RETRY_MS + Math.round(Math.random() * UNREACHED_JITTER_MS);
				this.hold = "unreached";
			} else if (offline) {
				// Nothing to retry until the network is back: the `online` poke dials then.
				delayMs = OFFLINE_RETRY_MS;
				why = "offline";
			}
		}

		this._state = retry ? "reconnect-wait" : "closed";
		this.emit({type: "close", code, reason, wasClean, willReconnect: retry, delayMs});

		// A close listener may have called close(): then no retry is wanted.
		if (delayMs !== undefined && this._state === "reconnect-wait") {
			this.scheduleRetry(delayMs, why);
		}
	}

	/** Wait `delayMs`, then dial. */
	private scheduleRetry(delayMs: number, reason?: RetryReason, spaced = false): void {
		this._state = "reconnect-wait";
		this.emit({
			type: "reconnecting",
			attempt: this.attempt,
			delayMs,
			...(reason ? {reason} : {}),
			...(spaced ? {spaced} : {}),
		});
		this.timer = setTimeout(() => {
			this.timer = null;
			const spacing = this.spacingWait();

			if (spacing > 0) {
				this.scheduleRetry(spacing, reason, true);
				return;
			}

			this.emit({type: "retry", attempt: this.attempt});

			// A retry listener may have closed this transport (an STS
			// policy took the dial to another one): then it does not dial.
			if (this._state === "reconnect-wait") {
				this.dial();
			}
		}, delayMs);
	}

	/**
	 * How much longer a long wait after unreached dials must run so that it
	 * ends {@link UNREACHED_RETRY_MS} (and jitter) after the host's last
	 * dial, which another network or tab may have made meanwhile; 0 when
	 * it may dial now.
	 */
	private spacingWait(): number {
		if (this.hold !== "unreached") {
			return 0;
		}

		const last = lastDials()[addressOf(this.opts.url)];
		const now = Date.now();

		// (A last dial in the future is a clock that went back: not ours to wait for.)
		if (last === undefined || last > now || now - last >= UNREACHED_RETRY_MS) {
			return 0;
		}

		return last + UNREACHED_RETRY_MS - now + Math.round(Math.random() * UNREACHED_JITTER_MS);
	}

	/**
	 * Exponential backoff; jitter picks uniformly from [3/4 base, base] —
	 * the floor keeps a wait at the 60 s cap above the 40 s clone window
	 * of nefarious2's IPcheck (see the header).
	 */
	private nextDelay(): number {
		const rc = this.opts.reconnect;
		this.attempt = Math.min(this.attempt + 1, MAX_ATTEMPTS);
		const base = Math.min(rc.maxDelayMs, rc.initialDelayMs * rc.factor ** (this.attempt - 1));
		return Math.round(rc.jitter ? base * (0.75 + Math.random() / 4) : base);
	}

	private clearTimer(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	private clearProbe(): void {
		if (this.probeTimer !== null) {
			clearTimeout(this.probeTimer);
			this.probeTimer = null;
		}
	}

	private clearConnectTimer(): void {
		if (this.connectTimer !== null) {
			clearTimeout(this.connectTimer);
			this.connectTimer = null;
		}
	}

	private emit(ev: TransportEvent): void {
		for (const listener of Array.from(this.listeners)) {
			listener(ev);
		}
	}
}

/** The host a dial reaches, as IPcheck's address stands in for it: the URL's host name. */
function addressOf(url: string): string {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch (err: unknown) {
		return url;
	}
}

/** {@link LAST_DIAL_KEY}'s map; empty when unreadable. */
function lastDials(): Record<string, number> {
	let parsed: unknown;

	try {
		parsed = JSON.parse(storage.get(LAST_DIAL_KEY) ?? "{}");
	} catch (err: unknown) {
		return {};
	}

	const result: Record<string, number> = {};

	if (parsed && typeof parsed === "object") {
		for (const [host, at] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof at === "number" && Number.isFinite(at)) {
				result[host] = at;
			}
		}
	}

	return result;
}

/** Note a dial to `url`'s host now; entries too old to delay anyone are dropped. */
function noteDial(url: string): void {
	const now = Date.now();
	const kept: Record<string, number> = {};

	for (const [host, at] of Object.entries(lastDials())) {
		if (now - at < UNREACHED_RETRY_MS) {
			kept[host] = at;
		}
	}

	kept[addressOf(url)] = now;
	storage.set(LAST_DIAL_KEY, JSON.stringify(kept));
}

/** Browser error events carry no message; `ws`/undici ones do. */
function errorMessage(err: unknown): string {
	const msg = (err as {message?: unknown} | null)?.message;
	return typeof msg === "string" && msg.length > 0 ? msg : "WebSocket error";
}
