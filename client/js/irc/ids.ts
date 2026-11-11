/** Ids set aside by {@link IdAllocator.reserve}: `next` up to `end` (exclusive). */
export interface IdBlock {
	next: number;
	end: number;
}

/**
 * Id allocation for channels and messages.
 *
 * The UI assumes channel ids are unique across every network (`findChannel`,
 * the `#/chan-<id>` route) and that message ids increase with a channel's row
 * order across every channel (unread marker, `more.lastId`, mention dedupe),
 * which is time order: a catch-up gap delivered late takes ids set aside
 * before the live lines it arrives behind ({@link reserve}). One shared
 * allocator therefore serves all {@link IrcClient} instances; tests can pass
 * their own to get deterministic numbers.
 */
export class IdAllocator {
	private nextChan: number;
	private nextMsg: number;
	/**
	 * Upper bound (exclusive) of the next history block; see {@link historyIds}.
	 * Starts at -1 so that -1 itself is never handed out: the UI sends
	 * `more.lastId = -1` to mean "no messages shown".
	 */
	private nextHistory = -1;

	constructor(firstChanId = 1, firstMsgId = 1) {
		this.nextChan = firstChanId;
		this.nextMsg = firstMsgId;
	}

	/** Allocate a channel id (never 0: `join.index` and `open` treat 0 as "none"). */
	chanId(): number {
		return this.nextChan++;
	}

	msgId(): number {
		return this.nextMsg++;
	}

	/**
	 * Set aside `count` message ids, above every id handed out so far and
	 * below every later one, for lines that are older than what arrives
	 * next but are only delivered after it: a reconnect's catch-up gap,
	 * reserved at our JOIN, comes in after the lines relayed live while it
	 * was being fetched, and its ids keep it above them.
	 */
	reserve(count: number): IdBlock {
		const block = {next: this.nextMsg, end: this.nextMsg + count};
		this.nextMsg += count;
		return block;
	}

	/**
	 * Ids for `count` history messages that are prepended in front of what
	 * the channel already shows: an ascending block, every id of which is
	 * below every id handed out before (live ids are positive, history ids
	 * negative). Assign them oldest-first, so ids keep increasing with time
	 * and the unread marker / `more` cursor keep working.
	 */
	historyIds(count: number): number[] {
		const ids: number[] = [];
		const end = this.nextHistory;
		this.nextHistory -= count;

		for (let id = this.nextHistory; id < end; id++) {
			ids.push(id);
		}

		return ids;
	}
}

/** Allocator shared by every network in the running app. */
export const sharedIds = new IdAllocator();
