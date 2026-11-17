/**
 * Chat history over `draft/chathistory` (https://ircv3.net/specs/extensions/chathistory).
 *
 * Two flows feed the UI:
 *
 * - **Older messages** (`more` on the bus, and `LATEST` on the first JOIN of
 *   a channel): `CHATHISTORY BEFORE|LATEST <target> <ref> <limit>` is sent,
 *   the reply arrives as a `chathistory` batch (`handlers/batch.ts`), every
 *   line in it is replayed through the normal handlers in collect mode
 *   (`IrcClient.collectReplay`: nothing is dispatched, no counters move, no
 *   user-list / topic side effects) and the result is handed to
 *   `socket-events/more.ts` as one `more` event, oldest first, with ids
 *   below everything the channel already shows (`IdAllocator.historyIds`).
 *   A replayed mention keeps `highlight` (the line renders highlighted),
 *   but history never notifies; what it holds past a known read marker
 *   counts as unread (the first page after a JOIN is often all the
 *   catch-up there is).
 * - **Catch-up** (re-JOIN after a reconnect): the spec's own gap-filling
 *   loop (chathistory.md, "Client pseudocode"): `CHATHISTORY LATEST`, then
 *   `BEFORE <oldest of the page>` back until a page overlaps what we already
 *   show (a msgid we held when our JOIN came back, or a line older than the
 *   newest we had seen minus {@link CATCHUP_FUZZ_MS} of clock skew), carries
 *   `draft/chathistory-end`, comes back empty, or the page cap is hit.
 *   Walking back from the present rather than forward from our newest line
 *   means the newest messages arrive first and the fill cannot be defeated
 *   by an anchor the server can no longer see (a presence gap, retention,
 *   a clock disagreement): it stops where the server's history meets ours.
 *   The pages are gathered and appended once, oldest first, as ordinary
 *   `msg` events flagged `replay` (a line no newer than what we held goes
 *   in among the rows by its time, {@link placeByTime}): counted as unread
 *   like live ones (`IrcClient.pushMessage`), but no notification or
 *   mention entry. The server can drive the same thing itself off a
 *   `PERSISTENCE ATTACH` cursor, in which case its `chathistory` batches
 *   arrive unasked inside a `evilnet.github.io/bouncer-replay` wrapper and
 *   take the same path, appended without placement (persistence.ts).
 *
 * Requests are matched to replies by `labeled-response` label when that
 * cap is on, else by target. `FAIL CHATHISTORY`, a labeled `ACK` or a
 * {@link HISTORY_TIMEOUT_MS} timeout answer the pending `more` with no
 * messages so the UI never sticks in `historyLoading` (bus-contract §more).
 * A refusal (`INVALID_TARGET`) is not shown, and the target is not asked
 * again until our account changes ({@link chatHistoryFailed}).
 */

import {ChanState, ChanType} from "../../../shared/types/chan";
import type {MessageType, SharedMsg} from "../../../shared/types/msg";
import type {Channel, MsgRef} from "./channel";
import type {IdBlock} from "./ids";
import type {IrcClient, ReplayCollection} from "./client";
import type {BatchHandler} from "./handlers/batch";
import {countPageUnread, scheduleMarkRead} from "./handlers/markread";
import {enqueueMarkerFetch} from "./catchup";
import {formatLine, IrcMessage} from "./message";
import {searchAck, searchContextBatch} from "./historysearch";
import {settlePendingLabel} from "./pending";
import {lineIdentity} from "./conversationStore";
import {inBouncerReplay, inServerCatchup} from "./persistence";
import type {Handler} from "./types";

/** How long to wait for the server before answering `more` with nothing. */
export const HISTORY_TIMEOUT_MS = 15_000;

/** One `CHATHISTORY BEFORE` page of the catch-up walk: a command. */
const PAGE_COST_MS = 2000;
/** Page size for `more` (the old server also paged by 100). */
export const MORE_PAGE_SIZE = 100;
/** Lines asked of the device beyond a page, for the ones the window already shows. */
const DEVICE_PAGE_OVERLAP = 20;
/** Page size for the LATEST request on first JOIN. */
export const JOIN_PAGE_SIZE = 50;
/** Most pages fetched in one catch-up (LATEST plus BEFORE pages). */
const MAX_CATCHUP_PAGES = 5;
/**
 * Ids set aside for one catch-up's gap (`IrcClient.reserveIds`): the walk
 * brings at most pages × page size, and the cursor's replay, every target's
 * together, would have to be this long to run out. Past that, lines take
 * ordinary ids and land after the live ones, as every gap did before.
 */
export const GAP_IDS = 1_000_000;
/** Clock-skew allowance when deciding a page has reached what we already
 * held (the spec's FUZZ_INTERVAL, "perhaps 1 to 10 seconds"). */
export const CATCHUP_FUZZ_MS = 5_000;

/** The open channel's next page goes at once while the server's clock stays under this (ms). */
const PAGE_NOW_LIMIT_MS = 6_000;

/** A page for the channel being looked at can go now without nearing the ceiling. */
export function pageFitsNow(client: IrcClient): boolean {
	return client.fakeLag.ahead() + PAGE_COST_MS <= PAGE_NOW_LIMIT_MS;
}

export type HistorySubcommand = "LATEST" | "BEFORE" | "AFTER";

export interface HistorySpec {
	subcommand: HistorySubcommand;
	/** Reference message (required for BEFORE / AFTER). */
	ref?: MsgRef;
	limit: number;
	mode: "prepend" | "append";
	pagesLeft?: number;
	floor?: MsgRef;
	/** Catch-up: the msgids held when the walk began (see HistoryRequest.held). */
	held?: ReadonlySet<string>;
	/** Re-issue after a reconnect when the answer never came (the `more` pages). */
	retry?: boolean;
	/** Catch-up: ids for the gap, set aside when it started (`IrcClient.reserveIds`). */
	ids?: IdBlock;
	/** Filling a marked gap: the id of the line the marker stands before ({@link requestFill}). */
	fill?: number;
}

