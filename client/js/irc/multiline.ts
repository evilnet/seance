/**
 * `draft/multiline` (https://ircv3.net/specs/extensions/multiline).
 *
 * A multi-line message travels as a `BATCH … draft/multiline <target>` whose
 * lines are ordinary `PRIVMSG`/`NOTICE`s: they are joined with `\n`, except
 * where a line carries {@link CONCAT_TAG}, which glues it to the previous one
 * with no separator (that is how a paragraph longer than the line budget is
 * split). One batch is one message: one msgid, one timeline entry.
 *
 * Sending is paced: the server charges a cooldown per delivered batch and
 * drops one opened inside it, so batches go out one at a time and a cooldown
 * re-sends rather than loses them (see {@link MultilineQueue}).
 *
 * This module is store- and DOM-free (it runs under mocha).
 */

import {t} from "../i18n/core";
import {MessageType} from "../../../shared/types/msg";
import type {IrcClient} from "./client";
import {BatchHandler, OpenBatch, openBatchesOf} from "./handlers/batch";
import {splitStatusTarget} from "./handlers/privmsg";
import {formatLine, IrcMessage, IrcSource, MAX_LINE_BYTES, utf8ByteLength} from "./message";
import {armPending, pendingLabel, PendingMessage, settlePending, showPending} from "./pending";
import {ClientTags, EDIT_TAG, REPLY_TAG, trailingLine} from "./wire";

/** The capability name, whose CAP 302 value carries the limits. */
export const MULTILINE_CAP = "draft/multiline";
/** Tag on a line that continues the previous one without a line feed. */
export const CONCAT_TAG = "draft/multiline-concat";

/**
 * Bytes the tags of a line inside a batch take: `batch` plus, at worst,
 * {@link CONCAT_TAG}. The reference is budgeted at ten characters, well past
 * what {@link IrcClient.nextBatchRef} needs. Inside a batch that is *all* the
 * tags there may be — the draft puts the message's own tags on the opener.
 */
export const CONCAT_LINE_TAG_BYTES = `@batch=0123456789;${CONCAT_TAG} `.length;

/** What one batch may carry, from the cap's 302 value. */
export type MultilineLimits = {
	/** Maximum total byte length of the joined message. */
	maxBytes: number;
	/**
	 * Maximum number of `PRIVMSG`/`NOTICE` lines in one batch, or `Infinity`
	 * when the server named none: the draft makes `max-lines` RECOMMENDED,
	 * not REQUIRED, so only `max-bytes` bounds such a batch.
	 */
	maxLines: number;
};

/** A positive integer token value, or undefined for anything else. */
function positiveInt(value: string | undefined): number | undefined {
	if (value === undefined || !/^\d+$/.test(value)) {
		return undefined;
	}

	const n = Number(value);
	return n > 0 ? n : undefined;
}

/**
 * `"max-bytes=16384,max-lines=100"` → the limits. `max-bytes` is REQUIRED by
 * the draft: without a usable one the server cannot tell us what it accepts
 * and the cap is treated as absent. `max-lines` is only RECOMMENDED, so a
 * missing (or unusable) one means "no line limit". Unknown tokens are
 * ignored, as future ones must be.
 */
export function parseMultilineValue(value: string | undefined): MultilineLimits | undefined {
	if (!value) {
		return undefined;
	}

	const tokens = new Map<string, string>();

	for (const token of value.split(",")) {
		const eq = token.indexOf("=");

		if (eq !== -1) {
			tokens.set(token.slice(0, eq), token.slice(eq + 1));
		}
	}

	const maxBytes = positiveInt(tokens.get("max-bytes"));

	if (maxBytes === undefined) {
		return undefined;
	}

	return {maxBytes, maxLines: positiveInt(tokens.get("max-lines")) ?? Infinity};
}

/** `nick!user@host`, as much of it as the line carried. */
function sourceString(source: IrcSource | undefined): string {
	if (!source) {
		return "";
	}

	return `${source.name}${source.user ? `!${source.user}` : ""}${
		source.host ? `@${source.host}` : ""
	}`;
}

