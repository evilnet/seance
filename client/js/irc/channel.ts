/**
 * Per-channel state owned by an {@link IrcClient}: the `SharedNetworkChan`
 * the UI is given (minus messages, which only the store keeps) plus the
 * user list and bookkeeping the store never sees.
 */

import {ChanState, ChanType} from "../../../shared/types/chan";
import type {SharedNetworkChan} from "../../../shared/types/network";
import type {SharedUser} from "../../../shared/types/user";
import {MessageType, type SharedMsg, type UserInMessage} from "../../../shared/types/msg";
import type {HistorySpec} from "./history";

export type Casefold = (s: string) => string;

/**
 * Lines someone says. Our own mean we read the channel (draft/read-marker);
 * someone else's count as unread, live or caught up.
 */
export const SAID_TYPES: ReadonlySet<MessageType> = new Set([
	MessageType.MESSAGE,
	MessageType.ACTION,
	MessageType.NOTICE,
]);

/**
 * A line delivered without a live `pushMessage` (a history page, a restored
 * query log) counts as unread past the read marker when a live one would
 * have: something someone else said, or a highlight. An edit counts only
 * when its original is not shown in `chan`: then it stands alone, and the original,
 * if it comes, is put behind it uncounted (`IrcClient.takeLateEdit`).
 */
export function countsAsUnread(msg: SharedMsg, chan: Channel): boolean {
	const said =
		SAID_TYPES.has(msg.type ?? MessageType.MESSAGE) &&
		(!msg.editOf || chan.idOf(msg.editOf) === undefined);
	return !msg.self && (said || !!msg.highlight);
}

/** What a CHATHISTORY request can point at: a message's msgid and/or time. */
export interface MsgRef {
	msgid?: string;
	time: Date;
	/** A chat line (message or action): what `/react` can target and the UI shows reactions on. */
	reactable?: boolean;
	/** Bumped the channel's `unread` counter when pushed (recounted by MARKREAD). */
	unread?: boolean;
	/** Bumped the channel's `highlight` counter when pushed. */
	highlight?: boolean;
	/** Who sent it, for the edit rule (IrcClient.isAuthor). */
	from?: Author;
	/** The msgid of the line it edits, if it is an edit. */
	editOf?: string;
}

/**
 * Whether an edit sent by `by` may replace a line `author` sent. When
 * either carries an account (`account-tag`) the accounts decide, across
 * nick changes, and one without never matches one with (our own lines
 * echoed locally carry our account, `IrcClient.sendMessage`). With none,
 * ours replace ours (`self` follows the current nick, so it is only
 * trusted without accounts), and anyone else's only lines of the same
 * nick. `fold` is the server's casemapping where it is known. One rule for
 * the timeline, past views and search.
 */
export function isEditAuthor(
	author: Author | undefined,
	by: Author,
	fold: (s: string) => string = (s) => s.toLowerCase()
): boolean {
	if (author?.account || by.account) {
		return !!author?.account && !!by.account && fold(author.account) === fold(by.account);
	}

	if (author?.self && by.self) {
		return true;
	}

	return (
		author?.nick !== undefined && by.nick !== undefined && fold(author.nick) === fold(by.nick)
	);
}

/** An edit shown before its original: its msgid, and who sent it. */
interface WaitingEdit {
	msgid: string;
	by: Author;
}

/** A message's sender, for {@link isEditAuthor}. */
export function authorOf(msg: SharedMsg): Author {
	return {nick: msg.from?.nick, account: msg.fromAccount, self: msg.self};
}

/** A line's sender as the edit rule needs it: an edit replaces only its author's line. */
export interface Author {
	nick?: string;
	/** Services account (`account-tag`): the identity across nick changes. */
	account?: string;
	/** Ours, whatever our nick was then. */
	self?: boolean;
}

/** A fresh user record; `mode` mirrors `modes[0]` and must be kept in sync. */
export function newUser(nick: string, modes: string[] = []): SharedUser {
	return {nick, modes: [...modes], mode: modes[0] ?? "", away: "", lastMessage: 0};
}

/** Replace a user's prefix symbols, keeping them ordered by `rank` (highest first). */
export function setUserModes(user: SharedUser, modes: string[], rank: (symbol: string) => number) {
	user.modes = [...modes].sort((a, b) => rank(a) - rank(b));
	user.mode = user.modes[0] ?? "";
}

