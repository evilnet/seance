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
	 * echo, unchanged topic and NAMES are state, not activity, and are not
	 * shown (cleared by the end of that NAMES burst).
	 */
	rejoining = false;
	/** The 332 just seen was hidden (a topic we already show); hide its 333 too. */
	topicQuiet = false;
	/** The user asked for the topic (`/topic`): show the next 331/332 even if it is unchanged. */
	topicAsked = false;
	/** The 332 just shown was asked for: it and its 333 follow the user to the active tab. */
	topicAskedActive = false;
	/** The modes 324 last showed; a reconnect asks again and gets the same answer back. */
	modeText: string | undefined = undefined;
	/** The user asked for the modes (`/mode #chan`): show the next 324 even if it is unchanged. */
	modesAsked = false;
	/** Last away message seen for the peer of a query window. */
	userAway: string | undefined = undefined;
	/** Reference of every message handed to the UI, by id (`more` cursor lookup). */
	readonly msgRefs = new Map<number, MsgRef>();
	/**
	 * Message id by msgid for every message handed to the UI. Used to
	 * deduplicate history replies and to resolve reply / react / REDACT /
	 * edit references (bus-contract §1.4: the IRC layer owns this map).
	 */
	readonly idByMsgid = new Map<string, number>();
	/** The newest message we have seen; a reconnect asks for history AFTER it. */
	newestRef: MsgRef | undefined = undefined;
	/** History has been requested at least once (so `newestRef` is a valid catch-up reference). */
	historyRequested = false;
	/** A `more` page the connection died on; asked again once we are back (history.ts). */
	lostMore: HistorySpec | undefined = undefined;
	/**
	 * Read marker (`draft/read-marker`): the newest time we have sent or the
	 * server has told us was read, on any of the account's sessions. Messages
	 * at or before it never count as unread.
	 */
	readMarker: Date | undefined = undefined;
	/** Pending debounced `MARKREAD` send (handlers/markread.ts). */
	markReadTimer: ReturnType<typeof setTimeout> | null = null;
	/** A debounced `MARKREAD` came due while the connection was not
	 * registered; sent once it is (`flushDeferredMarkRead`). */
	markReadDeferred = false;
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
		}

		if (msg.type === MessageType.MESSAGE || msg.type === MessageType.ACTION) {
			ref.reactable = true;
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

	/** Id of the loaded message with `msgid`, if we have shown it. */
	idOf(msgid: string): number | undefined {
		return this.idByMsgid.get(msgid);
	}

	/** msgids already shown (history deduplication). */
	get msgids(): IterableIterator<string> {
		return this.idByMsgid.keys();
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
