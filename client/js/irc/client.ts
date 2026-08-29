/**
 * IrcClient — one IRC network, spoken directly to an IRCv3 server over a
 * WebSocket, feeding the Vue UI through the in-process event bus.
 *
 * It owns a {@link WsTransport}, a {@link CapNegotiator}, an {@link ISupport}
 * registry and the `SharedNetwork` model the UI is given (lobby, channels,
 * queries, users, topics). Inbound lines are parsed and dispatched to the
 * handlers in `./handlers/` (one file per command / numeric); typed input is
 * routed through the commands in `./commands/`. Both are registries so new
 * behaviour is added by dropping in a file, not by editing this class.
 *
 * Bus contract: docs/resources/bus-contract.md. Everything the UI needs to
 * react to is a `dispatch()`; the client never touches the store directly
 * (that keeps it usable under mocha, where there is no DOM).
 */

import socket, {EventBus} from "../socket";
import {isHighlight} from "../highlight";
import {ChanState, ChanType} from "../../../shared/types/chan";
import {MessageType, SharedMsg, TypingState} from "../../../shared/types/msg";
import type {SharedNetwork, SharedServerOptions} from "../../../shared/types/network";
import {CapNegotiator, SEANCE_CAPS} from "./caps";
import {casefold, namesEqual} from "./casemap";
import {Channel, MsgRef} from "./channel";
import {commandNames, dispatchInput} from "./commands";
import {describeClose} from "./disconnect";
import {handlers, unhandled} from "./handlers";
import {interceptBatchLine, resetBatches} from "./handlers/batch";
import {cancelMarkRead, scheduleMarkRead} from "./handlers/markread";
import {abortHistory} from "./history";
import {
	cancelCatchup,
	dropFromCatchup,
	enqueueCatchup,
	prefetchCatchup,
	prioritiseCatchup,
} from "./catchup";
import {
	attachCursorLine,
	awaitRestoration,
	cancelRestoration,
	serverReplayCovers,
} from "./persistence";
import {IdAllocator, sharedIds} from "./ids";
import {ISupport} from "./isupport";
import {
	formatLine,
	IrcMessage,
	MAX_LINE_BYTES,
	parseLine,
	splitMessage,
	utf8ByteLength,
} from "./message";
import {
	buildMultiline,
	canMultiline,
	multilineLimits,
	noteMultilineSent,
	resetMultiline,
} from "./multiline";
import {mechanismOffered, SASL_TIMEOUT_MS, SaslAuth, SaslMechanism, SaslResult} from "./sasl";
import {
	applyDuration,
	clearExpired,
	getPolicy,
	parseStsValue,
	refreshPolicy,
	StsUpgrade,
	upgradeOptions,
} from "./sts";
import {get as getSavedNetwork, NetworkCursor, setCursor} from "./saved-networks";
import {ReconnectOptions, TransportEvent, TransportOptions, WsTransport} from "./transport";
import type {ConnectOptions, InputOptions, IrcClientState, Transport} from "./types";
import {
	ClientTags,
	EDIT_TAG,
	REACT_TAG,
	REDACTION_CAP,
	REPLY_TAG,
	tagPrefix,
	trailingLine,
	TYPING_INTERVAL_MS,
	TYPING_TAG,
	UNREACT_TAG,
} from "./wire";

export interface HighlightKeywords {
	keywords: string[];
	exceptions: string[];
}

/** A message produced while replaying history (see {@link IrcClient.collectReplay}). */
export interface ReplayedMessage {
	chan: Channel;
	msg: SharedMsg;
}

/** What one {@link IrcClient.collectReplay} run produced. */
export interface ReplayCollection {
	messages: ReplayedMessage[];
	/**
	 * Work to do once the collected messages have ids and are shown: the
	 * `msg:react` / `msg:redact` / `msg:edit` dispatches that refer to them
	 * (see {@link IrcClient.afterReplay}).
	 */
	after: (() => void)[];
}

/** Options for {@link IrcClient.sendMessage}. */
export interface SendMessageOptions {
	notice?: boolean;
	action?: boolean;
	/** Client tags (`+name` keys, unescaped values) put on every chunk. */
	tags?: ClientTags;
	/** Client tags put on the first chunk only (`+seance/edit`). */
	firstTags?: ClientTags;
}

/**
 * Outbound `+typing` throttle state for one target (see {@link IrcClient.typing}).
 * An entry exists only while a typing session is announced: it is created by
 * the first `active` put on the wire and dropped when `done` goes out, when
 * we send a message to the target, or when the connection closes.
 */
interface TypingEntry {
	/** The last state put on the wire (`active` or `paused`). */
	lastState?: TypingState;
	lastSentAt: number;
	/** Delivers `wanted` at `lastSentAt + TYPING_INTERVAL_MS`. */
	timer?: ReturnType<typeof setTimeout>;
	/** The transition waiting for the timer, replaced by later requests. */
	wanted?: TypingState;
}

/** An edit waiting for the server to confirm the REDACT of the old message. */
interface PendingEdit {
	chan: Channel;
	text: string;
	replyTo?: string;
	timer: ReturnType<typeof setTimeout>;
}

/** How long an edit waits for the echoed REDACT before giving up. */
export const EDIT_TIMEOUT_MS = 5000;

/** Trailing throttle on writing the catch-up cursor to localStorage. */
export const CURSOR_SAVE_INTERVAL_MS = 1000;

export interface IrcClientOptions extends ConnectOptions {
	/** Stable network id; derived from host/port/nick when omitted. */
	uuid?: string;
	username?: string;
	realname?: string;
	leaveMessage?: string;
	/** Where to dispatch bus events; defaults to the app bus. */
	bus?: Pick<EventBus, "dispatch">;
	ids?: IdAllocator;
	/** Build the transport (tests inject a fake); defaults to `new WsTransport(opts)`. */
	transportFactory?: (opts: TransportOptions) => Transport;
	reconnect?: ReconnectOptions;
	/** Custom highlight keywords (from the settings store). */
	highlights?: () => HighlightKeywords;
	/** Persist a channel's muted flag (`/mute`, `/unmute`); see client/js/mute.ts. */
	setMuteStatus?: (chanId: number, muted: boolean) => void;
	/**
	 * Networks to send in `init`. The `init` listener replaces the store's
	 * network list wholesale, so with several networks the manager supplies
	 * all of them here. Defaults to just this network.
	 */
	networksForInit?: () => SharedNetwork[];
	/**
	 * An STS policy upgraded this connect from `ws://` to `wss://` (see sts.ts).
	 * The manager persists the new port/tls so the saved network stays secure.
	 */
	onStsUpgrade?: (change: StsUpgrade) => void;
}

export const NOT_CONNECTED_TEXT =
	"You are not connected to the IRC network, unable to send your command.";

/** Prefix characters a channel name may start with when the user omits one. */
const CHANNEL_PREFIXES = "#&!+";

/** Own messages of these types mean the user read the channel (draft/read-marker). */
const SELF_READ_TYPES: ReadonlySet<MessageType> = new Set([
	MessageType.MESSAGE,
	MessageType.ACTION,
	MessageType.NOTICE,
]);

export class IrcClient {
	readonly uuid: string;
	/** Replaced (not mutated) when an STS upgrade changes port/tls, see {@link reconfigure}. */
	options: Readonly<IrcClientOptions>;
	/** Swapped for a new one on an STS upgrade; always subscribed via {@link reconfigure}. */
	transport: Transport;
	readonly isupport = new ISupport();
	readonly channels: Channel[] = [];
	readonly lobby: Channel;
	caps = new CapNegotiator(SEANCE_CAPS);