export interface HistoryRequest {
	chan: Channel;
	target: string;
	subcommand: HistorySubcommand;
	/** `labeled-response` label the reply is expected to carry. */
	label?: string;
	/** prepend: answer `more`; append: deliver as live `msg` events. */
	mode: "prepend" | "append";
	/** Limit as sent; a reply of this many lines means more may exist. */
	limit: number;
	/**
	 * A `more` page: what to ask again when the connection dies before the
	 * answer (see {@link abortHistory}). The other requests are re-made by
	 * the reconnect itself (the JOIN fill and its catch-up walk).
	 */
	retry?: HistorySpec;
	/** Further BEFORE pages allowed (append mode). */
	pagesLeft: number;
	/** Catch-up: the newest message the previous session saw; the walk back stops on reaching it. */
	floor?: MsgRef;
	/**
	 * Catch-up: the msgids the channel held at our JOIN; only these mean a
	 * page reached what we had. A line relayed while the walk runs is in its
	 * pages too, with the gap below it still unfilled.
	 */
	held?: ReadonlySet<string>;
	/** Catch-up: the gap gathered so far, oldest first (pages arrive newest first). */
	gap: SharedMsg[];
	/** Catch-up: post-delivery work of the gathered pages, in the same order. */
	gapAfter: (() => void)[];
	/** Catch-up: the gap's ids (HistorySpec.ids). */
	ids?: IdBlock;
	/** Filling a marked gap (HistorySpec.fill). */
	fill?: number;
	timer: ReturnType<typeof setTimeout>;
}

const pendingByClient = new WeakMap<IrcClient, HistoryRequest[]>();
let labelCounter = 0;

function pendingOf(client: IrcClient): HistoryRequest[] {
	let list = pendingByClient.get(client);

	if (!list) {
		list = [];
		pendingByClient.set(client, list);
	}

	return list;
}

/** Requests in flight for `client` (tests / diagnostics). */
export function pendingHistory(client: IrcClient): readonly HistoryRequest[] {
	return pendingOf(client);
}

export function historyEnabled(client: IrcClient): boolean {
	return client.caps.hasCapability("draft/chathistory");
}

/** `wanted` capped by ISUPPORT `CHATHISTORY=<n>` (0 / absent = no cap). */
export function historyLimit(client: IrcClient, wanted: number): number {
	const cap = client.isupport.chathistory;
	return cap !== undefined && cap > 0 ? Math.min(wanted, cap) : wanted;
}

function canRequest(client: IrcClient, chan: Channel): boolean {
	return (
		historyEnabled(client) &&
		client.isWelcomed && // before 001 it is `451 Register first.`
		(chan.type === ChanType.CHANNEL || chan.type === ChanType.QUERY) &&
		chan.historyDenied !== client.account // refused as we are (chatHistoryFailed)
	);
}

/** Whether the server takes `msgid=` references (MSGREFTYPES; unlisted means any). */
export function takesMsgidRefs(client: IrcClient): boolean {
	const types = client.isupport.tokens.get("MSGREFTYPES");
	return types === undefined || types.split(",").includes("msgid");
}

/** Whether the server takes `timestamp=` references (MSGREFTYPES; unlisted means any). */
export function takesTimestampRefs(client: IrcClient): boolean {
	const types = client.isupport.tokens.get("MSGREFTYPES");
	return types === undefined || types.split(",").includes("timestamp");
}

/** `msgid=…` when we have one and the server takes it, else `timestamp=<ISO 8601>`. */
export function formatRef(client: IrcClient, ref: MsgRef): string {
	if (ref.msgid && takesMsgidRefs(client)) {
		return `msgid=${ref.msgid}`;
	}

	return `timestamp=${ref.time.toISOString()}`;
}

/**
 * Send one CHATHISTORY request for `chan`. Returns the pending request, or
 * undefined when history is unavailable (cap off, disconnected, lobby).
 */
export function requestHistory(
	client: IrcClient,
	chan: Channel,
	spec: HistorySpec
): HistoryRequest | undefined {
	if (!canRequest(client, chan)) {
		return undefined;
	}

	const limit = historyLimit(client, spec.limit);
	const ref = spec.ref ? formatRef(client, spec.ref) : "*";
	const tags: Record<string, string> = {};
	let label: string | undefined;

	if (client.caps.hasCapability("labeled-response")) {
		label = `h${++labelCounter}`;
		tags.label = label;
	}

	const line = formatLine({
		tags,
		command: "CHATHISTORY",
		params: [spec.subcommand, chan.name, ref, String(limit)],
	});

	if (!client.send(line)) {
		return undefined;
	}

	const request: HistoryRequest = {
		chan,
		target: chan.name,
		subcommand: spec.subcommand,
		label,
		mode: spec.mode,
		limit,
		retry: spec.retry ? {...spec, retry: false} : undefined,
		pagesLeft: spec.pagesLeft ?? 0,
		floor: spec.floor,
		held: spec.held,
		ids: spec.ids,
		fill: spec.fill,
		gap: [],
		gapAfter: [],
		timer: setTimeout(() => resolve(client, request, null, "timeout"), HISTORY_TIMEOUT_MS),
	};
	pendingOf(client).push(request);
	chan.historyRequested = true;
	return request;
}

/**
 * The bus `more` emit: BEFORE the message the UI shows first (`lastId`), or
 * LATEST when the channel is empty (`lastId === -1`, which history ids
 * never use). False when nothing was sent — the caller must then answer
 * `more` itself.
 */
