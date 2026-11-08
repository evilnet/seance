/**
 * ShellSocket — a raw TCP/TLS IRC connection made by the app shell
 * (shells/tauri/src-tauri/src/socket.rs), dressed as the part of a WebSocket
 * that {@link WsTransport} uses ({@link LineSocket}). IRC over TCP carries the
 * same lines as IRC over WebSocket, so everything above the socket — the
 * retry schedule, the probe, PING, the line cap — is shared unchanged.
 *
 * The shell is reached through a {@link SocketBridge} (`window.seanceShell`
 * in the app), passed in so this module stays DOM-free and runs under mocha.
 *
 * The contract WsTransport relies on:
 * - every event is asynchronous; `open` comes after `readyState` is OPEN;
 * - calls to the shell run in order per socket (open, sends, close): each
 *   bridge call is its own IPC request and two may otherwise overtake each
 *   other, which would reorder a pipelined registration or QUIT-then-close;
 * - a failure fires `error` (carrying the shell's reason) then one `close`,
 *   marked `final` when the shell says a retry cannot mend it;
 * - `close()` from the page fires its own `close` event, once: the shell
 *   says nothing about a socket the page closed.
 */

import type {LineSocket, LineSocketCtor} from "./transport";

/** The shell bridge, as `client/js/helpers/shell.ts`'s `SeanceShell` has it. */
export interface SocketBridge {
	call(plugin: string, method: string, options?: unknown): Promise<unknown>;
	listen(plugin: string, event: string, cb: (data: any) => void): void;
}

/** Where to dial. `host` is a bare name or IP literal (no brackets, no path). */
export interface TcpEndpoint {
	host: string;
	port: number;
	tls: boolean;
}

const PLUGIN = "Socket";

/** The shell's close code for a failure a retry cannot mend (socket.rs `FINAL`). */
export const FINAL_CLOSE = 4001;

type Listeners = Record<"open" | "message" | "error" | "close", Array<(ev: any) => void>>;

/** Live sockets per bridge, by id; the bridge's events are routed through here. */
const routes = new WeakMap<SocketBridge, Map<string, ShellSocket>>();

function routesFor(bridge: SocketBridge): Map<string, ShellSocket> {
	const map = routes.get(bridge);

	if (map) {
		return map;
	}

	const sockets = new Map<string, ShellSocket>();
	routes.set(bridge, sockets);
	const route = (data: any, fn: (s: ShellSocket, d: any) => void) => {
		const socket = typeof data?.id === "string" ? sockets.get(data.id) : undefined;

		if (socket) {
			fn(socket, data);
		}
	};
	bridge.listen(PLUGIN, "open", (data) => route(data, (s) => s.onShellOpen()));
	bridge.listen(PLUGIN, "lines", (data) =>
		route(data, (s, d) => s.onShellLines(Array.isArray(d.lines) ? d.lines : []))
	);
	bridge.listen(PLUGIN, "close", (data) =>
		route(data, (s, d) =>
			s.onShellClose(
				typeof d.code === "number" ? d.code : 1006,
				typeof d.reason === "string" ? d.reason : ""
			)
		)
	);
	return sockets;
}

function messageOf(err: unknown): string {
	const msg = (err as {message?: unknown} | null)?.message;
	return typeof msg === "string" && msg.length > 0 ? msg : String(err);
}

function newId(): string {
	return globalThis.crypto.randomUUID();
}

/**
 * This page load's token, sent with every open: after a reload the shell
 * refuses an open from the page before, which can still be in flight.
 */
const PAGE = newId();

export class ShellSocket implements LineSocket {
	readonly CONNECTING = 0;
	readonly OPEN = 1;
	readonly CLOSING = 2;
	readonly CLOSED = 3;
	readonly protocol = "";
	binaryType = "arraybuffer";
	readonly id: string;

	private state = 0;
	private readonly listeners: Listeners = {open: [], message: [], error: [], close: []};
	private readonly sockets: Map<string, ShellSocket>;
	/** The shell calls, in order: open, then sends, then close. */
	private chain: Promise<unknown>;
	/** Lines sent this tick, to go out as one call. */
	private outbox: string[] = [];
	private flushQueued = false;