	/** Our current nick as the server knows it (or the one we asked for). */
	nick: string;
	ident: string;
	/** Our visible host; empty until the server tells us (JOIN echo, 396, CHGHOST). */
	host = "";
	/** MOTD lines being collected between 375 and 376. */
	motdBuffer: string[] | null = null;
	/** The SASL exchange in progress during registration, if any. */
	sasl: SaslAuth | null = null;
	/** Services account we are logged in as (900/901); "" when not. */
	account = "";
	/** The server holds our session across disconnects (`PERSISTENCE STATUS ON`, see persistence.ts). */
	persistenceHold = false;
	/** Set while a `draft/persistence` batch restores channel state: handlers update the model but show nothing. */
	restoring = false;
	/**
	 * Newest message we have shown on this network, over every channel and
	 * query: the catch-up cursor offered as `PERSISTENCE ATTACH default
	 * <msgid>` (persistence.ts). Loaded from the saved network so it survives
	 * the page being killed, and written back throttled.
	 */
	cursor: NetworkCursor | undefined;
	/** The msgid offered in this registration's `PERSISTENCE ATTACH`, if any. */
	attachCursor: string | undefined;
	/** The server took that cursor: it replays the gap, so catchup.ts stands down. */
	serverReplay = false;

	/** Batch references we hand out (`draft/multiline`); unique per connection. */
	private batchSeq = 0;
	private saslTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly bus: Pick<EventBus, "dispatch">;
	private readonly ids: IdAllocator;
	private url: string;
	private unsubscribeTransport: () => void = () => undefined;
	/** One insecure → secure reconnect per connection; reset when the transport closes. */
	private stsUpgradeTried = false;
	/** Settings edited while connected (`network:edit`); applied on the next connect. */
	private pendingOptions: IrcClientOptions | null = null;
	private networkName: string;
	private _state: IrcClientState = "disconnected";
	private connected = false;
	private announced = false;
	private quitting = false;
	/** Last transport error text for the close report; browsers say nothing useful. */
	private lastTransportError?: string;
	/** The close report's hint is shown once per attempt series, not per retry. */
	private closeHintShown = false;
	private activeChanId = 0;
	/** Set while a history batch is replayed through the handlers (see `collectReplay`). */
	private replayContext: {target: Channel; collected: ReplayCollection} | null = null;
	/** Edits whose REDACT is in flight, by the msgid being replaced. */
	private readonly pendingEdits = new Map<string, PendingEdit>();
	/** Announced typing sessions by casefolded target (see {@link typing}). */
	private readonly typingState = new Map<string, TypingEntry>();
	/** Pending throttled write of {@link cursor} (see {@link noteCursor}). */
	private cursorTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(options: IrcClientOptions) {
		const host = options.host.trim();
		this.options = {...options, host};
		this.nick = options.nick;
		this.ident = options.username || sanitizeIdent(options.nick);
		this.uuid = options.uuid ?? deriveUuid(host, options.port, options.nick);
		this.networkName = hostnameOf(host);
		this.bus = options.bus ?? socket;
		this.ids = options.ids ?? sharedIds;
		this.url = buildUrl(host, options.port, options.tls);
		this.transport = this.createTransport();
		this.unsubscribeTransport = this.transport.on((ev) => this.onTransportEvent(ev));

		this.cursor = savedCursor(this.uuid);
		this.lobby = new Channel(this.ids.chanId(), this.networkName, ChanType.LOBBY, (s) =>
			this.casefold(s)
		);
		this.channels.push(this.lobby);

		for (const {name, key} of parseJoinList(options.join)) {
			const {channel} = this.createChannel(name, ChanType.CHANNEL, {key});
			channel.autoJoin = true;
		}
	}

	// ---------------------------------------------------------------- state

	get state(): IrcClientState {
		return this._state;
	}

	/** Registered with the server (001 and end of MOTD seen). */
	get isConnected(): boolean {
		return this.connected;
	}

	get name(): string {
		return this.networkName;
	}

	/** True between our own QUIT/disconnect and the transport closing. */
	get isQuitting(): boolean {
		return this.quitting;
	}

	get serverOptions(): SharedServerOptions {
		const {modes, symbols} = this.isupport.prefix;
		const prefix = modes.split("").map((mode, i) => ({mode, symbol: symbols[i]}));
		const modeToSymbol: Record<string, string> = {};

		for (const entry of prefix) {
			modeToSymbol[entry.mode] = entry.symbol;
		}

		return {
			CHANTYPES: this.isupport.chantypes.split(""),
			PREFIX: {prefix, modeToSymbol, symbols: symbols.split("")},
			NETWORK: this.isupport.network ?? this.networkName,
		};
	}

	/** The `SharedNetwork` snapshot the UI is given (channels carry no messages). */
	get network(): SharedNetwork {
		return {
			uuid: this.uuid,
			name: this.networkName,
			nick: this.nick,
			serverOptions: this.serverOptions,
			status: {
				connected: this.connected,
				connecting: this._state === "connecting" || this._state === "registering",
				secure: this.options.tls,
			},
			channels: this.channels.map((chan) => chan.snapshot()),
		};
	}

	/** Fields `network:info` / the edit form expect, minus `channels`. */
	get editableInfo(): Record<string, unknown> {
		const o = this.options;

		return {
			uuid: this.uuid,
			name: this.networkName,
			nick: this.nick,
			host: o.host,
			port: o.port,
			tls: o.tls,
			rejectUnauthorized: true,
			username: this.ident,
			realname: o.realname || o.nick,
			password: "",
			leaveMessage: o.leaveMessage ?? "",
			sasl: o.sasl,
			saslAccount: o.saslAccount,
			saslPassword: o.saslPassword,
			commands: [],
			proxyEnabled: false,
			proxyHost: "",
			proxyPort: 0,
			proxyUsername: "",
			proxyPassword: "",
			hasSTSPolicy: getPolicy(o.host) !== undefined,
		};
	}

	// ------------------------------------------------------------ lifecycle

	/** Announce the network to the UI (first call only) and open the transport. */
	connect(): void {
		if (!this.announced) {
			this.announced = true;
			this.bus.dispatch("network", {network: this.network});
		}

		if (this.transport.state === "open" || this.transport.state === "connecting") {
			return;
		}

		this.applyPendingOptions();
		this.applyStsPolicy();
		this.quitting = false;
		this.closeHintShown = false;
		this._state = "connecting";
		this.bus.dispatch("connecting");
		this.bus.dispatch("network:status", {
			network: this.uuid,
			connected: false,
			connecting: true,
			secure: this.options.tls,
		});
		this.pushMessage(
			this.lobby,
			{text: `Connecting to ${this.options.host}:${this.options.port}…`},
			true
		);
		this.transport.connect();
	}

	/**
	 * Send QUIT and close without reconnecting; the network stays in the UI.
	 * Also cancels a pending reconnect.
	 */
	disconnect(reason?: string): void {
		this.quitting = true;
		const state = this.transport.state;

		if (state === "open") {
			this.transport.send(trailingLine("QUIT", [reason ?? "Seance"]));
		}

		this.transport.close();

		if (state === "reconnect-wait") {
			// The socket is already gone, so no close event follows: settle here.
			this._state = "disconnected";
			this.bus.dispatch("network:status", {
				network: this.uuid,
				connected: false,
				connecting: false,
				secure: this.options.tls,
			});
			this.pushMessage(this.lobby, {text: "Reconnect cancelled."}, true);
		}
	}