const ACTION_PREFIX = "\x01ACTION ";

/** `\x01ACTION x\x01` framing, stripped from one line of an action batch. */
function unwrapAction(text: string): string {
	let body = text;

	if (body.startsWith(ACTION_PREFIX)) {
		body = body.slice(ACTION_PREFIX.length);
	} else if (body === "\x01ACTION") {
		body = "";
	}

	return body.endsWith("\x01") ? body.slice(0, -1) : body;
}

/** What one multiline batch says, as a single `PRIVMSG`/`NOTICE` would say it. */
export interface JoinedMultiline {
	command: "PRIVMSG" | "NOTICE";
	target: string;
	text: string;
	/** `nick!user@host` of the first line. */
	source: string;
}

/**
 * Join a multiline batch's buffered lines, or undefined when the batch is
 * malformed and its lines have to be shown one by one: the spec allows only
 * `PRIVMSG` lines or only `NOTICE` lines, all to the batch's target.
 *
 * An action is framed per line on the wire (`\x01ACTION …\x01`); joining
 * the raw parameters would leave `\x01`s in the middle of the text, so the
 * framing is stripped from every line and put back around the joined text.
 * That also accepts a sender that framed only the first and last line.
 *
 * `casefold` compares the lines' targets the way the network does (the
 * batch handler passes the client's); the default compares them literally.
 */
export function joinMultiline(
	lines: IrcMessage[],
	casefold: (s: string) => string = (s) => s
): JoinedMultiline | undefined {
	const first = lines[0];

	if (!first || (first.command !== "PRIVMSG" && first.command !== "NOTICE")) {
		return undefined;
	}

	const command = first.command;
	const target = first.params[0] ?? "";
	const action = (first.params[1] ?? "").startsWith(ACTION_PREFIX);
	let text = "";

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		if (line.command !== command || casefold(line.params[0] ?? "") !== casefold(target)) {
			return undefined;
		}

		const body = line.params[1] ?? "";

		if (i > 0 && !line.tags.has(CONCAT_TAG)) {
			text += "\n";
		}

		text += action ? unwrapAction(body) : body;
	}

	return {
		command,
		target,
		text: action ? `${ACTION_PREFIX}${text}\x01` : text,
		source: sourceString(first.source),
	};
}

/** Hand `lines` on: into the enclosing batch while it is open, else live. */
function passOn(client: IrcClient, batch: OpenBatch, lines: IrcMessage[]): void {
	if (batch.parent && openBatchesOf(client).get(batch.parent.ref) === batch.parent) {
		// Keep the batch's position in the parent (a chathistory page, a
		// labeled response, the bouncer's replay); it is unwrapped there.
		batch.parent.messages.push(...lines);
		return;
	}

	for (const line of lines) {
		// The batch is closed, so the line is not intercepted again.
		client.handleMessage(line);
	}
}

/**
 * A closed `draft/multiline` batch: one synthetic `PRIVMSG`/`NOTICE` with the
 * joined text, carrying the opener's tags (msgid, time, `+draft/reply`,
 * `+seance/edit`, …) and the first line's source, run through the ordinary
 * handlers so CTCP, highlights, replies and edits all see the whole message.
 * A malformed batch falls back to its lines, one by one, as an unhandled
 * batch type would. The handler is registered whether or not the cap was
 * negotiated: what the server sends, the server sends.
 */