	constructor(
		private readonly bridge: SocketBridge,
		endpoint: TcpEndpoint,
		id: string = newId()
	) {
		this.id = id;
		this.sockets = routesFor(bridge);
		this.sockets.set(id, this);
		const options = {
			id,
			page: PAGE,
			host: endpoint.host,
			port: endpoint.port,
			tls: endpoint.tls,
		};
		let opened: Promise<unknown>;

		try {
			opened = bridge.call(PLUGIN, "open", options);
		} catch (err: unknown) {
			// A bridge that throws at once fails like one that rejects.
			opened = Promise.reject(err instanceof Error ? err : new Error(messageOf(err)));
		}

		this.chain = opened.catch((err: unknown) => this.onShellClose(1006, messageOf(err)));
	}

	get readyState(): number {
		return this.state;
	}

	addEventListener(type: "open", listener: () => void): void;
	addEventListener(type: "message", listener: (ev: {data: unknown}) => void): void;
	addEventListener(type: "error", listener: (ev: unknown) => void): void;
	addEventListener(
		type: "close",
		listener: (ev: {code: number; reason: string; wasClean: boolean; final?: boolean}) => void
	): void;
	addEventListener(type: keyof Listeners, listener: (ev: any) => void): void {
		this.listeners[type].push(listener);
	}

	send(line: string): void {
		if (this.state !== this.OPEN) {
			throw new Error("ShellSocket: not open");
		}

		this.outbox.push(line);

		if (!this.flushQueued) {
			this.flushQueued = true;
			queueMicrotask(() => this.flush());
		}
	}

	close(): void {
		if (this.state === this.CLOSING || this.state === this.CLOSED) {
			return;
		}

		const wasOpen = this.state === this.OPEN;
		this.flush(); // lines sent this tick (a QUIT) go before the close
		this.state = this.CLOSING;
		this.enqueue(() => this.bridge.call(PLUGIN, "close", {id: this.id}), false);
		queueMicrotask(() =>
			this.finish(wasOpen ? 1000 : 1006, wasOpen ? "" : "closed while connecting")
		);
	}

	/** @internal The shell connected. */
	onShellOpen(): void {
		if (this.state !== this.CONNECTING) {
			return;
		}

		this.state = this.OPEN;
		this.fire("open", undefined);
	}

	/** @internal Lines from the server. */
	onShellLines(lines: unknown[]): void {
		for (const line of lines) {
			if (this.state !== this.OPEN) {
				return; // a listener closed the socket mid-batch
			}

			if (typeof line === "string") {
				this.fire("message", {data: line});
			}
		}
	}

	/** @internal The shell lost the socket, or refused a call. */
	onShellClose(code: number, reason: string): void {
		if (this.state === this.CLOSING || this.state === this.CLOSED) {
			return; // a page close fires its own event
		}

		if (code !== 1000) {
			this.fire("error", {message: reason || "connection failed"});
		}

		this.finish(code, reason);
	}

	private flush(): void {
		this.flushQueued = false;

		if (this.outbox.length === 0 || this.state !== this.OPEN) {
			this.outbox = [];
			return;
		}

		const lines = this.outbox;
		this.outbox = [];
		this.enqueue(() => this.bridge.call(PLUGIN, "send", {id: this.id, lines}), true);
	}

	private enqueue(call: () => Promise<unknown>, failCloses: boolean): void {
		this.chain = this.chain.then(call).catch((err: unknown) => {
			if (failCloses) {
				this.onShellClose(1006, messageOf(err));
			}
		});
	}

	private finish(code: number, reason: string): void {
		if (this.state === this.CLOSED) {
			return;
		}

		this.state = this.CLOSED;
		this.sockets.delete(this.id);
		this.fire("close", {
			code,
			reason,
			wasClean: code === 1000,
			...(code === FINAL_CLOSE ? {final: true} : {}),
		});
	}

	private fire<K extends keyof Listeners>(type: K, ev: unknown): void {
		for (const listener of [...this.listeners[type]]) {
			// One listener's throw must not cost the rest of a read's lines;
			// it is rethrown on its own so it is still reported.
			try {
				listener(ev);
			} catch (err: unknown) {
				queueMicrotask(() => {
					throw err;
				});
			}
		}
	}
}

/** A socket constructor for {@link WsTransport}, bound to one endpoint; the URL it is given is only for show. */
export function shellSocketCtor(bridge: SocketBridge, endpoint: TcpEndpoint): LineSocketCtor {
	return class extends ShellSocket {
		constructor(_url: string, _protocols?: string | string[]) {
			super(bridge, endpoint);
		}
	};
}
