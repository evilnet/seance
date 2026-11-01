// Which incoming messages the reading pipeline considers (spec § Reading
// pipeline, 1): anyone's, the user's own included, not pending, a chat type, and any
// word once formatting, Markdown, URLs, code, emoji, channel names and nick
// mentions are gone (`plainTextOf`, which is also what the detector sees)
// -- however old: reading covers what is in the channel, not only what
// arrives after the switch. History -- a join's fill, a replay or catch-up,
// a "load more", the requeue of a switch-on or a language change -- is
// bounded here as well: newest first, `HISTORY_QUEUE_CAP` per load. Vue-free.

import {stripFormatting, stripMarkdown} from "../push/strip";
import {CHANNEL_RX} from "./spans";

export const MIN_WORDS = 1;

/**
 * How many of a channel's history lines one load may queue. A "load more",
 * a join's fill, one replay or catch-up batch and the requeue of a switch-on
 * are each held to this, so scrolling back through a year does not queue a
 * year: what is over the cap is left untranslated until the reader asks for
 * one of those lines by hand.
 */
export const HISTORY_QUEUE_CAP = 40;

/**
 * The lines of a loaded history page the pipeline considers, newest first:
 * the reader is looking at the newest of what just arrived, so those are
 * queued first and the oldest of an over-long page are not queued at all.
 */
export function historyQueueOrder<T>(messages: readonly T[], cap = HISTORY_QUEUE_CAP): T[] {
	if (cap <= 0) {
		return [];
	}

	return messages.slice(-cap).reverse();
}

/**
 * Replayed lines grouped into the load that brought them. A catch-up or a
 * bouncer replay reaches the reader one `msg` at a time, but a whole batch
 * is delivered in one synchronous run (irc/history.ts `deliverAppend`) and
 * the bus dispatches synchronously, so the lines a channel receives before
 * the scheduled flush runs are one batch. The flush gets them newest first
 * and capped (`historyQueueOrder`); the next batch starts a fresh count, with
 * no live line needed in between.
 */
export class ReplayBatches<T> {
	private readonly pending = new Map<number, T[]>();
	private readonly flush: (chanId: number, newestFirst: T[]) => void;
	private readonly schedule: (fn: () => void) => void;
	private readonly cap: number;

	constructor(
		flush: (chanId: number, newestFirst: T[]) => void,
		schedule: (fn: () => void) => void = (fn) => queueMicrotask(fn),
		cap = HISTORY_QUEUE_CAP
	) {
		this.flush = flush;
		this.schedule = schedule;
		this.cap = cap;
	}

	add(chanId: number, line: T): void {
		const open = this.pending.get(chanId);

		if (open) {
			open.push(line);
			return;
		}

		const batch = [line];

		this.pending.set(chanId, batch);
		this.schedule(() => {
			// Dropped (a part, a switch) or replaced since: nothing to flush.
			if (this.pending.get(chanId) !== batch) {
				return;
			}

			this.pending.delete(chanId);
			this.flush(chanId, historyQueueOrder(batch, this.cap));
		});
	}

	/** Forget a channel's unflushed lines. */
	drop(chanId: number): void {
		this.pending.delete(chanId);
	}
}

export interface EligibilityMsg {
	type?: string;
	self?: boolean;
	pending?: boolean;
	text?: string;
}

const CHAT_TYPES = new Set(["message", "action", "notice"]);

/**
 * A line someone said, as opposed to the channel's own bookkeeping (a join,
 * a mode, a topic). The pipeline's counter of what the channel has said
 * since a line was queued (`reader.ts` `arrivals`, which decides whether a
 * translation is still worth finishing) counts these and nothing else: a
 * netsplit's quits are not the conversation moving on.
 */
export function isChatLine(msg: EligibilityMsg): boolean {
	return !!msg.type && CHAT_TYPES.has(msg.type);
}

// A shortcode body must contain at least one letter, but :+1: and :-1: are
// special cases.
const SHORTCODE = /:(?:[+-]1|(?=[a-z0-9_+-]*[a-z])[a-z0-9_+-]{2,}):/gi;

// eslint-disable-next-line no-misleading-character-class
const EMOJI = /[\p{Extended_Pictographic}‍️]/gu;

/** A fenced code block, opener and closer included. */
const FENCE = /^```[\s\S]*?^```[^\n]*$/gm;
/** An unclosed fence: the rest of the message is code all the same. */
const OPEN_FENCE = /^```[\s\S]*$/m;

/**
 * The prose of a line, for the detector and the word count: everything the
 * client treats as syntax rather than language is gone — the IRC formatting
 * bytes, the Markdown markers (through the page's own layout tree, so what
 * the detector reads is what the reader sees), code, URLs, emoji and their
 * shortcodes, the channel names and the channel's own nicknames.
 *
 * The order is the one thing here that is not free. `stripMarkdown`
 * flattens the layout tree to its *text*, so a code span's content survives
 * it — code has to go first, by its backticks, while it still has them. A
 * URL has to go after, because `[see this](https://x.y)` loses its target
 * to the link node and would otherwise lose its text as well.
 */
export function plainTextOf(text: string, nicks: string[]): string {
	const lower = new Set(nicks.map((nick) => nick.toLowerCase()));
	let out = stripFormatting(text)
		.replace(FENCE, " ")
		.replace(OPEN_FENCE, " ")
		.replace(/`[^`\n]+`/g, " ");

	out = stripMarkdown(out)
		.replace(/\bhttps?:\/\/[^\s<>()]+/gi, " ")
		.replace(/\bwww\.[^\s<>()]+/gi, " ")
		.replace(SHORTCODE, " ")
		.replace(EMOJI, " ")
		.replace(CHANNEL_RX, " ");

	out = out
		.split(/\s+/)
		.filter((word) => {
			const bare = word.replace(/[:,]+$/, "").toLowerCase();

			return bare !== "" && !lower.has(bare);
		})
		.join(" ");

	return out.trim();
}

export function wordCount(text: string): number {
	return text
		.split(/\s+/)
		.map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
		.filter((word) => word !== "").length;
}

/**
 * `plain`, when given, is the line's `plainTextOf` already computed: the
 * reader strips a line once and hands the same text to detection, since the
 * strip runs the whole Markdown layout.
 */
export function isEligible(
	msg: EligibilityMsg,
	opts: {nicks: string[]; plain?: () => string}
): boolean {
	// Own lines are read too: a line from before a switch-on, a rejoin or a
	// reload is as much of the channel as anyone's. The one own line the
	// pipeline leaves alone -- a posted translation that keeps its
	// read-back -- is ruled out by its caller (sentReadBack.ts
	// `takesReadBack`), since eligibility cannot see the composer's records.
	if (msg.pending || !msg.type || !CHAT_TYPES.has(msg.type) || !msg.text) {
		return false;
	}

	return wordCount(opts.plain ? opts.plain() : plainTextOf(msg.text, opts.nicks)) >= MIN_WORDS;
}
