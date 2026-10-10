import {SharedMention} from "./mention";
import {ChanState, SharedChan} from "./chan";
import {SharedNetwork, SharedServerOptions} from "./network";
import {SharedMsg, LinkPreview, TypingState} from "./msg";
import {SharedUser} from "./user";
import {SharedChangelogData} from "./changelog";
import {SharedConfiguration, LockedSharedConfiguration} from "./config";
import {SearchResponse, SearchQuery} from "./storage";
import {SharedOperState, SnoticeInfo} from "./oper";

type Session = {
	current: boolean;
	active: number;
	lastUse: number;
	ip: string;
	agent: string;
	token: string;
};

/** One row of a `PERSISTENCE LIST` reply (draft/persistence): the account's
 * bouncer session as the server sees it. There is one session per account. */
type PushSession = {
	sessid: string;
	/** `ACTIVE` (a live connection holds it) or `HELD` (kept while away). */
	state: string;
	nick: string;
	channels: string[];
	info: string;
};

type EventHandler<T> = (data: T) => void;
type NoPayloadEventHandler = EventHandler<void>;

interface ServerToClientEvents {
	"auth:start": (serverHash: number) => void;
	"auth:failed": NoPayloadEventHandler;
	"auth:success": NoPayloadEventHandler;

	"upload:auth": (token: string) => void;

	changelog: EventHandler<SharedChangelogData>;
	"changelog:newversion": NoPayloadEventHandler;

	"channel:state": EventHandler<{chan: number; state: ChanState}>;

	"change-password": EventHandler<{success: boolean; error?: any}>;

	commands: EventHandler<string[]>;

	configuration: EventHandler<SharedConfiguration | LockedSharedConfiguration>;

	"push:issubscribed": EventHandler<boolean>;
	"push:unregister": NoPayloadEventHandler;

	"sessions:list": EventHandler<Session[]>;

	"mentions:list": EventHandler<SharedMention[]>;

	"setting:new": EventHandler<{name: string; value: any}>;
	"setting:all": EventHandler<{[key: string]: any}>;

	"history:clear": EventHandler<{target: number}>;

	"mute:changed": EventHandler<{target: number; status: boolean}>;

	names: EventHandler<{id: number; users: SharedUser[]}>;

	network: EventHandler<{network: SharedNetwork}>;
	"network:options": EventHandler<{network: string; serverOptions: SharedServerOptions}>;
	"network:status": EventHandler<{
		network: string;
		connected: boolean;
		connecting: boolean;
		secure: boolean;
		/** Epoch ms of the next automatic dial, only while waiting for a retry. */
		retryAt?: number;
	}>;
	/**
	 * A connect was dropped before it registered, for a reason the user has
	 * to read (a refused SASL login the deploy insists on). The report is in
	 * the lobby; the view follows it there.
	 */
	"network:aborted": EventHandler<{network: string; reason: string}>;
	"network:info": EventHandler<{uuid: string}>;
	"network:name": EventHandler<{uuid: string; name: string}>;

	nick: EventHandler<{network: string; nick: string}>;

	open: (id: number) => void;

	markread: EventHandler<{chan: number; firstUnread: number; unread: number; highlight: number}>;

	part: EventHandler<{chan: number}>;

	"sign-out": NoPayloadEventHandler;

	"sync_sort:networks": EventHandler<{order: SharedNetwork["uuid"][]}>;
	"sync_sort:channels": EventHandler<{
		network: SharedNetwork["uuid"];
		order: SharedChan["id"][];
	}>;

	topic: EventHandler<{chan: number; topic: string}>;

	users: EventHandler<{chan: number}>;

	more: EventHandler<{
		chan: number;
		messages: SharedMsg[];
		totalMessages: number;
		/** Whether older history remains (the server's end tag / page fullness). */
		moreAvailable?: boolean;
	}>;