export function requestMore(client: IrcClient, chan: Channel, lastId: number): boolean {
	// The device's own lines first (conversationStore.ts): they are there
	// without a connection, and older than what the server keeps. Only when
	// it has none older does the server get asked.
	const first = lastId === -1 ? undefined : chan.msgRefs.get(lastId);

	if (first && client.conversations.meta(chan.name)) {
		if (chan.deviceMore) {
			return true;
		}

		chan.deviceMore = true;
		void client.conversations
			.older(chan.name, first.time, MORE_PAGE_SIZE + DEVICE_PAGE_OVERLAP)
			.then((lines) => {
				chan.deviceMore = false;

				if (!client.channels.includes(chan)) {
					return;
				}

				const fresh = lines.filter((msg) => !chan.shows(msg)).slice(-MORE_PAGE_SIZE);

				if (fresh.length > 0) {
					deliverPrepend(client, chan, fresh, true, true);
				} else if (!requestServerMore(client, chan, lastId)) {
					// The device has no more and the server cannot be asked.
					// Offline, the control stays for when it can.
					client.dispatch("more", {
						chan: chan.id,
						messages: [],
						totalMessages: chan.shared.totalMessages,
						moreAvailable: !client.isWelcomed,
						device: false,
					});
				}
			});
		return true;
	}

	return requestServerMore(client, chan, lastId);
}

/** {@link requestMore}, from the server. */
function requestServerMore(client: IrcClient, chan: Channel, lastId: number): boolean {
	if (!canRequest(client, chan)) {
		return false;
	}

	// A fresh page for this channel supersedes one parked by a dead socket.
	chan.lostMore = undefined;

	// A page is already on its way (the JOIN fill, or a page re-asked after
	// a reconnect): its answer is the `more` the UI is waiting for. One
	// prepend in flight per channel; two would answer the same rows twice.
	if (pendingOf(client).some((r) => r.chan === chan && r.mode === "prepend")) {
		return true;
	}

	if (lastId === -1) {
		return (
			requestHistory(client, chan, {
				subcommand: "LATEST",
				limit: MORE_PAGE_SIZE,
				mode: "prepend",
				retry: true,
			}) !== undefined
		);
	}

	const ref = chan.msgRefs.get(lastId);

	if (!ref) {
		return false;
	}

	return (
		requestHistory(client, chan, {
			subcommand: "BEFORE",
			ref,
			limit: MORE_PAGE_SIZE,
			mode: "prepend",
			retry: true,
		}) !== undefined
	);
}

/**
 * Load the lines missing before the marked line `id` of `chan` (the gap
 * marker, SharedMsg.gapBefore): the catch-up walk again, from that line
 * back, `BEFORE` pages until one meets what the window holds below the
 * marker, the server says there is no more, or the page cap. What it brings
 * goes in above the marked line, by time; the marker then goes, or moves up
 * to the oldest line brought when the walk stopped short again. False when
 * nothing could be asked.
 */
export function requestFill(
	client: IrcClient,
	chan: Channel,
	id: number,
	pages = MAX_CATCHUP_PAGES
): boolean {
	const ref = chan.msgRefs.get(id);

	if (!ref?.gap || !canRequest(client, chan)) {
		return false;
	}

	if (pendingOf(client).some((r) => r.chan === chan && r.fill !== undefined)) {
		return true; // one fill per channel at a time
	}

	// The floor: the newest line the server stamped below the marker.
	const floor = chan.newestServerRefBefore(ref.time.getTime(), ref);

	return (
		requestHistory(client, chan, {
			subcommand: "BEFORE",
			ref,
			limit: MORE_PAGE_SIZE,
			mode: "append",
			pagesLeft: pages - 1,
			floor,
			held: new Set(chan.msgids),
			fill: id,
		}) !== undefined
	);
}

/**
 * Our JOIN was confirmed: fill the channel. First time round that is the
 * latest {@link JOIN_PAGE_SIZE} messages; after a reconnect (history was
 * loaded before and we know the newest message) it is the gap between that
 * message and now, gathered from LATEST backwards (see the header) and
 * appended as live messages. `before` is the channel's catch-up reference
 * (Channel.catchupRef) as it was before the JOIN line itself was pushed:
 * the walk's floor, so a line the server stamped where there is one. `held`
 * is its msgids then (taken now when absent: a request sent ahead of the JOIN
 * echo).
 */
export function requestChannelHistory(
	client: IrcClient,
	chan: Channel,
	before: MsgRef | undefined,
	held?: ReadonlySet<string>,
	ids?: IdBlock
): HistoryRequest | undefined {
	if (chan.historyRequested && before) {
		return requestHistory(client, chan, {
			subcommand: "LATEST",
			limit: MORE_PAGE_SIZE,
			mode: "append",
			pagesLeft: MAX_CATCHUP_PAGES - 1,
			floor: before,
			held: held ?? new Set(chan.msgids),
			ids,
		});
	}

	return requestHistory(client, chan, {
		subcommand: "LATEST",
		limit: JOIN_PAGE_SIZE,
		mode: "prepend",
	});
}

/**
 * Transport closed: answer every pending request with nothing. A `more`
 * page among them is parked on its channel and asked again once the
 * connection is back ({@link retryLostHistory}): the UI was released with
 * an empty page, and at the top of a buffer there is no scroll left to
 * make it ask a second time (a phone returning from the background scrolls
 * up while the transport still believes its dead socket is open, and the
 * request goes into that socket).
 */
export function abortHistory(client: IrcClient): void {
	const pending = pendingOf(client);

	for (const request of [...pending]) {
		// A catch-up walk, its next page in flight, is dropped whole (below):
		// resolving it would deliver the pages gathered so far.
		if (request.mode === "append") {
			pending.splice(pending.indexOf(request), 1);
			clearTimeout(request.timer);
			continue;
		}

		if (request.retry) {
			request.chan.lostMore = request.retry;
		}

		resolve(client, request, null, "timeout");
	}
	// A walk, whether its next page is in flight or waits in the background
	// queue (which the close empties), is dropped whole, its pages
	// undelivered: what the channel holds has not moved (nor its newest
	// line, nor the cursor saved with the close), so the next connection
	// walks the same gap from the same floor. Landing its newest pages would
	// have moved it, and that walk would stop at them with the older part
	// never fetched.
}

/**
 * Re-issue the `more` page `chan` lost with the previous connection, if
 * any. Called once the channel can answer again: behind the JOIN fill for
 * a channel, at registration for a query.
 */