export const multilineBatch: BatchHandler = (client, batch) => {
	const joined = joinMultiline(batch.messages, (s) => client.casefold(s));
	const target = batch.params[0] ?? "";

	// The lines must address the batch's target. An opener without one is
	// malformed too, but the lines still agree on a target: take theirs.
	if (!joined || (target !== "" && client.casefold(target) !== client.casefold(joined.target))) {
		passOn(client, batch, batch.messages);
		return;
	}

	const tags = new Map(batch.tags);
	// `batch` names the parent, which the synthetic message is not part of.
	tags.delete("batch");

	// The draft puts the message's own tags on the opener, but a server that
	// tags the first line instead (the shape of its non-multiline fallback)
	// must not leave the message without a msgid, a time or an account.
	for (const key of ["msgid", "time", "account"]) {
		const value = batch.messages[0].tags.get(key);

		if (value !== undefined && !tags.has(key)) {
			tags.set(key, value);
		}
	}

	// Our own batch coming back live is the server saying it took it, so the
	// next one of the message may go out (a nested batch is history, not an
	// echo).
	const from = batch.messages[0].source;

	if (!batch.parent && from && client.isSelf(from.name)) {
		multilineAccepted(client);
	}

	const prefix = joined.source ? `:${joined.source} ` : "";

	passOn(client, batch, [
		{
			tags,
			source: batch.messages[0].source,
			command: joined.command,
			params: [joined.target, joined.text],
			// Not a line that could have been received (the text has newlines
			// in it); it exists for diagnostics.
			raw: `${prefix}${joined.command} ${joined.target} :${joined.text}`,
		},
	]);
};

/** One `PRIVMSG`/`NOTICE` inside a batch: `concat` continues the line before it. */
export type MultilineLine = {text: string; concat: boolean};

/** A planned multi-line message: one inner array per batch, one batch per message. */
export type MultilinePlan = MultilineLine[][];

/**
 * Split one paragraph into chunks of at most `budget` bytes, leaving the
 * space a break lands on at the **end** of the chunk. That is the draft's
 * recommended method ("leave the space character at the end of the line"),
 * and the only one under which concatenating the chunks reproduces the
 * paragraph byte for byte — `splitMessage` drops the whitespace run around
 * the break instead, which is right for separate lines and wrong here.
 */
function splitConcat(text: string, budget: number): string[] {
	const chunks: string[] = [];
	let start = 0;

	while (start < text.length) {
		let pos = start;
		let bytes = 0;
		// Index just past the last space that still fits.
		let afterSpace = -1;

		while (pos < text.length) {
			const cp = text.codePointAt(pos) as number;
			const units = cp > 0xffff ? 2 : 1;
			const size = utf8ByteLength(text.slice(pos, pos + units));

			if (bytes + size > budget) {
				break;
			}

			bytes += size;
			pos += units;

			if (cp === 0x20 || cp === 0x09) {
				afterSpace = pos;
			}
		}

		if (pos >= text.length) {
			chunks.push(text.slice(start));
			break;
		}

		if (pos === start) {
			// One character does not fit the budget; emit it rather than spin.
			pos = start + ((text.codePointAt(start) as number) > 0xffff ? 2 : 1);
		}

		const end = afterSpace > start ? afterSpace : pos;
		chunks.push(text.slice(start, end));
		start = end;
	}

	return chunks;
}

/**
 * Plan `text` as `draft/multiline` batches.
 *
 * Every line feed starts a new line; a paragraph longer than the line budget
 * (`MAX_LINE_BYTES - prefixBytes`, never more than one message's `max-bytes`)
 * is split into {@link CONCAT_TAG} chunks.
 * The lines are then packed into batches under the server's `max-lines` and
 * `max-bytes` — which count the message bodies (`bodyOverhead` is what each
 * body carries beyond its text, i.e. the `\x01ACTION …\x01` framing) plus one
 * byte per joining line feed. Each batch is one message, so a text too big
 * for one batch arrives as consecutive messages.
 *
 * Trailing blank lines are dropped: they are invisible, and the draft forbids
 * a message that is nothing but blank lines (which then plans as no batch at
 * all). Blank lines inside the message are kept — those are content.
 * `\r` and NUL cannot go on the wire and become spaces.
 *
 * Throws `RangeError` when the prefix leaves no room for text at all.
 */
