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
import {t} from "../i18n/core";
import {collator} from "../i18n/collation";
import {brandingFeatures} from "../branding";
import {dialGateFor, type DialGate} from "./dialLedger";
import {createHighlightTester} from "../highlight";
import {ChanState, ChanType} from "../../../shared/types/chan";
import {MessageType, SharedMsg, TypingState} from "../../../shared/types/msg";
import type {
	ServicesConfig,
	SharedNetwork,
	SharedNetworkPresence,
	SharedNetworkStatus,
	SharedServerOptions,
} from "../../../shared/types/network";
import type {PushSession, ServerToClientEvents} from "../../../shared/types/socket-events";
import {CapNegotiator, SEANCE_CAPS, webpushVapidOf, WEBPUSH_CAP} from "./caps";
import {casefold, namesEqual} from "./casemap";
import {Channel, MsgRef, SAID_TYPES, countsAsUnread} from "./channel";
import {QueryLog} from "./querylog";
import {commandNames, dispatchInput} from "./commands";
import {describeClose} from "./disconnect";
import {handlers, unhandled} from "./handlers";
import {FILEHOST_SERVICE, TokenRequests, filehostUrlOf} from "./authtoken";
import {interceptBatchLine, resetBatches} from "./handlers/batch";
import {PAYLOAD_KEY} from "./handlers/metadata";
import {CLOSED_KEY, ClosedQueries, closedQueriesKept, encodeClosed} from "./closedQueries";
import {
	CONCAT_LINE_TAG_BYTES,
	MULTILINE_CAP,
	MultilineLimits,
	MultilinePlan,
	parseMultilineValue,
	planMultiline,
	resetMultiline,
	sendMultiline,
} from "./multiline";
import {
	applyReadMarker,
	cancelMarkRead,
	countPageUnread,
	flushDeferredMarkRead,
	markReadAt,
	markable,
	readNow,
	scheduleMarkRead,
} from "./handlers/markread";
import {entryFor} from "../helpers/inbox";
import type {InboxEntry} from "../../../shared/types/mention";
import {
	effectiveMode,
	type GlobalModeState,
	type NetworkMode,
	type PresenceMode,
} from "../helpers/dnd";
import {
	PresenceState,
	initialPresence,
	presenceClosed,
	presenceRegistered,
	registrationAwayLine,
	presenceSnapshot,
	setAttended,
	syncPresence,
} from "./presence";
import {abortHistory, retryLostHistory} from "./history";
import {globalUntil, MUTE_KEY, MUTE_READ_DELAY_MS, type PendingMute, releaseMute} from "./pushMute";
import {MODE_KEY, PRESENCE_KEY, syncShared, type Stamped} from "./presenceShare";
import {getMuteMemory, setMuteMemory, type MuteMemory} from "./muteMemory";
import {STAMP_EVERY_MS, lastInSync, mayHaveMissed, setInSync} from "./presenceSync";
import {getUserAway} from "./userAwayStore";
import {
	cancelCatchup,
	dropFromCatchup,
	enqueueCatchup,
	noteJoinsSent,
	enqueueMarkerFetch,
	releaseMarkers,
	prefetchCatchup,
	prioritiseCatchup,
	queueModes,
} from "./catchup";
import {
	attachCursorLine,
	awaitRestoration,
	beginSettling,
	cancelRestoration,
	persistenceEnableLine,
	PERSISTENCE_CAP,
	RESTORE_QUIET_MS,
	serverReplayCovers,
} from "./persistence";
import {IdAllocator, sharedIds} from "./ids";
import {NoticeLog} from "./noticelog";
import {initialOper, OperState, operRegistered, resetOper} from "./oper";
import {detectProfile, type ServerProfile} from "./profiles";
import {interceptRequestLine, resetRequests} from "./request";
import {noticeMessage} from "./snotice";
import {ISupport} from "./isupport";
import {
	formatLine,
	IrcMessage,
	MAX_LINE_BYTES,
	parseLine,
	splitMessage,
	utf8ByteLength,
} from "./message";
import {LABEL_TAG_BYTES, pendingLabel, resetPending, showPending} from "./pending";
import {splitStatusTarget} from "./handlers/privmsg";
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
import {channelOrder, get as getSavedNetwork, NetworkCursor, setCursor} from "./saved-networks";
import {noteServiceReply, resetServiceReplies} from "./services";
import {dropQuietLine} from "./quiet";
import {BackgroundQueue, FakeLagClock, type FakeLagModel} from "./fakelag";
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
	/** The server's flood rule as we model it (fakelag.ts); ircu's by default. */
	fakeLag?: FakeLagModel;
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
	/**
	 * A SASL login the deploy insists on was refused, so this connect was
	 * dropped. The manager stands the saved network's `autoconnect` down:
	 * credentials the server has already refused would fail again at every
	 * page load, and an autoconnecting entry that never registers leaves no
	 * way back to the connect screen to fix them.
	 */
	onSaslRejected?: () => void;
}

/** What to try after a SASL login the deploy insists on did not happen. */
export function saslRequiredHint(): string {
	return t("connect.saslRequiredHint");
}

/** Prefix characters a channel name may start with when the user omits one. */
const CHANNEL_PREFIXES = "#&!+";

/** A `+typing` TAGMSG: one command of fake lag. */
const TYPING_COST_MS = 2000;

export class IrcClient {
	readonly uuid: string;
	/** Replaced (not mutated) when an STS upgrade changes port/tls, see {@link reconfigure}. */
	options: Readonly<IrcClientOptions>;
	/** Swapped for a new one on an STS upgrade; always subscribed via {@link reconfigure}. */
	transport: Transport;
	readonly isupport = new ISupport();
	/** NICKLEN as registration learned it before 005 (`handlers/numerics.ts`);
	 * cleared with ISUPPORT, since the next connection may be another server. */
	learnedNickLen: number | undefined;
	/** Attention and away bookkeeping (presence.ts). */
	readonly presence: PresenceState = initialPresence();
	/** Online / Auto / Away / Do not disturb (docs/projects/do-not-disturb.md). */
	/** This network's own mode; `global` follows the pill (helpers/dnd.ts effectiveMode). */
	presenceMode: NetworkMode = "global";
	/** When `presenceMode` was chosen (Unix ms); undefined = never (presenceShare.ts). */
	presenceAt: number | undefined = undefined;
	/** The pill's global mode (client/js/dnd.ts, manager.setGlobalModeAll). */
	globalMode: GlobalModeState = {value: "auto", at: null};
	/** The shared mode / switch was read on this connection, and the server's last value. */
	presenceKnown = false;
	presenceServer: Stamped | null = null;
	globalKnown = false;
	globalServer: Stamped | null = null;
	/**
	 * The mute and the shared keys are subscribed on this connection: before
	 * `CAP END` when the server offers `draft/metadata-2=before-connect` and
	 * a SASL login succeeded, so a change another device makes the moment we
	 * register is not missed (nefarious2 answers a later GET from this
	 * connection's own copy, which a missed change leaves stale); else with
	 * the login read.
	 */
	metadataSubscribed = false;
	/**
	 * That subscription went out before `CAP END`, so the server sends the
	 * account's subscribed keys at registration (handlers/metadata.ts
	 * metadataBatch) and presence.ts holds this connection away until then.
	 */
	metadataBeforeConnect = false;
	/** The last line received while in sync with the shared state (irc/presenceSync.ts). */
	private syncLineAt: number | null = null;
	/** When {@link syncLineAt} was last written down. */
	private syncStampedAt = 0;
	/** The global do-not-disturb, fed by client/js/dnd.ts. */
	globalDnd: {active: boolean; until: number | null} = {active: false, until: null};
	/** The account's push mute list as last read or written (irc/pushMute.ts). */
	muteValue = "";
	/** `muteValue` has been read on this connection (GET answered). */
	muteKnown = false;
	/**
	 * The `*` end (unix seconds) this client last wrote, null once cleared or
	 * taken over, and the last of those the server echoed back. Both are kept
	 * across a reconnect and, per device, a reload (irc/muteMemory.ts), so
	 * the next GET can tell our own entry from another device's.
	 */
	private muteMemory: MuteMemory = {ownedUntil: null, confirmedUntil: null};
	get muteOwnedUntil(): number | null {
		return this.muteMemory.ownedUntil;
	}
	set muteOwnedUntil(until: number | null) {
		this.rememberMute({...this.muteMemory, ownedUntil: until});
	}
	get muteConfirmedUntil(): number | null {
		return this.muteMemory.confirmedUntil;
	}
	set muteConfirmedUntil(until: number | null) {
		this.rememberMute({...this.muteMemory, confirmedUntil: until});
	}
	/** The user changed DND by hand: the next sync takes the live `*` entry as ours (pushMute.ts `claimMute`). */
	muteClaim = false;
	/** Another device cleared our entry: write nothing until local DND ends and starts again. */
	muteSuppressed = false;
	/** Our writes awaiting their echoes (pushMute.ts `ownEcho`). */
	readonly mutePending: PendingMute[] = [];
	private muteReadTimer: ReturnType<typeof setTimeout> | null = null;