export function retryLostHistory(client: IrcClient, chan: Channel): void {
	const spec = chan.lostMore;

	if (!spec) {
		return;
	}

	chan.lostMore = undefined;
	requestHistory(client, chan, {...spec, retry: true});
}

// ---------------------------------------------------------------- replies

function findRequest(
	client: IrcClient,
	label: string | undefined,
	targets: string[],
	crossTargetFallback = true
): HistoryRequest | undefined {
	const pending = pendingOf(client);

	if (label) {
		const byLabel = pending.find((r) => r.label === label);

		if (byLabel) {
			return byLabel;
		}
	}

	for (const target of targets) {
		const byTarget = pending.find((r) => client.namesEqual(r.target, target));

		if (byTarget) {
			return byTarget;
		}
	}

	// A history batch names its target; one that matches no request by
	// label or by that target is NOT ours to answer with another channel's
	// request. Answering pending[0] delivered one channel's history into
	// whatever buffer had asked first (2026-09-06: #operserv's replay page
	// landed in #linux after a reload, when the outer bouncer-replay batch
	// went unrecognised). A FAIL keeps the fallback: its context may omit
	// the target, and the oldest request is then the only way it is
	// answered instead of waiting out the timeout.
	if (targets.length > 0 && !crossTargetFallback) {
		return undefined;
	}

	return pending[0];
}

/** What {@link replay} turned a batch into. */
interface Replayed {
	messages: SharedMsg[];
	/** Reaction / redaction / edit dispatches to run once `messages` are shown. */
	after: (() => void)[];
}

/**
 * Run the batch's lines through the normal handlers in collect mode and
 * keep what landed in `chan`, minus messages the channel already shows.
 * Work queued with `IrcClient.afterReplay` (TAGMSG reactions, REDACTs,
 * edit resends) is returned separately: it needs the messages'
 * ids, which only exist after delivery.
 */
function replay(client: IrcClient, chan: Channel, lines: IrcMessage[]): Replayed {
	const known = new Set(chan.msgids);
	const collected: ReplayCollection = {messages: [], after: []};

	for (const line of lines) {
		// Each handler copies its line's msgid (`msgidOf`), which is what
		// deduplicates below and serves as a BEFORE/AFTER reference. A handler
		// that forgets still gets it here: a replayed line is a stored one.
		const msgid = line.tags.get("msgid");
		// The page so far goes along: an edit judges an original on it
		// (privmsg.ts, the author rule).
		const result = client.collectReplay(
			chan,
			() => client.handleMessage(line),
			false,
			collected
		);

		for (const item of result.messages) {
			if (msgid && !item.msg.msgid) {
				item.msg.msgid = msgid;
			}

			collected.messages.push(item);
		}

		collected.after.push(...result.after);
	}

	const messages: SharedMsg[] = [];

	for (const {chan: target, msg} of collected.messages) {
		if (target !== chan) {
			continue;
		}

		if (msg.msgid && known.has(msg.msgid)) {
			continue; // already shown (dedupe against the channel, not within the batch)
		}

		if (chan.clearedAt !== undefined && new Date(msg.time).getTime() <= chan.clearedAt) {
			continue; // cleared by the user on this device: not brought back
		}

		// msg.highlight is kept: a replayed mention renders highlighted.
		// Delivery is what stays silent (no notification) — deliverAppend
		// pushes with `replay` and `more` never notifies.
		messages.push(msg);
	}

	return {messages, after: collected.after};
}

/** Run the queued post-delivery work; one failure must not skip the rest. */
function runAfter(after: (() => void)[]): void {
	for (const fn of after) {
		try {
			fn();
		} catch (err: unknown) {
			// eslint-disable-next-line no-console
			console.error("[irc] post-replay action failed", err);
		}
	}
}

/** Hand older messages to the UI as one `more` event. */
function deliverPrepend(
	client: IrcClient,
	chan: Channel,
	messages: SharedMsg[],
	moreAvailable: boolean,
	device?: boolean
): void {
	const ids = client.historyIds(messages.length);
	let lastRef: MsgRef | undefined;
	// The first page after a JOIN is the only catch-up when the server had
	// no cursor to replay from, and the read marker (sent right after the
	// JOIN) is known by then: what someone else said past it is unread.
	const marker = chan.readMarker;
	const looking = client.isReading(chan);
	const page: Array<[SharedMsg, MsgRef]> = [];

	messages.forEach((msg, i) => {
		msg.id = ids[i];
		lastRef = chan.remember(msg);
		page.push([msg, lastRef]);

		// Older by definition, but a LATEST fill can still hold the newest
		// line we have seen; noteCursor only ever moves forward.
		client.noteCursor(msg);

		client.keep(chan, msg); // added only when the device does not hold it
	});

	if (!chan.newestRef && lastRef) {
		chan.newestRef = lastRef;
	}

	if (looking && messages.length > 0) {
		// Shown to someone looking: read, as a live line would be.
		scheduleMarkRead(client, chan);
	}

	chan.shared.totalMessages += messages.length;
	// `moreAvailable` is the decision (end tag / full page / retryable
	// timeout); it used to travel as totalMessages+1 and be re-derived by
	// comparing against the CURRENT row count, which already holds live
	// rows (the JOIN echo, a topic) -- 51 > 2 + 50 is false, so a full
	// first page of a large channel hid the button and scrollback was never
	// offered; under overlapping requests the running total drifted the
	// other way. Send the boolean; totalMessages stays for other readers.
	const totalMessages = chan.shared.totalMessages + (moreAvailable ? 1 : 0);
	client.dispatch("more", {
		chan: chan.id,
		messages,
		totalMessages,
		moreAvailable,
		...(device === undefined ? {} : {device}),
	});

	// An original its edit already replaced is not news, read or not, nor
	// a line in this page that it edits in turn.
	const hidden = new Set(messages.flatMap((msg) => client.settleLateOriginal(chan, msg)));
	const replaced = new Set(messages.filter((msg) => hidden.has(msg.id)));

	if (marker && !looking) {
		countPageUnread(client, chan, page, marker, 0, replaced);
	}

	// The page's other mentions are read already (or looked at now): they
	// are listed read, as a live one would be.
	const read = page.flatMap(([msg, ref]) => {
		const entry =
			ref.highlight || replaced.has(msg) ? null : client.mentionEntry(chan, msg, false);
		return entry ? [entry] : [];
	});

	if (read.length > 0) {
		client.dispatch("inbox:add", {entries: read});
	}
}