export function planMultiline(
	text: string,
	prefixBytes: number,
	limits: MultilineLimits,
	bodyOverhead = 0
): MultilinePlan {
	// A line must fit the frame *and* the whole message must fit `max-bytes`:
	// a chunk larger than the latter could never be sent at all.
	const budget = Math.min(MAX_LINE_BYTES - prefixBytes, limits.maxBytes - bodyOverhead);

	if (budget <= 0) {
		throw new RangeError(
			t("multiline.noRoom", {prefix: prefixBytes, maxBytes: limits.maxBytes})
		);
	}

	const paragraphs = text
		.replace(/\r\n/g, "\n")
		.replace(/[\r\0]/g, " ")
		.split("\n");

	while (paragraphs.length > 0 && paragraphs[paragraphs.length - 1] === "") {
		paragraphs.pop();
	}

	const lines: MultilineLine[] = [];

	for (const paragraph of paragraphs) {
		if (utf8ByteLength(paragraph) <= budget) {
			lines.push({text: paragraph, concat: false});
			continue;
		}

		for (const [i, chunk] of splitConcat(paragraph, budget).entries()) {
			lines.push({text: chunk, concat: i > 0});
		}
	}

	const plan: MultilinePlan = [];
	let batch: MultilineLine[] = [];
	let bytes = 0;

	for (const line of lines) {
		const size = utf8ByteLength(line.text) + bodyOverhead;
		const feed = batch.length > 0 && !line.concat ? 1 : 0;

		if (
			batch.length > 0 &&
			(batch.length >= limits.maxLines || bytes + feed + size > limits.maxBytes)
		) {
			plan.push(batch);
			batch = [];
			bytes = 0;
		}

		if (batch.length === 0) {
			// The first line of a batch starts a message: it continues nothing.
			// (A single line over `max-bytes` goes out anyway — the server's
			// FAIL is a better answer than dropping the message here.)
			batch.push({text: line.text, concat: false});
			bytes = size;
		} else {
			batch.push(line);
			bytes += feed + size;
		}
	}

	if (batch.length > 0) {
		plan.push(batch);
	}

	return plan;
}

/** The text one planned batch stands for, joined as a receiver joins it. */
function joinPlan(batch: MultilineLine[]): string {
	return batch.map((line, i) => (i > 0 && !line.concat ? `\n${line.text}` : line.text)).join("");
}

// -------------------------------------------------------------- the pacer

/**
 * How long a batch on the wire waits for the server's verdict.
 *
 * With `echo-message` the batch comes back when it is delivered, so this is
 * only a safety net for an echo that never arrives. Without it a delivered
 * batch says nothing at all, and silence for a settle period is the only
 * "it went through" there is.
 */
export const MULTILINE_VERDICT_MS = 30000;
/** @see {@link MULTILINE_VERDICT_MS} — the same wait, without `echo-message`. */
export const MULTILINE_SETTLE_MS = 1500;
/** Longest cooldown a message is held for rather than reported as failed. */
export const MULTILINE_MAX_COOLDOWN_MS = 120000;

/**
 * The server charges a cooldown for every multiline batch it delivers and
 * *drops the opener* of a batch begun inside that window while still
 * delivering that batch's lines as standalone messages (so they duplicate,
 * and blank ones draw `ERR_NOTEXTTOSEND`, and the closer draws
 * `FAIL BATCH NO_ACTIVE_BATCH`). The echo of the previous batch comes back
 * long before its cooldown ends, so pacing the next batch on the echo alone
 * is not enough: {@link batchCooldownMs} waits out the cooldown too.
 *
 * The formula is `nefarious2`'s `multiline_apply_cooldown` (`ircd/m_batch.c`)
 * read verbatim: `(MULTILINE_COOLDOWN_BASE + total_bytes/128) * discount/100`
 * seconds, where `total_bytes` is each line's body plus one byte per newline
 * joining a non-continued line to the one before it, and `discount` is the
 * `MULTILINE_COOLDOWN_DISCOUNT` feature — 0-100, default 50. Since the
 * discount is at most 100, the *undiscounted* figure is an upper bound on the
 * cooldown for any server, whatever its discount; a second of margin covers
 * the whole-second rounding on the server's side.
 */
const MULTILINE_COOLDOWN_BASE_S = 2;
/** `MULTILINE_COOLDOWN_BYTES_PER_SEC` in `ircd/m_batch.c`. */
const MULTILINE_COOLDOWN_BYTES_PER_SEC = 128;
/** Margin on the estimated cooldown, for the server's whole-second rounding. */
const MULTILINE_PACE_MARGIN_MS = 1000;

