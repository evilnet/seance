/**
 * Paced per-channel catch-up after our JOIN: the history fetch
 * (`CHATHISTORY`) and the read-marker fetch (`MARKREAD`) for each channel.
 *
 * Why paced: ircu-family servers (nefarious2 included) charge every command
 * from a non-oper about 2 s of "fake lag" and stop parsing its lines once
 * the client is 10 s ahead (fakelag.ts). Firing MODE + CHATHISTORY +
 * MARKREAD for every autojoined channel the moment its JOIN echoes back put
 * ~65 commands on the wire for 15 channels and the user's first message
 * queued behind all of it (measured 2026-08-27, see
 * docs/projects/connect-burst.md).
 *
 * So: the channel the user is looking at is served at once, everything else
 * goes through the connection's background queue (`IrcClient.background`),
 * one channel per job, sent only while the server's clock as we reckon it
 * leaves room for the user's own lines. Opening a channel that is still
 * waiting serves it right away. Nothing here touches the store; tests drive
 * it with fake timers (`test/irc/catchup.ts`).
 *
 * Which channel goes first is the server's to say: one `CHATHISTORY TARGETS`
 * after the JOIN burst lists every channel we are in with the time of its
 * newest message, newest first. The catch-up is parked until it answers,
 * then queued in that order: channels with something new first, the ones it
 * does not list next, the ones it says we hold everything for last — still
 * fetched, since the index is a hint, not proof. One command buys the order
 * of N. A server that cannot answer gets the JOIN order.
 */

import {ChanState, ChanType} from "../../../shared/types/chan";
import type {Channel, MsgRef} from "./channel";
import type {IrcClient} from "./client";
import type {BatchHandler} from "./handlers/batch";
import {fetchReadMarker, markReadEnabled} from "./handlers/markread";
import {
	historyEnabled,
	historyLimit,
	pageFitsNow,
	requestChannelHistory,
	retryLostHistory,
} from "./history";
import {formatLine, type IrcMessage} from "./message";

/** What one channel's history fetch is reckoned to cost (its marker query, when sent with it, adds MARKER_COST_MS). */
export const CATCHUP_STEP_COST_MS = 2000;

/** A mode query is one command. */
const MODE_COST_MS = 2000;

/** So is a marker query. */
const MARKER_COST_MS = 2000;

/** And the `CHATHISTORY TARGETS` that orders the rest. */
export const TARGETS_COST_MS = 2000;

/** How long the parked catch-up waits for the TARGETS answer before going in JOIN order. */
export const TARGETS_TIMEOUT_MS = 5000;

/** Rows asked for (capped by ISUPPORT `CHATHISTORY`; nefarious2 caps at 100). */
const TARGETS_LIMIT = 100;

/**
 * The window's far end, past now: the server drops a target whose newest
 * message is later than it, and a server clock ahead of ours would lose
 * exactly the channel that was just written to.
 */
const TARGETS_AHEAD_MS = 86_400_000;

/** Fewer channels than this behind the active one are not worth a command to order. */
const TARGETS_MIN_CHANNELS = 2;

interface PendingCatchup {
	chan: Channel;
	/** The channel's newest known message before this JOIN (reconnect catch-up). */
	before: MsgRef | undefined;
	/** History + marker already went out with the JOIN; only the modes are left. */
	prefetched: boolean;
	/**
	 * The newest message the server stamped that the channel held before
	 * this JOIN (Channel.newestServerRef): what a TARGETS answer is compared
	 * with to tell that nothing is new.
	 */
	held: MsgRef | undefined;
	/** Its marker query is a job of its own, queued right ahead of this step. */
	markerQueued?: boolean;
}

/** The newest message per channel (casefolded name → ms), from a TARGETS answer. */
interface TargetsAnswer {
	rows: Map<string, number>;
}

