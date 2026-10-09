/**
 * Ask the server something and get the whole answer back as one unit, by
 * `labeled-response` label: `client.request("STATS g")` resolves with every
 * line of the reply, in order, once it is complete. This is the exact
 * correlation docs/projects/reply-routing.md parked under _Future_; the oper
 * tools (docs/projects/oper-tools.md) are its first users.
 *
 * nefarious2 answers a labeled request in one of three shapes:
 *
 * - **a batch**: STATS, CHECK, TRACE, MAP, LINKS, WHO, WHOIS, INFO, … open
 *   `BATCH +x labeled-response` (the label on the opener) around the reply,
 *   also for a command it forwards to another server. Delivered when the
 *   batch closes.
 * - **labeled lines**: a single numeric (008, 284, an error), or a list the
 *   server does not batch (GLINE's 280… 281). With `end` numerics given,
 *   lines collect until one of them; without, the first line answers.
 * - **`ACK`**: the command produced nothing it would label (KILL, a GLINE
 *   that worked). Also how a reply sent *without* the label ends — see below.
 *
 * Two server bugs are tolerated here, because the client has to work with the
 * server as it is (evilnet/nefarious2#119, #120):
 *
 * - NOTICEs sent inside a labeled batch carry no `@batch` tag (the STATS help
 *   list, `STATS w`, VERSION's library lines). A server NOTICE addressed to us
 *   while one of our labeled batches is open is taken into it.
 * - USERHOST 302, USERIP 340, ISON 303 and PRIVS 270 go out with no tags at
 *   all, followed by the `ACK` that says "nothing". A request that names them
 *   in `untagged` collects such a line while it waits, and the ACK resolves
 *   with it.
 *
 * Kept free of store and DOM imports (mocha). A server without
 * `labeled-response` cannot be asked this way: {@link canRequest} says so and
 * callers send the command plainly instead.
 */

import type {IrcClient} from "./client";
import {isErrorNumeric} from "./errors";
import {openBatchesOf, type BatchHandler, type OpenBatch} from "./handlers/batch";
import type {IrcMessage} from "./message";
import {tagPrefix} from "./wire";

export const LABELED_RESPONSE_CAP = "labeled-response";

/** How long a request waits for the end of its answer. */
export const REQUEST_TIMEOUT_MS = 30_000;

export type ReplyOutcome = "batch" | "lines" | "ack" | "timeout" | "closed";

export interface ReplyUnit {
	/** Every line of the answer, in arrival order (a batch's contents, unwrapped). */
	lines: IrcMessage[];
	outcome: ReplyOutcome;
}

export interface RequestOptions {
	/** Numerics that end an unbatched multi-line answer (GLINE's 281, 521). */
	end?: string[];
	/** Numerics the server sends without the label (#120): 270, 302, 303, 340. */
	untagged?: string[];
	timeoutMs?: number;
}