/**
 * Ids that put a reconnect's gathered lines among the rows already shown,
 * by server time, for the lines that are not newer than the newest line
 * held at the JOIN (`held`): a line missed between two held lines (#292),
 * or one kept inside the skew allowance below everything held (#290).
 * Appended with an id from the reserved block, either would show below
 * the newer held lines. Each goes after the last server-stamped row whose
 * time is no later than its own (after a tie), or before the first such
 * row when every one is newer; the lines are taken oldest first, so a run
 * keeps its server order. Its id lies between its neighbours' ids, which
 * is what the store orders rows by (helpers/messageUpdates.ts
 * `insertMessage`): a run after a row is numbered evenly across the open
 * interval up to the next row, never wider than one unit past the lower
 * row's integer part, so the ids are never integers, no allocator
 * (IdAllocator) can hand one out again, and the unit above an integer id
 * holds only its own channel's rows. A run before every row takes fresh
 * history ids instead (below every id there is), not a fraction under the
 * first row, which would lie in the unit above some other row's id. Lines
 * newer than everything held are left out: they take the reserved block, as
 * before. `old` holds every line that is not newer, numbered or not (out of
 * float precision after very many splits of one gap): none of them is the
 * channel's newest. Nothing is placed without a held line that carries a
 * msgid (no server time to place against).
 */
function placeByTime(
	client: IrcClient,
	chan: Channel,
	messages: SharedMsg[],
	held: ReadonlySet<string>
): {ids: Map<SharedMsg, number>; old: Set<SharedMsg>} {
	const placed = new Map<SharedMsg, number>();
	const old = new Set<SharedMsg>();
	const newest = chan.newestTimeOf(held);

	if (newest === undefined) {
		return {ids: placed, old};
	}

	interface Row {
		id?: number;
		time: number;
		stamped: boolean;
		msg?: SharedMsg;
	}

	// The rows as the store shows them: in id order.
	const rows: Row[] = [...chan.msgRefs]
		.sort((a, b) => a[0] - b[0])
		.map(([id, ref]) => ({id, time: ref.time.getTime(), stamped: ref.msgid !== undefined}));

	for (const msg of messages) {
		const time = new Date(msg.time).getTime();

		if (Number.isNaN(time) || time > newest) {
			continue;
		}

		old.add(msg);

		let at = rows.findIndex((row) => row.stamped);

		for (let i = rows.length - 1; i >= 0; i--) {
			if (rows[i].stamped && rows[i].time <= time) {
				at = i + 1;
				break;
			}
		}

		rows.splice(at, 0, {time, stamped: true, msg});
	}

	for (let start = 0; start < rows.length; start++) {
		if (!rows[start].msg) {
			continue;
		}

		let end = start;

		while (end < rows.length && rows[end].msg) {
			end++;
		}

		const lo = rows[start - 1]?.id;
		const hi = rows[end]?.id;
		const count = end - start;

		if (lo === undefined) {
			const fresh = client.historyIds(count);

			for (let k = 0; k < count; k++) {
				placed.set(rows[start + k].msg!, fresh[k]);
			}

			start = end;
			continue;
		}

		const from = lo;
		const to = Math.min(hi ?? Infinity, Math.floor(from) + 1);
		let previous = from;

		for (let k = 0; k < count; k++) {
			const id = from + ((to - from) * (k + 1)) / (count + 1);

			// Out of float precision (a gap split very many times): the
			// line keeps the reserved block's id instead.
			if (id > previous && id < to && !Number.isInteger(id)) {
				placed.set(rows[start + k].msg!, id);
				previous = id;
			}
		}

		start = end;
	}

	return {ids: placed, old};
}

/**
 * Append catch-up messages as live ones: counted as unread, never notified.
 * With `held` (a reconnect's walk), lines no newer than what was held go in
 * among the rows by time instead ({@link placeByTime}).
 */
function deliverAppend(
	client: IrcClient,
	chan: Channel,
	messages: SharedMsg[],
	ids: IdBlock | undefined,
	held?: ReadonlySet<string>
): void {
	const placed = held ? placeByTime(client, chan, messages, held) : undefined;

	for (const msg of messages) {
		// pushMessage copies; write the id back so post-replay work
		// (`afterReplay` closures hold the collected objects) can find it.
		msg.id = client.pushMessage(chan, msg, false, {
			replay: true,
			ids,
			id: placed?.ids.get(msg),
			old: placed?.old.has(msg),
		}).id;
	}

	// Unread against this device's read point only: another device may have
	// read it. The autojoin's ask for the query's marker may already have
	// been skipped, with nothing unread then (catchup.ts).
	if (chan.type === ChanType.QUERY && chan.shared.unread > 0) {
		enqueueMarkerFetch(client, chan);
	}
}

/**
 * A walk is over (the reconnect's catch-up, or the fill of a marked gap):
 * deliver what it gathered, in order, and say where lines are still
 * missing. `complete`: it met what the window held, or the server said there
 * is no more. When it did not, the oldest line it brought that is newer than
 * everything held gets the gap marker (SharedMsg.gapBefore): the lines
 * between it and the one before are not here, and the marker's control asks
 * for them ({@link requestFill}). The window is then complete down to the
 * marker, which is all `historyFilled` vouches for.
 */