/** One connection's TARGETS exchange. */
interface TargetsState {
	/** queued: the command waits for the clock; asked: sent, waiting for the answer; done: answered, failed or given up. */
	status: "queued" | "asked" | "done";
	/** Catch-up steps held until the answer, in JOIN order. */
	parked: PendingCatchup[];
	/**
	 * Channels (casefolded) whose JOIN went out after the command. The server
	 * reads our lines in order, so every other channel whose JOIN echo comes
	 * before the answer was a member when it answered; these may not have been.
	 */
	late: Set<string>;
	label?: string;
	timer?: ReturnType<typeof setTimeout>;
}

const targetsOf = new WeakMap<IrcClient, TargetsState>();

/** Clients whose server said it cannot answer TARGETS: not asked again for the page. */
const targetsRefused = new WeakSet<IrcClient>();

let targetsLabelCounter = 0;

/** The queued steps by background key, so a key can be told back as its channel. */
const pendingOf = new WeakMap<IrcClient, Map<string, PendingCatchup>>();

function pendingMap(client: IrcClient): Map<string, PendingCatchup> {
	let map = pendingOf.get(client);

	if (!map) {
		map = new Map();
		pendingOf.set(client, map);
	}

	return map;
}

const keyOf = (chan: Channel): string => `catchup:${chan.id}`;
const modeKeyOf = (chan: Channel): string => `mode:${chan.id}`;
/** A marker fetch: a query's (enqueueMarkerFetch), or a queued channel's, right ahead of its step. */
const markerKeyOf = (chan: Channel): string => `marker:${chan.id}`;

/** The marker is still unknown: neither stored nor answered (`*`) on this connection. */
function needsMarker(chan: Channel): boolean {
	return !chan.readMarker && !chan.markerAnswered;
}

/** Channels still waiting for their catch-up, in order (tests / diagnostics). */
export function pendingCatchup(client: IrcClient): readonly Channel[] {
	const map = pendingMap(client);
	const queued = client.background
		.keys()
		.map((key) => map.get(key)?.chan)
		.filter((chan): chan is Channel => chan !== undefined);
	return [...queued, ...(targetsOf.get(client)?.parked ?? []).map((p) => p.chan)];
}

/**
 * Send the history + marker fetch for `chan` right behind its JOIN, before
 * the echo: the server processes lines in order, so membership holds by the
 * time it reads them. Used for the active channel at connect time; the JOIN
 * echo then only has the modes left to ask for.
 */
export function prefetchCatchup(client: IrcClient, chan: Channel): void {
	chan.catchupPrefetched = true;
	fetchFor(client, chan, chan.newestRef);
}

/**
 * Our JOIN to `chan` was confirmed: queue its history + read-marker fetch.
 * The active channel jumps the queue and is served now.
 */
export function enqueueCatchup(
	client: IrcClient,
	chan: Channel,
	before: MsgRef | undefined,
	held: MsgRef | undefined
): void {
	const prefetched = chan.catchupPrefetched;
	chan.catchupPrefetched = false;
	unpark(client, chan); // a stale step from an earlier JOIN of this connection
	// Until this JOIN's catch-up is through, what the channel holds proves
	// nothing about the gap: a live line now is not the end of the missed ones.
	chan.historyFilled = false;

	if (chan.id === client.activeChannelId) {
		const queued = takePending(client, chan);

		if (!prefetched) {
			fetchFor(client, chan, before ?? queued?.before);
		}

		queueModes(client, chan);
		return;
	}

	if (prefetched) {
		return; // nothing left to ask for: the modes wait for the first open
	}

	const pending: PendingCatchup = {chan, before, prefetched, held};

	if (parkForTargets(client, pending)) {
		return;
	}

	queueStep(client, pending);
}

