/**
 * Searching the server's history (`soju.im/search`), and reading the lines
 * around a hit (`CHATHISTORY AROUND|BEFORE|AFTER`) for the search window.
 *
 * The replies feed the window and nothing else. They go through the normal
 * handlers in collect mode so a row looks like any other message (ACTION,
 * multi-line, formatting), but unlike `history.ts` they never reach a channel:
 * no unread counts, no catch-up cursor, no query opened or logged, and a row
 * the channel already shows is still a hit, so there is no msgid dedupe. The
 * work collect mode queues for after delivery (reactions, edits) is dropped,
 * and no handler reaches the bus while a row is collected.
 *
 * Without a registered batch handler a `search` batch would be unwrapped and
 * its rows shown as live messages; a late answer to a timed-out request lands
 * here too and is dropped: a timed-out request stays listed, `expired`, so its
 * reply is still recognised as its own (see {@link PendingSearch.expired}).
 *
 * A context reply is an ordinary `chathistory` batch, told apart from the
 * channel's own pages by its label alone, so context needs `labeled-response`.
 */

import type {
	SearchAttrs,
	SearchContextDirection,
	SearchHit,
	SearchStatus,
} from "../../../shared/types/search";
import type {IrcClient} from "./client";
import type {BatchHandler, OpenBatch} from "./handlers/batch";
import {formatLine, MAX_LINE_BYTES, utf8ByteLength, type IrcMessage} from "./message";
import type {Channel} from "./channel";

const SEARCH_CAP = "soju.im/search";
/** How long to wait for the server before giving up on a request. */
export const SEARCH_TIMEOUT_MS = 20_000;
/**
 * How long a timed-out request with no label keeps its place in line. Its late
 * answer must not be taken for the next request's, but if it never comes every
 * later answer would be off by one, so the place is given up in the end.
 */
export const SEARCH_TOMBSTONE_MS = 120_000;

interface PendingSearch {
	kind: "results" | "context";
	requestId: number;
	label?: string;
	timer: ReturnType<typeof setTimeout>;
	/**
	 * Timed out and already answered; still here so its late reply is known for
	 * what it is and dropped, not given to another request or to a channel.
	 */
	expired?: boolean;
}

const pendingByClient = new WeakMap<IrcClient, PendingSearch[]>();
let labelCounter = 0;

function pendingOf(client: IrcClient): PendingSearch[] {
	let list = pendingByClient.get(client);

	if (!list) {
		list = [];
		pendingByClient.set(client, list);
	}

	return list;
}

/** Requests in flight for `client` (tests / diagnostics). */
export function pendingSearches(client: IrcClient): readonly PendingSearch[] {
	return pendingOf(client);
}

/**
 * The spec's single parameter: `key=value` joined by `;`, values escaped like
 * message tags. nefarious2 spells it differently (its profile's `searchParams`).
 */
export function specSearchParams(attrs: SearchAttrs): string[] {
	const escape = (value: string) =>
		value
			.replaceAll("\\", "\\\\")
			.replaceAll(";", "\\:")
			.replaceAll(" ", "\\s")
			.replaceAll("\r", "\\r")
			.replaceAll("\n", "\\n");

	return [
		Object.entries(attrs)
			.filter(([, value]) => value !== undefined && value !== "")
			.map(([key, value]) => `${key}=${escape(String(value))}`)
			.join(";"),
	];
}

function labelTags(client: IrcClient): {tags: Record<string, string>; label?: string} {
	if (!client.caps.hasCapability("labeled-response")) {
		return {tags: {}};
	}

	const label = `q${++labelCounter}`;
	return {tags: {label}, label};
}

function track(
	client: IrcClient,
	kind: PendingSearch["kind"],
	requestId: number,
	label?: string
): void {
	const request: PendingSearch = {
		kind,
		requestId,
		label,
		timer: setTimeout(() => {
			request.expired = true;
			answer(client, request, "timeout");

			// A label can never be mistaken for another's: kept until the connection ends.
			if (!request.label) {
				request.timer = setTimeout(() => take(client, request), SEARCH_TOMBSTONE_MS);
			}
		}, SEARCH_TIMEOUT_MS),
	};
	pendingOf(client).push(request);
}

function take(client: IrcClient, request: PendingSearch): boolean {
	const list = pendingOf(client);
	const index = list.indexOf(request);

	if (index < 0) {
		return false;
	}

	list.splice(index, 1);
	clearTimeout(request.timer);
	return true;
}

function answer(
	client: IrcClient,
	request: Pick<PendingSearch, "kind" | "requestId">,
	status: SearchStatus,
	error?: string,
	hits: SearchHit[] = []
): void {
	const base = {network: client.uuid, requestId: request.requestId, status, error};

	if (request.kind === "results") {
		client.dispatchBus("search:results", {...base, hits});
	} else {
		client.dispatchBus("search:context", {...base, messages: hits.map((hit) => hit.msg)});
	}
}

/** The line, or undefined when it cannot go on the wire (a CR or LF from a crafted `?q=`). */
function lineFor(input: Parameters<typeof formatLine>[0]): string | undefined {
	try {
		const line = formatLine(input);
		return utf8ByteLength(line) > MAX_LINE_BYTES ? undefined : line;
	} catch {
		return undefined;
	}
}