	/** `/quit`: remove the network from the UI, then disconnect for good. */
	quit(reason?: string): void {
		this.bus.dispatch("quit", {network: this.uuid});
		this.disconnect(reason);
	}

	/**
	 * Take edited connection settings (`network:edit`). Host, port and TLS
	 * need a fresh transport, so while a connection is up (or being opened)
	 * they wait for the next connect — including the automatic reconnect
	 * after that connection drops. An idle client switches at once; one that
	 * is waiting to reconnect switches and retries right away, so a typo in
	 * the port or TLS box does not keep it hammering the wrong address.
	 * The nick is not touched here: `/nick` owns it.
	 */
	applySettings(next: ConnectOptions): void {
		const merged: IrcClientOptions = {
			...this.options,
			host: next.host,
			port: next.port,
			tls: next.tls,
			join: next.join,
			sasl: next.sasl,
			saslAccount: next.saslAccount,
			saslPassword: next.saslPassword,
		};
		const state = this.transport.state;

		if (state === "open" || state === "connecting") {
			this.pendingOptions = merged;
			return;
		}

		this.pendingOptions = null;

		if (!this.endpointChanged(merged)) {
			this.options = merged;
			return;
		}

		this.transport.close(); // drops a pending reconnect
		this.reconfigure(merged);

		if (state === "reconnect-wait") {
			this.connect();
		}
	}

	private endpointChanged(next: IrcClientOptions): boolean {
		const o = this.options;
		return next.host !== o.host || next.port !== o.port || next.tls !== o.tls;
	}

	/** Swap in settings edited while connected, if any (before a connect). */
	private applyPendingOptions(): boolean {
		const next = this.pendingOptions;

		if (!next) {
			return false;
		}

		this.pendingOptions = null;

		if (this.endpointChanged(next)) {
			this.transport.close();
			this.reconfigure(next);
		} else {
			this.options = next;
		}

		return true;
	}

	// ------------------------------------------------------------------- STS

	private createTransport(): Transport {
		const transportOptions: TransportOptions = {
			url: this.url,
			subprotocols: ["text.ircv3.net", "binary.ircv3.net"],
		};

		if (this.options.reconnect) {
			transportOptions.reconnect = this.options.reconnect;
		}

		return this.options.transportFactory
			? this.options.transportFactory(transportOptions)
			: new WsTransport(transportOptions);
	}

	/** Switch to `next` (port/tls) with a fresh transport; the old one is left to close. */
	private reconfigure(next: IrcClientOptions): void {
		this.unsubscribeTransport();
		this.options = {...next};
		this.url = buildUrl(next.host, next.port, next.tls);
		this.transport = this.createTransport();
		this.unsubscribeTransport = this.transport.on((ev) => this.onTransportEvent(ev));
	}

	/** Before connecting: a cached STS policy for the host turns `ws://` into `wss://`. */
	private applyStsPolicy(): void {
		clearExpired();
		const upgraded = upgradeOptions(this.options);

		if (upgraded === this.options) {
			return;
		}

		this.reconfigure(upgraded);
		this.pushMessage(
			this.lobby,
			{text: `Upgrading to TLS on port ${upgraded.port} (STS policy)`},
			true
		);
		this.options.onStsUpgrade?.({port: upgraded.port, tls: true});
	}

	/**
	 * After the final `CAP LS`: over `ws://` an `sts` with `port=` means drop
	 * the connection and come back over `wss://` on that port (once); over
	 * `wss://` a `duration=` caches / refreshes / removes the host's policy.
	 */
	private checkSts(msg: IrcMessage): void {
		if (msg.command !== "CAP" || (msg.params[1] ?? "").toUpperCase() !== "LS") {
			return;
		}

		if (msg.params[2] === "*" && msg.params.length > 3) {
			return; // more LS lines follow
		}

		const raw = this.caps.value("sts");

		if (raw === undefined) {
			return;
		}

		const value = parseStsValue(raw);

		if (this.options.tls) {
			applyDuration(this.options.host, this.options.port, value);
			return;
		}

		if (value.port === undefined || this.stsUpgradeTried) {
			return;
		}

		this.stsUpgradeTried = true;
		this.pushMessage(
			this.lobby,
			{
				text: `Server requires a secure connection (STS): reconnecting on port ${value.port}…`,
			},
			true
		);
		this.disconnect("STS upgrade");
		this.reconfigure({...this.options, tls: true, port: value.port});
		this.connect();
	}

	private onTransportEvent(ev: TransportEvent): void {
		switch (ev.type) {
			case "open":
				this.onOpen();
				break;
			case "line":
				this.handleLine(ev.line);
				break;
			case "close":
				this.onClose(ev.code, ev.reason, ev.willReconnect);
				break;
			case "reconnecting":
				this._state = "connecting";
				this.bus.dispatch("connecting");
				this.pushMessage(
					this.lobby,
					{
						text: `Reconnecting in ${Math.max(
							1,
							Math.round(ev.delayMs / 1000)
						)}s (attempt ${ev.attempt})…`,
					},
					true
				);
				break;
			case "retry":
				// The scheduled retry is dialling now.
				this._state = "connecting";
				this.pushMessage(
					this.lobby,
					{
						text: `Connecting to ${this.options.host}:${this.options.port}… (attempt ${ev.attempt})`,
					},
					true
				);
				break;
			case "error":
				// Always followed by a close event, which is where we report.
				this.lastTransportError = ev.message;
				break;
		}
	}

	/** Transport open: fresh negotiation state, then CAP LS / NICK / USER. */
	private onOpen(): void {
		this._state = "registering";
		this.connected = false;
		this.closeHintShown = false;
		this.caps = this.createCaps();
		this.isupport.reset();
		this.motdBuffer = null;
		this.host = "";
		this.account = "";
		this.persistenceHold = false;
		this.attachCursor = undefined;
		this.serverReplay = false;
		this.endSasl();

		for (const line of this.caps.start()) {
			this.send(line);
		}

		this.send(formatLine({command: "NICK", params: [this.nick]}));
		this.send(trailingLine("USER", [this.ident, "0", "*", this.options.realname || this.nick]));
	}

	// ------------------------------------------------------------------ SASL

	/** The mechanism the user configured, or null for none. */
	private get saslMechanism(): SaslMechanism | null {
		switch (this.options.sasl) {
			case "plain":
				return this.options.saslAccount && this.options.saslPassword ? "PLAIN" : null;
			case "external":
				return "EXTERNAL";
			default:
				return null;
		}
	}

	/** A negotiator that also asks for `sasl` (when usable) and runs SASL before `CAP END`. */
	private createCaps(): CapNegotiator {
		const mechanism = this.saslMechanism;

		if (!mechanism) {
			return new CapNegotiator(SEANCE_CAPS);
		}

		const caps = new CapNegotiator({
			...SEANCE_CAPS,
			wanted: [...SEANCE_CAPS.wanted, "sasl"],
			accept: (name, value) => name !== "sasl" || mechanismOffered(mechanism, value),
		});
		caps.beforeEnd = () => this.startSasl(mechanism);
		return caps;
	}

