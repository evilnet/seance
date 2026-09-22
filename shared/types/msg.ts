export enum MessageType {
	UNHANDLED = "unhandled",
	ACTION = "action",
	AWAY = "away",
	BACK = "back",
	ERROR = "error",
	INVITE = "invite",
	JOIN = "join",
	KICK = "kick",
	LOGIN = "login",
	LOGOUT = "logout",
	MESSAGE = "message",
	MODE = "mode",
	MODE_CHANNEL = "mode_channel",
	MODE_USER = "mode_user", // RPL_UMODEIS
	MONOSPACE_BLOCK = "monospace_block",
	NICK = "nick",
	NOTICE = "notice",
	PART = "part",
	QUIT = "quit",
	CTCP = "ctcp",
	CTCP_REQUEST = "ctcp_request",
	CHGHOST = "chghost",
	TOPIC = "topic",
	TOPIC_SET_BY = "topic_set_by",
	WHOIS = "whois",
	WHO = "who",
	RAW = "raw",
	PLUGIN = "plugin",
	WALLOPS = "wallops",
}

export type SharedUser = {
	modes: string[];
	// Users in the channel have only one mode assigned
	mode: string;
	away: string;
	nick: string;
	lastMessage: number;
};

export type UserInMessage = Partial<SharedUser> & {
	mode: string;
};

export type LinkPreview = {
	type: string;
	head: string;
	body: string;
	thumb: string;
	size: number;
	link: string; // Send original matched link to the client
	shown?: boolean | null;
	error?: string;
	message?: string;

	media?: string;
	mediaType?: string;
	maxSize?: number;
	thumbActualUrl?: string;
};

/** One row of a WHO reply (352 / WHOX 354), as `MessageTypes/who.vue` renders it. */
export type WhoEntry = {
	nick: string;
	ident: string;
	hostname: string;
	server: string;
	/** A channel the user shares with the asker, or undefined (`*` on the wire). */
	channel?: string;
	/** The flags column as sent (`H@*x`, …), for a tooltip. */
	flags: string;
	away: boolean;
	oper: boolean;
	/** Channel status symbols in the flags (`@`, `%`, `+`; also `!` zombie, `<` delayed). */
	prefixes: string;
	/** `z` (TLS) and `B` (bot) in nefarious2's flags. */
	secure: boolean;
	bot: boolean;
	/** Services account (WHOX `a` field), undefined when logged out or unknown. */
	account?: string;
	hops?: number;
	realname: string;
};

/** A finished WHO query: what was asked and every row that came back. */
export type WhoList = {
	target: string;
	entries: WhoEntry[];
};

/** `+typing` client tag states (https://ircv3.net/specs/client-tags/typing). */
export type TypingState = "active" | "paused" | "done";

/** One reaction text on a message and who sent it (each nick at most once). */
export type MsgReaction = {
	text: string;
	nicks: string[];
};

/** A `REDACT` applied to a message; the original `text` is kept for reveal. */
export type MsgRedaction = {
	by: string;
	reason?: string;
	time: Date;
};

export type SharedMsg = {
	from?: UserInMessage;
	id: number;
	msgid?: string;
	/** msgid this message replies to (`+reply` / `+draft/reply`); may not be loaded. */
	replyTo?: string;
	/** Aggregated `+draft/react` reactions, in first-seen order. */
	reactions?: MsgReaction[];
	/** Set when a REDACT for this message arrived; rendered as a placeholder. */
	redacted?: MsgRedaction;
	/**
	 * msgid of the message this one replaces (`+seance/edit`); rendered as
	 * "(edited)". When that original is loaded, `msg:edit` moves this
	 * message into its place and gives it the original's `time`.
	 */
	editOf?: string;
	/** When an edit was made (its own `time` before it took the original's). */
	editedAt?: Date;
	/**
	 * id of the newer message that replaced this one, standing right after
	 * it in the list; hidden from the list.
	 */
	supersededBy?: number;
	previews?: LinkPreview[];
	/** Sender's services account, from the `account-tag` on PRIVMSG/NOTICE. */
	fromAccount?: string;
	text?: string;
	type?: MessageType;
	self?: boolean;
	/**
	 * A copy of our own outgoing message shown before the server has taken
	 * it (bus-contract §1.9): rendered faded, kept at the bottom, and taken
	 * down by `msg:settled` when the echo (or a failure) arrives.
	 */
	pending?: boolean;
	time: Date;
	hostmask?: string;
	target?: UserInMessage;
	// TODO: new_nick is only on MessageType.NICK,
	// we should probably make Msgs that extend this class and use those
	// throughout. I'll leave any similar fields below.
	new_nick?: string;
	highlight?: boolean;
	showInActive?: boolean;
	new_ident?: string;
	new_host?: string;
	ctcpMessage?: string;
	command?: string;
	invitedYou?: boolean;
	gecos?: string;
	account?: boolean;

	// these are all just for error:
	error?: string;
	nick?: string;
	channel?: string;
	reason?: string;

	raw_modes?: any;
	when?: Date;
	whois?: any;
	who?: WhoList;

	users: string[];

	statusmsgGroup?: string;
	params?: string[];
};
