/**
 * Chat cues (docs/resources/themes.md § Chat cues): a theme's way to react to
 * what happens in the open conversation without running code of its own. A
 * live join, part or message there, or a mention, shows for a few seconds as
 * `<html data-chat-cue="join">` (or `part`, `message`, `mention`), which any
 * theme's CSS can select on, and is passed to the theme's scene, if it has one
 * (themeScene.ts `SceneHandle.cue`). A cue says only what kind of thing
 * happened: never who, where or what was said.
 *
 * One cue at a time: while one shows, a second is dropped (a mention replaces
 * anything but a mention), and after one ends the next waits QUIET_MS, so a
 * busy channel glows now and then rather than all the time. Nothing is cued
 * for history, catch-up or our own lines, and nothing while the page is hidden
 * or the user asks for reduced motion. It touches the document only inside
 * functions, so mocha loads it.
 */

import {MessageType} from "../../shared/types/msg";
import {themeScene} from "./themeScene";

export type ChatCue = "join" | "part" | "message" | "mention";

export const CHAT_CUES: readonly ChatCue[] = ["join", "part", "message", "mention"];

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

export interface ChatCues {
	/** Shows `cue` if nothing stops it (the rules above); returns whether it did. */
	fire(cue: ChatCue): boolean;
	/** Ends the cue showing, if any, at once (a theme switch, a teardown). */
	clear(): void;
	readonly current: ChatCue | null;
}

export function createChatCues(opts: {
	/** Shows a cue, or none. */
	show(cue: ChatCue | null): void;
	/** Whether a cue may show now (the page visible, motion allowed). */
	allowed(): boolean;
	now(): number;
	after(ms: number, fn: () => void): () => void;
}): ChatCues {
	let current: ChatCue | null = null;
	let cancel: (() => void) | undefined;
	let endedAt = -Infinity;

	const end = () => {
		cancel?.();
		cancel = undefined;

		if (current) {
			current = null;
			endedAt = opts.now();
			opts.show(null);
		}
	};

	return {
		get current() {
			return current;
		},

		fire(cue: ChatCue): boolean {
			const mention = cue === "mention";

			if (!opts.allowed()) {
				return false;
			}

			if (current && (!mention || current === "mention")) {
				return false;
			}

			if (!current && !mention && opts.now() - endedAt < QUIET_MS) {
				return false;
			}

			cancel?.();
			current = cue;
			opts.show(cue);
			cancel = opts.after(CUE_MS, end);
			return true;
		},

		clear: end,
	};
}

/** The app's cues: `<html data-chat-cue>` and the theme's scene (themeScene.ts). */
let appCues: ChatCues | undefined;

export function chatCues(): ChatCues {
	if (!appCues) {
		appCues = createChatCues({
			show(cue) {
				const html = document.documentElement;

				if (cue) {
					html.dataset.chatCue = cue;
				} else {
					delete html.dataset.chatCue;
				}

				themeScene.cue(cue);
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
	}

	return appCues;
}