	private rememberMute(next: MuteMemory): void {
		if (
			next.ownedUntil !== this.muteMemory.ownedUntil ||
			next.confirmedUntil !== this.muteMemory.confirmedUntil
		) {
			this.muteMemory = next;
			setMuteMemory(this.uuid, next, Math.floor(Date.now() / 1000));
		}
	}

	/** The live `*` entry is the one this client wrote. */
	get muteOwned(): boolean {
		return (
			this.muteOwnedUntil !== null &&
			globalUntil(this.muteValue, Math.floor(Date.now() / 1000)) === this.muteOwnedUntil
		);
	}

	/** A live `*` entry in the account's push mute list (another device's DND, or ours). */
	get remoteDnd(): boolean {
		return (
			this.muteKnown && globalUntil(this.muteValue, Math.floor(Date.now() / 1000)) !== null
		);
	}
	/** Outstanding `TOKEN GENERATE` requests (draft/authtoken). */
	readonly authtoken = new TokenRequests();
	readonly channels: Channel[] = [];
	readonly lobby: Channel;
	/** Private conversations kept on this device (querylog.ts). */
	readonly queryLog: QueryLog;
	/** The queries the user closed: a line from before the close never reopens one. */
	readonly closed: ClosedQueries;
	/** This connection's GET of the shared closes answered (irc/closedQueries.ts). */
	closedKnown = false;
	/** A close waits for that answer before it is written. */
	closedPending = false;

	/** This connection will read the account's closed queries but has not yet. */
	get closedReadAhead(): boolean {
		return !this.closedKnown && !!this.account && this.caps.hasCapability("draft/metadata-2");
	}
	/** Server notices and WALLOPS kept on the device (noticelog.ts). */
	readonly noticeLog: NoticeLog;
	/** Being an oper here (oper.ts): level, privileges, snomask. */
	oper: OperState = initialOper();
	/** The version the server reports in 004, for {@link profile}. */
	serverVersion: string | undefined;
	/** The name of the server we are connected to (004). */
	serverName: string | undefined;
	/**
	 * The network's services, as the oper set them up (services.ts,
	 * servicesfeed.ts): read from the saved network, changed by the edit
	 * form through {@link setServices}. Undefined: none configured.
	 */
	services: ServicesConfig | undefined;
	/** Query windows brought back from the log, filled on the first announce. */
	private restoredQueries: Channel[] = [];
	caps = new CapNegotiator(SEANCE_CAPS);

	/** Our current nick as the server knows it (or the one we asked for). */
	nick: string;
	ident: string;
	/** Our visible host; empty until the server tells us (JOIN echo, 396, CHGHOST). */
	host = "";
	/** MOTD lines being collected between 375 and 376. */
	motdBuffer: string[] | null = null;
	/** Counter behind {@link nextBatchRef}. */
	private batchRefs = 0;
	/** The SASL exchange in progress during registration, if any. */
	sasl: SaslAuth | null = null;
	/** The last SASL exchange ended successfully (903); a configured login
	 * that was asked for and succeeded. Drives the push-subscribe prompt. */
	saslOk = false;
	/** Services account we are logged in as (900/901); "" when not. */
	account = "";
	/** The server holds our session across disconnects (`PERSISTENCE STATUS ON`, see persistence.ts). */
	persistenceHold = false;
	/** This network's host in the dial ledger (irc/dialLedger.ts). */
	private dialLedger: DialGate | null = null;
	/** The user's setting from the last `PERSISTENCE STATUS` line (`ON`,
	 * `OFF`, `DEFAULT`), undefined before one. An alias of another device's
	 * session reads `ON OFF`: not held itself, though the session is. */
	persistenceSetting: string | undefined = undefined;
	/** `NOTE BOUNCER ALIAS_ATTACHED` on this connection: it joined another
	 * device's live session as an alias (presence.ts `heldByBouncer`). */
	bouncerAlias = false;
	/** Our registration-time `PERSISTENCE SET ON` ack is pending (swallowed
	 * by handlers/persistence.ts until the STATUS echo lands). */
	persistenceAutoSetPending = false;
	/** Buffer for `PERSISTENCE LIST`'s SESSION lines until ENDOFLIST closes
	 * the batch (Settings → session panel). */
	persistenceListBuf: PushSession[] | undefined = undefined;
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
	/** 001 seen on this connection: the server takes commands (`isWelcomed`). */
	private welcomed = false;
	/** The server's fake-lag clock as we reckon it (fakelag.ts). */
	readonly fakeLag: FakeLagClock;
	/**
	 * Work nobody is waiting for — catch-up, read markers, mode queries,
	 * push renewal — sent only while {@link fakeLag} leaves the user room.
	 */
	readonly background: BackgroundQueue;
	/** Tells {@link whenRoom}'s jobs apart. */
	private roomWaits = 0;
	private announced = false;
	private quitting = false;
	/** Last transport error text for the close report; browsers say nothing useful. */
	private lastTransportError?: string;
	/** The close report's hint is shown once per attempt series, not per retry. */
	private closeHintShown = false;
	/** The close about to arrive is ours and the lobby already says why (transport.abandon). */
	private closeExplained = false;
	/** When the transport's next automatic dial is due; only while waiting for a retry. */
	private retryAt: number | undefined;
	/** That wait is the server's connection throttle, not the backoff (irc/dialLedger.ts). */
	private retryThrottled = false;
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
		this.fakeLag = new FakeLagClock(options.fakeLag);
		this.background = new BackgroundQueue(this.fakeLag, () => this.isWelcomed);
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
		this.muteMemory = getMuteMemory(this.uuid);
		// A `/away` set before the reload is declared again at registration.
		const away = getUserAway(this.uuid);

		if (away !== null) {
			this.presence.userAway = true;
			this.presence.userAwayText = away;
		}

		this.services = getSavedNetwork(this.uuid)?.services;
		this.lobby = new Channel(this.ids.chanId(), this.networkName, ChanType.LOBBY, (s) =>
			this.casefold(s)
		);
		this.channels.push(this.lobby);

		for (const {name, key} of parseJoinList(options.join)) {
			const {channel} = this.createChannel(name, ChanType.CHANNEL, {key});
			channel.autoJoin = true;
		}

		// The private conversations of the last page come back as windows,
		// as the autojoin channels do; their lines follow the announce.
		this.queryLog = new QueryLog(
			this.uuid,
			(s) => this.casefold(s),
			() => getSavedNetwork(this.uuid) !== undefined
		);

		this.noticeLog = new NoticeLog(this.uuid, () => getSavedNetwork(this.uuid) !== undefined);
		this.closed = new ClosedQueries(this.uuid, (s) => this.casefold(s));

		for (const name of this.queryLog.names()) {
			const newest = this.queryLog.newestAt(name);

			// Closed in another tab since this log was written.
			if (newest !== undefined && this.closed.suppresses(name, new Date(newest))) {
				this.queryLog.forget(name);
				continue;
			}

			if (!this.findChannel(name) && !this.isChannelName(name)) {
				const {channel} = this.createChannel(name, ChanType.QUERY);
				channel.autoOpened = true;
				this.restoredQueries.push(channel);
			}
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

	/**
	 * The server has welcomed this connection (001): from here on it takes
	 * commands. Before it, anything but the registration exchange (CAP,
	 * AUTHENTICATE, NICK/USER, PING, PERSISTENCE, QUIT) is answered with
	 * `451 Register first.` — so a sender that may fire while a reconnect
	 * is still registering (a debounced MARKREAD, a history page) checks
	 * this, not the transport. Earlier than {@link isConnected}, which waits
	 * for the end of the MOTD.
	 */
	get isWelcomed(): boolean {
		return this.welcomed && this.transport.state === "open";
	}

	/** The 001 handler: see {@link isWelcomed}. */
	markWelcomed(): void {
		this.welcomed = true;
		this.fakeLag.start();
		this.background.pump(); // anything queued before 001 can go now
	}

	get name(): string {
		return this.networkName;
	}

	/** The ircd family this server belongs to (profiles/): what the oper tools speak. */
	get profile(): ServerProfile {
		return detectProfile(this.serverVersion, this.isupport);
	}

	/** True between our own QUIT/disconnect and the transport closing. */
	get isQuitting(): boolean {
		return this.quitting;
	}

	/**
	 * The upload host the network advertises (`draft/FILEHOST` ISUPPORT,
	 * or soju's `soju.im/FILEHOST`), usable from this connection; undefined
	 * when there is none. Read at 005 and after a reconnect.
	 */
	filehostUrl(): string | undefined {
		return filehostUrlOf(this.isupport, this.options.tls);
	}

	/**
	 * Ask the server for a `draft/authtoken` token for `service` (the
	 * upload host: `FILEHOST`), scoped to `scope` (a channel) when given.
	 * Resolves with the opaque token; rejects with a `TokenError` on
	 * `FAIL TOKEN …`, timeout or disconnect.
	 */
	generateToken(service = FILEHOST_SERVICE, scope?: string): Promise<string> {
		return this.authtoken.request(service, () =>
			this.send(scope ? `TOKEN GENERATE ${service} ${scope}` : `TOKEN GENERATE ${service}`)
		);
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
			FILEHOST: this.filehostUrl(),
		};
	}