	/**
	 * `beforeEnd` hook: open the exchange if the server enabled `sasl` — or is
	 * about to (the opener is pipelined right behind the `CAP REQ`, which the
	 * server has answered by the time it reads AUTHENTICATE) — else nothing.
	 */
	private startSasl(mechanism: SaslMechanism): string[] {
		if (!this.caps.hasCapability("sasl") && !this.caps.isRequesting("sasl")) {
			return [];
		}

		this.sasl = new SaslAuth(mechanism, {
			account: this.options.saslAccount,
			password: this.options.saslPassword,
		});
		this.armSaslTimer();
		return this.sasl.start();
	}

	/** Apply what the state machine returned for one inbound line (called by handlers/sasl.ts). */
	saslProgress(result: SaslResult): void {
		for (const line of result.send) {
			this.send(line);
		}

		if (result.info) {
			this.pushMessage(this.lobby, {text: result.info}, true);
		}

		if (!result.done) {
			this.armSaslTimer();
			return;
		}

		this.endSasl();

		if (!result.ok) {
			this.pushMessage(
				this.lobby,
				{
					type: MessageType.ERROR,
					text: `SASL authentication failed: ${result.error ?? "unknown error"}`,
				},
				true
			);

			if (this.options.saslDisconnectOnFail) {
				this.disconnect("SASL authentication failed");
				return;
			}
		} else {
			// The one window `PERSISTENCE ATTACH` fits in: the server refuses
			// it without an account and again once we are registered. It goes
			// out in the same flush as `CAP END`, before it (persistence.ts).
			this.offerAttachCursor();
		}

		for (const line of this.caps.end()) {
			this.send(line);
		}
	}

	/**
	 * Hand the server the newest msgid we hold so it replays the gap itself
	 * (`PERSISTENCE ATTACH default <msgid>`). Nothing is sent when the server
	 * does not advertise the `attach-cursor` token or we have no cursor, and
	 * the reply (or its absence) decides whether catchup.ts stands down —
	 * see handlers/persistence.ts.
	 */
	private offerAttachCursor(): void {
		const line = attachCursorLine(this);

		if (line && this.send(line)) {
			this.attachCursor = this.cursor?.msgid;
		}
	}

	/** Give up on an exchange in progress (e.g. the server NAKed `sasl`) and finish CAP. */
	abortSasl(reason: string): void {
		if (this.sasl && !this.sasl.done) {
			this.saslProgress(this.sasl.abort(reason));
		}
	}

	private armSaslTimer(): void {
		this.clearSaslTimer();
		this.saslTimer = setTimeout(() => {
			this.saslTimer = null;

			if (this.sasl && !this.sasl.done) {
				this.saslProgress(this.sasl.abort("timed out waiting for the server"));
			}
		}, SASL_TIMEOUT_MS);
	}

	private clearSaslTimer(): void {
		if (this.saslTimer !== null) {
			clearTimeout(this.saslTimer);
			this.saslTimer = null;
		}
	}

	private endSasl(): void {
		this.clearSaslTimer();
		this.sasl = null;
	}

	private onClose(code: number, reason: string, willReconnect: boolean): void {
		const phase = this._state;
		const wasUp = phase !== "disconnected";
		this._state = "disconnected";
		this.connected = false;
		this.stsUpgradeTried = false;
		this.endSasl();

		if (this.options.tls) {
			refreshPolicy(this.options.host);
		}

		resetBatches(this);
		resetMultiline(this);
		abortHistory(this);
		cancelCatchup(this);
		cancelRestoration(this);
		this.saveCursor(); // the newest one must not die with the connection
		this.serverReplay = false;
		this.clearPendingEdits();
		this.clearTyping();

		for (const chan of this.channels) {
			chan.users.clear();
			chan.namesBuffer = null;
			cancelMarkRead(chan);

			if (chan.type === ChanType.CHANNEL) {
				// Dropped, not our QUIT: the re-JOIN is state, not news (Channel.rejoining).
				chan.rejoining = chan.state === ChanState.JOINED && !this.quitting;
				chan.state = ChanState.PARTED;
			}
		}

		this.bus.dispatch("network:status", {
			network: this.uuid,
			connected: false,
			connecting: willReconnect,
			secure: this.options.tls,
		});

		if (wasUp) {
			if (this.quitting) {
				this.pushMessage(this.lobby, {text: "Disconnected."}, true);
			} else {
				const report = describeClose({
					url: this.url,
					host: this.options.host,
					phase,
					code,
					reason,
					errorMessage: this.lastTransportError,
					pageProtocol: globalThis.location?.protocol,
					willReconnect,
				});
				this.pushMessage(this.lobby, {type: MessageType.ERROR, text: report.text}, true);

				if (report.hint && !this.closeHintShown) {
					this.closeHintShown = true;
					this.pushMessage(this.lobby, {text: report.hint}, true);
				}
			}
		}

		this.lastTransportError = undefined;

		// Settings edited during this connection: reconnect with them instead
		// of letting the transport retry the old address.
		if (willReconnect && this.pendingOptions) {
			const moved = this.endpointChanged(this.pendingOptions);
			this.applyPendingOptions();

			if (moved) {
				this.connect(); // replaces the old transport's retry
			}
		}
	}

	/** Called by the 376/422 handler once registration has completed. */
	onRegistered(): void {
		if (this.connected) {
			return;
		}

		this.connected = true;
		this._state = "registered";

		const first = this.channels.find((chan) => chan.type === ChanType.CHANNEL);
		const networks = this.options.networksForInit
			? this.options.networksForInit()
			: [this.network];
		this.bus.dispatch("init", {active: (first ?? this.lobby).id, networks});
		this.bus.dispatch("network:status", {
			network: this.uuid,
			connected: true,
			connecting: false,
			secure: this.options.tls,
		});
		this.bus.dispatch("commands", commandNames());

		if (this.caps.enabled.size > 0) {
			this.pushMessage(
				this.lobby,
				{text: `Enabled capabilities: ${Array.from(this.caps.enabled).join(", ")}`},
				true
			);
		}

		if (this.persistenceHold) {
			// The server may be about to restore the channels of our held
			// session (a draft/persistence batch right behind the MOTD): JOIN
			// only what it does not restore, once that batch is in.
			awaitRestoration(this);
		} else {
			this.autojoin();
		}
	}

	/**
	 * JOIN every autojoin channel we are not in, the active one's catch-up
	 * pipelined behind it: the server processes lines in order, so by the
	 * time it reads the history request we are a member. Saves a round trip
	 * on the channel the user is looking at.
	 */
	autojoin(): void {
		const joining = this.channels.filter(
			(chan) =>
				chan.type === ChanType.CHANNEL && chan.autoJoin && chan.state === ChanState.PARTED
		);

		if (joining.length === 0) {
			return;
		}

		this.joinChannels(joining.map((chan) => ({name: chan.name, key: chan.shared.key})));
		const active = joining.find((chan) => chan.id === this.activeChanId);

		if (active) {
			prefetchCatchup(this, active);
		}
	}

	// --------------------------------------------------------------- sending

	/** Send one raw line. Reports an ERROR message in the lobby instead of throwing. */
	send(line: string): boolean {
		if (this.transport.state !== "open") {
			this.pushMessage(this.lobby, {type: MessageType.ERROR, text: NOT_CONNECTED_TEXT});
			return false;
		}

		try {
			this.transport.send(line);
			return true;
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.pushMessage(this.lobby, {type: MessageType.ERROR, text: `Not sent: ${message}`});
			return false;
		}
	}

