/**
 * The account's push mute list, `draft/webpush/mute` metadata: `;`-separated
 * `target:until` entries (unix seconds) that nefarious2 enforces before it
 * pushes (ircd/webpush_mute.c); `*` mutes every target. Do not disturb owns
 * the `*` entry and leaves every other entry (per-channel mutes written by
 * any device) as it found it. See docs/projects/do-not-disturb.md.
 */

import type {IrcClient} from "./client";
// presence.ts imports this module too; the cycle is only between functions
// called after both modules have loaded, which ES modules allow.
import {syncPresence} from "./presence";

export const MUTE_KEY = "draft/webpush/mute";
/** An indefinite do not disturb writes this far ahead (the server's mute is timed)... */
export const INDEFINITE_MUTE_S = 30 * 86400;
/** ...and writes again once less than this remains. */
export const RENEW_BELOW_S = 7 * 86400;
/** SUB/GET wait this long after registration: the connect burst is over by then. */
export const MUTE_READ_DELAY_MS = 10_000;
/** A write not echoed within this long is taken as lost (a FAIL, say). */
export const MUTE_ECHO_TIMEOUT_MS = 30_000;

/** A value this client sent and the server has not yet echoed (or has once). */
export interface PendingMute {
	value: string;
	/** Date.now() when sent. */
	at: number;
	/** At least one echo (761/766 or the METADATA line) has come back. */
	echoed: boolean;
	/** The `*` end the value says (unix seconds), null for none. */
	until: number | null;
}

export interface MuteEntry {
	target: string;
	/** Unix seconds. */
	until: number;
}

export function parseMute(value: string): MuteEntry[] {
	const out: MuteEntry[] = [];

	for (const raw of value.split(";")) {
		// The first colon, as the server splits it (memchr): a target never has one.
		const colon = raw.indexOf(":");

		if (colon <= 0) {
			continue;
		}

		const target = raw.slice(0, colon);
		const untilText = raw.slice(colon + 1);

		// A signed integer: 0 or a leading '-' is indefinite on the server.
		if (!/^-?\d+$/.test(untilText)) {
			continue;
		}

		out.push({target, until: Number(untilText)});
	}

	return out;
}

export function formatMute(entries: MuteEntry[]): string {
	return entries.map((e) => `${e.target}:${e.until}`).join(";");
}

/**
 * The `*` entry's end while it is live: a unix-seconds number, `Infinity`
 * for an indefinite one (until 0 or negative), `null` when absent or expired.
 */
export function globalUntil(value: string, nowSec: number): number | null {
	const entry = parseMute(value).find((e) => e.target === "*");

	if (!entry) {
		return null;
	}

	if (entry.until <= 0) {
		return Number.POSITIVE_INFINITY;
	}

	return entry.until > nowSec ? entry.until : null;
}

/** Entries other than `*` that are still live; indefinite ones always are. */
function liveOthers(value: string, nowSec: number): MuteEntry[] {
	return parseMute(value).filter((e) => e.target !== "*" && (e.until <= 0 || e.until > nowSec));
}

export function withGlobal(value: string, untilSec: number, nowSec: number): string {
	return formatMute([...liveOthers(value, nowSec), {target: "*", until: untilSec}]);
}

export function withoutGlobal(value: string, nowSec: number): string {
	return formatMute(liveOthers(value, nowSec));
}

const nowSec = () => Math.floor(Date.now() / 1000);

/** The account's mute list can be written on this connection. */
export function canWriteMute(client: IrcClient): boolean {
	return (
		client.isWelcomed && client.caps.hasCapability("draft/metadata-2") && client.account !== ""
	);
}

/** What this client's own `*` entry should say (unix seconds), or null for none. */
export function desiredUntil(client: IrcClient, now: number): number | null {
	const g = client.globalDnd;

	if (g.active && g.until !== null) {
		const until = Math.floor(g.until / 1000);

		// A timed DND already over (the minute tick has not caught up) wants
		// nothing of its own; a network in mode dnd still does.
		if (until > now) {
			return until;
		}
	} else if (g.active) {
		return now + INDEFINITE_MUTE_S;
	}

	return client.presenceMode === "dnd" ? now + INDEFINITE_MUTE_S : null;
}

/** The `*` end a value says, live or not; null for none or an indefinite one. */
function ownUntil(value: string): number | null {
	const entry = parseMute(value).find((e) => e.target === "*");
	return entry && entry.until > 0 ? entry.until : null;
}

/** Send the whole value (empty deletes the key); `muteValue` holds it at once. */
function writeMute(client: IrcClient, value: string): void {
	client.muteValue = value;
	prunePending(client);
	client.mutePending.push({value, at: Date.now(), echoed: false, until: ownUntil(value)});
	// Private: only the account's own sessions may read it (the server's
	// push gate reads it whatever its visibility). A delete takes no
	// visibility (m_metadata.c: `SET target key` deletes).
	const line = client.metadataSetLine(MUTE_KEY, value);

	if (line) {
		client.send(line);
	}
}

