/**
 * Shared types for the browser IRC layer (`client/js/irc/`).
 */

import type {IrcMessage} from "./message";
import type {IrcClient} from "./client";
import type {Channel} from "./channel";
import type {TransportEvent, TransportState} from "./transport";

/**
 * The slice of {@link WsTransport} the client relies on. Tests inject a fake
 * that implements just this.
 */
export interface Transport {
	readonly state: TransportState;
	on(listener: (ev: TransportEvent) => void): () => void;
	connect(): void;
	send(line: string): void;
	close(code?: number, reason?: string): void;
	/** Check that an open socket is alive (PING; silence closes it as lost). Optional. */
	probe?(timeoutMs?: number): void;
	/** Foreground poke: how long the current dial has been in flight (0 unless connecting). */
	connectingForMs?(): number;
	/** Foreground poke: abandon a stuck dial and start over now. */
	redial?(): void;
	/** Drop the current socket as lost (close 1006, `reason`) and reconnect on the usual schedule. */
	abandon?(reason: string): void;
	/** The server said it throttled us: the next retry waits `delayMs`, or the fallback. Optional. */
	throttled?(delayMs?: number): void;
	/** A long wait is pending: the foreground poke leaves it be. Optional. */
	holding?(): boolean;
}

/**
 * Everything needed to open a connection. Populated by the connect form
 * (`client/components/Windows/Connect.vue`) and consumed by {@link IrcClient}.
 */
export type ConnectOptions = {
	/** Host name, optionally with a path (`irc.example.org/ws`). */
	host: string;
	port: number;
	tls: boolean;
	/**
	 * `tcp`: plain IRC over TCP (TLS when `tls`), made by the app shell
	 * (shellSocket.ts); unavailable in a browser. `websocket` or absent: IRC
	 * over WebSocket. The forms send `websocket` to switch back (an absent
	 * option keeps the stored value); a saved entry never holds it.
	 */
	transport?: "tcp" | "websocket";
	nick: string;
	/** Comma-separated channel list, optionally with keys (`#a key, #b`). */
	join: string;
	/** `external` is a stub: browsers cannot present client certificates over WebSocket. */
	sasl: "" | "plain" | "external";
	saslAccount: string;
	saslPassword: string;
	/**
	 * Server password, sent as `PASS` before `NICK`/`USER` when non-empty.
	 * Bouncers that predate client SASL want it (ZNC: `user/network:password`);
	 * independent of SASL, and both are sent when both are set.
	 */
	serverPassword?: string;
	/**
	 * Drop the connection when a configured SASL login does not succeed,
	 * instead of carrying on unauthenticated. Unset means "ask the deploy":
	 * `config.json`'s `features.saslDisconnectOnFail`, which defaults to
	 * true (see `client/js/branding.ts` and client.ts `saslRequired`).
	 */
	saslDisconnectOnFail?: boolean;
};

/** Connection state as seen by the rest of the app. */
export type IrcClientState = "disconnected" | "connecting" | "registering" | "registered";

/**
 * An inbound handler: one per command / numeric, registered in
 * `handlers/index.ts`. Handlers mutate the client's model and dispatch bus
 * events through the client; they never touch the transport directly.
 */
export type Handler = (client: IrcClient, msg: IrcMessage) => void;

/**
 * What the UI attached to a line of input (`input` emit, bus-contract §1.4):
 * msgids to reply to and/or replace. Only plain text honours both; `/me`
 * honours `reply`; every other command ignores them.
 */
export interface InputOptions {
	reply?: string;
	edit?: string;
	/** Run by the client, not typed or clicked (a network's saved commands
	 * after every registration): never counts as the user asking. */
	auto?: boolean;
}

/** The channel (or lobby/query) an input line was typed into. */
export interface CommandContext {
	client: IrcClient;
	chan: Channel;
	/** Lower-cased command name without the slash (`msg`, `me`, ...). */
	cmd: string;
	/** The words after the command name; a run of spaces is one separator. */
	args: string[];
	/** Everything after the command name, untrimmed. */
	rest: string;
	/** Reply / edit references attached by the UI (empty when none). */
	opts?: InputOptions;
}

/** An outbound (slash) command, registered in `commands/index.ts`. */
export interface Command {
	/** Names this command answers to, without the slash. */
	commands: string[];
	/** Whether the command may run while the network is disconnected. */
	allowDisconnected?: boolean;
	input: (ctx: CommandContext) => void;
}