	/**
	 * PRIVMSG/NOTICE `text` to `target`, split into lines that fit the frame
	 * cap (client tags counted in). Without `echo-message` the lines are fed
	 * back through the inbound handlers, tags included, as if the server had
	 * echoed them.
	 */
	sendMessage(target: string, text: string, opts: SendMessageOptions = {}) {
		// The message itself ends the typing session on the receiver's side:
		// forget ours (no `done`), and let the next `active` go out at once.
		this.resetTyping(target);
		const command = opts.notice ? "NOTICE" : "PRIVMSG";
		const firstTags: ClientTags | undefined =
			opts.tags || opts.firstTags ? {...opts.firstTags, ...opts.tags} : undefined;
		// The server prepends our full source to the echo; budget for it even
		// when the host is still unknown (63 is the usual hostname limit).
		const hostLen = this.host.length || 63;
		let prefixBytes = utf8ByteLength(`:${this.nick}!${this.ident}@`) + hostLen;
		prefixBytes += utf8ByteLength(` ${command} ${target} :`);
		// The frame cap applies to the whole line; the first chunk carries the
		// most tags, so every chunk is budgeted as if it did.
		prefixBytes += utf8ByteLength(tagPrefix(firstTags));

		if (opts.action) {
			prefixBytes += "\x01ACTION \x01".length;
		}

		let chunks: string[];

		try {
			chunks = splitMessage(prefixBytes, text.replace(/[\r\n\0]/g, " "));
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.pushMessage(this.lobby, {type: MessageType.ERROR, text: `Not sent: ${message}`});
			return;
		}

		const echo = this.caps.hasCapability("echo-message");

		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];
			const body = opts.action ? `\x01ACTION ${chunk}\x01` : chunk;
			const tags = i === 0 ? firstTags : opts.tags;

			if (!this.send(trailingLine(command, [target, body], tags))) {
				return;
			}