/**
 * Forget writes older than MUTE_ECHO_TIMEOUT_MS, wherever they sit: one
 * never echoed (refused) must stop hiding other devices' values, and this
 * bounds the queue to the last timeout's writes whether or not any echo
 * ever comes back.
 */
function prunePending(client: IrcClient): void {
	const queue = client.mutePending;
	const cutoff = Date.now() - MUTE_ECHO_TIMEOUT_MS;

	for (let i = queue.length - 1; i >= 0; i--) {
		if (queue[i].at < cutoff) {
			queue.splice(i, 1);
		}
	}
}

/**
 * Keep the account's `*` entry in step with this client's do not disturb:
 * write it while DND is wanted, remove it when DND ends, but only an entry
 * this client wrote. Nothing is written before the value has been read.
 */
export function syncPushMute(client: IrcClient): void {
	if (!client.muteKnown || !canWriteMute(client)) {
		return;
	}

	const now = nowSec();
	const want = desiredUntil(client, now);
	const have = globalUntil(client.muteValue, now);
	const claim = client.muteClaim;
	client.muteClaim = false;

	// The user changed DND here by hand: the live entry, whoever wrote it,
	// is replaced by what they asked for (an indefinite `*:0` excepted: it
	// already mutes everything). A change that wants no entry claims
	// nothing, so following or editing a schedule never removes another
	// device's DND; the pill's Off removes it (clearRemoteDnd).
	if (claim && want !== null) {
		client.muteSuppressed = false;

		if (have !== null && have !== Number.POSITIVE_INFINITY) {
			client.muteOwnedUntil = have;
		}
	}

	if (want !== null) {
		// Another device took our entry away: leave it until DND starts afresh.
		if (client.muteSuppressed) {
			return;
		}

		// A live entry we did not write is adopted: push is muted already,
		// and rewriting it would have two devices that disagree on the end
		// (one indefinite, one timed) rewrite each other forever. Once it
		// expires, `have` is null and our own entry goes in.
		if (have !== null && !client.muteOwned) {
			return;
		}

		// Ours: keep it saying what we want. (An indefinite `*:0` is never
		// ours; we write only timed entries.) A timed DND already over is
		// not timed: desiredUntil fell through to the mode's renewing end.
		const g = client.globalDnd;
		const timed = g.active && g.until !== null && Math.floor(g.until / 1000) > now;
		const stale =
			have === null ||
			(have !== Number.POSITIVE_INFINITY &&
				(timed ? have !== want : have - now < RENEW_BELOW_S));

		if (stale) {
			writeMute(client, withGlobal(client.muteValue, want, now));
			client.muteOwnedUntil = want;
		}

		return;
	}

	client.muteSuppressed = false;

	const owned = client.muteOwned;
	// Ours is gone either way: removed now, or it expired by itself.
	client.muteOwnedUntil = null;

	if (!owned) {
		// Another device's entry: removed only by clearRemoteDnd.
		return;
	}

	writeMute(client, withoutGlobal(client.muteValue, now));
	// remoteDnd followed muteValue down: say so (AWAY, the snapshot).
	syncPresence(client);
}

/**
 * An explicit change to the do not disturb on this page (client/js/dnd.ts):
 * the next sync on this connection takes the live `*` entry as ours and
 * writes the new want over it. Before the GET has answered, the claim waits
 * for it. Automatic syncs (the minute tick, a reconnect) still adopt an
 * entry another device wrote.
 */
export function claimMute(client: IrcClient): void {
	client.muteClaim = true;
	client.muteClearPending = false;
}

/** The pill's Off with DND set elsewhere: remove the `*` entry here. */
export function clearRemoteDnd(client: IrcClient): void {
	const now = nowSec();

	if (!client.muteKnown) {
		// A list read before a gap (a reconnect, metadata out of use) may
		// be stale: writing it back could erase another device's newer
		// mutes. The removal waits for the read (onMuteValue).
		client.muteClearPending = true;
		return;
	}

	if (!canWriteMute(client) || globalUntil(client.muteValue, now) === null) {
		return;
	}

	writeMute(client, withoutGlobal(client.muteValue, now));
	client.muteOwnedUntil = null;
	syncPresence(client);
}

/**
 * The network is going away for good (`/quit`, removing it): take this
 * client's own `*` entry with it, or every other device would read it as a
 * do not disturb set here for up to INDEFINITE_MUTE_S, and a re-added
 * network (its muteMemory forgotten) would adopt it as another device's.
 */
