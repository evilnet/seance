/**
 * Live rows (docs/resources/themes.md § Live rows): a theme's way to tell a
 * line that just arrived from one it is drawing again. Someone else's live
 * message, mention or join in the open conversation is noted here by id as it
 * is inserted (`socket-events/msg.ts`); the chat list's row for it takes the
 * note once, when it mounts, and carries it as `data-live="message|mention|join"`
 * for a theme's CSS to select on. Nothing else is ever marked: history,
 * catch-up, placed lines, notices rerouted into the open window, edits, pending
 * copies, our own lines, lines buffered behind a past view, joins under hidden
 * status messages, or anything while the page is hidden. The row drops the
 * attribute once LIVE_MS has passed and its animations have finished.
 *
 * Rows are keyed by message id, but every row is mounted again when the open
 * conversation changes, a past view closes or the status-message setting
 * changes, so a flag stored on the message would replay its animation on each
 * of those. A note here is consumed by the first mount and only honoured
 * within LIVE_MS of the line's arrival, so a row that mounts later (behind a
 * past view, under hidden status messages, folded into a condensed group)
 * never animates. Non-reactive and DOM-free, so mocha loads it.
 */

import {MessageType} from "../../shared/types/msg";

export type LiveKind = "message" | "mention" | "join";

/** How long after its arrival a line's row may still claim the note. */
export const LIVE_MS = 1000;

/** The longest a row keeps `data-live` after it mounts, for a theme's
 * animation on it to finish (Message.vue); an endless one is cut here. */
export const LIVE_HOLD_MAX_MS = 10000;

/** What a message arriving in the open conversation is, if anything. */
export function liveKindOf(msg: {
	type?: MessageType;
	self?: boolean;
	highlight?: boolean;
	pending?: boolean;
	editOf?: string;
}): LiveKind | null {
	if (msg.self || msg.pending || msg.editOf) {
		return null;
	}

	switch (msg.type) {
		case MessageType.JOIN:
			return "join";
		case MessageType.MESSAGE:
		case MessageType.ACTION:
			// The message's own highlight, not the row's `.highlight`, which
			// also follows the highlightMessages setting and the focus.
			return msg.highlight ? "mention" : "message";
		default:
			return null;
	}
}

export interface LiveRows {
	/** Note that the line with this id just arrived live. */
	mark(id: number, kind: LiveKind): void;
	/** The note for this id, at most once, and only while it is fresh. */
	take(id: number): LiveKind | null;
}

export function createLiveRows(now: () => number): LiveRows {
	const notes = new Map<number, {kind: LiveKind; at: number}>();

	const prune = (t: number) => {
		for (const [id, note] of notes) {
			if (t - note.at > LIVE_MS) {
				notes.delete(id);
			}
		}
	};

	return {
		mark(id, kind) {
			const t = now();
			prune(t);
			notes.set(id, {kind, at: t});
		},
		take(id) {
			const note = notes.get(id);

			if (!note) {
				return null;
			}

			notes.delete(id);
			return now() - note.at <= LIVE_MS ? note.kind : null;
		},
	};
}

export const liveRows = createLiveRows(() => performance.now());
