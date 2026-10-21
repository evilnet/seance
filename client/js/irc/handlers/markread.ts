/**
 * Read markers (`draft/read-marker`, https://ircv3.net/specs/extensions/read-marker).
 *
 * Inbound `MARKREAD <target> timestamp=<ISO 8601>` means the account read
 * `target` up to that time on some session (possibly this one: the server
 * echoes our own markers). The channel's `firstUnread` moves to the last
 * message at or before the marker, the `unread`/`highlight` counters are
 * recounted from the messages after it (only those that bumped them when
 * they arrived, see `MsgRef.unread`/`highlight`) and the UI is told with a
 * `markread` event. That event exists because the only inbound path the UI
 * already had for this, `open`, always marks the whole channel read; a
 * marker in the middle of the backlog needs the exact `firstUnread` and
 * counters. `timestamp=*` (no marker known) changes nothing, and a marker
 * older than what we already hold never moves anything backwards.
 *
 * Outbound: {@link scheduleMarkRead} sends `MARKREAD <target> timestamp=<newest>`
 * when the user reads a channel (opening it, or a message arriving in the
 * open channel), debounced {@link MARKREAD_DEBOUNCE_MS} per channel and only
 * when the newest message is newer than the last marker sent or received.
 * {@link fetchReadMarker} sends the bare `MARKREAD <target>` after our JOIN
 * so the server answers with the stored marker (nefarious2 also volunteers
 * it after JOIN for logged-in accounts).
 */

import {ChanType} from "../../../../shared/types/chan";
import {MessageType, type SharedMsg} from "../../../../shared/types/msg";
import {SAID_TYPES, countsAsUnread, type Channel, type MsgRef} from "../channel";
import type {IrcClient} from "../client";
import {formatLine} from "../message";
import type {Handler} from "../types";

export const MARKREAD_CAP = "draft/read-marker";
/** Delay between the user reading a channel and the `MARKREAD` going out. */
export const MARKREAD_DEBOUNCE_MS = 1000;

export function markReadEnabled(client: IrcClient): boolean {
	return client.caps.hasCapability(MARKREAD_CAP);
}

function markable(chan: Channel): boolean {
	return chan.type === ChanType.CHANNEL || chan.type === ChanType.QUERY;
}

/** `timestamp=<t>` / `<t>` → Date; undefined for `*`, missing or unparsable. */
export function parseMarker(param: string | undefined): Date | undefined {
	if (!param) {
		return undefined;
	}

	const raw = param.startsWith("timestamp=") ? param.slice("timestamp=".length) : param;

	if (raw === "" || raw === "*") {
		return undefined;
	}

	const time = new Date(raw);
	return Number.isNaN(time.getTime()) ? undefined : time;
}

/** `chan` is read up to `time`; a query's read point is kept with its log. */
function moveReadMarker(client: IrcClient, chan: Channel, time: Date): void {
	chan.readMarker = time;

	if (chan.type === ChanType.QUERY) {
		client.queryLog.setRead(chan.name, time);
	}
}

/**
 * The account read `chan` up to `time`: move `firstUnread`, recount the
 * counters and tell the UI. No-op when the marker is not newer than the one
 * we already hold, or when nothing shown is at or before it.
 */
export function applyReadMarker(client: IrcClient, chan: Channel, time: Date): void {
	if (chan.readMarker && time.getTime() <= chan.readMarker.getTime()) {
		return;
	}

	moveReadMarker(client, chan, time);

	let lastRead: [number, MsgRef] | undefined;
	let unread = 0;
	let highlight = 0;

	for (const entry of chan.msgRefs) {
		const [id, ref] = entry;

		if (ref.time.getTime() > time.getTime()) {
			if (ref.unread) {
				unread++;
			}

			if (ref.highlight) {
				highlight++;
			}
		} else if (
			!lastRead ||
			ref.time.getTime() > lastRead[1].time.getTime() ||
			(ref.time.getTime() === lastRead[1].time.getTime() && id > lastRead[0])
		) {
			lastRead = entry;
		}
	}

	if (!lastRead) {
		return; // everything shown is newer than the marker: nothing was read
	}

	const shared = chan.shared;
	const current = chan.msgRefs.get(shared.firstUnread);

	// Never move the marker backwards (e.g. behind one of our own messages).
	if (!current || current.time.getTime() <= lastRead[1].time.getTime()) {
		shared.firstUnread = lastRead[0];
	}

	shared.unread = Math.min(shared.unread, unread);
	shared.highlight = Math.min(shared.highlight, highlight);
	client.dispatch("markread", {
		chan: chan.id,
		firstUnread: shared.firstUnread,
		unread: shared.unread,
		highlight: shared.highlight,
	});
}

