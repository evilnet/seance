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
 */

import type {DialGate} from "./dialLedger";

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
	/** WebSocket constructor to use instead of `globalThis.WebSocket`. */
	WebSocketImpl?: typeof WebSocket;
	/**
	 * The server's connection throttle as this device has seen it
	 * (irc/dialLedger.ts): no dial goes out while it says the server would
	 * refuse it — a refusal renews the server's window — and every dial is
	 * recorded in it.
	 */
	gate?: DialGate;
}

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
	| {type: "error"; message: string}
	// `throttled`: the wait is the server's connection throttle, not the backoff.
	| {type: "reconnecting"; attempt: number; delayMs: number; throttled?: boolean}
	// The scheduled retry is starting now (its wait from "reconnecting" is over).
	| {type: "retry"; attempt: number};

export type TransportState = "closed" | "connecting" | "open" | "reconnect-wait";
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
const PING_RE = /^(?:@\S+ )?(?::\S+ )?PING(?: (.*))?$/i; // [tags] [prefix] PING [params]

export class WsTransport {
	private readonly opts: Required<Omit<TransportOptions, "WebSocketImpl" | "gate">> &
		Pick<TransportOptions, "WebSocketImpl" | "gate">;
	private readonly listeners = new Set<(ev: TransportEvent) => void>();
	private readonly decoder = new TextDecoder();
	private ws: WebSocket | null = null;
	private _state: TransportState = "closed";
	private attempt = 0;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private closedByUs = false;
	private openedAt: number | null = null; // null = not open (0 is a real fake-clock time)
	/** A dial the ledger recorded and has not yet seen end (irc/dialLedger.ts). */
	private dialing = false;
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

	/** Open the socket now, on whatever attempt count the schedule is at. */
	private dial(): void {
		this.clearTimer();
		this.closedByUs = false;
		const throttle = this.opts.gate?.waitMs(Date.now()) ?? 0;

		// The server would refuse this dial, and the refusal would renew its
		// window: wait it out instead, whoever asked (a click included).
		if (throttle > 0) {
			this.scheduleRetry(throttle, true);
			return;
		}

		const Impl = this.opts.WebSocketImpl ?? globalThis.WebSocket;

		if (typeof Impl !== "function") {
			throw new Error("WsTransport: no WebSocket implementation available");
		}

		this._state = "connecting";
		let ws: WebSocket;

		try {
			ws = new Impl(this.opts.url, this.opts.subprotocols);
		} catch (err: unknown) {
			// Synchronous failure (bad URL, blocked port): same path as a failed open.
			this.emit({type: "error", message: errorMessage(err)});
			this.handleClosed(1006, "", false);
			return;
		}

		// A dial made with the radio off never reached the server.
		if ((globalThis.navigator as {onLine?: boolean} | undefined)?.onLine !== false) {
			this.opts.gate?.record(Date.now());
			this.dialing = true;
		}

		// Every handler checks `ws === this.ws` so a superseded socket stays silent.
		this.ws = ws;
		this.connectingSince = Date.now();
		this.connectTimer = setTimeout(() => {
			this.connectTimer = null;

			if (ws === this.ws && this._state === "connecting") {
				this.ws = null; // its late events are ignored
				ws.close();
				this.handleClosed(1006, "connect timed out", false);
			}
		}, CONNECT_TIMEOUT_MS);
		ws.binaryType = "arraybuffer";
		ws.addEventListener("open", () => {
			if (ws === this.ws) {
				this.clearConnectTimer();

				// A socket that opened reached the server, whatever `onLine` said
				// at the dial (it can be wrong): the server counted it, and a
				// refund at its registration needs the dial it gives back.
				if (!this.dialing) {
					this.opts.gate?.record(Date.now());
					this.dialing = true;
				}

				this._state = "open";
				this.openedAt = Date.now();
				this.emit({type: "open", subprotocol: ws.protocol});
			}
		});
		ws.addEventListener("message", (ev: MessageEvent) => {
			if (ws === this.ws) {
				this.handleMessage(ev.data);
			}
		});
		ws.addEventListener("error", (ev: Event) => {
			if (ws === this.ws) {
				this.emit({type: "error", message: errorMessage(ev)});
			}
		});
		ws.addEventListener("close", (ev: CloseEvent) => {
			if (ws === this.ws) {
				this.ws = null;
				this.handleClosed(ev.code, ev.reason, ev.wasClean);
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
	 * close (so the usual reconnect follows). No-op unless open.
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
				this.handleClosed(1006, "no reply to PING", false);
			}
		}, timeoutMs);
	}

	/** How long the current dial has been in flight (0 unless connecting). */
	connectingForMs(): number {
		return this._state === "connecting" ? Date.now() - this.connectingSince : 0;
	}

	/**
	 * The server restarts its throttle's gap when a connection it accepted
	 * goes (irc/dialLedger.ts). It counts one at the TCP accept, before TLS
	 * and the WebSocket upgrade, so a dial that never opened — timed out,
	 * refused its certificate, abandoned for a fresh one — may have counted
	 * too: every dial that ends is a close. One that never reached the server
	 * makes the ledger wait a little longer, never too little.
	 */
	private dialEnded(): void {
		if (this.dialing) {
			this.dialing = false;
			this.opts.gate?.closed(Date.now());
		}
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
		this.dialEnded();

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

	private handleClosed(code: number, reason: string, wasClean: boolean): void {
		// A socket that dies while we are probing it (the foreground poke
		// asked "are you alive?" and the OS answered with the close) is the
		// user waiting at the screen: retry at once.
		const probing = this.probeTimer !== null;

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

		this.dialEnded();

		const atOnce = wasStable || probing;

		if (atOnce) {
			this.attempt = 0;
		}

		this.openedAt = null;
		const retry = !this.closedByUs && this.opts.reconnect.enabled;
		let delayMs: number | undefined;
		let throttled = false;

		if (retry) {
			delayMs = this.nextDelay(); // counts the attempt either way

			if (atOnce) {
				delayMs = 0;
			}

			// Never sooner than the server's throttle lets the dial in.
			const gateMs = this.opts.gate?.waitMs(Date.now()) ?? 0;

			if (gateMs > delayMs) {
				delayMs = gateMs;
				throttled = true;
			}
		}

		this._state = retry ? "reconnect-wait" : "closed";
		this.emit({type: "close", code, reason, wasClean, willReconnect: retry, delayMs});

		// A close listener may have called close(): then no retry is wanted.
		if (delayMs !== undefined && this._state === "reconnect-wait") {
			this.scheduleRetry(delayMs, throttled);
		}
	}

	/** Wait `delayMs`, then dial (which asks the gate again). */
	private scheduleRetry(delayMs: number, throttled: boolean): void {
		this._state = "reconnect-wait";
		this.emit({
			type: "reconnecting",
			attempt: this.attempt,
			delayMs,
			...(throttled ? {throttled: true} : {}),
		});
		this.timer = setTimeout(() => {
			this.timer = null;
			this.emit({type: "retry", attempt: this.attempt});
			this.dial();
		}, delayMs);
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

/** Browser error events carry no message; `ws`/undici ones do. */
function errorMessage(err: unknown): string {
	const msg = (err as {message?: unknown} | null)?.message;
	return typeof msg === "string" && msg.length > 0 ? msg : "WebSocket error";
}