/** A safe upper bound (ms) on the server's cooldown after delivering `batch`. */
export function batchCooldownMs(batch: {lines: MultilineLine[]; action: boolean}): number {
	// `total_bytes` exactly as the server counts it (m_batch.c L850): each
	// line's body, plus one byte for the newline joining a non-continued line
	// to the one before it. An action's body carries its `\x01ACTION …\x01`.
	let bytes = 0;

	batch.lines.forEach((line, i) => {
		const body = utf8ByteLength(line.text) + (batch.action ? ACTION_PREFIX.length + 1 : 0);
		const feed = i > 0 && !line.concat ? 1 : 0;
		bytes += body + feed;
	});

	return (
		Math.ceil((MULTILINE_COOLDOWN_BASE_S + bytes / MULTILINE_COOLDOWN_BYTES_PER_SEC) * 1000) +
		MULTILINE_PACE_MARGIN_MS
	);
}

/** A planned batch, and everything needed to put it on the wire again. */
interface SentBatch {
	target: string;
	command: "PRIVMSG" | "NOTICE";
	lines: MultilineLine[];
	tags: ClientTags;
	action: boolean;
	/** Its local echo has been shown already (no `echo-message`). */
	shown: boolean;
	/** `labeled-response` label on the opener, so the echo settles {@link pending}. */
	label?: string;
	/** The copy shown while the server has not taken it (with `echo-message`). */
	pending?: PendingMessage;
}

/**
 * One batch at a time, per client.
 *
 * nefarious2 charges a cooldown for every multiline batch it delivers —
 * `(2 + bytes/128) x MULTILINE_COOLDOWN_DISCOUNT` seconds, so at least one
 * even for a short one — and answers a batch opened inside that window with
 * `FAIL BATCH MULTILINE_COOLDOWN <seconds>`, dropping it whole
 * (`ircd/m_batch.c`). A plan of several batches put on the wire in one flush
 * would therefore lose everything after the first, and so would a second
 * message typed a moment after the first.
 *
 * So a batch goes out only once the one before it has been answered, and a
 * cooldown puts it back at the front of the queue for the seconds the server
 * named: the message is late, never lost.
 */
interface MultilineQueue {
	/** On the wire, waiting for the server's verdict. */
	inFlight: SentBatch | null;
	/** Planned and not sent yet, in order. */
	waiting: SentBatch[];
	/** Verdict timer for {@link inFlight}. */
	verdict: ReturnType<typeof setTimeout> | null;
	/** Cooldown re-send timer (a `MULTILINE_COOLDOWN` FAIL); nothing goes out while it runs. */
	retry: ReturnType<typeof setTimeout> | null;
	/**
	 * Proactive pacing timer: after a delivered batch, the next one waits out
	 * that batch's server-side cooldown ({@link batchCooldownMs}) so its opener
	 * is never dropped mid-cooldown. Nothing goes out while it runs.
	 */
	pace: ReturnType<typeof setTimeout> | null;
}

const queues = new WeakMap<IrcClient, MultilineQueue>();

function queueOf(client: IrcClient): MultilineQueue {
	let queue = queues.get(client);

	if (!queue) {
		queue = {inFlight: null, waiting: [], verdict: null, retry: null, pace: null};
		queues.set(client, queue);
	}

	return queue;
}

/**
 * Queue `plan` and start it: one `BATCH +<ref> draft/multiline <target>` per
 * inner array, its lines tagged `batch` (and {@link CONCAT_TAG}), then
 * `BATCH -<ref>`. `openerTags` are the client-only tags every batch carries
 * (a reply reference applies to each of them); `firstOpenerTags` are the ones
 * only the first batch may carry (`+seance/edit` replaces *one* message, so
 * a plan that needs several batches must not claim to replace it several
 * times). The draft requires those tags on the opener and forbids any tag but
 * `batch`/`concat` on the lines. An action is framed per line, which is what
 * nefarious2 relays verbatim and what a client without the cap sees as one
 * action per line.
 *
 * Only the first batch goes out now; the rest follow as the server answers
 * for the one before them (see {@link MultilineQueue}). Without
 * `echo-message` each batch is fed back through the handlers as one joined
 * message, as the single-line path does.
 */
