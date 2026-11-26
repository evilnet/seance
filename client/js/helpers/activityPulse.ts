// Sidebar activity pulse: a channel's icon breathes for a few seconds after
// somebody says something there, poxchat's leading-glyph cue for "this channel
// is talking right now". The typing pulse (helpers/typingState.ts) says someone
// is *about* to speak; this one says someone just did.
//
// Only real conversation counts. Joins, parts, quits, nick changes, mode and
// topic changes, numerics and our own messages leave the icon still — they are
// what the sidebar would be pulsing for all day if the filter were "anything
// that arrives", and they are exactly the noise the unread badge already
// swallows for you.
//
// State is a single deadline per channel rather than a flag, so a burst of
// messages just pushes the deadline out and the animation runs unbroken. The
// shared sweep in helpers/expirySweep.ts clears lapsed deadlines in every
// channel, so the sidebar reads a plain reactive computed with no per-row timer.
//
// No store/DOM imports so it can be unit-tested under mocha.
import {ExpirySweep, SWEEP_INTERVAL} from "./expirySweep";
import {MessageType, type SharedMsg} from "../../../shared/types/msg";

/** Anything carrying an activity deadline; a `ClientChan` in practice. */
export type ActivityHolder = {activityUntil: number};

/**
 * How long the icon keeps pulsing after the last message. Long enough to catch
 * the eye on a channel you are not looking at, short enough that a quiet
 * channel stops moving before you switch to it.
 */
export const ACTIVITY_PULSE_MS = 4000;

/** Sweep period; the only TTL is 4 s, so 1 s granularity is ample. */
export const ACTIVITY_SWEEP_INTERVAL = SWEEP_INTERVAL;

/**
 * Message types that count as somebody talking. WALLOPS is in because it is an
 * oper addressing you in words; CTCP, monospace blocks and the rest of the
 * numeric output are not.
 */
const SPEECH_TYPES: ReadonlySet<MessageType> = new Set([
	MessageType.MESSAGE,
	MessageType.ACTION,
	MessageType.NOTICE,
	MessageType.WALLOPS,
]);

/** Whether `msg` should make its channel's sidebar icon pulse. */
export function isActivity(msg: Pick<SharedMsg, "type" | "self">): boolean {
	if (msg.self) {
		return false; // you are not news to yourself
	}

	return SPEECH_TYPES.has(msg.type ?? MessageType.MESSAGE);
}

/** Start (or extend) the pulse on `holder`. */
export function noteActivity(holder: ActivityHolder, now: number): void {
	holder.activityUntil = now + ACTIVITY_PULSE_MS;
}

/**
 * Clear a lapsed deadline and report whether one is still running. Leaves the
 * holder untouched otherwise, so reactive watchers only fire on a real stop.
 */
export function expireActivity(holder: ActivityHolder, now: number): boolean {
	if (holder.activityUntil === 0) {
		return false;
	}

	if (holder.activityUntil <= now) {
		holder.activityUntil = 0;
		return false;
	}

	return true;
}

export class ActivityExpiry extends ExpirySweep<ActivityHolder> {
	constructor(holders: () => Iterable<ActivityHolder>, interval = ACTIVITY_SWEEP_INTERVAL) {
		super(holders, expireActivity, interval);
	}
}