function finishWalk(
	client: IrcClient,
	chan: Channel,
	walk: {held?: ReadonlySet<string>; ids?: IdBlock; fill?: number; floor?: MsgRef},
	gap: SharedMsg[],
	complete: boolean
): void {
	const held = walk.held ?? new Set(chan.msgids);

	if (walk.fill !== undefined) {
		// Filling a marked gap: every line is older than the marked one and
		// goes in by time. Stopped short again, the marker moves up to the
		// oldest line brought; nothing brought, it stays where it is.
		if (!complete && gap.length > 0) {
			gap[0].gapBefore = true;
		}

		deliverAppend(client, chan, gap, walk.ids, held);

		if (complete || gap.length > 0) {
			client.setGap(chan, walk.fill, false);
		} else {
			client.setGap(chan, walk.fill, true); // releases the control
		}

		return;
	}

	let marked = false;

	if (!complete && walk.floor) {
		const newestHeld = chan.newestTimeOf(held) ?? walk.floor.time.getTime();
		const first = gap.find((msg) => new Date(msg.time).getTime() > newestHeld);

		if (first) {
			first.gapBefore = true;
			marked = true;
		}
	}

	if (complete || marked) {
		chan.historyFilled = true;
	}

	deliverAppend(client, chan, gap, walk.ids, held);
	client.noteFilled(chan);
}

type Outcome = "batch" | "fail" | "ack" | "timeout";

function resolve(
	client: IrcClient,
	request: HistoryRequest,
	lines: IrcMessage[] | null,
	outcome: Outcome,
	end = false
): void {
	const pending = pendingOf(client);
	const idx = pending.indexOf(request);

	if (idx === -1) {
		return; // already answered (late reply after a timeout)
	}

	pending.splice(idx, 1);
	clearTimeout(request.timer);

	const {chan} = request;
	const answered = outcome === "batch" || outcome === "ack";

	const {messages, after} =
		lines && lines.length > 0 ? replay(client, chan, lines) : {messages: [], after: []};

	if (request.mode === "append") {
		// The spec's loop: this page reached what we already hold when it
		// carries a msgid we held when our JOIN came back (request.held; replay
		// dropped that line, so look at the raw page) or a line older than
		// the previous session's newest minus the skew allowance. A line
		// relayed live while the walk runs is in its pages too and does not
		// count. An empty page, the end tag, the page cap, or a page without
		// timestamps also stop it. A short page does not:
		// nefarious2 filters pages and caps its scan, so it can leave a hole.
		// For the same reason an empty page without the end tag stops the walk
		// (nothing to page back from) but does not vouch for the gap.
		const page = lines ?? [];
		const known = request.held ?? new Set(chan.msgids);
		const floorMs = request.floor ? request.floor.time.getTime() - CATCHUP_FUZZ_MS : undefined;
		let reached = false;
		let oldest: MsgRef | undefined;

		for (const line of page) {
			const msgid = line.tags.get("msgid");
			const stamp = line.tags.get("time");
			const time = stamp ? new Date(stamp) : undefined;

			if (msgid && known.has(msgid)) {
				reached = true;
			}

			if (time && !Number.isNaN(time.getTime())) {
				if (floorMs !== undefined && time.getTime() < floorMs) {
					reached = true;
				}

				if (!oldest || time < oldest.time) {
					oldest = {msgid, time};
				}
			}
		}

		// A page can reach past what we hold into lines we never loaded (a
		// busy channel, or only its last page shown): older than the gap, not
		// part of it, and appended they would land above the rejoin as if
		// new. Scrolling up brings them as history. A line below the floor
		// but within what we hold is one we missed, and still goes in.
		// Without a msgid on anything held there is no server-stamped
		// boundary to judge by, and the page is kept as before. Held means at
		// the JOIN (`known`): a live line since is newer than the gap.
		const holdsFrom = chan.oldestTimeOf(known);
		const cutoff =
			floorMs === undefined || holdsFrom === undefined
				? undefined
				: Math.min(floorMs, holdsFrom);
		const inGap =
			cutoff === undefined
				? messages
				: messages.filter((msg) => {
						const ms = new Date(msg.time).getTime();
						return Number.isNaN(ms) || ms >= cutoff;
				  });

		// Pages arrive newest first; keep the gathered gap oldest first.
		request.gap.unshift(...inGap);
		request.gapAfter.unshift(...after);

		if (!reached && !end && request.pagesLeft > 0 && oldest) {
			// The next page back is background work like the rest of the
			// catch-up (fakelag.ts): asked for as soon as each reply landed,
			// a busy channel's walk alone put the server's clock 10 s ahead.
			// At the front, so a channel finishes its walk before the next
			// channel starts one.
			const spec: HistorySpec = {
				subcommand: "BEFORE",
				ref: oldest,
				limit: request.limit,
				mode: "append",
				pagesLeft: request.pagesLeft - 1,
				floor: request.floor,
				held: request.held,
				ids: request.ids,
				fill: request.fill,
			};
			const {gap, gapAfter} = request;
			const job = {
				key: `page:${chan.id}`,
				cost: PAGE_COST_MS,
				run() {
					const next = requestHistory(client, chan, spec);

					if (next) {
						next.gap = gap;
						next.gapAfter = gapAfter;
						return;
					}

					finishWalk(client, chan, spec, gap, false);
					runAfter(gapAfter);
				},
			};

			// The channel being looked at is the user waiting: its pages go at
			// once while the clock stays clear of the ceiling (two lines'
			// room); anyone else's, and that one past it, wait their turn.
			if (chan.id === client.activeChannelId && pageFitsNow(client)) {
				job.run();
			} else {
				client.background.add(job, {front: true});
			}

			return;
		}

		// Done (or the next page could not be asked for): deliver what we
		// gathered, in order. A FAIL or timeout mid-walk still lands the
		// newer pages already received. Only a walk that met what we hold, or
		// that the server said is the end, vouches for the whole gap: the page
		// cap stops it short.
		finishWalk(client, chan, request, request.gap, answered && (reached || end));
		runAfter(request.gapAfter);
		return;
	}

	// A timeout may be transient: leave the "show older messages" button
	// so the user can retry. FAIL / ACK / an empty page mean there is no
	// more. A page that came back short is NOT the end unless the server
	// says so: draft/chathistory-end on the batch is the spec's signal, and
	// a server that filters the walk (nefarious2's presence-aware paging
	// caps the raw scan) hands back short pages that are not final --
	// reading fullness stopped the scrollback where the server had more
	// (2026-09-06). An older server that never sends the tag ends with an
	// empty page, which still closes the button.
	if (answered && request.mode === "prepend" && request.subcommand === "LATEST") {
		chan.historyFilled = true;

		// This page could not see what the device keeps of the window (the
		// boot read was slow or failed): older lines may be there with a
		// hole below this page. Marked, so that it is found and can be
		// loaded; a marker over nothing goes at the first try.
		if (client.conversations.blind && messages.length > 0 && !end) {
			messages[0].gapBefore = true;
		}
	}

	client.noteFilled(chan);

	// The end tag closes it even after a full page (draft/chathistory-end).
	// So does a page that reaches what the user cleared here: nothing from
	// before that is offered again.
	const cleared =
		chan.clearedAt !== undefined &&
		(lines ?? []).some((line) => Date.parse(line.tags.get("time") ?? "") <= chan.clearedAt!);
	const more = outcome === "timeout" || (lines !== null && lines.length > 0 && !end && !cleared);
	deliverPrepend(client, chan, messages, more);
	runAfter(after);
}