function queueStep(client: IrcClient, pending: PendingCatchup): void {
	const key = keyOf(pending.chan);
	const map = pendingMap(client);
	const chan = pending.chan;
	map.set(key, pending);

	// The marker query goes first, so its answer is in before the history it
	// decides the unread count of (deliverPrepend): the server replies in
	// order. A job of its own, so a server that volunteers the marker after
	// JOIN (nefarious2 does for a logged-in account, `*` when none is
	// stored) has done so by its turn and the query is dropped; and each
	// job is one command, which fits the clock's room sooner than two.
	if (needsMarker(chan)) {
		pending.markerQueued = true;
		client.background.add({
			key: markerKeyOf(chan),
			cost: MARKER_COST_MS,
			run() {
				if (
					needsMarker(chan) &&
					chan.state === ChanState.JOINED &&
					client.transport.state === "open"
				) {
					fetchReadMarker(client, chan);
				}
			},
		});
	}

	client.background.add({
		key,
		cost: CATCHUP_STEP_COST_MS,
		run() {
			map.delete(key);
			step(client, pending);
		},
	});
}

/**
 * After registration: ask for a query's read marker, so a private message
 * read on another device while this one was away stops counting here.
 * Queries are never JOINed, so nothing else asks, and the server volunteers
 * markers only for channels. Behind every channel (a `last` job, so the
 * channels' catch-up queued after it still goes first), and skipped when
 * its turn comes if the query has nothing unread to lower. Never queued
 * for a server without the cap, and once per connection: `autojoin()`
 * runs again after a held session's restoration, by when a replay may
 * have asked already.
 */
export function enqueueMarkerFetch(client: IrcClient, chan: Channel): void {
	const asked = askedOf(client);

	if (!markReadEnabled(client) || asked.has(chan)) {
		return;
	}

	// Registration: the autojoin's echoes have not queued their channels
	// yet, and a job queued now would run ahead of them on an empty queue.
	if (joinsInFlight(client)) {
		holdMarker(client, chan);
		return;
	}

	queueMarker(client, chan);
}

function queueMarker(client: IrcClient, chan: Channel): void {
	const asked = askedOf(client);
	client.background.add({
		key: markerKeyOf(chan),
		cost: MARKER_COST_MS,
		last: true,
		run() {
			if (
				chan.shared.unread > 0 &&
				client.channels.includes(chan) &&
				client.transport.state === "open"
			) {
				asked.add(chan);
				fetchReadMarker(client, chan);
			}
		},
	});
}

/** Longest a query's marker waits for the autojoin's echoes (a JOIN refused never echoes). */
export const MARKER_HOLD_MS = 5000;

/** Queries whose marker went out on this connection: asked once, like a channel's history. */
const askedMarkers = new WeakMap<IrcClient, Set<Channel>>();
/** Query markers waiting for the autojoin's echoes. */
const heldMarkers = new WeakMap<
	IrcClient,
	{chans: Set<Channel>; timer: ReturnType<typeof setTimeout>}
>();

function askedOf(client: IrcClient): Set<Channel> {
	let asked = askedMarkers.get(client);

	if (!asked) {
		asked = new Set();
		askedMarkers.set(client, asked);
	}

	return asked;
}

/** An autojoin channel whose JOIN has not echoed yet. */
function joinsInFlight(client: IrcClient): boolean {
	return client.channels.some(
		(c) => c.type === ChanType.CHANNEL && c.autoJoin && c.state === ChanState.PARTED
	);
}

function holdMarker(client: IrcClient, chan: Channel): void {
	let held = heldMarkers.get(client);

	if (!held) {
		const timer = setTimeout(() => releaseMarkers(client, true), MARKER_HOLD_MS);
		held = {chans: new Set(), timer};
		heldMarkers.set(client, held);
	}

	held.chans.add(chan);
}

/** Queue the held markers once every autojoin echo is in (or the hold ran out). */
export function releaseMarkers(client: IrcClient, force = false): void {
	const held = heldMarkers.get(client);

	if (!held || (!force && joinsInFlight(client))) {
		return;
	}

	clearTimeout(held.timer);
	heldMarkers.delete(client);

	for (const chan of held.chans) {
		queueMarker(client, chan);
	}
}