	/** The connection state as the UI sees it; `retryAt` only while a retry is pending. */
	private get status(): SharedNetworkStatus {
		return {
			connected: this.connected,
			connecting: this._state === "connecting" || this._state === "registering",
			secure: this.options.tls,
			...(this.retryAt !== undefined ? {retryAt: this.retryAt} : {}),
			...(this.retryThrottled ? {retryThrottled: true} : {}),
		};
	}

	/** `network:status` for the current state. */
	private announceStatus(): void {
		this.bus.dispatch("network:status", {network: this.uuid, ...this.status});
	}

	/** The `SharedNetwork` snapshot the UI is given (channels carry no messages). */
	get network(): SharedNetwork {
		return {
			uuid: this.uuid,
			name: this.networkName,
			nick: this.nick,
			serverOptions: this.serverOptions,
			status: this.status,
			presence: presenceSnapshot(this),
			channels: this.channels.map((chan) => chan.snapshot()),
			...(this.services ? {services: this.services} : {}),
		};
	}

	/** The services setting changed (`network:edit`); takes effect at once. */
	setServices(services: ServicesConfig | undefined): void {
		this.services = services;
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

	/** Announce the network to the UI (first call only) and open the
	 * transport; `force` (the user asked) dials even into the throttle. */
	connect(opts: {force?: boolean} = {}): void {
		if (!this.announced) {
			this.announced = true;
			this.bus.dispatch("network", {network: this.network});
			this.restoreQueryLines();
			void this.restoreNotices();
		}

		if (this.transport.state === "open" || this.transport.state === "connecting") {
			return;
		}

		this.applyPendingOptions();
		this.applyStsPolicy();
		this.quitting = false;
		this.closeHintShown = false;
		this.retryAt = undefined;
		this.retryThrottled = false;
		this._state = "connecting";
		this.bus.dispatch("connecting");
		this.announceStatus();
		this.pushMessage(
			this.lobby,
			{text: t("connect.connectingTo", {host: this.options.host, port: this.options.port})},
			true
		);
		this.transport.connect(opts);
	}

	/**
	 * Send QUIT and close without reconnecting; the network stays in the UI.
	 * Also cancels a pending reconnect.
	 */
	disconnect(reason?: string): void {
		this.quitting = true;
		const state = this.transport.state;

		if (state === "open") {
			// The reason is the user's text: a line break or a long paste must
			// not stop the close below, so it is flattened and cut to fit.
			const text = (reason ?? "Seance").replace(/[\r\n\0]+/g, " ");
			const [fits = ""] = splitMessage(utf8ByteLength("QUIT :"), text);
			this.send(trailingLine("QUIT", [fits]));
		}

		this.transport.close();
		this.retryAt = undefined;
		this.retryThrottled = false;

		if (state === "reconnect-wait") {
			// The socket is already gone, so no close event follows: settle here.
			this._state = "disconnected";
			this.announceStatus();
			this.pushMessage(this.lobby, {text: t("connect.reconnectCancelled")}, true);
		}
	}

	/** `/quit`: remove the network from the UI, then disconnect for good. */
	quit(reason?: string): void {
		// Before the QUIT, on the same socket: our do not disturb goes too.
		releaseMute(this);
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

		// Never dial into the server's connection throttle (irc/dialLedger.ts).
		// A drop counts there only when the server lets the connection go: a
		// session the bouncer holds stays counted (bounce_hold_client never
		// calls IPcheck_disconnect), so its drop restarts nothing.
		const ledger = dialGateFor(this.options.host);
		this.dialLedger = ledger;
		transportOptions.gate = {
			waitMs: (now) => ledger.waitMs(now),
			record: (at) => ledger.record(at),
			closed: (at) => {
				if (!this.persistenceHold) {
					ledger.closed(at);
				}
			},
		};

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
		this.pushMessage(this.lobby, {text: t("connect.stsUpgrade", {port: upgraded.port})}, true);
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
		this.pushMessage(this.lobby, {text: t("connect.stsReconnect", {port: value.port})}, true);
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
				this.noteSyncLine();
				this.handleLine(ev.line);
				break;
			case "close":
				this.onClose(ev.code, ev.reason, ev.willReconnect, ev.delayMs);
				break;
			case "reconnecting":
				this._state = "connecting";
				this.bus.dispatch("connecting");

				// The server's throttle, waited out (irc/dialLedger.ts): a
				// connect() that never dialled has no close to carry its due time.
				if (ev.throttled) {
					this.retryAt = Date.now() + ev.delayMs;
					this.retryThrottled = true;
					this.announceStatus();
				}

				this.pushMessage(
					this.lobby,
					{
						// A stable connection's loss retries at once (transport.ts).
						text: ev.throttled
							? t("connect.reconnectWaitThrottled", {
									seconds: Math.round(ev.delayMs / 1000),
									attempt: ev.attempt,
							  })
							: ev.delayMs < 500
							? t("connect.reconnectNow", {attempt: ev.attempt})
							: t("connect.reconnectIn", {
									seconds: Math.round(ev.delayMs / 1000),
									attempt: ev.attempt,
							  }),
					},
					true
				);
				break;
			case "retry":
				// The scheduled retry is dialling now: no due time any more.
				this._state = "connecting";
				this.retryAt = undefined;
				this.retryThrottled = false;
				this.announceStatus();
				this.pushMessage(
					this.lobby,
					{
						text: t("connect.connectingToAttempt", {
							host: this.options.host,
							port: this.options.port,
							attempt: ev.attempt,
						}),
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
		this.welcomed = false;
		this.fakeLag.stop();
		this.retryAt = undefined;
		this.retryThrottled = false;
		this.closeHintShown = false;
		this.isupport.reset();
		this.learnedNickLen = undefined;
		this.authtoken.clear("Reconnecting");
		this.motdBuffer = null;
		this.host = "";
		this.account = "";
		this.persistenceHold = false;
		this.persistenceSetting = undefined;
		this.bouncerAlias = false;
		this.attachCursor = undefined;
		this.serverReplay = false;
		this.endSasl();

		// SASL was picked for this network but there is nothing to log in
		// with: say so before registering as a stranger.
		if (
			this.options.sasl &&
			!this.saslMechanism &&
			this.saslFailed(t("connect.saslReason.noCredentials"))
		) {
			return;
		}

		this.caps = this.createCaps();

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

	/**
	 * Deploy policy: when the user picked SASL, does the login have to
	 * succeed for the connection to go ahead? `config.json`'s
	 * `features.saslDisconnectOnFail` (default true) decides; a caller may
	 * override it per network through {@link ConnectOptions}.
	 */
	private get saslRequired(): boolean {
		return this.options.saslDisconnectOnFail ?? brandingFeatures().saslDisconnectOnFail;
	}

	/**
	 * SASL was asked for and did not succeed. Always reported — silently
	 * registering as a stranger when the user asked to log in hides
	 * everything from a typo in the password to services being down — and,
	 * unless the deploy turned {@link saslRequired} off, never carried on
	 * with: QUIT instead of connecting unauthenticated.
	 *
	 * What comes after the QUIT depends on what failed. A rejection (904, a
	 * server without the cap, a NAK, missing credentials) will not change
	 * on a retry, so the network stays down. A `timedOut` exchange is the
	 * server or its services being slow — the phone coming back to a poor
	 * link, a lagging services link — and retrying is exactly right: the
	 * socket is dropped as lost (`transport.abandon`) and the usual
	 * reconnect follows, so the foreground poke and the schedule keep
	 * working on it instead of leaving the network for the user to reconnect
	 * by hand.
	 *
	 * Returns true when it dropped the connection, so callers stop there.
	 */
	private saslFailed(reason: string, timedOut = false): boolean {
		this.pushMessage(
			this.lobby,
			{type: MessageType.ERROR, text: t("connect.saslFailed", {reason})},
			true
		);

		if (!this.saslRequired) {
			return false;
		}

		if (timedOut && this.transport.abandon) {
			this.pushMessage(
				this.lobby,
				{
					type: MessageType.ERROR,
					text: t("connect.saslQuitHintRetry", {host: this.options.host}),
				},
				true
			);

			if (this.transport.state === "open") {
				this.transport.send(trailingLine("QUIT", ["SASL authentication failed"]));
			}

			this.closeExplained = true;
			this.transport.abandon("SASL timed out");
			return true;
		}

		this.pushMessage(
			this.lobby,
			{
				type: MessageType.ERROR,
				text: t("connect.saslQuitHint", {host: this.options.host}),
			},
			true
		);
		this.pushMessage(this.lobby, {text: saslRequiredHint()}, true);
		// The connect flow has already opened an autojoin channel; the reason
		// this network is empty is in the lobby, so the view goes there.
		this.bus.dispatch("network:aborted", {network: this.uuid, reason});
		this.options.onSaslRejected?.();
		this.disconnect("SASL authentication failed");
		return true;
	}

	/** Why the server's `sasl` cap cannot carry `mechanism`, for the report. */
	private saslUnavailable(mechanism: SaslMechanism): string {
		const offered = this.caps.value("sasl");

		if (offered === undefined || offered === "") {
			return t("connect.saslReason.unavailable");
		}

		return t("connect.saslReason.wrongMechanism", {offered, mechanism});
	}

	/**
	 * A negotiator that also asks for `sasl` (when usable) and runs SASL
	 * before `CAP END`. The `accept` hook drops a cap whose 302 value says
	 * we cannot use it: a `sasl` without our mechanism, a `draft/multiline`
	 * without both of its limits (multiline.ts).
	 */
	private createCaps(): CapNegotiator {
		const mechanism = this.saslMechanism;

		const accept = (name: string, value: string): boolean => {
			if (name === MULTILINE_CAP) {
				return parseMultilineValue(value) !== undefined;
			}

			if (name === WEBPUSH_CAP) {
				// Without a VAPID key the server could never send a push, so
				// subscribing would be pointless (webpush.ts).
				return webpushVapidOf(value) !== undefined;
			}

			if (name === "sasl") {
				return mechanism !== null && mechanismOffered(mechanism, value);
			}

			return true;
		};

		const caps = new CapNegotiator({
			...SEANCE_CAPS,
			wanted: mechanism ? [...SEANCE_CAPS.wanted, "sasl"] : SEANCE_CAPS.wanted,
			accept,
		});

		if (mechanism) {
			caps.beforeEnd = () => this.startSasl(mechanism);
		}

		// The shared metadata, subscribed before registration where the server
		// allows it, and the away state, declared right before `CAP END`
		// (presence.ts).
		caps.finalLines = () => {
			const lines: string[] = [];
			const metadata = caps.value("draft/metadata-2");

			if (
				!this.isQuitting &&
				this.saslOk &&
				metadata !== undefined &&
				metadata.split(",").includes("before-connect") &&
				(caps.hasCapability("draft/metadata-2") || caps.isRequesting("draft/metadata-2"))
			) {
				this.metadataSubscribed = true;
				this.metadataBeforeConnect = true;
				this.presence.syncStale = mayHaveMissed(
					Math.max(this.syncLineAt ?? -Infinity, lastInSync(this.uuid) ?? -Infinity),
					Date.now()
				);
				lines.push(`METADATA * SUB ${MUTE_KEY} ${PRESENCE_KEY} ${MODE_KEY} ${CLOSED_KEY}`);
			}

			const line = registrationAwayLine(this);
			return line ? [...lines, line] : lines;
		};

		return caps;
	}

	/**
	 * `beforeEnd` hook: open the exchange if the server enabled `sasl` — or is
	 * about to (the opener is pipelined right behind the `CAP REQ`, which the
	 * server has answered by the time it reads AUTHENTICATE). A server that
	 * offers no usable `sasl` is a SASL failure like any other: the user
	 * asked to log in and will not be logged in.
	 */
	private startSasl(mechanism: SaslMechanism): string[] {
		if (!this.caps.hasCapability("sasl") && !this.caps.isRequesting("sasl")) {
			this.saslFailed(this.saslUnavailable(mechanism));
			return [];
		}

		this.sasl = new SaslAuth(mechanism, {
			account: this.options.saslAccount,
			password: this.options.saslPassword,
		});
		this.armSaslTimer();
		return this.sasl.start();
	}

	/**
	 * Apply what the state machine returned for one inbound line (called by
	 * handlers/sasl.ts), or for the timer running out (`timedOut`).
	 */
	saslProgress(result: SaslResult, timedOut = false): void {
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
			this.saslOk = false;

			if (this.saslFailed(result.error ?? t("connect.saslReason.unknown"), timedOut)) {
				return;
			}
		} else {
			this.saslOk = true;

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
				this.saslProgress(this.sasl.abort(t("connect.saslReason.timeout")), true);
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

	private onClose(code: number, reason: string, willReconnect: boolean, delayMs?: number): void {
		const phase = this._state;
		const wasUp = phase !== "disconnected";
		this._state = "disconnected";
		this.connected = false;
		this.welcomed = false;
		this.fakeLag.stop();
		this.background.clear();

		this.clearMuteRead();

		if (this.syncLineAt !== null) {
			setInSync(this.uuid, this.syncLineAt);
		}

		// Unknown until read again: the snapshot below stops counting it.
		this.muteKnown = false;
		this.presenceKnown = false;
		this.presenceServer = null;
		this.globalKnown = false;
		this.globalServer = null;
		this.closedKnown = false;
		this.metadataSubscribed = false;
		this.metadataBeforeConnect = false;
		this.mutePending.length = 0;
		presenceClosed(this);
		// The wait before the transport's retry, for the UI to count down;
		// an immediate retry has nothing worth counting. Whether it is the
		// server's throttle comes with the `reconnecting` that follows.
		this.retryThrottled = false;
		this.retryAt =
			willReconnect && delayMs !== undefined && delayMs > 0
				? Date.now() + delayMs
				: undefined;
		this.stsUpgradeTried = false;
		this.endSasl();
		this.authtoken.clear();

		if (this.options.tls) {
			refreshPolicy(this.options.host);
		}

		resetBatches(this);
		resetMultiline(this);
		abortHistory(this);
		cancelCatchup(this);
		cancelRestoration(this);
		this.saveCursor(); // the newest one must not die with the connection
		this.queryLog.flush();
		this.noticeLog.flush();
		resetRequests(this);
		resetServiceReplies(this);
		resetOper(this);
		this.serverReplay = false;
		this.clearPendingEdits();
		// Before resetMultiline: a queued batch's copy is reported here, with
		// the reason, rather than dropped without a word there.
		resetPending(this, t("pending.connectionLost"));
		this.clearTyping();

		for (const chan of this.channels) {
			chan.users.clear();
			chan.namesBuffer = null;

			// A marker the socket died holding goes out once we are back.
			if (chan.markReadTimer !== null) {
				chan.markReadDeferred = true;
			}

			cancelMarkRead(chan);

			// An account may read it on another device meanwhile: a `*`
			// answer no longer holds (a server that volunteers the marker
			// after JOIN still drops the query, catchup.ts).
			if (this.options.saslAccount) {
				chan.markerAnswered = false;
			}

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
			...(this.retryAt !== undefined ? {retryAt: this.retryAt} : {}),
			...(this.retryThrottled ? {retryThrottled: true} : {}),
		});

		if (wasUp) {
			if (this.quitting) {
				this.pushMessage(this.lobby, {text: t("connect.disconnected")}, true);
			} else if (this.closeExplained) {
				// We dropped the socket ourselves and said why just before.
				this.closeExplained = false;
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
		presenceRegistered(this);
		this.scheduleMuteRead();
		flushDeferredMarkRead(this);
		operRegistered(this);

		if (this.caps.enabled.size > 0) {
			this.pushMessage(
				this.lobby,
				{text: t("connect.enabledCaps", {caps: Array.from(this.caps.enabled).join(", ")})},
				true
			);
		}

		// Whatever a bouncer says in the next few seconds is setup chatter,
		// on any build (persistence.ts).
		beginSettling(this);

		// Queries have no JOIN to hang it on: a `more` page the last
		// connection died on is asked again here (channels: catchup.ts).
		for (const chan of this.channels) {
			if (chan.type === ChanType.QUERY) {
				retryLostHistory(this, chan);
			}
		}

		// Web Push availability (draft/webpush): announce the server's VAPID
		// key (or its absence) so webpush.ts can re-register a stored
		// subscription and the Settings UI can tell the two cases apart. The
		// WEBPUSH REGISTER itself is emitted later through the bus — a
		// REGISTER sent before CAP END is silently dropped by nefarious2.
		this.dispatch("webpush:available", {
			network: this.uuid,
			vapid: this.webpushVapid(),
			sasl: this.saslOk,
		});

		if (this.persistenceHold || this.serverReplay) {
			// The server may be about to restore the channels of our held
			// session (a draft/persistence batch right behind the MOTD, or
			// the replay our ATTACH cursor asked for): JOIN only what it does
			// not restore, once that batch is in.
			awaitRestoration(this);
		} else if (this.persistenceSetting === "ON") {
			// A setting of ON that is not in force (`STATUS ON OFF`) is most
			// often an alias of another device's live session, which nefarious2
			// only says after the MOTD (`NOTE BOUNCER ALIAS_ATTACHED`), in the
			// same call that sent the MOTD and right before the channels
			// (bounce_setup_local_alias): it is already on the wire, and the
			// note extends the wait. Otherwise nothing comes, so a short wait.
			awaitRestoration(this, RESTORE_QUIET_MS);
		} else {
			this.restorationSettled();
		}
	}

	/**
	 * Registration's restoration is in, or was never coming: opt into
	 * session persistence if that still does something, then JOIN what the
	 * server did not give back. Once per connection (persistence.ts).
	 */
	restorationSettled(): void {
		// `PERSISTENCE SET ON` creates the server's bouncer session and turns
		// its hold on, which is what draft/webpush triggers fire against. It
		// needs the account flag, so it only goes out post-registration (a SET
		// sent before CAP END is answered FAIL ACCOUNT_REQUIRED), and it is
		// idempotent — so it is skipped when it would change nothing: every
		// command after 001 costs fake lag (fakelag.ts).
		if (
			this.caps.hasCapability(PERSISTENCE_CAP) &&
			this.options.saslAccount &&
			// The setting is ON and in force, or this connection is an alias of
			// a session that is (it reads `ON OFF`: the alias is not held, the
			// session is). A setting of ON not in force otherwise (no session,
			// bouncer off) still asks, since SET ON is what creates the session.
			!(this.persistenceSetting === "ON" && (this.persistenceHold || this.bouncerAlias))
		) {
			// Flag the ack + STATUS echo as ours: handlers/persistence.ts
			// swallows them (the user never typed anything).
			this.persistenceAutoSetPending = true;
			this.send(persistenceEnableLine());
		}

		this.autojoin();
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

		if (joining.length > 0) {
			this.joinChannels(joining.map((chan) => ({name: chan.name, key: chan.shared.key})));
			const active = joining.find((chan) => chan.id === this.activeChanId);

			if (active) {
				prefetchCatchup(this, active);
			}
		}

		// A logged query with unread lines asks for its read marker behind
		// the channels (catchup.ts): held until their JOINs have echoed.
		for (const chan of this.channels) {
			if (chan.type === ChanType.QUERY) {
				enqueueMarkerFetch(this, chan);
			}
		}
	}

	// ------------------------------------------------------- web push (draft/webpush)

	/**
	 * The VAPID public key this server advertises for Web Push, when the
	 * `draft/webpush` capability is enabled: the cap 302 value is the primary
	 * source, the `VAPID` ISUPPORT token the fallback. Undefined when the
	 * network cannot push (cap missing or no key).
	 */
	webpushVapid(): string | undefined {
		if (!this.caps.hasCapability(WEBPUSH_CAP)) {
			return undefined;
		}

		return webpushVapidOf(this.caps.value(WEBPUSH_CAP) ?? "") ?? this.isupport.vapid;
	}

	/**
	 * `WEBPUSH REGISTER <endpoint> <keys>`: store the browser's push
	 * subscription with this account. The endpoint must be https (the server
	 * rejects anything else) and the keys are the `PushSubscription.toJSON()`
	 * material (`p256dh`, `auth`). Registration is idempotent per endpoint —
	 * re-registering on every connect is the draft's renewal mechanism. That
	 * renewal is background work (nefarious2 keeps a registration 90 days):
	 * it waits in {@link background} until the fake-lag clock has room.
	 */
	webpushRegister(
		endpoint: string,
		keys: {p256dh: string; auth: string},
		{renewal = false}: {renewal?: boolean} = {}
	): boolean {
		const line = `WEBPUSH REGISTER ${endpoint} p256dh=${keys.p256dh};auth=${keys.auth}`;

		// A REGISTER split in two would be two garbage commands: endpoints are
		// ~150 bytes and the keys ~120, but refuse whole rather than send a
		// mangled line (MAX_LINE_BYTES guards the ircd's 500-byte WS frames).
		if (utf8ByteLength(line) > MAX_LINE_BYTES) {
			this.pushMessage(this.lobby, {
				type: MessageType.ERROR,
				text: t("send.pushTooLong"),
			});
			return false;
		}

		if (renewal) {
			this.background.add({
				key: `webpush:${endpoint}`,
				cost: this.fakeLag.cost(line),
				run: () => void this.send(line),
			});
			return true;
		}

		return this.send(line);
	}

	/**
	 * `WEBPUSH UNREGISTER <endpoint>`: drop one subscription for this
	 * account (the draft defines no wildcard). The server echoes even when
	 * the endpoint was not registered.
	 */
	webpushUnregister(endpoint: string): boolean {
		// A renewal still waiting for the clock must not re-register it after.
		this.background.take(`webpush:${endpoint}`);
		return this.send(`WEBPUSH UNREGISTER ${endpoint}`);
	}

	// --------------------------------------------------------------- sending

	/**
	 * Resolves when the fake-lag clock has room for `cost` ms more of
	 * background work (fakelag.ts), for a sender that awaits a reply — the
	 * oper-up queries. Ahead of the catch-up: the oper panel and its menus
	 * wait on these, other channels' history on nobody. Never resolves if
	 * the connection closes first.
	 */
	whenRoom(key: string, cost = 2000): Promise<void> {
		return new Promise((resolve) => {
			this.background.add(
				{
					// Never in place of an earlier wait on the same key: that
					// promise would never resolve.
					key: `${key}#${++this.roomWaits}`,
					cost,
					run: () => {
						resolve();
						// The caller's line goes out in a microtask: let it be charged first.
						this.background.yieldTurn();
					},
				},
				{ahead: (k) => /^(catchup|mode|page|targets):/.test(k)}
			);
		});
	}

	/** Send one raw line. Reports an ERROR message in the lobby instead of throwing. */
	send(line: string): boolean {
		if (this.transport.state !== "open") {
			this.pushMessage(this.lobby, {type: MessageType.ERROR, text: t("send.notConnected")});
			return false;
		}

		try {
			this.transport.send(line);
			this.fakeLag.charge(line);
			return true;
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.pushMessage(this.lobby, {
				type: MessageType.ERROR,
				text: t("send.notSent", {message}),
			});
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
		const written = this.findChannel(target);

		if (written) {
			written.autoOpened = false; // the user wrote in it
		}

		const command = opts.notice ? "NOTICE" : "PRIVMSG";
		const firstTags: ClientTags | undefined =
			opts.tags || opts.firstTags ? {...opts.firstTags, ...opts.tags} : undefined;
		// The server prepends our full source to the echo; budget for it even
		// when the host is still unknown (63 is the usual hostname limit).
		const hostLen = this.host.length || 63;
		const sourceBytes =
			utf8ByteLength(`:${this.nick}!${this.ident}@`) +
			hostLen +
			utf8ByteLength(` ${command} ${target} :`);
		const actionBytes = opts.action ? "\x01ACTION \x01".length : 0;
		const limits = this.multilineLimits();
		let plain = text;

		if (limits && text.includes("\n")) {
			let plan: MultilinePlan;

			try {
				// Inside a batch a line carries `batch` (+ concat) and nothing
				// else; the client tags go on the opener.
				plan = planMultiline(
					text,
					sourceBytes + actionBytes + CONCAT_LINE_TAG_BYTES,
					limits,
					actionBytes
				);
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				this.pushMessage(this.lobby, {
					type: MessageType.ERROR,
					text: t("send.notSent", {message}),
				});
				return;
			}

			const count = plan.reduce((n, batch) => n + batch.length, 0);

			if (count === 0) {
				return; // nothing but blank lines
			}

			if (count > 1) {
				// `opts.tags` (a reply) belongs on every batch, `opts.firstTags`
				// (an edit) only on the first — one edit replaces one message.
				sendMultiline(
					this,
					target,
					command,
					plan,
					opts.tags ?? {},
					opts.action === true,
					opts.firstTags ?? {}
				);
				return;
			}

			// One line once the blanks are gone: an ordinary message.
			plain = plan[0][0].text;
		}

		// With `echo-message` each line is labelled so its echo can be told
		// apart (pending.ts); without it there is no echo to label.
		const echo = this.caps.hasCapability("echo-message");
		const labelled = echo && this.caps.hasCapability("labeled-response");
		// The frame cap applies to the whole line; the first chunk carries the
		// most tags, so every chunk is budgeted as if it did.
		const prefixBytes =
			sourceBytes +
			actionBytes +
			utf8ByteLength(tagPrefix(firstTags)) +
			(labelled ? LABEL_TAG_BYTES : 0);
		let chunks: string[];

		try {
			chunks = splitMessage(prefixBytes, plain.replace(/[\r\n\0]/g, " "));
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.pushMessage(this.lobby, {
				type: MessageType.ERROR,
				text: t("send.notSent", {message}),
			});
			return;
		}

		// Where the pending copy shows: the channel a STATUSMSG names, or the
		// open channel / query. A target that is not open shows nothing (its
		// echo opens the query, as it always did).
		const {target: shownTarget, group} = splitStatusTarget(this, target);
		const chan = echo ? this.findChannel(shownTarget) : undefined;
		const type = opts.notice
			? MessageType.NOTICE
			: opts.action
			? MessageType.ACTION
			: MessageType.MESSAGE;

		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];
			const body = opts.action ? `\x01ACTION ${chunk}\x01` : chunk;
			const base = i === 0 ? firstTags : opts.tags;
			const label = echo ? pendingLabel(this) : undefined;
			const tags = label ? {...base, label} : base;

			if (!this.send(trailingLine(command, [target, body], tags))) {
				return;
			}

			if (!echo) {
				this.handleLine(
					`${tagPrefix(base)}:${this.nick}!${this.ident}@${
						this.host || "localhost"
					} ${command} ${target} :${body}`
				);
			} else if (chan) {
				showPending(this, chan, {
					type,
					text: chunk,
					label,
					replyTo: opts.tags?.[REPLY_TAG],
					editOf: i === 0 ? opts.firstTags?.[EDIT_TAG] : undefined,
					statusmsgGroup: group,
				});
			}
		}
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
				text: t("send.tagsTooLong"),
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
				text: t("send.reactNeedsTags"),
			});
			return false;
		}

		if (chan.type !== ChanType.CHANNEL && chan.type !== ChanType.QUERY) {
			this.pushMessage(chan, {
				type: MessageType.ERROR,
				text: t("send.reactTargets"),
			});
			return false;
		}

		return this.sendTagmsg(chan.name, {
			[remove ? UNREACT_TAG : REACT_TAG]: text,
			[REPLY_TAG]: msgid,
		});
	}

	/**
	 * The user read `target` up to `time` (ISO 8601) somewhere else — a
	 * notification's Mark read, relayed by the service worker (bus-contract
	 * §2 `markread`). Sent at once, undebounced; nothing without the
	 * `draft/read-marker` cap or while not connected.
	 */
	markRead(target: string, time: string): void {
		markReadAt(this, target, new Date(time));
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

			// Each notice costs as much fake lag as the message it announces,
			// and one the server reads seconds late is worse than none: it
			// goes only when nothing else is waiting and the clock has room
			// (fakelag.ts), never ahead of the catch-up.
			if (wait <= 0 && this.background.fits(TYPING_COST_MS)) {
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
		// A transition is held to the same room as `active` (typing above);
		// the other side lets an unended session lapse on its own.
		if (state !== "active" && !this.background.fits(TYPING_COST_MS)) {
			if (state === "done") {
				this.typingState.delete(key);
			}

			return;
		}

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

	/**
	 * What one `draft/multiline` batch may carry, or undefined when
	 * multi-line messages are not available: the cap has to be enabled with
	 * a usable 302 value, and the two the draft depends on with it — `batch`,
	 * which carries the message, and `message-tags`, without which the
	 * `batch` tag never reaches the server and the batch has no lines.
	 */
	multilineLimits(): MultilineLimits | undefined {
		if (
			!this.caps.hasCapability(MULTILINE_CAP) ||
			!this.caps.hasCapability("batch") ||
			!this.caps.hasCapability("message-tags")
		) {
			return undefined;
		}

		return parseMultilineValue(this.caps.value(MULTILINE_CAP));
	}

	/**
	 * A reference for our next outbound batch (`m1`, `m2`, …). Only has to be
	 * unique among the batches we have open, which is at most one at a time.
	 */
	nextBatchRef(): string {
		this.batchRefs++;
		return `m${this.batchRefs}`;
	}

	/** An id for a message delivered to the UI outside {@link pushMessage} (a pending copy). */
	nextMsgId(): number {
		return this.ids.msgId();
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
				text: t("send.redactUnavailable"),
			});
			return false;
		}

		if (chan.type !== ChanType.CHANNEL) {
			this.pushMessage(chan, {
				type: MessageType.ERROR,
				text: t("send.redactChannels"),
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
				text: t("send.editWaiting"),
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
					text: t("send.editNoReply"),
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
				noteJoinsSent(this, names);
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
	/** The channel the UI shows for this network, if any. */
	activeChannel(): Channel | undefined {
		return this.activeChanId ? this.channelById(this.activeChanId) : undefined;
	}

	/** Attention changed (foreground.ts); see presence.ts. */
	setAttended(attended: boolean): void {
		setAttended(this, attended);
	}

	/**
	 * Apply a presence mode. `at` stamps it as a choice (made here: now;
	 * adopted from the server: its time) and shares it (presenceShare.ts);
	 * without one the time is left as it is.
	 */
	setPresenceMode(mode: NetworkMode, at?: number): void {
		if (at !== undefined) {
			this.presenceAt = at;
		}

		if (this.presenceMode !== mode) {
			this.presenceMode = mode;
			syncPresence(this);
		}

		if (at !== undefined) {
			syncShared(this);
		}
	}

	/** The mode in force: this network's own, or the global one (helpers/dnd.ts). */
	get effectiveMode(): PresenceMode {
		return effectiveMode(this.presenceMode, this.globalMode.value);
	}

	/** The pill's global mode (docs/projects/shared-presence-modes.md § 2). */
	setGlobalMode(mode: GlobalModeState): void {
		if (this.globalMode.value === mode.value && this.globalMode.at === mode.at) {
			return;
		}

		const changed = this.globalMode.value !== mode.value;
		this.globalMode = {value: mode.value, at: mode.at};

		if (changed) {
			syncPresence(this);
		}

		syncShared(this);
	}

	setGlobalDnd(active: boolean, until: number | null): void {
		if (this.globalDnd.active !== active || this.globalDnd.until !== until) {
			this.globalDnd = {active, until};
			syncPresence(this);
		}
	}

	presenceSnapshot(): SharedNetworkPresence {
		return presenceSnapshot(this);
	}

	/**
	 * The push mute list (do not disturb), read once the connect burst is
	 * over: every command costs fake lag and the server stops reading at
	 * 10 s (docs/resources/nefarious2-websocket.md § Fake lag). The account
	 * comes from SASL's 900, before 001; without one the list is neither
	 * read nor written (push needs an account anyway).
	 */
	private scheduleMuteRead(): void {
		this.clearMuteRead();

		if (!this.caps.hasCapability("draft/metadata-2") || !this.account) {
			return;
		}

		this.muteReadTimer = setTimeout(() => {
			this.muteReadTimer = null;

			if (this.isWelcomed && this.transport.state === "open") {
				if (!this.metadataSubscribed) {
					this.metadataSubscribed = true;
					this.send(
						`METADATA * SUB ${MUTE_KEY} ${PRESENCE_KEY} ${MODE_KEY} ${CLOSED_KEY}`
					);
				}

				// The payload tier rides along: an account that wrote it public
				// before it was written private (WHOIS listed it) is told so in
				// the answer, and handlers/metadata.ts rewrites it private.
				this.send(
					`METADATA * GET ${MUTE_KEY} ${PRESENCE_KEY} ${MODE_KEY} ${PAYLOAD_KEY} ${CLOSED_KEY}`
				);
			}
		}, MUTE_READ_DELAY_MS);
		// Never what keeps a process (mocha) alive.
		(this.muteReadTimer as {unref?: () => void}).unref?.();
	}

	/**
	 * A line in on a connection in sync with the shared state (subscribed,
	 * and read by the burst or the GET): this device has heard every change
	 * up to now. Written down every STAMP_EVERY_MS (irc/presenceSync.ts).
	 */
	private noteSyncLine(): void {
		const read = this.presence.burstRead || (this.presenceKnown && this.globalKnown);

		if (!this.metadataSubscribed || !read) {
			return;
		}

		const now = Date.now();
		this.syncLineAt = now;

		if (now - this.syncStampedAt >= STAMP_EVERY_MS) {
			this.syncStampedAt = now;
			setInSync(this.uuid, now);
		}
	}

	private clearMuteRead(): void {
		if (this.muteReadTimer !== null) {
			clearTimeout(this.muteReadTimer);
			this.muteReadTimer = null;
		}
	}

	/** Dispatch on the bus this client was given (presence.ts reports through it). */
	dispatchBus<E extends keyof ServerToClientEvents>(
		event: E,
		...args: Parameters<ServerToClientEvents[E]>
	): void {
		this.bus.dispatch(event, ...args);
	}

	open(chanId: number): void {
		this.activeChanId = chanId;
		const chan = this.channelById(chanId);

		if (chan) {
			chan.autoOpened = false; // the user has it now

			// Only a person looking reads it: a page that lands here hidden
			// (a cold start, a deep link) leaves that to attention returning
			// (presence.ts).
			if (this.presence.attended) {
				readNow(this, chan);
			}

			prioritiseCatchup(this, chan);

			// The modes only feed the "Channel modes" line: background work,
			// so clicking through channels during the catch-up costs the user
			// nothing (catchup.ts).
			if (chan.type === ChanType.CHANNEL && chan.state === ChanState.JOINED) {
				queueModes(this, chan);
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

		// An answer to one of our labeled requests (request.ts): its asker
		// renders it, the handlers never see it.
		if (interceptRequestLine(this, msg)) {
			return;
		}

		// The echo of a quiet line of ours — a lookup sent to a services bot
		// (quiet.ts) — opens no window and shows nowhere.
		if (dropQuietLine(this, msg)) {
			return;
		}

		// A services bot answering a command we sent it, or the server
		// saying there is no such bot (services.ts). A line a quiet watcher
		// consumed is shown in no window — the asker renders the answer.
		if (noteServiceReply(this, msg)) {
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
		// Only once history has filled it: before that, its newest stamped line
		// can be our own previous JOIN, with the scrollback never fetched.
		const heldBeforeJoin: MsgRef | undefined =
			selfJoin && joined?.historyFilled ? joined.newestServerRef() : undefined;
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
				enqueueCatchup(this, chan, beforeJoin, heldBeforeJoin);
			} else if (chan) {
				// The replay fills the gap, not a `more` page the last
				// connection died on: that one is asked again here.
				retryLostHistory(this, chan);
			}

			// The last autojoin echo lets the queries' markers queue behind
			// the channels (enqueueMarkerFetch).
			releaseMarkers(this);
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

	dispatch: EventBus["dispatch"] = (event, ...args) => {
		this.followInQueryLog(event, args[0]);
		return this.bus.dispatch(event, ...args);
	};

	/**
	 * An edit, a redaction or a reaction in a query reaches the log the way
	 * it reaches the UI — through the one dispatch every handler uses — so
	 * no handler has to know the log exists. Ids are the UI's; the log keys
	 * by msgid, which `msgRefs` holds for every loaded line.
	 */
	private followInQueryLog(event: string, payload: unknown): void {
		if (event !== "msg:edit" && event !== "msg:redact" && event !== "msg:react") {
			return;
		}

		const data = payload as {chan: number; id: number};
		const chan = this.channelById(data.chan);
		const msgid = chan?.msgRefs.get(data.id)?.msgid;

		if (!chan || chan.type !== ChanType.QUERY || !msgid) {
			return;
		}

		if (event === "msg:edit") {
			const original = chan.msgRefs.get((payload as {replaces: number}).replaces)?.msgid;

			if (original) {
				this.queryLog.edit(chan.name, original, msgid);
			}
		} else if (event === "msg:redact") {
			this.queryLog.redact(chan.name, msgid);
		} else {
			const {text, nick, remove} = payload as {text: string; nick: string; remove: boolean};
			this.queryLog.react(chan.name, msgid, text, nick, remove);
		}
	}

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

	/** Compiled highlight regexes, cached until nick or settings change. */
	private highlightTester = createHighlightTester();

	/** Whether `text` mentions our nick or a custom highlight keyword. */
	isHighlight(text: string): boolean {
		const {keywords, exceptions} = this.options.highlights?.() ?? {
			keywords: [],
			exceptions: [],
		};
		return this.highlightTester.isHighlight(text, this.nick, keywords, exceptions);
	}

	/**
	 * Whether `text` matches a highlight exception on its own — for
	 * highlights that are not derived from the text (the query
	 * auto-highlight), where {@link isHighlight}'s folded-in exceptions
	 * never run.
	 */
	isHighlightException(text: string): boolean {
		const {exceptions} = this.options.highlights?.() ?? {keywords: [], exceptions: []};
		return this.highlightTester.isHighlightException(text, exceptions);
	}

	/** The inbox entry for an unread highlight in `chan` (helpers/inbox.ts), or null. */
	inboxEntry(chan: Channel, msg: SharedMsg): InboxEntry | null {
		if (!markable(chan)) {
			return null; // the lobby: no read point would ever clear it
		}

		const {keywords} = this.options.highlights?.() ?? {keywords: []};
		return entryFor(this.uuid, chan.name, msg, {
			query: chan.type === ChanType.QUERY,
			findMention: (plain) => this.highlightTester.mentionIndex(plain, this.nick, keywords),
		});
	}

	findChannel(name: string): Channel | undefined {
		return this.channels.find((chan) => this.namesEqual(chan.name, name));
	}

	/**
	 * Channels the user asked to `/join` (casefolded) whose JOIN has not come
	 * back yet. Their JOIN announces a window the user wants to see
	 * (`join.shouldOpen`, like `/query` and whois do), unlike an autojoin, a
	 * restore or a forced join, which are state and must not move the view.
	 */
	private requestedJoins = new Set<string>();

	/** Note a `/join` the user typed (commands/join.ts). */
	requestJoin(name: string): void {
		this.requestedJoins.add(this.casefold(name));
	}

	/** Whether the user asked for this channel — once: the request is consumed. */
	takeRequestedJoin(name: string): boolean {
		return this.requestedJoins.delete(this.casefold(name));
	}

	/**
	 * Channels (casefolded) whose topic/modes the user asked about without
	 * being in them (`/topic #chan`, `/mode #chan`). The 331/332/324 for a
	 * channel not in the channel list is normally dropped; one that was asked
	 * for renders in the lobby with `showInActive` instead.
	 */
	private infoAsked = new Set<string>();

	/** Note a topic/modes query for a channel we are not in (commands/). */
	markInfoAsked(name: string): void {
		this.infoAsked.add(this.casefold(name));
	}

	/** Whether the user asked about this channel — once: the request is consumed. */
	takeInfoAsked(name: string): boolean {
		return this.infoAsked.delete(this.casefold(name));
	}

	channelById(id: number): Channel | undefined {
		return this.channels.find((chan) => chan.id === id);
	}

	/**
	 * Create a channel/query and insert it after the lobby (the index is what
	 * `join` needs; always >= 1): in the order the user gave the sidebar
	 * (saved-networks `channelOrder`, names the user dragged) first, then
	 * alphabetically among the names that order does not know.
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
		const order = channelOrder(this.uuid).map((n) => this.casefold(n));

		const rank = (n: string) => {
			const i = order.indexOf(this.casefold(n));
			return i === -1 ? Infinity : i;
		};

		const mine = rank(name);
		let index = this.channels.length;

		for (let i = 1; i < this.channels.length; i++) {
			const other = this.channels[i];
			const sortable = other.type === ChanType.CHANNEL || other.type === ChanType.QUERY;
			const theirs = rank(other.name);
			const before = mine === theirs ? compareNames(name, other.name) <= 0 : mine < theirs;

			if (!sortable || before) {
				index = i;
				break;
			}
		}

		this.channels.splice(index, 0, channel);
		return {channel, index};
	}

	/**
	 * Open the query with `nick` for a line it did not ask for (a message, a
	 * catch-up), unless the user closed that conversation after `time`:
	 * then nothing opens (irc/closedQueries.ts). A `live` line — not in a
	 * replay, not in the settling window where a reattach replays unwrapped —
	 * is news whatever its time: another server stamps it with its own clock,
	 * and a reply that crossed ours can carry a time before our last line.
	 * It opens the window, and the close gives way to a reopen so a reload
	 * keeps it open.
	 */
	openAutoQuery(nick: string, time: Date, live = false): Channel | undefined {
		if (this.closed.suppresses(nick, time)) {
			if (!live) {
				return undefined;
			}

			if (this.closed.reopen(nick)) {
				this.writeClosed();
			}
		}

		const chan = this.announceChannel(nick, ChanType.QUERY);
		chan.autoOpened = true;
		return chan;
	}

	/**
	 * Write the closes this device knows to the account's private
	 * {@link CLOSED_KEY} (irc/closedQueries.ts), once this connection's read
	 * of it has answered; until then the write waits for it.
	 */
	writeClosed(): void {
		// Private conversations not kept: nothing is shared (closedQueries.ts).
		if (!closedQueriesKept()) {
			this.closedPending = false;
			return;
		}

		if (!this.closedKnown) {
			this.closedPending = true;
			return;
		}

		this.closedPending = false;

		if (!this.isWelcomed || this.transport.state !== "open") {
			return;
		}

		// What the server keeps, and what fits one line after the command
		// (MAX_LINE_BYTES): a server allowing more must not get an unsendable line.
		const prefix = `METADATA * SET ${CLOSED_KEY} private :`;
		const room = MAX_LINE_BYTES - new TextEncoder().encode(prefix).length;
		const value = encodeClosed(
			this.closed.entries(),
			Math.min(this.metadataMaxValueBytes(), room),
			Date.now()
		);
		this.send(value ? `${prefix}${value}` : `METADATA * SET ${CLOSED_KEY}`);
	}

	/**
	 * Sharing stopped (closedQueries.ts setClosedQueriesKept, or a login read
	 * that finds a list while it is off): delete the account's list of closed
	 * conversations, which the network's operators can read, if this
	 * connection can. The server answers the delete with a 766, the same
	 * "key not set" a read gets, and that (closedQueries.ts onClosedValue)
	 * is what marks the network done: a delete lost with the socket or
	 * refused (`FAIL METADATA RATE_LIMITED`) is tried again at the next read.
	 */
	unshareClosed(): void {
		this.closedPending = false;

		if (
			this.isWelcomed &&
			this.transport.state === "open" &&
			this.account &&
			this.caps.hasCapability("draft/metadata-2")
		) {
			this.send(`METADATA * SET ${CLOSED_KEY}`);
		}
	}

	/**
	 * The page is going away (manager.ts sends a registered connection its
	 * QUIT): an open or dialling socket drops without a close the transport
	 * would see, so the drop goes into the dial ledger here — unless the
	 * bouncer holds the session, which the server keeps counted.
	 */
	noteUnload(): void {
		const live = this.transport.state === "open" || this.transport.state === "connecting";

		if (live && !this.persistenceHold) {
			this.dialLedger?.closed(Date.now());
		}
	}

	/** The server's `max-value-bytes` (draft/metadata-2): a plain number, else nefarious2's 300. */
	private metadataMaxValueBytes(): number {
		const token = (this.caps.value("draft/metadata-2") ?? "")
			.split(",")
			.find((entry) => entry.startsWith("max-value-bytes="));
		const value = token?.slice("max-value-bytes=".length) ?? "";
		return /^[1-9]\d*$/.test(value) ? Number(value) : 300;
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

	/**
	 * Hand the restored query windows their logged lines, as one history
	 * page each (`more`, negative ids, no unread): remembered by msgid like
	 * any page, so the server's own replay of the same lines — the ATTACH
	 * cursor's, a CHATHISTORY page — is deduplicated against them.
	 */
	private restoreQueryLines(): void {
		for (const chan of this.restoredQueries.splice(0)) {
			if (!this.channels.includes(chan)) {
				continue;
			}

			const messages = this.queryLog.messages(chan.name);

			if (messages.length === 0) {
				continue;
			}

			const ids = this.historyIds(messages.length);
			let lastRef: MsgRef | undefined;
			// Lines this device had not read when the page went away count
			// again; in a log from before the read point was kept, nothing does.
			const read = this.queryLog.readUpTo(chan.name);
			const page: Array<[SharedMsg, MsgRef]> = [];
			let lastRead = 0;

			messages.forEach((msg, i) => {
				msg.id = ids[i];
				const ref = chan.remember(msg);
				lastRef = ref;
				page.push([msg, ref]);

				if (read && ref.time.getTime() <= read.getTime()) {
					lastRead = msg.id;
				}
			});

			for (const [msgid, index] of this.queryLog.aliases(chan.name)) {
				if (!chan.idByMsgid.has(msgid)) {
					chan.idByMsgid.set(msgid, messages[index].id);
				}
			}

			chan.newestRef ??= lastRef;
			chan.shared.totalMessages += messages.length;
			this.bus.dispatch("more", {
				chan: chan.id,
				messages,
				totalMessages: chan.shared.totalMessages,
				moreAvailable: false,
			});

			if (read && read.getTime() > 0) {
				chan.readMarker = read;
			}

			if (read) {
				countPageUnread(this, chan, page, read, lastRead);
			}
		}
	}

	/**
	 * Put the server notices and WALLOPS the last page kept back into the
	 * lobby, as one history page (noticelog.ts): the server never replays
	 * them, and a discarded PWA would otherwise come back without them.
	 * Asynchronous (IndexedDB), so live lines may already be there; the page
	 * goes in ahead of them.
	 */
	private async restoreNotices(): Promise<void> {
		// The services feed's lines (servicesfeed.ts) were channel messages,
		// never lobby lines: they come back for the Opers rollup only.
		const entries = (await this.noticeLog.load()).filter(
			(entry) => entry.type === "snotice" || entry.type === "wallops"
		);

		if (entries.length === 0) {
			return;
		}

		const ids = this.historyIds(entries.length);
		const messages = entries.map((entry, i) => {
			const msg: SharedMsg = {
				users: [],
				...noticeMessage(entry, true),
				id: ids[i],
			} as SharedMsg;
			this.lobby.remember(msg);
			return msg;
		});

		this.lobby.shared.totalMessages += messages.length;
		this.bus.dispatch("more", {
			chan: this.lobby.id,
			messages,
			totalMessages: this.lobby.shared.totalMessages,
			moreAvailable: false,
		});
	}

	/** Drop a channel from the model and the UI (`part` event). */
	removeChannel(chan: Channel): void {
		if (chan.type === ChanType.QUERY) {
			this.queryLog.forget(chan.name); // closed: not brought back
		}

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
	 * `Chan.pushMessage` in the old server. With `replay` (history catch-up
	 * appends) the message counts as unread as it would have live — what
	 * someone else said, not an edit, newer than the read marker — and
	 * `increasesUnread` is ignored; the flag travels on the `msg` event so
	 * the consumer skips notifications. An unread highlight, replayed or
	 * not, also goes out as `inbox:add`.
	 */
	pushMessage(
		chan: Channel,
		partial: Partial<SharedMsg>,
		increasesUnread = false,
		{replay = false}: {replay?: boolean} = {}
	): SharedMsg {
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

		if (chan.type === ChanType.QUERY) {
			// Before the counting below, which may move the read point it keeps.
			this.queryLog.append(chan.name, msg);
		}

		const shared = chan.shared;
		shared.totalMessages++;
		// Already read on another session (draft/read-marker), e.g. a catch-up.
		const read =
			chan.readMarker !== undefined && ref.time.getTime() <= chan.readMarker.getTime();
		const said = SAID_TYPES.has(msg.type ?? MessageType.MESSAGE);

		if (msg.self) {
			// Something we said is read by definition; our own JOIN/MODE
			// are not (a reconnect must not advance the read marker), and
			// replayed by a catch-up they leave the counters and the
			// new-messages line where the lines before them put them.
			if (said || !replay) {
				shared.firstUnread = msg.id;
			}

			if (said && replay) {
				// An old line of ours in a catch-up read what came before it,
				// not a live line that arrived while the catch-up was out. No
				// MARKREAD: the server has the line, and the marker is now at it.
				applyReadMarker(this, chan, ref.time);
			} else if (said) {
				shared.unread = 0;
				shared.highlight = 0;
				scheduleMarkRead(this, chan);
			}
		} else if (chan.id === this.activeChanId && this.presence.attended) {
			// Only a person looking reads it; a hidden page marks nothing
			// (presence.ts marks the open channel when attention returns).
			scheduleMarkRead(this, chan);
		} else if (!read) {
			if (!shared.firstUnread) {
				shared.firstUnread = msg.id;
			}

			// A catch-up line counts as privmsg.ts counts a live one.
			if (replay ? countsAsUnread(msg) : increasesUnread || msg.highlight) {
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
			...(replay ? {replay: true} : {}),
		});

		// An unread highlight in a conversation, live or caught up, is an
		// inbox entry; one read already (looked at, or past another
		// session's marker) is not, nor one in the lobby, which no read
		// marker ever clears.
		const entry = ref.highlight ? this.inboxEntry(chan, msg) : null;

		if (entry) {
			this.bus.dispatch("inbox:add", {entries: [entry]});
		}

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

/** Where a newly created channel/query lands in the sidebar: the active
 * locale's collation, case-insensitively as before (sensitivity "base"
 * matches the old localeCompare options). */
function compareNames(a: string, b: string): number {
	return collator({sensitivity: "base"}).compare(a, b);
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