export function sendMultiline(
	client: IrcClient,
	target: string,
	command: "PRIVMSG" | "NOTICE",
	plan: MultilinePlan,
	openerTags: ClientTags,
	action: boolean,
	firstOpenerTags: ClientTags = {}
): void {
	const queue = queueOf(client);
	// With `echo-message` every batch shows as a pending copy from the
	// start — the ones queued behind the first included, since to the user
	// they are one message — and is armed when it goes out (transmit).
	const echo = client.caps.hasCapability("echo-message");
	const chan = echo ? client.findChannel(splitStatusTarget(client, target).target) : undefined;
	const type =
		command === "NOTICE"
			? MessageType.NOTICE
			: action
			? MessageType.ACTION
			: MessageType.MESSAGE;

	for (const [index, lines] of plan.entries()) {
		const tags = index === 0 ? {...firstOpenerTags, ...openerTags} : openerTags;
		const batch: SentBatch = {
			target,
			command,
			lines,
			tags,
			action,
			shown: false,
			label: echo ? pendingLabel(client) : undefined,
		};

		if (chan) {
			batch.pending = showPending(
				client,
				chan,
				{
					type,
					text: joinPlan(lines),
					label: batch.label,
					replyTo: tags[REPLY_TAG],
					editOf: tags[EDIT_TAG],
					statusmsgGroup: splitStatusTarget(client, target).group,
				},
				{arm: false}
			);
		}

		queue.waiting.push(batch);
	}

	pump(client);
}

/** Put the next batch on the wire, if one may go now. */
function pump(client: IrcClient): void {
	const queue = queueOf(client);

	if (queue.inFlight || queue.retry || queue.pace || queue.waiting.length === 0) {
		return;
	}

	const batch = queue.waiting.shift() as SentBatch;

	if (!transmit(client, batch)) {
		// The transport is gone and `send` has reported it; the rest of the
		// message goes with it.
		resetMultiline(client);
	}
}

/** Write one batch out and start waiting for the server's answer. */
function transmit(client: IrcClient, batch: SentBatch): boolean {
	const queue = queueOf(client);
	const ref = client.nextBatchRef();
	const opener = formatLine({
		tags: batch.label ? {...batch.tags, label: batch.label} : batch.tags,
		command: "BATCH",
		params: [`+${ref}`, MULTILINE_CAP, batch.target],
	});

	if (!client.send(opener)) {
		return false;
	}

	for (const line of batch.lines) {
		const lineTags: ClientTags = {batch: ref};

		if (line.concat) {
			lineTags[CONCAT_TAG] = "";
		}

		const body = batch.action ? `${ACTION_PREFIX}${line.text}\x01` : line.text;

		if (!client.send(trailingLine(batch.command, [batch.target, body], lineTags))) {
			return false;
		}
	}

	if (!client.send(formatLine({command: "BATCH", params: [`-${ref}`]}))) {
		return false;
	}

	const echo = client.caps.hasCapability("echo-message");

	queue.inFlight = batch;
	queue.verdict = setTimeout(
		() => {
			// Nothing came back: without `echo-message` that is what delivery
			// looks like, and with it the echo was lost. Either way, treat the
			// batch as delivered and pace what comes after it.
			queue.verdict = null;
			queue.inFlight = null;
			paceAfter(client, batch);
		},
		echo ? MULTILINE_VERDICT_MS : MULTILINE_SETTLE_MS
	);

	if (batch.pending) {
		armPending(client, batch.pending); // (again, for a re-sent batch)
	}

	// A re-sent batch has been on screen since its first attempt.
	if (!echo && !batch.shown) {
		batch.shown = true;

		const text = joinPlan(batch.lines);
		const body = batch.action ? `${ACTION_PREFIX}${text}\x01` : text;

		client.handleMessage({
			tags: new Map(Object.entries(batch.tags)),
			source: {name: client.nick, user: client.ident, host: client.host || "localhost"},
			command: batch.command,
			params: [batch.target, body],
			// Not a line that could have been received (the text has line
			// feeds in it); it exists for diagnostics.
			raw: `${batch.command} ${batch.target} :${body}`,
		});
	}

	return true;
}

