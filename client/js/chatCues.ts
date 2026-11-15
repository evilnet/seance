/**
 * Chat cues (docs/resources/themes.md § Chat cues): a theme's way to react to
 * what happens in the open conversation without running code of its own.
 * Someone else's live join, part, message or mention there shows for CUE_MS as
 * `<html data-chat-cue="join">` (or `part`, `message`, `mention`) for any
 * theme's CSS to select on. A cue says only what kind of thing happened.
 *
 * One cue at a time: while one shows another is dropped (a mention replaces
 * anything but a mention), and after one ends the next waits QUIET_MS, so a
 * busy channel glows now and then rather than all the time. Nothing while the
 * page is hidden or the user asks for reduced motion. The document is touched
 * only inside functions, so mocha loads it.
 */

import {MessageType} from "../../shared/types/msg";

export type ChatCue = "join" | "part" | "message" | "mention";

/** How long a cue shows: long enough for a glow to rise and fall. */
export const CUE_MS = 3000;

/** How long after a cue ends the next may start (a mention does not wait). */
export const QUIET_MS = 2000;

/** What a message in the open conversation cues, if anything. */
export function cueForMessage(msg: {
	type?: MessageType;
	self?: boolean;
	highlight?: boolean;
	pending?: boolean;
	editOf?: string;
}): ChatCue | null {
	if (msg.self || msg.pending || msg.editOf) {
		return null;
	}

	switch (msg.type ?? MessageType.MESSAGE) {
		case MessageType.JOIN:
			return "join";
		case MessageType.PART:
		case MessageType.QUIT:
		case MessageType.KICK:
			return "part";
		case MessageType.MESSAGE:
		case MessageType.ACTION:
			return msg.highlight ? "mention" : "message";
		default:
			return null;
	}
}

/** The rules above around `show`; returns the function that fires a cue. */
export function createChatCues(opts: {
	show(cue: ChatCue | null): void;
	allowed(): boolean;
	now(): number;
	after(ms: number, fn: () => void): () => void;
}): (cue: ChatCue) => void {
	let current: ChatCue | null = null;
	let cancel = () => {};
	let endedAt = -Infinity;

	return (cue) => {
		const mention = cue === "mention";

		if (
			!opts.allowed() ||
			(current && (!mention || current === "mention")) ||
			(!current && !mention && opts.now() - endedAt < QUIET_MS)
		) {
			return;
		}

		cancel();
		current = cue;
		opts.show(cue);
		cancel = opts.after(CUE_MS, () => {
			current = null;
			endedAt = opts.now();
			opts.show(null);
		});
	};
}

export const fireChatCue = createChatCues({
	show(cue) {
		if (cue) {
			document.documentElement.dataset.chatCue = cue;
		} else {
			delete document.documentElement.dataset.chatCue;
		}
	},
	allowed: () =>
		document.visibilityState === "visible" &&
		!document.documentElement.hasAttribute("data-reduce-motion"),
	now: () => performance.now(),
	after(ms, fn) {
		const id = window.setTimeout(fn, ms);
		return () => window.clearTimeout(id);
	},
});
