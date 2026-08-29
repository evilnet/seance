/**
 * `draft/multiline` (https://ircv3.net/specs/extensions/multiline): several
 * PRIVMSG/NOTICE lines wrapped in a `BATCH … draft/multiline <target>` that
 * both ends treat as **one** message.
 *
 * Inbound, {@link multilineBatch} is the batch handler: it joins the batch's
 * lines with `\n` (a line tagged {@link CONCAT_TAG} is appended without one,
 * which is how a sender splits a body that is too long for a single line)
 * and hands the result on as a single message carrying the opener's tags —
 * `time`, `msgid`, `account` and client tags all live there, not on the
 * inner lines. It emits through `emitBatched`, so a multiline batch nested
 * in a `chathistory` replay stays inside that replay.
 *
 * Outbound, {@link buildMultiline} serialises the batch (see
 * `IrcClient.sendMultiline`). The server only accepts one at a time:
 * nefarious2 charges a cooldown per delivered batch and answers a second
 * one with `FAIL BATCH MULTILINE_COOLDOWN`, so every batch we send is
 * remembered until it is answered and {@link multilineFailed} re-sends it as
 * one message per line — a `FAIL` means the server delivered nothing.
 */

import type {IrcClient, SendMessageOptions} from "./client";
import {
	formatLine,
	formatSource,
	IrcMessage,
	MAX_LINE_BYTES,
	splitMessage,
	utf8ByteLength,
} from "./message";
import {emitBatched, OpenBatch} from "./handlers/batch";
import {ClientTags, tagPrefix, trailingLine} from "./wire";

/** The capability, which is also the batch type. */
export const MULTILINE_CAP = "draft/multiline";
/** On a batch line: append it to the previous one without a newline. */
export const CONCAT_TAG = "draft/multiline-concat";
/** How long a sent batch waits for a `FAIL BATCH` before it is forgotten. */
export const MULTILINE_FAIL_WINDOW_MS = 30000;

/** `max-bytes` / `max-lines` from the CAP 302 value; 0 = not advertised. */
export interface MultilineLimits {
	maxBytes: number;
	maxLines: number;
}

/** Whether a multiline batch can be sent at all (both caps are needed). */
export function canMultiline(client: IrcClient): boolean {
	return client.caps.hasCapability(MULTILINE_CAP) && client.caps.hasCapability("batch");
}

/** Parse `max-bytes=16384,max-lines=100`; unparseable parts mean "no limit". */
export function multilineLimits(client: IrcClient): MultilineLimits {
	const limits: MultilineLimits = {maxBytes: 0, maxLines: 0};

	for (const token of (client.caps.value(MULTILINE_CAP) ?? "").split(",")) {
		const eq = token.indexOf("=");

		if (eq === -1) {
			continue;
		}

		const value = Number.parseInt(token.slice(eq + 1), 10);

		if (!Number.isFinite(value) || value <= 0) {
			continue;
		}

		if (token.slice(0, eq) === "max-bytes") {
			limits.maxBytes = value;
		} else if (token.slice(0, eq) === "max-lines") {
			limits.maxLines = value;
		}
	}

	return limits;
}

// ------------------------------------------------------------------ inbound

/**
 * Join a closed `draft/multiline` batch into one message and emit it where
 * the batch stood. Lines that are not PRIVMSG/NOTICE cannot be part of the
 * message (the spec allows neither); they are passed through unchanged.
 */
export function multilineBatch(client: IrcClient, batch: OpenBatch): void {
	const parts: IrcMessage[] = [];
	const others: IrcMessage[] = [];

	for (const line of batch.messages) {
		(line.command === "PRIVMSG" || line.command === "NOTICE" ? parts : others).push(line);
	}

	if (parts.length === 0) {
		emitBatched(client, batch, batch.messages);
		return;
	}

	const joined = joinMultiline(batch, parts);

	// Our own message coming back (`echo-message`) is the server saying it
	// took that batch, in the order we sent them. A nested batch is history,
	// not an echo.
	if (!batch.parent && joined.source && client.isSelf(joined.source.name)) {
		const entry = pendingOf(client).shift();

		if (entry) {
			clearTimeout(entry.timer);
		}
	}

	emitBatched(client, batch, [joined, ...others]);
}

/** The one message a batch's PRIVMSG/NOTICE lines make. */
function joinMultiline(batch: OpenBatch, parts: IrcMessage[]): IrcMessage {
	let text = "";

	parts.forEach((line, i) => {
		if (i > 0 && !line.tags.has(CONCAT_TAG)) {
			text += "\n";
		}

		text += line.params[1] ?? "";
	});

	const first = parts[0];
	// `time`, `msgid`, `account` and client tags belong to the message as a
	// whole and ride on the opener; take anything else off the first line
	// (a server that tags the lines instead still works).
	const tags = new Map(batch.tags);
	tags.delete("batch");

	for (const [key, value] of first.tags) {
		if (key !== "batch" && key !== CONCAT_TAG && !tags.has(key)) {
			tags.set(key, value);
		}
	}

	// The opener's source is the sender live but the server itself in a
	// chathistory replay (m_chathistory.c), so the sender comes off the lines.
	const target = first.params[0] ?? batch.params[0] ?? "";
	const joined: IrcMessage = {
		tags,
		command: first.command,
		params: [target, text],
		raw: `${first.source ? `:${formatSource(first.source)} ` : ""}${
			first.command
		} ${target} :${text.replace(/\n/g, "\\n")}`,
	};

	if (first.source) {
		joined.source = first.source;
	}

	return joined;
}