/** The user opened `chan`: if it is still waiting, serve it immediately. */
export function prioritiseCatchup(client: IrcClient, chan: Channel): void {
	// A reconnect walk waiting for its next page: the user is waiting now,
	// as long as the clock stays clear of the ceiling (else it is at the
	// front already and goes first).
	if (pageFitsNow(client)) {
		client.background.take(`page:${chan.id}`)?.run();
	}

	const parked = unpark(client, chan);

	if (parked) {
		step(client, parked);
		return;
	}

	const job = client.background.take(keyOf(chan));

	if (job) {
		// Its marker query first, if it is still waiting ahead of it.
		client.background.take(markerKeyOf(chan))?.run();
		job.run();
	}

	// A query's marker fetch (enqueueMarkerFetch) keeps its turn: opened
	// with someone looking, the query is read (IrcClient.open) and the job
	// sends nothing at its turn on `unread === 0`; with nobody looking the
	// open reads nothing, so the server's marker is still wanted. A PM that
	// lands after the user leaves again is the case the fetch is for.
}

/** Forget a channel we left / removed while it was waiting. */
export function dropFromCatchup(client: IrcClient, chan: Channel): void {
	unpark(client, chan);
	takePending(client, chan);
	client.background.take(modeKeyOf(chan));
	client.background.take(markerKeyOf(chan));
	client.background.take(`page:${chan.id}`);
}

/** Transport closed: nothing queued survives (the reconnect re-JOINs). */
export function cancelCatchup(client: IrcClient): void {
	pendingMap(client).clear();
	askedOf(client).clear();
	clearTimeout(heldMarkers.get(client)?.timer);
	heldMarkers.delete(client);
	client.background.drop((key) => /^(catchup|mode|marker|page|targets):/.test(key));
	clearTimeout(targetsOf.get(client)?.timer);
	targetsOf.delete(client);
}

function takePending(client: IrcClient, chan: Channel): PendingCatchup | undefined {
	const key = keyOf(chan);
	const pending = pendingMap(client).get(key);
	pendingMap(client).delete(key);

	if (client.background.take(key)) {
		// Whoever takes the step sends its marker query with it (fetchFor).
		client.background.take(markerKeyOf(chan));
	}

	return pending;
}

/**
 * The modes line is cosmetic (it feeds the "Channel modes: +nt" line): the
 * channel being looked at gets it behind the rest of the catch-up, so it
 * never delays another channel's unread count; others on first open
 * (IrcClient.open).
 */
export function queueModes(client: IrcClient, chan: Channel): void {
	if (chan.modesKnown) {
		return;
	}

	client.background.add({
		key: modeKeyOf(chan),
		cost: MODE_COST_MS,
		run() {
			if (chan.modesKnown || chan.state !== ChanState.JOINED) {
				return;
			}

			chan.modesKnown = true;
			client.send(formatLine({command: "MODE", params: [chan.name]}));
		},
	});
}

function step(client: IrcClient, next: PendingCatchup): void {
	// Left again while waiting (or the socket went): nothing to send.
	if (next.chan.state !== ChanState.JOINED || client.transport.state !== "open") {
		return;
	}

	if (!next.prefetched) {
		fetchFor(client, next.chan, next.before, !next.markerQueued);
	}

	if (next.chan.id === client.activeChannelId) {
		queueModes(client, next.chan);
	}
}

function fetchFor(
	client: IrcClient,
	chan: Channel,
	before: MsgRef | undefined,
	marker = true
): void {
	// nefarious2 volunteers the marker after a logged-in account's JOIN (`*`
	// when none is stored), a held session's restore included: then it has
	// an answer and costs nothing. Else ask, once per connection, and first,
	// so the answer is in before the history it decides the unread count of
	// (deliverPrepend): the server replies in order. A queued step's marker
	// query went (or was dropped) in its own job just ahead (queueStep).
	if (marker && needsMarker(chan)) {
		fetchReadMarker(client, chan);
	}

	requestChannelHistory(client, chan, before);

	retryLostHistory(client, chan);
}

