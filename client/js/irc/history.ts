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
 *   but history never notifies and never counts as unread.
 * - **Catch-up** (re-JOIN after a reconnect): the spec's own gap-filling
 *   loop (chathistory.md, "Client pseudocode"): `CHATHISTORY LATEST`, then
 *   `BEFORE <oldest of the page>` back until a page overlaps what we already
 *   show (a msgid we hold, or a line older than the newest we had seen
 *   minus {@link CATCHUP_FUZZ_MS} of clock skew), carries
 *   `draft/chathistory-end`, comes back short, or the page cap is hit.
 *   Walking back from the present rather than forward from our newest line
 *   means the newest messages arrive first and the fill cannot be defeated
 *   by an anchor the server can no longer see (a presence gap, retention,
 *   a clock disagreement): it stops where the server's history meets ours.
 *   The pages are gathered and appended once, oldest first, as ordinary
 *   `msg` events flagged `replay` (shown with their highlights, but no
 *   unread / notification side effects). The server
 *   can drive the same thing itself off a `PERSISTENCE ATTACH` cursor, in
 *   which case its `chathistory` batches arrive unasked inside a
 *   `evilnet.github.io/bouncer-replay` wrapper and take the same path
 *   (persistence.ts).
 *
 * Requests are matched to replies by `labeled-response` label when that
 * cap is on, else by target. `FAIL CHATHISTORY`, a labeled `ACK` or a
 * {@link HISTORY_TIMEOUT_MS} timeout answer the pending `more` with no
 * messages so the UI never sticks in `historyLoading` (bus-contract §more).
 */

import {ChanType} from "../../../shared/types/chan";
import type {SharedMsg} from "../../../shared/types/msg";
import type {Channel, MsgRef} from "./channel";
import type {IrcClient, ReplayCollection} from "./client";
import type {BatchHandler} from "./handlers/batch";
import {formatLine, IrcMessage} from "./message";
import {settlePendingLabel} from "./pending";
import {inBouncerReplay, inServerCatchup} from "./persistence";
import type {Handler} from "./types";

/** How long to wait for the server before answering `more` with nothing. */
export const HISTORY_TIMEOUT_MS = 15_000;
/** Page size for `more` (the old server also paged by 100). */
export const MORE_PAGE_SIZE = 100;
/** Page size for the LATEST request on first JOIN. */
export const JOIN_PAGE_SIZE = 50;
/** Most pages fetched in one catch-up (LATEST plus BEFORE pages). */
const MAX_CATCHUP_PAGES = 5;
/** Clock-skew allowance when deciding a page has reached what we already
 * held (the spec's FUZZ_INTERVAL, "perhaps 1 to 10 seconds"). */
export const CATCHUP_FUZZ_MS = 5_000;

export type HistorySubcommand = "LATEST" | "BEFORE" | "AFTER";

export interface HistorySpec {
	subcommand: HistorySubcommand;
	/** Reference message (required for BEFORE / AFTER). */
	ref?: MsgRef;
	limit: number;
	mode: "prepend" | "append";
	pagesLeft?: number;
	floor?: MsgRef;
	/** Re-issue after a reconnect when the answer never came (the `more` pages). */
	retry?: boolean;
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
	/** Catch-up: the gap gathered so far, oldest first (pages arrive newest first). */
	gap: SharedMsg[];
	/** Catch-up: post-delivery work of the gathered pages, in the same order. */
	gapAfter: (() => void)[];
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
		(chan.type === ChanType.CHANNEL || chan.type === ChanType.QUERY)
	);
}