			if (!echo) {
				this.handleLine(
					`${tagPrefix(tags)}:${this.nick}!${this.ident}@${
						this.host || "localhost"
					} ${command} ${target} :${body}`
				);
			}
		}
	}

	/**
	 * Say `lines` as one message in a `draft/multiline` batch (multiline.ts).
	 * Returns false when the server cannot take it — no cap, or more lines /
	 * bytes than it advertised — and the caller falls back to one message per
	 * line, which is what a server without the cap gets anyway.
	 */
	sendMultiline(target: string, lines: string[], opts: SendMessageOptions = {}): boolean {
		if (!canMultiline(this) || this.transport.state !== "open") {
			return false;
		}

		const tags: ClientTags | undefined =
			opts.tags || opts.firstTags ? {...opts.firstTags, ...opts.tags} : undefined;
		// The server prepends our full source to the echo; budget for it even
		// when the host is still unknown (63 is the usual hostname limit).
		const hostLen = this.host.length || 63;
		const wire = buildMultiline({
			ref: `ml${++this.batchSeq}`,
			target,
			lines,
			command: opts.notice ? "NOTICE" : "PRIVMSG",
			sourceBytes: utf8ByteLength(`:${this.nick}!${this.ident}@`) + hostLen + 1,
			tags,
			limits: multilineLimits(this),
		});

		if (!wire) {
			return false;
		}

		// The message itself ends the typing session on the receiver's side.
		this.resetTyping(target);

		for (const line of wire.lines) {
			if (!this.send(line)) {
				return true; // the transport is gone; `send` reported it
			}
		}

		// A FAIL drops the whole batch server-side: keep the text so it can
		// go out as separate lines instead (multiline.ts).
		noteMultilineSent(this, target, lines, opts);

		if (!this.caps.hasCapability("echo-message")) {
			this.handleMessage({
				tags: new Map(Object.entries(tags ?? {})),
				source: {name: this.nick, user: this.ident, host: this.host || "localhost"},
				command: opts.notice ? "NOTICE" : "PRIVMSG",
				params: [target, wire.text],
				raw: wire.lines[0],
			});
		}

		return true;
	}

	/**
	 * `TAGMSG target` carrying only `tags`. Without `echo-message` the line is
	 * fed back through the handlers so our own reaction shows up.
	 */
	sendTagmsg(target: string, tags: ClientTags): boolean {
		const line = formatLine({tags, command: "TAGMSG", params: [target]});

		if (utf8ByteLength(line) > MAX_LINE_BYTES) {
			this.pushMessage(this.lobby, {
				type: MessageType.ERROR,
				text: "Not sent: the tags do not fit on one line",
			});
			return false;
		}

		if (!this.send(line)) {
			return false;
		}

		if (!this.caps.hasCapability("echo-message")) {
			this.handleLine(
				`${tagPrefix(tags)}:${this.nick}!${this.ident}@${
					this.host || "localhost"
				} TAGMSG ${target}`
			);
		}

		return true;
	}

	/**
	 * React to (or, with `remove`, take a reaction off) the message `msgid`
	 * in `chan`: `@+draft/react=<text>;+draft/reply=<msgid> TAGMSG` (bus-contract §1.4).
	 */
	react(chan: Channel, msgid: string, text: string, remove = false): boolean {
		if (!this.caps.hasCapability("message-tags")) {
			this.pushMessage(chan, {
				type: MessageType.ERROR,
				text: "Reactions need the message-tags capability, which this server did not enable.",
			});
			return false;
		}

		if (chan.type !== ChanType.CHANNEL && chan.type !== ChanType.QUERY) {
			this.pushMessage(chan, {
				type: MessageType.ERROR,
				text: "Reactions can only be sent in channels and queries.",
			});
			return false;
		}

		return this.sendTagmsg(chan.name, {
			[remove ? UNREACT_TAG : REACT_TAG]: text,
			[REPLY_TAG]: msgid,
		});
	}

	/**
	 * Announce our typing `state` in `chan` with `@+typing=<state> TAGMSG`
	 * (bus-contract §1.5). The UI reports unthrottled; this applies the
	 * spec's rule that two notifications to one target are at least
	 * {@link TYPING_INTERVAL_MS} apart:
	 *
	 * - `active` goes out at once when no typing session is announced (nothing
	 *   sent yet, or `done` / a message went out) or the last send is ≥ 3 s
	 *   old; otherwise it is dropped — the UI keeps reporting it, so the first
	 *   report after the 3 s re-sends it. It also cancels a scheduled
	 *   `paused`/`done`.
	 * - `paused`/`done` need an announced session and are sent once per
	 *   transition: at once when the last send is ≥ 3 s old, else scheduled
	 *   for `lastSentAt + 3 s` with the latest requested state winning.
	 *
	 * Nothing is sent to the lobby, without `message-tags`, or while not
	 * registered. `done` ends the session, as does {@link sendMessage} to the
	 * same target (without a `done`) and the connection closing.
	 */
	typing(chan: Channel, state: TypingState): void {
		if (
			chan.type === ChanType.LOBBY ||
			!this.connected ||
			!this.caps.hasCapability("message-tags")
		) {
			return;
		}

		const key = this.casefold(chan.name);
		const entry = this.typingState.get(key);
		const wait = entry ? entry.lastSentAt + TYPING_INTERVAL_MS - Date.now() : 0;

		if (state === "active") {
			if (entry) {
				this.cancelTypingTimer(entry);
			}

			if (wait <= 0) {
				this.sendTyping(chan.name, key, state);
			}

			return;
		}

		// A transition needs an announced session and must change something:
		// `paused` after `paused` or `done` after `done` is a no-op.
		if (!entry || (entry.wanted ?? entry.lastState) === state) {
			return;
		}

		if (wait <= 0) {
			this.cancelTypingTimer(entry);
			this.sendTyping(chan.name, key, state);
			return;
		}

		entry.wanted = state;

		if (!entry.timer) {
			entry.timer = setTimeout(() => {
				const wanted = entry.wanted;
				entry.timer = undefined;
				entry.wanted = undefined;

				if (wanted && this.typingState.get(key) === entry) {
					this.sendTyping(chan.name, key, wanted);
				}
			}, wait);
		}
	}

	private sendTyping(target: string, key: string, state: TypingState): void {
		if (!this.connected || !this.sendTagmsg(target, {[TYPING_TAG]: state})) {
			return;
		}

		if (state === "done") {
			this.typingState.delete(key);
			return;
		}

		const entry = this.typingState.get(key) ?? {lastSentAt: 0};
		entry.lastState = state;
		entry.lastSentAt = Date.now();
		this.typingState.set(key, entry);
	}

	private cancelTypingTimer(entry: TypingEntry): void {
		if (entry.timer) {
			clearTimeout(entry.timer);
			entry.timer = undefined;
		}

		entry.wanted = undefined;
	}

	/** Forget the typing session with `target`, if any (no `done` goes out). */
	private resetTyping(target: string): void {
		const key = this.casefold(target);
		const entry = this.typingState.get(key);

		if (entry) {
			this.cancelTypingTimer(entry);
			this.typingState.delete(key);
		}
	}

	private clearTyping(): void {
		for (const entry of this.typingState.values()) {
			this.cancelTypingTimer(entry);
		}

		this.typingState.clear();
	}

	/** Whether the server lets us send REDACT. */
	get canRedact(): boolean {
		return this.caps.hasCapability(REDACTION_CAP);
	}

	/**
	 * `REDACT <chan> <msgid> [:reason]`. Channels only, and only with
	 * `draft/message-redaction` negotiated; otherwise an error in `chan`.
	 */
	redact(chan: Channel, msgid: string, reason?: string): boolean {
		if (!this.canRedact) {
			this.pushMessage(chan, {
				type: MessageType.ERROR,
				text: "Deleting messages is not available: the server did not enable draft/message-redaction.",
			});
			return false;
		}

		if (chan.type !== ChanType.CHANNEL) {
			this.pushMessage(chan, {
				type: MessageType.ERROR,
				text: "Messages can only be deleted in channels.",
			});
			return false;
		}

		return this.send(
			reason
				? trailingLine("REDACT", [chan.name, msgid, reason])
				: formatLine({command: "REDACT", params: [chan.name, msgid]})
		);
	}

	/**
	 * Replace our own message `oldMsgid` with `text` (bus-contract §1.4).
	 * There is no edit on the wire, so in a channel where REDACT works the
	 * old message is redacted (`:edited`) first and the resend, tagged
	 * `+seance/edit=<old>`, goes out once our own REDACT is echoed back
	 * ({@link settleEdit}); `FAIL REDACT` ({@link rejectEdit}) or
	 * {@link EDIT_TIMEOUT_MS} without an answer abort it. In queries, or
	 * without the cap, only the tagged resend happens. Without
	 * `echo-message` the server never echoes our REDACT, so there is
	 * nothing to wait for: the REDACT is applied locally and the resend
	 * follows at once (a late `FAIL REDACT` then only shows as an error).
	 */
	editMessage(chan: Channel, oldMsgid: string, text: string, replyTo?: string): void {
		if (chan.type !== ChanType.CHANNEL || !this.canRedact) {
			this.sendEdit(chan, oldMsgid, text, replyTo);
			return;
		}

		if (!this.caps.hasCapability("echo-message")) {
			if (this.redact(chan, oldMsgid, "edited")) {
				this.handleLine(
					`:${this.nick}!${this.ident}@${this.host || "localhost"} REDACT ${
						chan.name
					} ${oldMsgid} :edited`
				);
				this.sendEdit(chan, oldMsgid, text, replyTo);
			}

			return;
		}

		if (this.pendingEdits.has(oldMsgid)) {
			this.pushMessage(chan, {
				type: MessageType.ERROR,
				text: "Edit not sent: an edit of that message is already waiting for the server.",
			});
			return;
		}

		if (!this.redact(chan, oldMsgid, "edited")) {
			return;
		}

		const timer = setTimeout(() => {
			if (this.pendingEdits.delete(oldMsgid)) {
				this.pushMessage(chan, {
					type: MessageType.ERROR,
					text: "Edit not sent: no reply from the server.",
				});
			}
		}, EDIT_TIMEOUT_MS);
		this.pendingEdits.set(oldMsgid, {chan, text, replyTo, timer});
	}

	/** The tagged resend that completes an edit. */
	private sendEdit(chan: Channel, oldMsgid: string, text: string, replyTo?: string): void {
		const opts: SendMessageOptions = {firstTags: {[EDIT_TAG]: oldMsgid}};

		if (replyTo) {
			opts.tags = {[REPLY_TAG]: replyTo};
		}

		this.sendMessage(chan.name, text, opts);
	}

	/** Our REDACT of `msgid` was echoed: send the edit waiting on it, if any. */
	settleEdit(msgid: string): void {
		const pending = this.takePendingEdit(msgid);

		if (pending) {
			this.sendEdit(pending.chan, msgid, pending.text, pending.replyTo);
		}
	}

	/** The REDACT of `msgid` failed: drop the edit waiting on it. Returns its channel. */
	rejectEdit(msgid: string): Channel | undefined {
		return this.takePendingEdit(msgid)?.chan;
	}

	/** Whether an edit of `msgid` is waiting for the server (tests / diagnostics). */
	hasPendingEdit(msgid: string): boolean {
		return this.pendingEdits.has(msgid);
	}

	private takePendingEdit(msgid: string): PendingEdit | undefined {
		const pending = this.pendingEdits.get(msgid);

		if (pending) {
			clearTimeout(pending.timer);
			this.pendingEdits.delete(msgid);
		}

		return pending;
	}

	private clearPendingEdits(): void {
		for (const pending of this.pendingEdits.values()) {
			clearTimeout(pending.timer);
		}

		this.pendingEdits.clear();
	}

	joinChannel(name: string, key = ""): void {
		this.send(formatLine({command: "JOIN", params: key ? [name, key] : [name]}));
	}

	/**
	 * JOIN several channels with as few lines as possible (`JOIN a,b,c k1,k2`):
	 * every command costs fake lag on ircu-family servers, so the autojoin
	 * list must not become one command per channel. Keys are positional, so
	 * keyed channels go first; lines respect `MAX_LINE_BYTES` and a
	 * `TARGMAX=JOIN:<n>` limit when the server advertises one.
	 */
	joinChannels(chans: {name: string; key?: string}[]): void {
		const limit = this.isupport.targmax.get("JOIN");
		const ordered = [...chans.filter((c) => c.key), ...chans.filter((c) => !c.key)];
		let names: string[] = [];
		let keys: string[] = [];

		const lineFor = (n: string[], k: string[]) =>
			formatLine({
				command: "JOIN",
				params: k.length ? [n.join(","), k.join(",")] : [n.join(",")],
			});

		const flush = () => {
			if (names.length > 0) {
				this.send(lineFor(names, keys));
				names = [];
				keys = [];
			}
		};

		for (const chan of ordered) {
			const nextNames = [...names, chan.name];
			const nextKeys = chan.key ? [...keys, chan.key] : keys;
			const tooMany = limit !== undefined && limit > 0 && nextNames.length > limit;

			if (
				names.length > 0 &&
				(tooMany || utf8ByteLength(lineFor(nextNames, nextKeys)) > MAX_LINE_BYTES)
			) {
				flush();
			}

			names.push(chan.name);

			if (chan.key) {
				keys.push(chan.key);
			}
		}

		flush();
	}

	/** Handle a line of user input typed into channel `chanId`. */
	input(chanId: number, text: string, opts: InputOptions = {}): void {
		const chan = this.channelById(chanId);

		if (chan) {
			dispatchInput(this, chan, text, opts);
		}
	}

	/** Id of the channel the UI is showing (0 for none). */
	get activeChannelId(): number {
		return this.activeChanId;
	}

	/**
	 * The UI opened `chanId` (or 0 for none): unread counters restart there,
	 * a pending catch-up is served now, and the channel modes are asked for
	 * the first time round.
	 */
	open(chanId: number): void {
		this.activeChanId = chanId;
		const chan = this.channelById(chanId);

		if (chan) {
			chan.shared.unread = 0;
			chan.shared.highlight = 0;
			scheduleMarkRead(this, chan);
			prioritiseCatchup(this, chan);

			if (
				chan.type === ChanType.CHANNEL &&
				chan.state === ChanState.JOINED &&
				!chan.modesKnown &&
				this.transport.state === "open"
			) {
				chan.modesKnown = true;
				this.send(formatLine({command: "MODE", params: [chan.name]}));
			}
		}
	}

	// -------------------------------------------------------------- inbound

	/** Parse and handle one inbound line (also used for local echo). */
	handleLine(line: string): void {
		const msg = parseLine(line);

		if (!msg || msg.command === "PING" || msg.command === "PONG") {
			return; // the transport answers PING itself
		}

		this.handleMessage(msg);
	}

	/**
	 * Route one parsed message: batch buffering first, then the handler for
	 * its command. Also the entry point for replaying buffered batch lines.
	 */
	handleMessage(msg: IrcMessage): void {
		// Learn our own ident@host from anything the server attributes to us.
		if (msg.source?.user !== undefined && this.isSelf(msg.source.name)) {
			this.ident = msg.source.user;

			if (msg.source.host) {
				this.host = msg.source.host;
			}
		}

		if (interceptBatchLine(this, msg)) {
			return;
		}

		// Our own JOIN (live, not replayed) is what triggers a history load;
		// the reference for a catch-up is the newest message before the JOIN.
		const selfJoin =
			msg.command === "JOIN" &&
			!this.replayContext &&
			msg.source !== undefined &&
			this.isSelf(msg.source.name);
		const joinName = selfJoin ? msg.params[0] ?? "" : "";
		const joined = selfJoin ? this.findChannel(joinName) : undefined;
		const beforeJoin: MsgRef | undefined = selfJoin ? joined?.newestRef : undefined;
		// A JOIN for a channel we are already in repeats a membership we have
		// (see handlers/join.ts): its history and modes are not asked again.
		const alreadyJoined = joined?.state === ChanState.JOINED;

		const handler = handlers.get(msg.command) ?? unhandled;

		try {
			handler(this, msg);
		} catch (err: unknown) {
			// eslint-disable-next-line no-console
			console.error(`[irc] handler for ${msg.command} failed on: ${msg.raw}`, err);
		}

		this.checkSts(msg);

		if (selfJoin && !alreadyJoined) {
			const chan = this.findChannel(joinName);

			// The ATTACH cursor's server-driven replay already covers the gap
			// of a channel the server restored; asking again per channel is
			// exactly what the cursor replaces (persistence.ts).
			if (chan && !serverReplayCovers(this, chan, beforeJoin)) {
				// History + read marker, paced (catchup.ts): the active channel
				// now, the rest one at a time so the server's flood penalty
				// never queues the user's own lines.
				enqueueCatchup(this, chan, beforeJoin);
			}
		}
	}

	/** `@time` tag as a Date, or now. */
	timeOf(msg: IrcMessage): Date {
		const tag = msg.tags.get("time");

		if (tag) {
			const time = new Date(tag);

			if (!Number.isNaN(time.getTime())) {
				return time;
			}
		}

		return new Date();
	}

	/** Record a nick change of our own and tell the UI. */
	setNick(nick: string): void {
		this.nick = nick;
		this.bus.dispatch("nick", {network: this.uuid, nick});
	}

	/** Record the network name from ISUPPORT and rename the lobby. */
	setNetworkName(name: string): void {
		if (name === this.networkName) {
			return;
		}

		this.networkName = name;
		this.lobby.shared.name = name;
		this.bus.dispatch("network:name", {uuid: this.uuid, name});
	}

	// -------------------------------------------------------------- helpers

	dispatch: EventBus["dispatch"] = (event, ...args) => this.bus.dispatch(event, ...args);

	casefold(s: string): string {
		return casefold(s, this.isupport.casemapping);
	}

	namesEqual(a: string, b: string): boolean {
		return namesEqual(a, b, this.isupport.casemapping);
	}

	isSelf(nick: string): boolean {
		return this.namesEqual(nick, this.nick);
	}

	isChannelName(name: string): boolean {
		return name.length > 0 && this.isupport.chantypes.includes(name[0]);
	}

	/** Position of a prefix symbol in PREFIX (0 = most privileged); unknown → large. */
	prefixRank(symbol: string): number {
		const idx = this.isupport.prefix.symbols.indexOf(symbol);
		return idx === -1 ? 1000 : idx;
	}

	/** Whether `text` mentions our nick or a custom highlight keyword. */
	isHighlight(text: string): boolean {
		const {keywords, exceptions} = this.options.highlights?.() ?? {
			keywords: [],
			exceptions: [],
		};
		return isHighlight(text, this.nick, keywords, exceptions);
	}

	findChannel(name: string): Channel | undefined {
		return this.channels.find((chan) => this.namesEqual(chan.name, name));
	}

	channelById(id: number): Channel | undefined {
		return this.channels.find((chan) => chan.id === id);
	}

	/**
	 * Create a channel/query and insert it alphabetically after the lobby
	 * (the index is what `join` needs; always >= 1).
	 */
	createChannel(
		name: string,
		type: ChanType,
		options: {state?: ChanState; key?: string} = {}
	): {channel: Channel; index: number} {
		const channel = new Channel(
			this.ids.chanId(),
			name,
			type,
			(s) => this.casefold(s),
			options
		);
		let index = this.channels.length;

		for (let i = 1; i < this.channels.length; i++) {
			const other = this.channels[i];
			const sortable = other.type === ChanType.CHANNEL || other.type === ChanType.QUERY;

			if (!sortable || compareNames(name, other.name) <= 0) {
				index = i;
				break;
			}
		}

		this.channels.splice(index, 0, channel);
		return {channel, index};
	}

	/** Create + announce (`join` event) a channel or query. */
	announceChannel(
		name: string,
		type: ChanType,
		options: {state?: ChanState; key?: string; shouldOpen?: boolean} = {}
	): Channel {
		const {channel, index} = this.createChannel(name, type, options);
		this.bus.dispatch("join", {
			network: this.uuid,
			chan: channel.snapshot(),
			index,
			shouldOpen: options.shouldOpen ?? false,
		});
		return channel;
	}

	/** Drop a channel from the model and the UI (`part` event). */
	removeChannel(chan: Channel): void {
		const idx = this.channels.indexOf(chan);

		if (idx > 0) {
			this.channels.splice(idx, 1);
		}

		if (this.activeChanId === chan.id) {
			this.activeChanId = 0;
		}

		dropFromCatchup(this, chan);
		this.bus.dispatch("part", {chan: chan.id});
	}

	/**
	 * Allocate an id, keep the unread counters and dispatch `msg`. Mirrors
	 * `Chan.pushMessage` in the old server.
	 */
	pushMessage(chan: Channel, partial: Partial<SharedMsg>, increasesUnread = false): SharedMsg {
		const msg: SharedMsg = {
			users: [],
			...partial,
			id: 0,
			time: partial.time ?? new Date(),
		};

		if (this.replayContext) {
			// History replay: collect, the caller allocates ids and delivers.
			this.replayContext.collected.messages.push({chan, msg});
			return msg;
		}

		msg.id = this.ids.msgId();
		const ref = chan.remember(msg);
		chan.newestRef = ref;
		this.noteCursor(msg);
		const shared = chan.shared;
		shared.totalMessages++;
		// Already read on another session (draft/read-marker), e.g. a catch-up.
		const read =
			chan.readMarker !== undefined && ref.time.getTime() <= chan.readMarker.getTime();

		if (msg.self) {
			shared.unread = 0;
			shared.highlight = 0;
			shared.firstUnread = msg.id;

			// Something we said is read by definition; our own JOIN/MODE
			// echoes are not (a reconnect must not advance the marker).
			if (SELF_READ_TYPES.has(msg.type ?? MessageType.MESSAGE)) {
				scheduleMarkRead(this, chan);
			}
		} else if (chan.id === this.activeChanId) {
			scheduleMarkRead(this, chan);
		} else if (!read) {
			if (!shared.firstUnread) {
				shared.firstUnread = msg.id;
			}

			if (increasesUnread || msg.highlight) {
				shared.unread++;
				ref.unread = true;
			}

			if (msg.highlight) {
				shared.highlight++;
				ref.highlight = true;
			}
		}

		this.bus.dispatch("msg", {
			chan: chan.id,
			msg,
			unread: shared.unread,
			highlight: shared.highlight,
		});
		return msg;
	}

	/**
	 * Run `fn` with every `pushMessage` collected instead of dispatched, and
	 * handlers told (via {@link replaying}) to skip state side effects. Used
	 * to turn a chathistory batch into messages (history.ts).
	 */
	collectReplay(target: Channel, fn: () => void): ReplayCollection {
		const previous = this.replayContext;
		const context = {target, collected: {messages: [], after: []} as ReplayCollection};
		this.replayContext = context;

		try {
			fn();
		} finally {
			this.replayContext = previous;
		}

		return context.collected;
	}

	/**
	 * Run `fn` once the messages of the current replay are delivered (ids
	 * allocated, msgid map filled) — or right away when not replaying. This
	 * is how `msg:react` / `msg:redact` / `msg:edit` keep the contract's
	 * ordering guarantee: they always follow the `msg` they refer to.
	 */
	afterReplay(fn: () => void): void {
		if (this.replayContext) {
			this.replayContext.collected.after.push(fn);
		} else {
			fn();
		}
	}

	/** True inside {@link collectReplay}: handlers must not touch channel state. */
	get replaying(): boolean {
		return this.replayContext !== null;
	}

	/** The channel whose history is being replayed (for QUIT/NICK, which name none). */
	get replayTarget(): Channel | undefined {
		return this.replayContext?.target;
	}

	/** Ids for `count` older messages, below everything shown so far (see ids.ts). */
	historyIds(count: number): number[] {
		return this.ids.historyIds(count);
	}

	/**
	 * Remember `msg` as the newest thing we have shown, if it is. The
	 * catch-up cursor is the globally newest msgid over every channel and
	 * query, picked by time so a page of older history (`more`, the LATEST
	 * fill) can never move it backwards. Called wherever a message gets its
	 * id: {@link pushMessage} for live and appended messages, history.ts for
	 * prepended ones.
	 */
	noteCursor(msg: SharedMsg): void {
		if (!msg.msgid) {
			return;
		}

		const time = (msg.time instanceof Date ? msg.time : new Date(msg.time)).getTime();

		if (Number.isNaN(time) || (this.cursor && this.cursor.time >= time)) {
			return;
		}

		this.cursor = {msgid: msg.msgid, time};

		if (this.cursorTimer === null) {
			// Trailing throttle: a busy channel must not write localStorage
			// once per line.
			this.cursorTimer = setTimeout(() => {
				this.cursorTimer = null;
				this.saveCursor();
			}, CURSOR_SAVE_INTERVAL_MS);
		}
	}

	/** Write the cursor now, throttle or not (the connection is going away). */
	private saveCursor(): void {
		if (this.cursorTimer !== null) {
			clearTimeout(this.cursorTimer);
			this.cursorTimer = null;
		}

		if (this.cursor) {
			// A network the user never saved has nowhere to keep it: skip.
			setCursor(this.uuid, this.cursor);
		}
	}

	/** Tell the UI a channel's user list changed (it will ask `names`). */
	usersChanged(chan: Channel): void {
		this.bus.dispatch("users", {chan: chan.id});
	}
}