export class Channel {
	readonly shared: SharedNetworkChan;
	/** Users keyed by casefolded nick. Empty for lobbies and queries. */
	users = new Map<string, SharedUser>();
	/** NAMES burst being accumulated (353) until 366 swaps it in. */
	namesBuffer: Map<string, SharedUser> | null = null;
	/** JOIN this channel after (re)registration. */
	autoJoin = false;
	/** `MODE <chan>` has been asked for since the last JOIN (asked lazily, on first open). */
	modesKnown = false;
	/** History/marker were requested in the same flush as the JOIN (catchup.ts); the echo must not repeat them. */
	catchupPrefetched = false;
	/**
	 * We were in this channel when the connection dropped: the re-JOIN's
	 * echo and NAMES are state, not activity, and are not shown (cleared by
	 * the end of that NAMES burst). Its topic never is (handlers/topic.ts).
	 */
	rejoining = false;
	/** The 332 just seen went to the header only (state, not news); its 333 goes nowhere either. */
	topicQuiet = false;
	/** The user asked for the topic (`/topic`): show the next 331/332 as a line. */
	topicAsked = false;
	/** The 332 just shown was asked for: it and its 333 follow the user to the active tab. */
	topicAskedActive = false;
	/**
	 * The user joined this channel by hand (`/join`) and its JOIN just came
	 * back: the topic in that join burst is shown as a line, once — the
	 * header truncates a long one. Cleared by the end of the burst's NAMES.
	 */
	topicWanted = false;
	/** The user asked for the modes (`/mode #chan`): show the next 324 as a line. */
	modesAsked = false;
	/**
	 * For a `ChanType.SPECIAL` window, what it shows besides its kind: the
	 * channel of a mode list (casefolded by the client). The title is a
	 * translated string and cannot identify the window (findings F15).
	 */
	specialTarget: string | undefined = undefined;
	/**
	 * Last away state seen for the peer of a query window: their message,
	 * `*` (`draft/pre-away`: away, no reason given), "" once back.
	 */
	userAway: string | undefined = undefined;
	/**
	 * The query's last away line was an "is away": only then does the peer's
	 * return get an "is back" (a pre-away peer's tab-switch star → back
	 * showed nothing on the way out, so it shows nothing on the way back).
	 */
	awayShown = false;
	/** Reference of every message handed to the UI, by id (`more` cursor lookup). */
	readonly msgRefs = new Map<number, MsgRef>();
	/**
	 * Message id by msgid for every message handed to the UI. Used to
	 * deduplicate history replies and to resolve reply / react / REDACT /
	 * edit references (bus-contract §1.4: the IRC layer owns this map).
	 */
	readonly idByMsgid = new Map<string, number>();
	/**
	 * Edits shown before their original was (the original arrives later in
	 * an older page): the original's msgid → every such edit, and who sent
	 * it. When the original is delivered, `IrcClient.settleLateOriginal` puts
	 * its author's edit in its place, so the two never stand side by side,
	 * and makes anyone else's a line of its own.
	 */
	private readonly editsBeforeOriginal = new Map<string, WaitingEdit[]>();
	/** The newest message we have seen; a reconnect asks for history AFTER it. */
	newestRef: MsgRef | undefined = undefined;
	/**
	 * A query opened by a line or a restored log rather than by the user, and
	 * not yet opened, read or written in: a close another device or tab made
	 * may still take it away (irc/closedQueries.ts applyClosed).
	 */
	autoOpened = false;
	/**
	 * Unix ms of the newest line the server sent here (one with a msgid): a
	 * close's boundary (irc/closedQueries.ts). Lines this device made carry its
	 * clock, so they never move it.
	 */
	newestServerAt: number | undefined = undefined;
	/** History has been requested at least once (so `newestRef` is a valid catch-up reference). */
	historyRequested = false;
	/**
	 * Everything up to the newest line the server stamped is held: the
	 * JOIN's fill (or a reconnect's walk) was answered in full, or TARGETS
	 * said nothing was new. Cleared when a JOIN's catch-up is scheduled and
	 * set again when it completes, so a catch-up the socket cut short is
	 * never taken for one that finished (catchup.ts).
	 */
	historyFilled = false;
	/**
	 * The server refused this target's history (`FAIL CHATHISTORY
	 * INVALID_TARGET`) while we were in it, and this is the account we were
	 * logged in as then ("" for none). Not asked again while that account
	 * stays the same, reconnects included: a login (or logout) lifts it, and
	 * so does a reload. A network may keep history for logged-in accounts
	 * only (nefarious2's CHATHISTORY_REQUIRE_AUTH, on at AfterNET), so this is
	 * a routine answer, not an error (history.ts `chatHistoryFailed`).
	 */
	historyDenied: string | undefined = undefined;
	/**
	 * Open, but its reader was taken to an older message: nothing is read until
	 * they reach the bottom ({@link IrcClient.isReading}). What we say still reads it,
	 * and so do reads from other sessions.
	 */
	readHeld = false;
	/** A `more` page the connection died on; asked again once we are back (history.ts). */
	lostMore: HistorySpec | undefined = undefined;
	/**
	 * Read marker (`draft/read-marker`): the newest time we have sent or the
	 * server has told us was read, on any of the account's sessions. Messages
	 * at or before it never count as unread.
	 */
	readMarker: Date | undefined = undefined;
	/**
	 * The server has told us this channel's marker at least once, `*` (none
	 * stored) included: asking again would only cost fake lag.
	 */
	markerAnswered = false;
	/** Pending debounced `MARKREAD` send (handlers/markread.ts). */
	markReadTimer: ReturnType<typeof setTimeout> | null = null;
	/** A debounced `MARKREAD` came due while the connection was not
	 * registered; sent once it is (`flushDeferredMarkRead`). */
	markReadDeferred = false;
	/** When this channel's marker last went ahead of the catch-up (ms; handlers/markread.ts). */
	markReadJumpedAt = 0;
	private readonly fold: Casefold;