/** Take the batch off the wire; the caller decides what becomes of it. */
function settle(client: IrcClient): SentBatch | null {
	const queue = queueOf(client);
	const batch = queue.inFlight;

	if (queue.verdict) {
		clearTimeout(queue.verdict);
	}

	queue.verdict = null;
	queue.inFlight = null;

	return batch;
}

/**
 * Our own batch came back, so the server took it: the next one may go out.
 * Called from {@link multilineBatch} for a live echo of ours — a nested batch
 * is history, not an echo.
 */
export function multilineAccepted(client: IrcClient): void {
	const batch = settle(client);

	if (batch) {
		paceAfter(client, batch);
	} else {
		pump(client);
	}
}

/**
 * Hold whatever goes out next — the next batch of this message, or the first
 * batch of a message sent moments later — for `batch`'s server-side cooldown,
 * timed from its *delivery* (this is called from the echo, or the verdict
 * timeout that stands in for it). The gate outlives the queue, so the cooldown
 * a delivered batch leaves behind is not walked into by the next message; and
 * timing it from delivery, not from the send, is what keeps it right once the
 * server throttles and delivers a batch long after we sent it.
 */
function paceAfter(client: IrcClient, batch: SentBatch): void {
	const queue = queueOf(client);

	if (queue.pace) {
		clearTimeout(queue.pace);
	}

	queue.pace = setTimeout(() => {
		queue.pace = null;
		pump(client);
	}, batchCooldownMs(batch));
}

/**
 * `FAIL BATCH MULTILINE_COOLDOWN <seconds>`: the server dropped the batch
 * whole because it is still cooling down from the one before it. Put it back
 * at the front of the queue and send it again once the cooldown is over.
 *
 * False when there is nothing on the wire this could be about, or the wait is
 * too long to sit on quietly — then the failure is reported like any other.
 */
export function multilineCooldown(client: IrcClient, seconds: number): boolean {
	const queue = queueOf(client);

	// This batch was not delivered, so its estimated cooldown does not apply;
	// the server's named wait replaces it.
	if (queue.pace) {
		clearTimeout(queue.pace);
		queue.pace = null;
	}

	const batch = settle(client);

	if (!batch) {
		return false;
	}

	if (seconds * 1000 > MULTILINE_MAX_COOLDOWN_MS) {
		// Do not leave the rest of the message queued behind a batch that is
		// not going out.
		resetMultiline(client);
		return false;
	}

	queue.waiting.unshift(batch);
	// The server counts in whole seconds, so the one it names has already
	// partly elapsed: a second of margin saves a wasted round trip.
	queue.retry = setTimeout(() => {
		queue.retry = null;
		pump(client);
	}, (Math.max(seconds, 0) + 1) * 1000);

	return true;
}

/**
 * Any other `FAIL BATCH MULTILINE_…`: the batch was dropped for a reason
 * waiting will not mend, so the rest of the message goes with it rather than
 * arriving on its own with the middle missing.
 */
export function multilineRejected(client: IrcClient): void {
	resetMultiline(client);
}

/**
 * Drop everything queued and on the wire (the transport closed, or the
 * server rejected the batch and the failure is reported by the caller).
 * The pending copies come down without a word of their own: on a close
 * `IrcClient` has already reported them, and a `FAIL` is shown once.
 */
export function resetMultiline(client: IrcClient): void {
	const queue = queueOf(client);

	if (queue.verdict) {
		clearTimeout(queue.verdict);
	}

	if (queue.retry) {
		clearTimeout(queue.retry);
	}

	if (queue.pace) {
		clearTimeout(queue.pace);
	}

	for (const batch of [queue.inFlight, ...queue.waiting]) {
		if (batch?.pending) {
			settlePending(client, batch.pending);
		}
	}

	queue.verdict = null;
	queue.retry = null;
	queue.pace = null;
	queue.inFlight = null;
	queue.waiting.length = 0;
}
