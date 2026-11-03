/**
 * ERROR (`ERROR :Closing Link: ...`). The server drops the connection right
 * after; the transport's close event does the state change. After our own
 * QUIT the transport is already closed by us, so the (1006) close that
 * follows never reconnects; otherwise the reason is shown and the usual
 * reconnect kicks in.
 *
 * An ERROR that says "throttled" is the server's connection throttle
 * (nefarious2: `Your host is trying to (re)connect too fast -- throttled`):
 * the retry waits the seconds it names after "retry in", at most
 * {@link MAX_THROTTLE_WAIT_MS}, else the transport's fallback
 * (docs/projects/reconnect-throttle.md). Any other number in the text (a
 * kill or ban reason's) is not a wait.
 */

import {MessageType} from "../../../../shared/types/msg";
import type {Handler} from "../types";

export interface ThrottleError {
	/** The wait the server named, in ms; undefined when it named none. */
	waitMs?: number;
}

/** "retry in N", optionally followed by s / sec / secs / second(s). */
const RETRY_IN = /\bretry in (\d{1,6})(?:\s*s(?:ec(?:ond)?s?)?)?\b/i;

/** The longest wait an ERROR may set: past this, the server is not throttling, it is something else. */
export const MAX_THROTTLE_WAIT_MS = 300_000;

/** The server's throttle in an ERROR's text, or undefined for any other ERROR. */
export function parseThrottleError(text: string): ThrottleError | undefined {
	if (!/\bthrottled\b/i.test(text)) {
		return undefined;
	}

	const match = RETRY_IN.exec(text);
	return match ? {waitMs: Math.min(Number(match[1]) * 1000, MAX_THROTTLE_WAIT_MS)} : {};
}

const error: Handler = (client, msg) => {
	if (client.isQuitting) {
		return;
	}

	const text = msg.params[0] ?? "ERROR";
	const throttle = parseThrottleError(text);

	if (throttle) {
		client.noteThrottled(throttle.waitMs);
	}

	client.pushMessage(
		client.lobby,
		{type: MessageType.ERROR, time: client.timeOf(msg), text},
		true
	);
};

export default {ERROR: error};