	"msg:preview": EventHandler<{id: number; chan: number; preview: LinkPreview}>;
	/** A `+draft/react` / `+draft/unreact` TAGMSG resolved to the message it targets. */
	"msg:react": EventHandler<{
		chan: number;
		id: number;
		text: string;
		nick: string;
		remove: boolean;
	}>;
	/** A REDACT resolved to the loaded message it targets. */
	"msg:redact": EventHandler<{chan: number; id: number; by: string; reason?: string; time: Date}>;
	/** Message `id` (already delivered via `msg`) replaces message `replaces`. */
	"msg:edit": EventHandler<{chan: number; id: number; replaces: number}>;
	/**
	 * The pending copy `id` (delivered via `msg` with `pending: true`) is
	 * settled: drop it. The echo, or the error line, that settles it
	 * follows as its own `msg`.
	 */
	"msg:settled": EventHandler<{chan: number; id: number}>;
	/** Someone else's `+typing` TAGMSG in a loaded channel/query (never our own). */
	typing: EventHandler<{chan: number; nick: string; state: TypingState}>;

	/** Web Push (draft/webpush): one dispatch per network at registration. `vapid` is the server's public key, or undefined when it cannot push (cap not negotiated or no key advertised). `sasl` is true when this connection logged in via SASL (903 seen). Consumed by `client/js/webpush.ts` (re-register + the subscribe prompt). */
	"webpush:available": EventHandler<{network: string; vapid: string | undefined; sasl: boolean}>;
	/** The server acknowledged (`ok: true`) or refused (`FAIL WEBPUSH`, `ok: false` + `code`/`reason`) a `WEBPUSH REGISTER|UNREGISTER`. */
	"webpush:state": EventHandler<{
		network: string;
		action: string;
		endpoint: string;
		ok: boolean;
		code?: string;
		reason?: string;
	}>;
	/** Being an oper on `network` changed: level, privileges, snomask, features (irc/oper.ts). */
	"oper:state": EventHandler<{network: string; state: SharedOperState}>;
	/**
	 * The answer to an `oper:request`: every line of the labeled reply, raw,
	 * in order. `outcome` says how it ended (`batch`, `lines`, `ack`,
	 * `timeout`, `closed`).
	 */
	"oper:reply": EventHandler<{network: string; id: string; lines: string[]; outcome: string}>;
	/** The notice log of `network` (oldest first), for the oper panel's Notices tab. */
	"oper:notices": EventHandler<{
		network: string;
		entries: {time: number; type: string; text: string; from?: string; snotice: SnoticeInfo}[];
	}>;
	/** One `PushSession` per `PERSISTENCE LIST` row, dispatched when the list closes (Settings → session panel). */
	"persistence:sessions": EventHandler<{sessions: PushSession[]}>;
	"msg:special": EventHandler<{chan: number; data?: Record<string, any>}>;
	msg: EventHandler<{
		msg: SharedMsg;
		chan: number;
		highlight?: number;
		unread?: number;
		/**
		 * History catch-up replay: show the message (highlight included)
		 * but do not notify, play a sound or record a mention.
		 */
		replay?: boolean;
	}>;

	init: EventHandler<{active: number; networks: SharedNetwork[]; token?: string}>;

	"search:results": (response: SearchResponse) => void;

	quit: EventHandler<{network: string}>;

	error: (error: any) => void;

	connecting: NoPayloadEventHandler;

	join: EventHandler<{
		shouldOpen: boolean;
		index: number;
		network: string;
		chan: SharedNetworkChan;
	}>;
}

type AuthPerformData =
	| Record<string, never> // funny way of saying an empty object
	| {user: string; password: string}
	| {
			user: string;
			token: string;
			lastMessage: number;
			openChannel: number | null;
			hasConfig: boolean;
	  };

interface ClientToServerEvents {
	"auth:perform": EventHandler<AuthPerformData>;

	changelog: NoPayloadEventHandler;

	"change-password": EventHandler<{
		old_password: string;
		new_password: string;
		verify_password: string;
	}>;

	open: (channelId: number) => void;

	names: EventHandler<{target: number}>;