/** Send a request for the window, which always gets its one answer, whatever happens. */
function sendRequest(
	client: IrcClient,
	kind: PendingSearch["kind"],
	requestId: number,
	available: boolean,
	command: string,
	params: string[]
): void {
	const request = {kind, requestId};

	if (!client.isWelcomed) {
		answer(client, request, "offline");
		return;
	}

	if (!available) {
		answer(client, request, "unsupported");
		return;
	}

	const {tags, label} = labelTags(client);
	const line = lineFor({tags, command, params});

	if (!line) {
		answer(client, request, "invalid", "That search can't be sent.");
		return;
	}

	if (!client.send(line)) {
		answer(client, request, "offline");
		return;
	}

	track(client, kind, requestId, label);
}

/** Send a `SEARCH`, answered by one `search:results`. */
export function requestSearch(client: IrcClient, requestId: number, attrs: SearchAttrs): void {
	sendRequest(
		client,
		"results",
		requestId,
		client.caps.hasCapability(SEARCH_CAP) && client.caps.hasCapability("batch"),
		"SEARCH",
		client.profile.searchParams?.(attrs) ?? specSearchParams(attrs)
	);
}

/** Send a `CHATHISTORY` for the search window, answered by one `search:context`. */
export function requestSearchContext(
	client: IrcClient,
	requestId: number,
	target: string,
	direction: SearchContextDirection,
	msgid: string,
	limit: number
): void {
	sendRequest(
		client,
		"context",
		requestId,
		client.caps.hasCapability("draft/chathistory") &&
			client.caps.hasCapability("labeled-response"),
		"CHATHISTORY",
		[direction, target, `msgid=${msgid}`, String(limit)]
	);
}

/** The conversation a stored line belongs to: our own nick means the sender's window. */
function conversationOf(client: IrcClient, line: IrcMessage, fallback?: string): string {
	const target = line.params[0] ?? fallback ?? "";
	return client.isSelf(target) ? line.source?.name ?? target : target;
}

/** Turn stored lines into messages without letting them near a channel. */
function collect(client: IrcClient, lines: IrcMessage[], fallback?: string): SearchHit[] {
	const hits: SearchHit[] = [];

	for (const line of lines) {
		const target = conversationOf(client, line, fallback);
		const chan: Channel = client.findChannel(target) ?? client.lobby;
		const msgid = line.tags.get("msgid");
		const result = client.collectReplay(chan, () => client.handleMessage(line), true);

		for (const {msg} of result.messages) {
			if (msgid && !msg.msgid) {
				msg.msgid = msgid;
			}

			hits.push({target, msg});
		}
	}

	const ids = client.historyIds(hits.length);
	hits.forEach((hit, index) => {
		hit.msg.id = ids[index];
	});

	return hits;
}

function labelOf(batch: OpenBatch): string | undefined {
	return batch.tags.get("label") ?? batch.parent?.tags.get("label");
}

/** The search a reply names, else the oldest: replies come in order. */
function searchFor(client: IrcClient, label?: string): PendingSearch | undefined {
	const searches = pendingOf(client).filter((request) => request.kind === "results");
	return label ? searches.find((request) => request.label === label) : searches[0];
}

/** The context request a reply names: only a label tells it from a channel's own. */
function contextFor(client: IrcClient, label?: string): PendingSearch | undefined {
	return label
		? pendingOf(client).find((request) => request.kind === "context" && request.label === label)
		: undefined;
}

/** Close a request with its answer; one that timed out has had its answer already. */
function settle(
	client: IrcClient,
	request: PendingSearch,
	status: SearchStatus,
	error?: string,
	hits?: () => SearchHit[]
): void {
	if (take(client, request) && !request.expired) {
		answer(client, request, status, error, hits?.());
	}
}

/** A closed `search` batch: the answer to the request it names, else the oldest. */
export const searchBatch: BatchHandler = (client, batch) => {
	const request = searchFor(client, labelOf(batch));

	if (request) {
		settle(client, request, "ok", undefined, () => collect(client, batch.messages));
	}
};

/** A `chathistory` batch that answers our context request; false when it is not ours. */
export function searchContextBatch(client: IrcClient, batch: OpenBatch): boolean {
	const request = contextFor(client, labelOf(batch));

	if (!request) {
		return false;
	}

	settle(client, request, "ok", undefined, () =>
		collect(client, batch.messages, batch.params[0])
	);
	return true;
}

/** `FAIL SEARCH <code> [context] :text`: the window shows it, the lobby does not. */
export function searchFailed(client: IrcClient, msg: IrcMessage): void {
	const request = searchFor(client, msg.tags.get("label"));

	if (request) {
		settle(client, request, "fail", msg.params[msg.params.length - 1]);
	}
}

/** `FAIL CHATHISTORY` answering a context request; false when it is not ours. */
export function searchContextFailed(client: IrcClient, msg: IrcMessage): boolean {
	const request = contextFor(client, msg.tags.get("label"));

	if (!request) {
		return false;
	}

	settle(client, request, "fail", msg.params[msg.params.length - 1]);
	return true;
}

/** A labeled `ACK` closes a request with nothing to say; false when it is not ours. */
export function searchAck(client: IrcClient, label: string): boolean {
	const request = pendingOf(client).find((r) => r.label === label);

	if (!request) {
		return false;
	}

	settle(client, request, "ok");
	return true;
}

/** The connection closed: nothing in flight will be answered. */
export function resetSearches(client: IrcClient): void {
	for (const request of [...pendingOf(client)]) {
		settle(client, request, "offline");
	}
}