/** `msgid=…` when we have one and the server takes it, else `timestamp=<ISO 8601>`. */
export function formatRef(client: IrcClient, ref: MsgRef): string {
	const types = client.isupport.tokens.get("MSGREFTYPES");
	const msgidOk = types === undefined || types.split(",").includes("msgid");

	if (ref.msgid && msgidOk) {
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
 * Our JOIN was confirmed: fill the channel. First time round that is the
 * latest {@link JOIN_PAGE_SIZE} messages; after a reconnect (history was
 * loaded before and we know the newest message) it is the gap between that
 * message and now, gathered from LATEST backwards (see the header) and
 * appended as live messages. `before` is the channel's newest reference as
 * it was before the JOIN line itself was pushed.
 */
export function requestChannelHistory(
	client: IrcClient,
	chan: Channel,
	before: MsgRef | undefined
): HistoryRequest | undefined {
	if (chan.historyRequested && before) {
		return requestHistory(client, chan, {
			subcommand: "LATEST",
			limit: MORE_PAGE_SIZE,
			mode: "append",
			pagesLeft: MAX_CATCHUP_PAGES - 1,
			floor: before,
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
	for (const request of [...pendingOf(client)]) {
		if (request.retry) {
			request.chan.lostMore = request.retry;
		}

		resolve(client, request, null, "timeout");
	}
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
 * `+seance/edit` resends) is returned separately: it needs the messages'
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
		const result = client.collectReplay(chan, () => client.handleMessage(line));

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

		// msg.highlight is kept: a replayed mention renders highlighted.
		// Delivery is what stays silent (no counters, no notification) —
		// deliverAppend pushes with `replay` and `more` never notifies.
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
	moreAvailable: boolean
): void {
	const ids = client.historyIds(messages.length);
	let lastRef: MsgRef | undefined;

	messages.forEach((msg, i) => {
		msg.id = ids[i];
		lastRef = chan.remember(msg);
		// Older by definition, but a LATEST fill can still hold the newest
		// line we have seen; noteCursor only ever moves forward.
		client.noteCursor(msg);

		if (chan.type === ChanType.QUERY) {
			client.queryLog.append(chan.name, msg); // by time, deduplicated
		}
	});

	if (!chan.newestRef && lastRef) {
		chan.newestRef = lastRef;
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
	client.dispatch("more", {chan: chan.id, messages, totalMessages, moreAvailable});
}

/** Append catch-up messages as live ones, without unread / notification effects. */
function deliverAppend(client: IrcClient, chan: Channel, messages: SharedMsg[]): void {
	for (const msg of messages) {
		// pushMessage copies; write the id back so post-replay work
		// (`afterReplay` closures hold the collected objects) can find it.
		msg.id = client.pushMessage(chan, msg, false, {replay: true}).id;
	}
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
	const {messages, after} =
		lines && lines.length > 0 ? replay(client, chan, lines) : {messages: [], after: []};
	const fullPage = lines !== null && lines.length >= request.limit;

	if (request.mode === "append") {
		// The spec's loop: this page reached what we already hold when it
		// carries a msgid we show (replay dropped that line, so look at the
		// raw page) or a line older than the previous session's newest
		// minus the skew allowance. An empty page, the end tag, a short
		// page, the page cap, or a page without timestamps also stop it.
		const page = lines ?? [];
		const known = new Set(chan.msgids);
		const floorMs = request.floor ? request.floor.time.getTime() - CATCHUP_FUZZ_MS : undefined;
		let reached = page.length === 0;
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

		// Pages arrive newest first; keep the gathered gap oldest first.
		request.gap.unshift(...messages);
		request.gapAfter.unshift(...after);

		if (!reached && !end && fullPage && request.pagesLeft > 0 && oldest) {
			const next = requestHistory(client, chan, {
				subcommand: "BEFORE",
				ref: oldest,
				limit: request.limit,
				mode: "append",
				pagesLeft: request.pagesLeft - 1,
				floor: request.floor,
			});

			if (next) {
				next.gap = request.gap;
				next.gapAfter = request.gapAfter;
				return;
			}
		}

		// Done (or the next page could not be asked for): deliver what we
		// gathered, in order. A FAIL or timeout mid-walk still lands the
		// newer pages already received.
		deliverAppend(client, chan, request.gap);
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
	const more = outcome === "timeout" || (lines !== null && lines.length > 0 && !end) || fullPage;
	deliverPrepend(client, chan, messages, more);
	runAfter(after);
}

/** Closed `chathistory` batch: answer the request it belongs to. */
export const chathistoryBatch: BatchHandler = (client, batch) => {
	const target = batch.params[0] ?? "";

	// The server's ATTACH-cursor catch-up: messages from *after* what we
	// hold, so they are appended as live ones. Checked before findRequest,
	// which would otherwise match one to a pending request by target alone.
	if (inBouncerReplay(batch)) {
		deliverCatchup(client, target, batch.messages);
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

/**
 * One inner batch of the server-driven catch-up (persistence.ts): appended
 * like the gathered pages of our own catch-up — highlights kept but silent
 * (`replay`), no unread, msgid dedupe against what the channel already shows. A PM from someone we have
 * no window for opens one, as a live message would.
 */
function deliverCatchup(client: IrcClient, target: string, lines: IrcMessage[]): void {
	if (!target) {
		return;
	}

	let chan = client.findChannel(target);

	if (!chan && !client.isChannelName(target)) {
		chan = client.announceChannel(target, ChanType.QUERY);
	}

	if (!chan || (chan.type !== ChanType.CHANNEL && chan.type !== ChanType.QUERY)) {
		return;
	}

	const {messages, after} = replay(client, chan, lines);
	deliverAppend(client, chan, messages);
	runAfter(after);
}

/** `FAIL CHATHISTORY <code> [subcommand|target…] :text` (called by standard-replies.ts). */
export function chatHistoryFailed(client: IrcClient, msg: IrcMessage): void {
	const request = findRequest(client, msg.tags.get("label"), msg.params.slice(2, -1));

	if (request) {
		resolve(client, request, null, "fail");
	}
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
	} else if (label) {
		settlePendingLabel(client, label);
	}
};

export default {ACK: ack};