	input: EventHandler<{
		target: number;
		text: string;
		/** msgid to reply to: plain text / `/me` get `+draft/reply`. */
		reply?: string;
		/** msgid of our own message to replace: REDACT (channels) + resend with `+seance/edit`. */
		edit?: string;
	}>;
	/** Send `text` to a target named by network uuid + channel/nick — the
	 * form a notification can use after the page (and its channel ids) is
	 * gone: the service worker's relayed reply and the queued outbox. Returns
	 * nothing; the bus handler drops it when that network is not connected,
	 * so callers check `network.status.connected` first. */
	send: EventHandler<{network: string; target: string; text: string; replyTo?: string}>;
	/** A notification's Mark read relayed by the service worker (and the outbox it drains): the account's read marker for `target` on `network` at `time` (ISO 8601, the notification's newest message). Sent as `MARKREAD` when the network is connected and negotiated `draft/read-marker`; otherwise dropped, so callers check `network.status.connected` first. */
	markread: EventHandler<{network: string; target: string; time: string}>;
	"msg:react": EventHandler<{target: number; msgid: string; text: string; remove?: boolean}>;
	"msg:redact": EventHandler<{target: number; msgid: string; reason?: string}>;
	/** The user's own input activity; the IRC layer throttles and sends `+typing` TAGMSGs. */
	typing: EventHandler<{target: number; state: TypingState}>;

	/** Web Push (draft/webpush): register the browser's push subscription with one network's server (docs/projects/push-subscription.md). */
	"webpush:register": EventHandler<{
		network: string;
		endpoint: string;
		keys: {p256dh: string; auth: string};
	}>;
	"webpush:unregister": EventHandler<{network: string; endpoint: string}>;
	/** Account metadata write for webpush settings (payload tier, mute/snooze). An empty value deletes the key. */
	"webpush:metadata": EventHandler<{network: string; key: string; value: string}>;
	/** Ask the server for the account's bouncer session(s) (`PERSISTENCE LIST`); the reply arrives as `persistence:sessions`. The network is optional — any connected client sees the same session. */
	"persistence:sessions:list": EventHandler<{network?: string}>;
	/** End the current device's bouncer session (`PERSISTENCE DETACH`): the hold preference clears and the session is destroyed. */
	"persistence:sessions:logout": EventHandler<{network?: string}>;

	/**
	 * Oper tools (irc/oper.ts, irc/request.ts): send `line` to `network`
	 * labeled and answer with `oper:reply` carrying the same `id`.
	 * `untagged` names numerics the server sends without the label
	 * (evilnet/nefarious2#120), `end` the numerics that end an unbatched
	 * answer.
	 */
	"oper:request": EventHandler<{
		network: string;
		id: string;
		line: string;
		untagged?: string[];
		end?: string[];
	}>;
	/** Set the server notice mask (decimal; 0 turns +s off) and remember it for the next oper-up. */
	"oper:snomask": EventHandler<{network: string; mask: number}>;
	/** Ask again for privileges, snomask and features; answered by `oper:state`. */
	"oper:refresh": EventHandler<{network: string}>;
	/** Ask for the notice log; answered by `oper:notices`. */
	"oper:notices:get": EventHandler<{network: string}>;

	"upload:auth": NoPayloadEventHandler;
	"upload:ping": (token: string) => void;

	"mute:change": EventHandler<{target: number; setMutedTo: boolean}>;

	"push:register": EventHandler<PushSubscriptionJSON>;
	"push:unregister": NoPayloadEventHandler;

	"setting:get": NoPayloadEventHandler;
	"setting:set": EventHandler<{name: string; value: any}>;

	"sessions:get": NoPayloadEventHandler;

	"sort:networks": EventHandler<{order: SharedNetwork["uuid"][]}>;
	"sort:channels": EventHandler<{
		network: SharedNetwork["uuid"];
		order: SharedChan["id"][];
	}>;

	"mentions:dismiss": (msgId: number) => void;
	"mentions:dismiss_all": NoPayloadEventHandler;
	"mentions:get": NoPayloadEventHandler;

	more: EventHandler<{target: number; lastId: number; condensed: boolean}>;
	/** The UI dropped these messages from a channel's buffer (see bus-contract § 2). */
	"history:trim": EventHandler<{target: number; ids: number[]}>;

	"msg:preview:toggle": EventHandler<{
		target: number;
		messageIds?: number[];
		msgId?: number;
		shown?: boolean | null;
		link?: string;
	}>;

	"network:get": (uuid: string) => void;
	// TODO typing
	"network:edit": (data: Record<string, any>) => void;
	"network:new": (data: Record<string, any>) => void;

	"sign-out": (token?: string) => void;

	"history:clear": EventHandler<{target: number}>;

	search: EventHandler<SearchQuery>;
}

interface InterServerEvents {}

interface SocketData {}