// ----------------------------------------------------------------- outbound

export interface MultilineRequest {
	ref: string;
	target: string;
	/** One entry per line of the message; empty entries are blank lines. */
	lines: string[];
	command: "PRIVMSG" | "NOTICE";
	/** Bytes the server's echo prefix adds (`:nick!user@host `). */
	sourceBytes: number;
	/** Client tags for the whole message; they ride on the batch opener. */
	tags?: ClientTags;
	limits: MultilineLimits;
}

export interface MultilineWire {
	/** Opener, one line per wire line, closer — in send order. */
	lines: string[];
	/** The message as the receiver will reassemble it (for the local echo). */
	text: string;
}

/**
 * Serialise a multiline batch, or return undefined when it does not fit what
 * the server advertised — the caller then sends one message per line, which
 * is what a server without the cap gets anyway.
 */
export function buildMultiline(req: MultilineRequest): MultilineWire | undefined {
	const {ref, target, lines, command, limits} = req;
	const text = lines.join("\n");

	if (limits.maxBytes > 0 && utf8ByteLength(text) - (lines.length - 1) > limits.maxBytes) {
		return undefined; // max-bytes counts the message bodies, not the newlines
	}

	const open = formatLine({
		tags: req.tags,
		command: "BATCH",
		params: [`+${ref}`, MULTILINE_CAP, target],
	});

	if (utf8ByteLength(open) > MAX_LINE_BYTES) {
		return undefined;
	}

	// Every line is budgeted as if it carried the concat tag: only the
	// continuations of an over-long line do, but the cap is per line.
	const tags: ClientTags = {batch: ref, [CONCAT_TAG]: ""};
	const prefixBytes =
		req.sourceBytes +
		utf8ByteLength(tagPrefix(tags)) +
		utf8ByteLength(`${command} ${target} :`);
	const body: string[] = [];

	for (const line of lines) {
		if (line.length === 0) {
			body.push(trailingLine(command, [target, ""], {batch: ref}));
			continue;
		}

		let chunks: string[];

		try {
			chunks = splitMessage(prefixBytes, line);
		} catch {
			return undefined; // not even one character fits
		}

		chunks.forEach((chunk, i) => {
			body.push(trailingLine(command, [target, chunk], i === 0 ? {batch: ref} : {...tags}));
		});
	}

	if (body.length === 0 || (limits.maxLines > 0 && body.length > limits.maxLines)) {
		return undefined;
	}

	return {lines: [open, ...body, `BATCH -${ref}`], text};
}

/** A batch on the wire, kept until the server accepts it or FAILs it. */
interface PendingMultiline {
	target: string;
	lines: string[];
	opts: SendMessageOptions;
	timer: ReturnType<typeof setTimeout>;
}

const pending = new WeakMap<IrcClient, PendingMultiline[]>();

function pendingOf(client: IrcClient): PendingMultiline[] {
	let queue = pending.get(client);

	if (!queue) {
		queue = [];
		pending.set(client, queue);
	}

	return queue;
}

/**
 * Remember a sent batch so a `FAIL BATCH` can put its text back on the wire.
 * The server answers our batches in order, and the queue is emptied from the
 * front by both the echo and a `FAIL` — but without `echo-message` a
 * delivered batch is indistinguishable from a waiting one, so then only the
 * most recent is kept.
 */
export function noteMultilineSent(
	client: IrcClient,
	target: string,
	lines: string[],
	opts: SendMessageOptions
): void {
	const queue = pendingOf(client);

	if (!client.caps.hasCapability("echo-message")) {
		resetMultiline(client);
	}

	const entry: PendingMultiline = {
		target,
		lines,
		opts,
		timer: setTimeout(() => {
			const idx = queue.indexOf(entry);

			if (idx !== -1) {
				queue.splice(idx, 1);
			}
		}, MULTILINE_FAIL_WINDOW_MS),
	};
	queue.push(entry);
}

/**
 * A `FAIL BATCH` arrived: the oldest batch we sent was dropped whole (every
 * reject path in the server clears it before delivery), so say it again as
 * one message per line. Returns false when no batch was waiting.
 */
export function multilineFailed(client: IrcClient): boolean {
	const entry = pendingOf(client).shift();

	if (!entry) {
		return false;
	}

	clearTimeout(entry.timer);

	for (const line of entry.lines) {
		if (line.length > 0) {
			client.sendMessage(entry.target, line, entry.opts);
		}
	}

	return true;
}

/** Drop what we were waiting on (the transport closed). */
export function resetMultiline(client: IrcClient): void {
	const queue = pendingOf(client);

	for (const entry of queue) {
		clearTimeout(entry.timer);
	}

	queue.length = 0;
}