export function releaseMute(client: IrcClient): void {
	// Not before the read: the list from before a gap may be stale, and
	// writing it back would erase another device's newer mutes.
	if (!client.muteOwned || !client.muteKnown || !canWriteMute(client)) {
		return;
	}

	writeMute(client, withoutGlobal(client.muteValue, nowSec()));
	client.muteOwnedUntil = null;
}

/**
 * Whether `value` is the echo of one of our own writes. Each SET comes back
 * twice (the 761/766 confirmation and, being subscribed, the METADATA line),
 * in the order sent, so an echo of an older write means newer ones are in
 * flight and `muteValue` already holds the newest. A value that is no write
 * of ours while one is still unechoed was set before it on the server, and
 * our write replaces it there: it is stale too. Echo-matching only by value
 * is enough because a foreign value equal to our newest one changes nothing.
 */
function ownEcho(client: IrcClient, value: string): boolean {
	prunePending(client);
	const queue = client.mutePending;

	const index = queue.findIndex((p) => p.value === value);

	if (index >= 0) {
		queue.splice(0, index);

		if (!queue[0].echoed) {
			queue[0].echoed = true;
			// The server holds this write: a reload's GET can trust it.
			client.muteConfirmedUntil = queue[0].until;
		}

		return true;
	}

	if (queue.some((p) => !p.echoed)) {
		return true;
	}

	queue.length = 0;
	return false;
}

/** A value read back from the server (761, 766 as "", or a METADATA line). */
export function onMuteValue(client: IrcClient, value: string): void {
	if (client.muteKnown && ownEcho(client, value)) {
		return;
	}

	if (!client.muteKnown) {
		onFirstRead(client, value);

		if (client.muteClearPending) {
			client.muteClearPending = false;
			clearRemoteDnd(client);
		}

		syncPresence(client);
		return;
	}

	const now = nowSec();
	const before = globalUntil(client.muteValue, now);
	const hadLive = before !== null;
	client.muteValue = value;
	const after = globalUntil(value, now);
	const live = after !== null;

	// Our entry is still ours only while the live `*` says the end we last
	// wrote: another device changing a per-channel entry, or the GET after
	// a reconnect reading our own entry back, keeps it ours. A different
	// `*`, or none, is theirs and is adopted (syncPushMute).
	if (after !== client.muteOwnedUntil) {
		client.muteOwnedUntil = null;
		// Not ours on the server any more either.
		client.muteConfirmedUntil = null;
	}

	if (hadLive && !live && desiredUntil(client, now) !== null) {
		// The entry is gone while we still want one, and we did not remove
		// it (our own clears happen only when we want none, and update
		// muteValue before their echo): another device turned DND off. Do
		// not put it back; tell the page (client/js/dnd.ts).
		client.muteOwnedUntil = null;
		client.muteConfirmedUntil = null;
		client.muteSuppressed = true;
		client.dispatchBus("dnd:cleared", {network: client.uuid});
	}

	syncPresence(client);
}

/**
 * The GET after registration (a reconnect, or a reload with this device's
 * memory, irc/muteMemory.ts): what the server holds against what we last
 * wrote and what it last confirmed.
 */
function onFirstRead(client: IrcClient, value: string): void {
	const now = nowSec();
	client.muteValue = value;
	client.muteKnown = true;
	const live = globalUntil(value, now);
	const owned = client.muteOwnedUntil;
	const confirmed = client.muteConfirmedUntil;

	if (live !== null && live !== Number.POSITIVE_INFINITY) {
		if (live === owned) {
			// Our last write is there, whether or not its echo reached us.
			client.muteConfirmedUntil = live;
			return;
		}

		if (live === confirmed) {
			// Our last write died with the socket (or the page): the entry
			// is our previous one. Ours, so the next sync writes the want.
			client.muteOwnedUntil = live;
			return;
		}
	}

	if (
		live === null &&
		confirmed !== null &&
		confirmed > now &&
		owned !== null &&
		owned > now &&
		!client.muteClaim &&
		desiredUntil(client, now) !== null
	) {
		// Neither our last write (it would be live had it landed) nor the
		// one the server confirmed (live had ours been lost), both still
		// ahead: another device turned DND off while we were away.
		client.muteOwnedUntil = null;
		client.muteConfirmedUntil = null;
		client.muteSuppressed = true;
		client.dispatchBus("dnd:cleared", {network: client.uuid});
		return;
	}

	if (live === null && owned !== confirmed) {
		// Our last write never landed: a clear (owned null), or one whose
		// end has passed, or none confirmed before it. No report: the next
		// sync writes the want, as it would have.
		client.muteConfirmedUntil = null;
		return;
	}

	// Another device's entry (adopted, syncPushMute), or none at all.
	client.muteOwnedUntil = null;
	client.muteConfirmedUntil = null;
}
