/**
 * ERROR (`ERROR :Closing Link: ...`). The server drops the connection right
 * after; the transport's close event does the state change. After our own
 * QUIT the transport is already closed by us, so the (1006) close that
 * follows never reconnects; otherwise the reason is shown and the usual
 * reconnect kicks in.
 *
 * An ERROR that says "throttled" is the server's connection throttle
 * (nefarious2: `Your host is trying to (re)connect too fast -- throttled`):
 * the retry waits the seconds it names, else the transport's fallback
 * (docs/projects/reconnect-throttle.md).
 */

import {MessageType} from "../../../../shared/types/msg";
import type {Handler} from "../types";

export interface ThrottleError {
	/** The wait the server named, in ms; undefined when it named none. */
	waitMs?: number;
}

/** "N s", "N sec", "N secs", "N second(s)", the first one in the text. */
const SECONDS = /\b(\d{1,5})\s*s(?:ec(?:ond)?s?)?\b/i;

/** The server's throttle in an ERROR's text, or undefined for any other ERROR. */
export function parseThrottleError(text: string): ThrottleError | undefined {
	if (!/\bthrottled\b/i.test(text)) {
		return undefined;
	}

	const match = SECONDS.exec(text);
	return match ? {waitMs: Number(match[1]) * 1000} : {};
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