/** Closed `chathistory` batch: answer the request it belongs to. */
export const chathistoryBatch: BatchHandler = (client, batch) => {
	if (searchContextBatch(client, batch)) {
		return; // the search window's, never a channel's
	}

	const target = batch.params[0] ?? "";

	// The server's ATTACH-cursor catch-up: messages from *after* what we
	// hold, so they are appended as live ones. Checked before findRequest,
	// which would otherwise match one to a pending request by target alone.
	if (inBouncerReplay(batch)) {
		// nefarious2 sends each leg's newest lines up to a limit and says a
		// leg is whole with the end tag (replay.c); without it the leg was
		// cut, and the lines before its oldest are missing.
		deliverCatchup(client, target, batch.messages, !batch.tags.has("draft/chathistory-end"));
		return;
	}

	const label = batch.tags.get("label") ?? batch.parent?.tags.get("label");
	const request = findRequest(client, label, target ? [target] : [], false);

	if (request) {
		resolve(client, request, batch.messages, "batch", batch.tags.has("draft/chathistory-end"));
		return;
	}

	// Unsolicited: part of the cursor's catch-up when one is running (a
	// server that replays without the wrapper), else older history — which
	// is what a cold start on any other ircd wants.
	if (inServerCatchup(client)) {
		deliverCatchup(client, target, batch.messages);
		return;
	}

	const chan = target ? client.findChannel(target) : undefined;

	if (chan && (chan.type === ChanType.CHANNEL || chan.type === ChanType.QUERY)) {
		const {messages, after} = replay(client, chan, batch.messages);
		deliverPrepend(client, chan, messages, false);
		runAfter(after);
	}
};

/** ZNC's buffer replay on attach: `BATCH +x znc.in/playback <target>`. */
export const ZNC_PLAYBACK_BATCH = "znc.in/playback";

/**
 * What each conversation has shown on this page, by identity: the time, the
 * sender, the kind (message, action, notice) and the text, with how many
 * times each came. ZNC has no msgids, and a buffer it does not clear
 * (`AutoClearChanBuffer` off, or the `*playback` module) comes back on every
 * attach, along with lines we already saw live. A window's lines restored from
 * this device (conversationStore.ts) count too, seeded at its first replay
 * ({@link seedFromStore}). Bounded per conversation.
 */
const zncSeen = new WeakMap<IrcClient, Map<string, Map<string, number>>>();
/** Conversations whose logged lines were counted in already, per client. */
const zncSeeded = new WeakMap<IrcClient, Set<string>>();
const ZNC_SEEN_MAX = 2000;

/** A line's identity: epoch ms, then what the line is (conversationStore.ts lineIdentity). */
function identity(client: IrcClient, ms: number, nick: string, kind: string, text: string): string {
	return `${ms}${lineIdentity({from: {nick, mode: ""}, type: kind as MessageType, text}, (s) =>
		client.casefold(s)
	)}`;
}

/** A PRIVMSG or NOTICE's identity, from the bouncer's own time tag; none without one. */
function zncKey(client: IrcClient, line: IrcMessage): string | undefined {
	const ms = Date.parse(line.tags.get("time") ?? "");

	if (Number.isNaN(ms)) {
		return undefined;
	}

	let text = line.params[1] ?? "";
	let kind = line.command === "NOTICE" ? "notice" : "message";

	if (kind === "message" && text.startsWith("\x01ACTION ")) {
		kind = "action";
		text = text.slice("\x01ACTION ".length).replace(/\x01$/, "");
	}

	return identity(client, ms, line.source?.name ?? "", kind, text);
}

function zncSeenFor(client: IrcClient, target: string): Map<string, number> {
	let byTarget = zncSeen.get(client);

	if (!byTarget) {
		byTarget = new Map();
		zncSeen.set(client, byTarget);
	}

	const key = client.casefold(target);
	let seen = byTarget.get(key);

	if (!seen) {
		seen = new Map();
		byTarget.set(key, seen);
	}

	return seen;
}

function trimSeen(seen: Map<string, number>): void {
	for (const key of seen.keys()) {
		if (seen.size <= ZNC_SEEN_MAX) {
			break;
		}

		seen.delete(key);
	}
}

/**
 * Count a window's lines kept on this device (conversationStore.ts) as shown,
 * once per page: after a reload they were restored into the window, and ZNC's
 * buffer replays the same lines. Counted with the larger of the two counts,
 * since the lines seen live since are in the log as well.
 */
function seedFromStore(client: IrcClient, target: string, seen: Map<string, number>): void {
	let seeded = zncSeeded.get(client);

	if (!seeded) {
		seeded = new Set();
		zncSeeded.set(client, seeded);
	}

	const folded = client.casefold(target);

	if (seeded.has(folded)) {
		return;
	}

	seeded.add(folded);
	const logged = new Map<string, number>();

	for (const msg of client.conversations.restoredMessages(target)) {
		const ms = new Date(msg.time).getTime();

		if (Number.isNaN(ms) || msg.text === undefined || msg.type === undefined) {
			continue;
		}

		const key = identity(client, ms, msg.from?.nick ?? "", msg.type, msg.text);
		logged.set(key, (logged.get(key) ?? 0) + 1);
	}

	for (const [key, count] of logged) {
		seen.set(key, Math.max(count, seen.get(key) ?? 0));
	}
}