/**
 * A page of older lines was handed to the UI (`more`, which carries no
 * counters): what in it is past `marker` and would have counted live is
 * unread. Flag those refs, add them to the counters and tell the UI with
 * `markread`, moving `firstUnread` to `lastRead` when there is one. A line
 * of ours past `marker` read everything before it (as in `pushMessage`):
 * the count starts after it and the read point moves to it.
 */
export function countPageUnread(
	client: IrcClient,
	chan: Channel,
	page: Array<[SharedMsg, MsgRef]>,
	marker: Date,
	lastRead = 0
): void {
	let readTo = marker.getTime();

	for (const [msg, ref] of page) {
		if (
			msg.self &&
			SAID_TYPES.has(msg.type ?? MessageType.MESSAGE) &&
			ref.time.getTime() > readTo
		) {
			readTo = ref.time.getTime();
			lastRead = msg.id;
		}
	}

	if (readTo > marker.getTime()) {
		moveReadMarker(client, chan, new Date(readTo));
	}

	let unread = 0;
	let highlight = 0;

	for (const [msg, ref] of page) {
		if (ref.time.getTime() <= readTo || !countsAsUnread(msg)) {
			continue;
		}

		ref.unread = true;
		unread++;

		if (msg.highlight) {
			ref.highlight = true;
			highlight++;
		}
	}

	if (unread === 0) {
		return;
	}

	const shared = chan.shared;
	shared.unread += unread;
	shared.highlight += highlight;
	shared.firstUnread = lastRead || shared.firstUnread;
	client.dispatch("markread", {
		chan: chan.id,
		firstUnread: shared.firstUnread,
		unread: shared.unread,
		highlight: shared.highlight,
	});
}

/**
 * Someone is looking at `chan` (opened, or attention returned to it): it is
 * read. Zero its counters, tell the UI, and mark it on the server.
 */
export function readNow(client: IrcClient, chan: Channel): void {
	chan.shared.unread = 0;
	chan.shared.highlight = 0;
	// The counters only (`firstUnread: 0`): the page may not have made the
	// conversation its active one yet (Chat mounts before RoutedChat), and
	// the new-messages line it shows is its own to keep.
	client.dispatch("markread", {chan: chan.id, firstUnread: 0, unread: 0, highlight: 0});
	scheduleMarkRead(client, chan);
}

/**
 * The user read `chan` up to its newest message: send a `MARKREAD` after
 * {@link MARKREAD_DEBOUNCE_MS}, carrying whatever is newest by then. The
 * read point moves whether or not the server keeps markers (or has said
 * yet that it does): a query's is kept with its log, and a send that comes
 * due before registration waits for it.
 */
export function scheduleMarkRead(client: IrcClient, chan: Channel): void {
	const newest = chan.newestRef;

	if (!newest || !markable(chan)) {
		return;
	}

	if (chan.readMarker && newest.time.getTime() <= chan.readMarker.getTime()) {
		return;
	}

	moveReadMarker(client, chan, newest.time);

	if (chan.markReadTimer !== null) {
		return; // the pending send picks up the newer marker
	}

	chan.markReadTimer = setTimeout(() => {
		chan.markReadTimer = null;
		sendMarkRead(client, chan);
	}, MARKREAD_DEBOUNCE_MS);
}

/** One command: what a background marker send is reckoned to cost. */
const MARKREAD_COST_MS = 2000;
/** A channel's marker goes ahead of the catch-up at most this often. */
export const MARKREAD_JUMP_GAP_MS = 10_000;