// ----------------------------------------------------------------- utilities

function compareNames(a: string, b: string): number {
	return a.localeCompare(b, undefined, {sensitivity: "base"});
}

function sanitizeIdent(nick: string): string {
	const ident = nick.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 10);
	return ident || "seance";
}

/** `host[:port][/path]` with an optional scheme → hostname only. */
function hostnameOf(host: string): string {
	const stripped = host.replace(/^(?:wss?|https?|ircs?):\/\//i, "");
	const slash = stripped.indexOf("/");
	return slash === -1 ? stripped : stripped.slice(0, slash);
}

export function buildUrl(host: string, port: number, tls: boolean): string {
	const stripped = host.trim().replace(/^(?:wss?|https?|ircs?):\/\//i, "");
	const slash = stripped.indexOf("/");
	let hostname = slash === -1 ? stripped : stripped.slice(0, slash);
	const path = slash === -1 ? "/" : stripped.slice(slash);

	if (hostname.includes(":") && !hostname.startsWith("[")) {
		hostname = `[${hostname}]`; // bare IPv6 literal
	}

	return `${tls ? "wss" : "ws"}://${hostname}:${port}${path}`;
}

/** The cursor stored for `uuid`, if the network was saved and has one. */
function savedCursor(uuid: string): NetworkCursor | undefined {
	try {
		return getSavedNetwork(uuid)?.cursor;
	} catch (err: unknown) {
		return undefined;
	}
}

/** A readable, stable id so per-network preferences survive reloads. */
export function deriveUuid(host: string, port: number, nick: string): string {
	const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9.-]+/g, "_");
	return `${clean(hostnameOf(host))}-${port}-${clean(nick)}`;
}

/** `"#a key, b, #c"` → channels with optional keys; a missing prefix gets `#`. */
export function parseJoinList(join: string): {name: string; key: string}[] {
	const result: {name: string; key: string}[] = [];

	for (const entry of join.split(",")) {
		const [rawName, key = ""] = entry.trim().split(/\s+/);

		if (!rawName) {
			continue;
		}

		const name = CHANNEL_PREFIXES.includes(rawName[0]) ? rawName : `#${rawName}`;

		if (!result.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
			result.push({name, key});
		}
	}

	return result;
}
