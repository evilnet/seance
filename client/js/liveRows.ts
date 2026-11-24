/**
 * Live rows (docs/resources/themes.md § Live rows): a theme's way to tell a
 * line that just arrived from one it is drawing again. A live line in the open
 * conversation (someone else's message, mention, join, part, quit, a kick, or
 * our own line as the server confirms it) is noted here by id as it is
 * inserted (`socket-events/msg.ts`); the chat list's row for it takes the note
 * once, when it mounts, and carries it as `data-live="<kind>"` for a theme's
 * CSS to select on. A status line folded into a condensed group has no row of
 * its own: the group's row takes its note (MessageCondensed.vue). A reaction
 * arriving live is noted the same way by message id and text
 * (`socket-events/msg_updates.ts`) and taken by its chip (MessageReactions.vue,
 * `data-arrived`). Nothing else is ever marked: history, catch-up, placed
 * lines, notices rerouted into the open window, edits, pending copies, lines
 * buffered behind a past view, status lines under hidden status messages, or
 * anything while the page is hidden. The row drops the attribute LIVE_HOLD_MS
 * after it takes the note.
 *
 * Rows are keyed by message id, but every row is mounted again when the open
 * conversation changes or a past view closes (a status-message setting change
 * regroups the status rows), so a flag stored on the message would replay its animation on each
 * of those. A note here is consumed by the first mount and only honoured
 * within LIVE_MS of the line's arrival, so a row that mounts later (behind a
 * past view, under hidden status messages) never animates. Non-reactive and
 * DOM-free, so mocha loads it.
 *
 * A mention elsewhere (a conversation that is not the open one) is not a row:
 * it is a deadline on the conversation, swept like its activity pulse
 * (helpers/activityPulse.ts `noteMention`).
 */

import {MessageType} from "../../shared/types/msg";

export type LiveKind = "message" | "mention" | "self" | "join" | "part" | "quit" | "kick";

/** A reaction's chip arriving live: the message's first, another chip, or
 * another nick on a chip already shown. */
export type ArrivalKind = "first" | "new" | "more";

/** How long after its arrival a line's row may still claim the note. */
export const LIVE_MS = 1000;

/** How long a row keeps `data-live` after it mounts (Message.vue), a chip
 * `data-arrived` and a sidebar row `data-mentioned`: a fixed time, the most
 * an arrival animation keyed on them may run. */
export const LIVE_HOLD_MS = 3000;

/** What a message arriving in the open conversation is, if anything. */
export function liveKindOf(msg: {
	type?: MessageType;
	self?: boolean;
	highlight?: boolean;
	pending?: boolean;
	editOf?: string;
}): LiveKind | null {
	if (msg.pending || msg.editOf) {
		return null;
	}

	switch (msg.type) {
		case MessageType.MESSAGE:
		case MessageType.ACTION:
			// Our own line as the server confirms it: the echo that replaces a
			// pending copy, or the line itself without echo-message. The
			// message's own highlight, not the row's `.highlight`, which also
			// follows the highlightMessages setting and the focus.
			return msg.self ? "self" : msg.highlight ? "mention" : "message";
		// A kick's `self` is the kicker: someone leaves either way.
		case MessageType.KICK:
			return "kick";
		// Our own join, part or quit is the window's, not someone arriving.
		case MessageType.JOIN:
			return msg.self ? null : "join";
		case MessageType.PART:
			return msg.self ? null : "part";
		case MessageType.QUIT:
			return msg.self ? null : "quit";
		default:
			return null;
	}
}

/** What `nick` adding reaction `text` does to a message's chips, if anything
 * (null: a removal, or a nick already on that chip). */
export function reactionArrival(
	reactions: readonly {text: string; nicks: readonly string[]}[] | undefined,
	text: string,
	nick: string,
	remove: boolean
): ArrivalKind | null {
	if (remove) {
		return null;
	}

	if (!reactions?.length) {
		return "first";
	}

	const chip = reactions.find((r) => r.text === text);

	if (!chip) {
		return "new";
	}

	const lower = nick.toLowerCase();
	return chip.nicks.some((n) => n.toLowerCase() === lower) ? null : "more";
}

/** A chip's note key: its message and its text. */
export const chipKey = (id: number, text: string) => `${id} ${text}`;

export interface LiveRows<K = number, V = LiveKind> {
	/** Note that the line (or chip) with this key just arrived live. */
	mark(id: K, kind: V): void;
	/** The note for this key, at most once, and only while it is fresh. */
	take(id: K): V | null;
}

export function createLiveRows<K = number, V = LiveKind>(now: () => number): LiveRows<K, V> {
	const notes = new Map<K, {kind: V; at: number}>();

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

/** Reactions' chips, by {@link chipKey}. */
export const liveChips = createLiveRows<string, ArrivalKind>(() => performance.now());