function sendMarkRead(client: IrcClient, chan: Channel): void {
	if (!chan.readMarker) {
		return;
	}

	// Came due while a reconnect is still registering (the page returning
	// to the foreground marks the open channel and redials at once): the
	// server would answer `451 Register first.` Keep it for registration —
	// the other devices' notifications close on it.
	if (!client.isWelcomed) {
		chan.markReadDeferred = true;
		return;
	}

	if (!markReadEnabled(client)) {
		chan.markReadDeferred = false;
		return;
	}

	// Nobody waits on the marker the moment it moves: it is background work
	// (fakelag.ts), sent with whatever is newest when the clock has room —
	// ahead of the catch-up, since the account's other devices close their
	// notifications on it, but at most once per MARKREAD_JUMP_GAP_MS for a
	// channel: in an open channel where a line arrives (or is typed) every
	// few seconds, each line's marker at the front would take all the
	// clock's room and the catch-up would never run. Deferred until sent,
	// so a socket that closes first hands it to flushDeferredMarkRead on
	// the next registration.
	const key = `markread:${chan.id}`;
	const front = Date.now() - chan.markReadJumpedAt >= MARKREAD_JUMP_GAP_MS;

	if (front) {
		client.background.take(key); // one queued at the back moves up
		chan.markReadJumpedAt = Date.now();
	}

	chan.markReadDeferred = true;
	client.background.add(
		{
			key,
			cost: MARKREAD_COST_MS,
			run() {
				chan.markReadDeferred = false;

				if (chan.readMarker && markReadEnabled(client)) {
					client.send(
						formatLine({
							command: "MARKREAD",
							params: [chan.name, `timestamp=${chan.readMarker.toISOString()}`],
						})
					);
				}
			},
		},
		{front}
	);
}

/**
 * The user read `target` up to `time` elsewhere — a notification's Mark
 * read, relayed by the service worker (bus-contract §2 `markread`): send
 * the marker at once, undebounced, since nothing newer is coming from
 * here. `target` need not be loaded (a query with no window still has a
 * marker); a loaded channel's own marker moves with it so the debounced
 * path does not follow with an older one, and a pending send is dropped.
 */
export function markReadAt(client: IrcClient, target: string, time: Date): void {
	if (Number.isNaN(time.getTime()) || !markReadEnabled(client) || !client.isWelcomed) {
		return;
	}

	const chan = client.findChannel(target);

	if (chan) {
		if (!markable(chan)) {
			return;
		}

		if (chan.readMarker && time.getTime() <= chan.readMarker.getTime()) {
			return; // marked at least this far already
		}

		cancelMarkRead(chan);
		client.background.take(`markread:${chan.id}`);
		chan.markReadDeferred = false;
		// Moves the badge too: the server's echo of this same marker is
		// not newer, so applyReadMarker would ignore it.
		applyReadMarker(client, chan, time);
	}

	client.send(
		formatLine({
			command: "MARKREAD",
			params: [chan ? chan.name : target, `timestamp=${time.toISOString()}`],
		})
	);
}

/** Ask the server for the stored marker (`MARKREAD <target>`), e.g. after JOIN. */
export function fetchReadMarker(client: IrcClient, chan: Channel): void {
	if (!markable(chan) || !markReadEnabled(client) || !client.isWelcomed) {
		return;
	}

	client.send(formatLine({command: "MARKREAD", params: [chan.name]}));
}

/** Registration is complete: send the markers that came due before it
 * ({@link sendMarkRead}, and a debounce the last socket died holding). */
export function flushDeferredMarkRead(client: IrcClient): void {
	for (const chan of client.channels) {
		if (chan.markReadDeferred && chan.markReadTimer === null) {
			sendMarkRead(client, chan);
		}
	}
}

/** Cancel a pending send (transport closed). */
export function cancelMarkRead(chan: Channel): void {
	if (chan.markReadTimer !== null) {
		clearTimeout(chan.markReadTimer);
		chan.markReadTimer = null;
	}
}

const markread: Handler = (client, msg) => {
	const [target, param] = msg.params;
	const chan = target ? client.findChannel(target) : undefined;

	if (!chan || client.replaying) {
		return;
	}

	chan.markerAnswered = true;
	const time = parseMarker(param);

	if (time) {
		applyReadMarker(client, chan, time);
	}
};

export default {MARKREAD: markread};