	constructor(
		id: number,
		name: string,
		type: ChanType,
		fold: Casefold,
		options: {state?: ChanState; key?: string} = {}
	) {
		this.fold = fold;
		this.shared = {
			id,
			name,
			type,
			key: options.key ?? "",
			topic: "",
			messages: [],
			totalMessages: 0,
			firstUnread: 0,
			unread: 0,
			highlight: 0,
			muted: false,
			state:
				options.state ?? (type === ChanType.CHANNEL ? ChanState.PARTED : ChanState.JOINED),
		};
	}

	get id(): number {
		return this.shared.id;
	}

	get name(): string {
		return this.shared.name;
	}

	get type(): ChanType {
		return this.shared.type;
	}

	get state(): ChanState {
		return this.shared.state;
	}

	set state(state: ChanState) {
		this.shared.state = state;
	}

	/** Record a message handed to the UI so history requests can refer to it. */
	remember(msg: SharedMsg): MsgRef {
		const ref: MsgRef = {time: msg.time instanceof Date ? msg.time : new Date(msg.time)};

		if (msg.msgid) {
			ref.msgid = msg.msgid;
			this.idByMsgid.set(msg.msgid, msg.id);
			this.newestServerAt = Math.max(this.newestServerAt ?? 0, ref.time.getTime());
		}

		if (msg.type === MessageType.MESSAGE || msg.type === MessageType.ACTION) {
			ref.reactable = true;
		}

		if (msg.self || msg.from?.nick) {
			ref.from = authorOf(msg);
		}

		if (msg.editOf) {
			ref.editOf = msg.editOf;
		}

		this.msgRefs.set(msg.id, ref);
		return ref;
	}

	/**
	 * The UI dropped these messages from its buffer (it keeps 100 for a
	 * channel it is not showing, router.ts / socket-events/msg.ts): forget
	 * them here too, or every page that brings them back is deduplicated
	 * away and the channel can never scroll past that point again. They
	 * are re-remembered, under fresh ids, when a page delivers them.
	 */
	forget(ids: number[]): void {
		for (const id of ids) {
			const ref = this.msgRefs.get(id);

			if (!ref) {
				continue;
			}

			this.msgRefs.delete(id);

			if (ref.msgid && this.idByMsgid.get(ref.msgid) === id) {
				this.idByMsgid.delete(ref.msgid);
			}

			if (this.shared.totalMessages > 0) {
				this.shared.totalMessages--;
			}
		}
	}

	/** The edit `editMsgid` is shown, its original `originalMsgid` not yet. */
	awaitOriginal(originalMsgid: string, editMsgid: string, by: Author): void {
		const waiting = this.editsBeforeOriginal.get(originalMsgid);

		if (waiting) {
			waiting.push({msgid: editMsgid, by});
		} else {
			this.editsBeforeOriginal.set(originalMsgid, [{msgid: editMsgid, by}]);
		}
	}

	/** The shown edits waiting for `msgid`, oldest first, taken off the list. */
	takeEditsOf(msgid: string): WaitingEdit[] {
		const edits = this.editsBeforeOriginal.get(msgid) ?? [];
		this.editsBeforeOriginal.delete(msgid);
		return edits;
	}

