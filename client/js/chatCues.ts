/**
 * Chat cues (docs/resources/themes.md § Chat cues): a theme's way to react to
 * the open conversation without running code of its own. Someone else's live
 * message, join or mention there shows for CUE_MS as `<html data-chat-cue>`
 * (`message`, `join`, `mention`) for any theme's CSS to select on.
 *
 * Every cue shows: a new one replaces the one showing and restarts the
 * theme's animation, except that nothing but a mention cuts a mention short.
 * None while the page is hidden or motion is reduced, and the one showing ends
 * when either happens, or the open conversation or the theme changes
 * (`clear`). The document is touched only inside functions, so mocha loads it.
 */

import {MessageType} from "../../shared/types/msg";
import {onSystemAccessibility} from "./helpers/systemAccessibility";

export type ChatCue = "message" | "join" | "mention";

/** How long a cue shows: long enough for a glow to rise and fall. */
export const CUE_MS = 3000;

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

	switch (msg.type) {
		case MessageType.JOIN:
			return "join";
		case MessageType.MESSAGE:
		case MessageType.ACTION:
			return msg.highlight ? "mention" : "message";
		default:
			return null;
	}
}

export interface ChatCues {
	fire(cue: ChatCue): void;
	/** Ends the cue showing, if any. */
	clear(): void;
}

/** The rules above around `show`. */
export function createChatCues(opts: {
	show(cue: ChatCue | null): void;
	allowed(): boolean;
	after(ms: number, fn: () => void): () => void;
}): ChatCues {
	let current: ChatCue | null = null;
	let cancel = () => {};

	const clear = () => {
		cancel();

		if (current) {
			current = null;
			opts.show(null);
		}
	};

	return {
		fire(cue) {
			if (!opts.allowed() || (current === "mention" && cue !== "mention")) {
				return;
			}

			cancel();
			current = cue;
			opts.show(cue);
			cancel = opts.after(CUE_MS, clear);
		},
		clear,
	};
}

let watching = false;

export const chatCues = createChatCues({
	show(cue) {
		const html = document.documentElement;
		delete html.dataset.chatCue;

		if (cue) {
			// Read layout between the two writes so the same cue twice in a
			// row restarts a theme's animation instead of carrying on.
			void html.offsetWidth;
			html.dataset.chatCue = cue;
		}

		// Hidden or reduced motion ends a cue; installed with the first one.
		if (!watching) {
			watching = true;
			document.addEventListener("visibilitychange", () => {
				if (document.visibilityState !== "visible") {
					chatCues.clear();
				}
			});
			onSystemAccessibility((a) => a.reduceMotion && chatCues.clear());
		}
	},
	allowed: () =>
		document.visibilityState === "visible" &&
		!document.documentElement.hasAttribute("data-reduce-motion"),
	after(ms, fn) {
		const id = window.setTimeout(fn, ms);
		return () => window.clearTimeout(id);
	},
});