// ------------------------------------------------------------ TARGETS

/**
 * Hold `pending` for the TARGETS answer, asking for it first if this is
 * the connection's first channel to wait. False when the order is not
 * worth asking for (or cannot be): the caller queues the step at once.
 */
function parkForTargets(client: IrcClient, pending: PendingCatchup): boolean {
	let state = targetsOf.get(client);

	if (!state) {
		if (!canAskTargets(client)) {
			targetsOf.set(client, {status: "done", parked: [], late: new Set()});
			return false;
		}

		// Parked before the command is queued: with room on the clock it goes
		// out at once, and it covers what is parked when it does.
		state = {status: "queued", parked: [pending], late: new Set()};
		targetsOf.set(client, state);
		queueTargets(client, state);
		return true;
	}

	if (state.status === "done") {
		return false;
	}

	state.parked.push(pending);
	return true;
}

function canAskTargets(client: IrcClient): boolean {
	if (
		targetsRefused.has(client) ||
		!historyEnabled(client) ||
		// Without `batch` the rows arrive bare, with no end to the answer.
		!client.caps.hasCapability("batch") ||
		client.serverReplay
	) {
		return false;
	}

	const waiting = client.channels.filter(
		(chan) =>
			chan.type === ChanType.CHANNEL &&
			chan.id !== client.activeChannelId &&
			(chan.state === ChanState.JOINED || (chan.state === ChanState.PARTED && chan.autoJoin))
	);
	return waiting.length >= TARGETS_MIN_CHANNELS;
}

function queueTargets(client: IrcClient, state: TargetsState): void {
	client.background.add(
		{
			key: "targets:",
			cost: TARGETS_COST_MS,
			run() {
				if (targetsOf.get(client) !== state || client.transport.state !== "open") {
					return;
				}

				sendTargets(client, state);
			},
		},
		{front: true}
	);
}

function sendTargets(client: IrcClient, state: TargetsState): void {
	if (state.parked.length === 0) {
		state.status = "done";
		return;
	}

	// From the start: the server's index moves on messages only (not joins,
	// parts, topics, redactions), so the newest line we hold can be well past
	// a quiet channel's newest message, and a window starting there would
	// leave it out. Newest first, so a long history costs nothing extra.
	const since = new Date(0);
	const until = new Date(Date.now() + TARGETS_AHEAD_MS);
	const tags: Record<string, string> = {};

	if (client.caps.hasCapability("labeled-response")) {
		state.label = `tg${++targetsLabelCounter}`;
		tags.label = state.label;
	}

	const line = formatLine({
		tags,
		command: "CHATHISTORY",
		params: [
			"TARGETS",
			`timestamp=${since.toISOString()}`,
			`timestamp=${until.toISOString()}`,
			String(historyLimit(client, TARGETS_LIMIT)),
		],
	});

	if (!client.send(line)) {
		release(client, state, undefined);
		return;
	}

	state.status = "asked";
	state.timer = setTimeout(() => release(client, state, undefined), TARGETS_TIMEOUT_MS);
}

/** `IrcClient.joinChannels` sent JOINs for `names`: an answer still to come does not speak for them. */
export function noteJoinsSent(client: IrcClient, names: string[]): void {
	const state = targetsOf.get(client);

	if (state?.status === "asked") {
		names.forEach((name) => state.late.add(client.casefold(name)));
	}
}

function unpark(client: IrcClient, chan: Channel): PendingCatchup | undefined {
	const state = targetsOf.get(client);
	const index = state ? state.parked.findIndex((p) => p.chan === chan) : -1;

	if (!state || index < 0) {
		return undefined;
	}

	return state.parked.splice(index, 1)[0];
}