	/** Id of the loaded message with `msgid`, if we have shown it. */
	idOf(msgid: string): number | undefined {
		return this.idByMsgid.get(msgid);
	}

	/** msgids already shown (history deduplication). */
	get msgids(): IterableIterator<string> {
		return this.idByMsgid.keys();
	}

	/**
	 * The newest message the server stamped — one with a msgid, whose time is
	 * the server's. `newestRef` can be a local line on our own clock (an
	 * error while the socket was dead), later than lines the server stored
	 * that we never got: never vouch for "nothing new" by that one.
	 */
	newestServerRef(): MsgRef | undefined {
		if (this.newestRef?.msgid) {
			return this.newestRef;
		}

		let best: MsgRef | undefined;

		for (const ref of this.msgRefs.values()) {
			if (ref.msgid && (!best || ref.time.getTime() > best.time.getTime())) {
				best = ref;
			}
		}

		return best;
	}

	/** Time of the oldest line we hold whose msgid is in `among`, in ms. */
	oldestTimeOf(among: ReadonlySet<string>): number | undefined {
		return this.timeSpanOf(among)?.[0];
	}

	/** Time of the newest line we hold whose msgid is in `among`, in ms. */
	newestTimeOf(among: ReadonlySet<string>): number | undefined {
		return this.timeSpanOf(among)?.[1];
	}

	private timeSpanOf(among: ReadonlySet<string>): [number, number] | undefined {
		let span: [number, number] | undefined;

		for (const ref of this.msgRefs.values()) {
			if (ref.msgid && among.has(ref.msgid)) {
				const time = ref.time.getTime();
				span = span ? [Math.min(span[0], time), Math.max(span[1], time)] : [time, time];
			}
		}

		return span;
	}

	/**
	 * Where a reconnect's catch-up walk may stop (history.ts, the floor):
	 * {@link newestServerRef}, so that a local line on a clock ahead of the
	 * server's cannot end the walk above the gap. A server that sends no
	 * msgids gives no such line; there it is `newestRef`, as before.
	 */
	catchupRef(): MsgRef | undefined {
		return this.newestServerRef() ?? this.newestRef;
	}

	/**
	 * msgid of the newest chat line that has one (`/react` without an
	 * explicit msgid). Joins, quits and other events carry msgids too, but
	 * show no reactions, and `newestRef` may be a local line without a
	 * msgid, so fall back to the latest remembered chat line.
	 */
	newestReactableMsgid(): string | undefined {
		if (this.newestRef?.msgid && this.newestRef.reactable) {
			return this.newestRef.msgid;
		}

		let best: MsgRef | undefined;

		for (const ref of this.msgRefs.values()) {
			if (
				ref.msgid &&
				ref.reactable &&
				(!best || ref.time.getTime() >= best.time.getTime())
			) {
				best = ref;
			}
		}

		return best?.msgid;
	}

	/** Copy handed to the UI; `messages` is always empty (the store owns them). */
	snapshot(): SharedNetworkChan {
		return {...this.shared, messages: []};
	}

	findUser(nick: string): SharedUser | undefined {
		return this.users.get(this.fold(nick));
	}

	/** Existing user or a detached placeholder (never inserted). */
	getUser(nick: string): SharedUser {
		return this.findUser(nick) ?? newUser(nick);
	}

	/** `{nick, mode}` for a message's `from`/`target` field. */
	userRef(nick: string): UserInMessage {
		return {nick, mode: this.findUser(nick)?.mode ?? ""};
	}

	setUser(user: SharedUser): void {
		this.users.set(this.fold(user.nick), user);
	}

	removeUser(nick: string): boolean {
		return this.users.delete(this.fold(nick));
	}

	/** Rename a user in place; returns the record if it was present. */
	renameUser(oldNick: string, newNick: string): SharedUser | undefined {
		const user = this.findUser(oldNick);

		if (!user) {
			return undefined;
		}

		this.users.delete(this.fold(oldNick));
		user.nick = newNick;
		this.users.set(this.fold(newNick), user);
		return user;
	}

	/** Users sorted by prefix rank (highest first), then nick. */
	sortedUsers(rank: (symbol: string) => number): SharedUser[] {
		return Array.from(this.users.values()).sort((a, b) => {
			const ra = a.mode === "" ? Number.MAX_SAFE_INTEGER : rank(a.mode);
			const rb = b.mode === "" ? Number.MAX_SAFE_INTEGER : rank(b.mode);

			if (ra !== rb) {
				return ra - rb;
			}

			return this.fold(a.nick) < this.fold(b.nick) ? -1 : 1;
		});
	}
}