interface PendingRequest {
	label: string;
	line: string;
	opts: RequestOptions;
	lines: IrcMessage[];
	resolve: (unit: ReplyUnit) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface Registry {
	next: number;
	pending: PendingRequest[];
}

const registries = new WeakMap<IrcClient, Registry>();

function registryOf(client: IrcClient): Registry {
	let registry = registries.get(client);

	if (!registry) {
		registry = {next: 0, pending: []};
		registries.set(client, registry);
	}

	return registry;
}

/** Whether `client` can be asked with {@link request} right now. */
export function canRequest(client: IrcClient): boolean {
	return client.caps.hasCapability(LABELED_RESPONSE_CAP) && client.isWelcomed;
}

/**
 * Send `line` labeled and resolve with its whole answer. Never rejects: a
 * line that cannot be sent resolves at once with outcome `closed`, a socket
 * that dies first with what had arrived, a server that never finishes with
 * `timeout`.
 */
export function request(
	client: IrcClient,
	line: string,
	opts: RequestOptions = {}
): Promise<ReplyUnit> {
	const registry = registryOf(client);
	const label = `r${++registry.next}`;

	return new Promise((resolve) => {
		if (!canRequest(client)) {
			resolve({lines: [], outcome: "closed"});
			return;
		}

		const entry: PendingRequest = {
			label,
			line,
			opts,
			lines: [],
			resolve,
			timer: setTimeout(
				() => finish(client, entry, "timeout"),
				opts.timeoutMs ?? REQUEST_TIMEOUT_MS
			),
		};

		registry.pending.push(entry);

		if (!client.send(`${tagPrefix({label})}${line}`)) {
			finish(client, entry, "closed");
		}
	});
}

function finish(client: IrcClient, entry: PendingRequest, outcome: ReplyOutcome): void {
	const registry = registryOf(client);
	const index = registry.pending.indexOf(entry);

	if (index === -1) {
		return; // already answered
	}

	registry.pending.splice(index, 1);
	clearTimeout(entry.timer);
	entry.resolve({lines: entry.lines, outcome});
}

function byLabel(client: IrcClient, label: string | undefined): PendingRequest | undefined {
	return label ? registryOf(client).pending.find((e) => e.label === label) : undefined;
}

/** An error numeric or a standard-reply FAIL: always the end of an answer. */
function isError(msg: IrcMessage): boolean {
	return isErrorNumeric(msg.command) || msg.command === "FAIL";
}

/** Our open labeled batch, if one is open (the newest). */
function openLabeledBatch(client: IrcClient): OpenBatch | undefined {
	let found: OpenBatch | undefined;

	for (const batch of openBatchesOf(client).values()) {
		if (
			batch.type.toLowerCase() === "labeled-response" &&
			byLabel(client, batch.tags.get("label"))
		) {
			found = batch;
		}
	}

	return found;
}

/**
 * Called by `IrcClient.handleMessage` for every line after batch buffering:
 * takes the lines that answer one of our requests. Returns whether the line
 * was taken (the normal handlers then never see it).
 */
export function interceptRequestLine(client: IrcClient, msg: IrcMessage): boolean {
	const registry = registries.get(client);

	if (!registry || registry.pending.length === 0 || msg.command === "BATCH") {
		return false;
	}

	const entry = byLabel(client, msg.tags.get("label"));

	if (entry) {
		if (msg.command === "ACK") {
			finish(client, entry, "ack");
			return true;
		}

		entry.lines.push(msg);
		const end = entry.opts.end;

		if (!end || end.includes(msg.command) || isError(msg)) {
			finish(client, entry, "lines");
		}

		return true;
	}

	if (msg.tags.has("label") || msg.tags.has("batch")) {
		return false;
	}

	const fromServer = msg.source !== undefined && msg.source.user === undefined;

	// #119: a server NOTICE to us inside our open labeled batch belongs to it.
	if (msg.command === "NOTICE" && fromServer && client.isSelf(msg.params[0] ?? "")) {
		const batch = openLabeledBatch(client);

		if (batch) {
			batch.messages.push(msg);
			return true;
		}
	}

	// #120: the untagged reply a waiting request named; its ACK follows.
	if (fromServer) {
		const waiting = registry.pending.find((e) => e.opts.untagged?.includes(msg.command));

		if (waiting) {
			waiting.lines.push(msg);
			return true;
		}
	}

	return false;
}

/**
 * A closed `labeled-response` batch: ours resolves its request, anyone
 * else's (a labeled history request, a labeled message's echo) is unwrapped
 * into the normal handlers, as an unregistered batch type would be.
 */
export const labeledBatch: BatchHandler = (client, batch) => {
	const entry = byLabel(client, batch.tags.get("label"));

	if (entry) {
		entry.lines.push(...batch.messages);
		finish(client, entry, "batch");
		return;
	}

	for (const msg of batch.messages) {
		client.handleMessage(msg);
	}
};

/** The socket closed: every waiting request resolves with what it has. */
export function resetRequests(client: IrcClient): void {
	const registry = registries.get(client);

	if (!registry) {
		return;
	}

	for (const entry of [...registry.pending]) {
		finish(client, entry, "closed");
	}
}