/** A live PRIVMSG or NOTICE behind ZNC: remembered, so its replay is known. */
export function noteZncLine(client: IrcClient, line: IrcMessage): void {
	const key = zncKey(client, line);
	const target = line.params[0];

	if (!key || !target) {
		return;
	}

	const conversation = client.isSelf(target) ? line.source?.name ?? target : target;
	const seen = zncSeenFor(client, conversation);
	seen.set(key, (seen.get(key) ?? 0) + 1);
	trimSeen(seen);
}

/**
 * ZNC's buffer replay (`BATCH +x znc.in/playback <target>`, sent on every
 * attach). The lines are stored ones, so they go the catch-up's way:
 * appended, counted as unread but silent, a closed query reopened only by
 * what was said since. A line this page has already shown, as often as it
 * showed it, is dropped ({@link zncSeen}); a line without a time tag is kept.
 */
export const zncPlaybackBatch: BatchHandler = (client, batch) => {
	const target = batch.params[0] ?? "";

	if (!target) {
		return;
	}

	const seen = zncSeenFor(client, target);
	seedFromStore(client, target, seen);
	const inBatch = new Map<string, number>();
	const lines = batch.messages.filter((line) => {
		const key = zncKey(client, line);

		if (!key) {
			return true;
		}

		const count = (inBatch.get(key) ?? 0) + 1;
		inBatch.set(key, count);
		return count > (seen.get(key) ?? 0);
	});

	for (const [key, count] of inBatch) {
		seen.set(key, Math.max(count, seen.get(key) ?? 0));
	}

	trimSeen(seen);

	if (lines.length > 0) {
		deliverCatchup(client, target, lines);
	}
};

/**
 * One inner batch of the server-driven catch-up (persistence.ts): appended
 * like the gathered pages of our own catch-up — counted as unread but silent
 * (`replay`), msgid dedupe against what the channel already shows. A PM from
 * someone we have no window for opens one, as a live message would.
 */
function deliverCatchup(client: IrcClient, target: string, lines: IrcMessage[], cut = false): void {
	if (!target) {
		return;
	}

	let chan = client.findChannel(target);

	if (!chan && !client.isChannelName(target)) {
		// A query the user closed: only what was said since opens it again,
		// and only that is shown (irc/closedQueries.ts).
		lines = lines.filter((line) => !client.closed.suppresses(target, client.timeOf(line)));

		if (lines.length === 0) {
			return;
		}

		chan = client.openAutoQuery(target, client.timeOf(lines[lines.length - 1]));
	}

	if (!chan || (chan.type !== ChanType.CHANNEL && chan.type !== ChanType.QUERY)) {
		return;
	}

	// What the window held before this leg: a line of it no newer than that
	// goes in by time, and a cut leg leaves a gap above its oldest new line.
	const held = new Set(chan.msgids);
	const newestHeld = chan.newestTimeOf(held);
	const {messages, after} = replay(client, chan, lines);
	const first =
		cut && newestHeld !== undefined
			? messages.find((msg) => new Date(msg.time).getTime() > newestHeld)
			: undefined;

	if (first) {
		first.gapBefore = true;
	}

	deliverAppend(client, chan, messages, client.replayIds, held);
	runAfter(after);

	if (first) {
		// Nobody is waiting for it: the fill goes behind the user's own
		// lines, the open channel's first (fakelag.ts).
		const window = chan;
		const id = first.id;
		client.background.add(
			{
				key: `fill:${window.id}`,
				cost: PAGE_COST_MS,
				run() {
					// One page: the rest waits for whoever wants it (the
					// marker's control), not for every busy channel's turn.
					requestFill(client, window, id, 1);
				},
			},
			{front: window.id === client.activeChannelId}
		);
	}
}

/**
 * `FAIL CHATHISTORY <code> [subcommand|target…] :text` (called by
 * standard-replies.ts): answers the request it belongs to. True when the
 * user is not to see it: `INVALID_TARGET` for a target we asked about,
 * which the spec also sends for a target the client may not read. A
 * network can keep history for logged-in accounts only (nefarious2's
 * CHATHISTORY_REQUIRE_AUTH, on at AfterNET; a `+H` channel is open to
 * everyone), so to someone not logged in every channel answers this, on
 * every connect. The target is then not asked again as this account
 * (Channel.historyDenied) — a channel only when the refusal came while we
 * were in it: one whose JOIN failed is refused the same way (nefarious2
 * serves members only), and the JOIN's own numeric has said why.
 */
export function chatHistoryFailed(client: IrcClient, msg: IrcMessage): boolean {
	const label = msg.tags.get("label");
	const context = msg.params.slice(2, -1);
	const request = findRequest(client, label, context);

	if (!request) {
		return false;
	}

	resolve(client, request, null, "fail");

	const ours =
		(label !== undefined && request.label === label) ||
		context.some((param) => client.namesEqual(param, request.target));

	if ((msg.params[1] ?? "").toUpperCase() !== "INVALID_TARGET" || !ours) {
		return false;
	}

	const {chan} = request;

	if (chan.type === ChanType.QUERY || chan.state === ChanState.JOINED) {
		chan.historyDenied = client.account;
	}

	return true;
}

/**
 * `labeled-response`: `@label=x ACK` means the request produced nothing —
 * a history request answered with no messages, or a message of ours the
 * server took without echoing (pending.ts).
 */
const ack: Handler = (client, msg) => {
	const label = msg.tags.get("label");
	const request = label ? pendingOf(client).find((r) => r.label === label) : undefined;

	if (request) {
		resolve(client, request, [], "ack");
	} else if (label && !searchAck(client, label)) {
		settlePendingLabel(client, label);
	}
};

export default {ACK: ack};