/**
 * Queue the parked steps: by the answer when there is one, else as they
 * came. Per channel, against what that channel already holds:
 *
 * - listed, newest message later than ours (or we hold none): first, the
 *   most recently written channel first;
 * - not listed, or its JOIN followed the command: next, as before;
 * - listed, newest message the one we hold: last. Nothing new by the
 *   server's index, but the index is only a hint for the order: it has been
 *   wrong (a federated answer cut short, a REDACT or TOPIC that did not move
 *   it before nefarious2 7598622), and a message that reached the store late
 *   with an older stamp (S2S lag, a netsplit's other side) is listed under
 *   the time we hold. So the channel is still fetched, the same walk as any
 *   other, only behind every channel that may have something new.
 */
function release(client: IrcClient, state: TargetsState, answer: TargetsAnswer | undefined): void {
	if (state.status === "done") {
		return;
	}

	clearTimeout(state.timer);
	state.status = "done";
	const parked = state.parked;
	state.parked = [];

	if (!answer) {
		parked.forEach((p) => queueStep(client, p));
		return;
	}

	const busy: {pending: PendingCatchup; newest: number}[] = [];
	const rest: PendingCatchup[] = [];
	const quiet: PendingCatchup[] = [];

	for (const pending of parked) {
		const newest = answer.rows.get(client.casefold(pending.chan.name));
		const held = pending.held?.time.getTime();

		if (state.late.has(client.casefold(pending.chan.name))) {
			rest.push(pending);
		} else if (newest === undefined) {
			rest.push(pending);
		} else if (held !== undefined && newest <= held) {
			quiet.push(pending);
		} else {
			busy.push({pending, newest});
		}
	}

	busy.sort((a, b) => b.newest - a.newest);
	busy.forEach(({pending}) => queueStep(client, pending));
	rest.forEach((p) => queueStep(client, p));
	quiet.forEach((p) => queueStep(client, p));
}

/** A closed `draft/chathistory-targets` batch: the answer, if it is ours. */
export const targetsBatch: BatchHandler = (client, batch) => {
	const state = targetsOf.get(client);
	const label = batch.tags.get("label") ?? batch.parent?.tags.get("label");

	// Ours carries our label when the server labels; a batch without it
	// answers somebody's `/quote CHATHISTORY TARGETS`, and is theirs.
	if (state?.status !== "asked" || label !== state.label) {
		return;
	}

	const rows = new Map<string, number>();

	for (const msg of batch.messages) {
		if (msg.command !== "CHATHISTORY" || msg.params[0]?.toUpperCase() !== "TARGETS") {
			continue;
		}

		const [, target = "", stamp = ""] = msg.params;
		// Rows carry a bare timestamp; older servers put the request's prefix on it.
		const time = Date.parse(stamp.replace(/^timestamp=/, ""));

		if (target && Number.isFinite(time)) {
			const key = client.casefold(target);
			rows.set(key, Math.max(rows.get(key) ?? 0, time));
		}
	}

	release(client, state, {rows});
};

/**
 * `FAIL CHATHISTORY … TARGETS`: the order is lost, the catch-up goes in
 * JOIN order. A server that does not know the subcommand is not asked
 * again for the page. True when it was ours (it is not shown: nobody typed it).
 */
export function targetsFailed(client: IrcClient, msg: IrcMessage): boolean {
	const state = targetsOf.get(client);
	const label = msg.tags.get("label");
	const [, code = "", context = ""] = msg.params;

	if (state?.status !== "asked") {
		return false;
	}

	if (state.label !== undefined ? label !== state.label : !/^TARGETS\b/i.test(context)) {
		return false;
	}

	if (/^(INVALID_PARAMS|UNKNOWN_COMMAND|NEED_MORE_PARAMS|INVALID_TARGET)$/i.test(code)) {
		targetsRefused.add(client);
	}

	release(client, state, undefined);
	return true;
}
