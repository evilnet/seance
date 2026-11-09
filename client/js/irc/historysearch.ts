/**
 * Searching the server's history (`soju.im/search`), and reading the lines
 * around a message (`CHATHISTORY AROUND|BEFORE|AFTER`) for a past view.
 *
 * The replies feed those and nothing else. They go through the normal
 * handlers in collect mode so a row looks like any other message (ACTION,
 * multi-line, formatting), but unlike `history.ts` they never reach a channel:
 * no unread counts, no catch-up cursor, no query opened or logged, and a row
 * the channel already shows is still a hit, so there is no msgid dedupe. A
 * page's reactions, deletions and edits apply to its own rows ({@link withUpdates}),
 * and no handler reaches the bus while a row is collected.
 *
 * Without a registered batch handler a `search` batch would be unwrapped and
 * its rows shown as live messages; a late answer to a timed-out request lands
 * here too and is dropped: a timed-out request stays listed, `expired`, so its
 * reply is still recognised as its own (see {@link PendingSearch.expired}).
 *
 * A context reply is an ordinary `chathistory` batch, told apart from the
 * channel's own pages by its label alone, so context needs `labeled-response`.
 *
 * The parent of a reply that is not loaded comes the same way
 * ({@link requestReplyParent}): one `CHATHISTORY AROUND msgid=<id> 1`, its row
 * handed to the quote (`reply:parent`) and never made a row of the channel.
 */

import type {
	LineChange,
	SearchAttrs,
	SearchContextDirection,
	SearchHit,
	SearchStatus,
} from "../../../shared/types/search";
import {t} from "../i18n/core";
import type {IrcClient} from "./client";
import type {BatchHandler, OpenBatch} from "./handlers/batch";
import {formatLine, MAX_LINE_BYTES, utf8ByteLength, type IrcMessage} from "./message";
import type {Channel} from "./channel";
import {formatRef, historyLimit, takesMsgidRefs, takesTimestampRefs} from "./history";
import {ChanState, ChanType} from "../../../shared/types/chan";
import {applyEdit, applyReaction, applyRedaction} from "../helpers/messageUpdates";
import {sameAuthor} from "../helpers/pastRows";
import {ignoreListFor} from "../ignore";
import {replyTagOf} from "./handlers/privmsg";
import {REACT_TAG, UNREACT_TAG} from "./wire";

const SEARCH_CAP = "soju.im/search";
/** How long to wait for the server before giving up on a request. */
export const SEARCH_TIMEOUT_MS = 20_000;
/**
 * How long a timed-out request with no label keeps its place in line. Its late
 * answer must not be taken for the next request's, but if it never comes every
 * later answer would be off by one, so the place is given up in the end.
 */
export const SEARCH_TOMBSTONE_MS = 120_000;
/** One `CHATHISTORY AROUND` for a reply's parent: a command. */
const PARENT_COST_MS = 2000;

interface PendingSearch {
	kind: "results" | "context";
	requestId: number;
	/** Set on a context request for a reply's parent: its answer goes to the quote. */
	parent?: {chan: Channel; msgid: string};
	/** A search's attributes, kept so one the server refuses for want of `in=` can be sent again. */
	attrs?: SearchAttrs;
	/** One channel's part of a search over every channel ({@link fanOut}). */
	group?: SearchGroup;
	label?: string;
	timer: ReturnType<typeof setTimeout>;
	/**
	 * Timed out and already answered; still here so its late reply is known for
	 * what it is and dropped, not given to another request or to a channel.
	 */
	expired?: boolean;
}

/** What a request is for: who gets its answer. */
type Asked = Pick<PendingSearch, "kind" | "requestId" | "parent" | "attrs" | "group">;

/**
 * A search over every channel, sent as one `SEARCH in=<channel>` each to a
 * server that wants `in=` (soju: `FAIL SEARCH INVALID_PARAMS in`). One part at
 * a time, so an unlabeled answer is always the part's; answered once, when the
 * last part has: the newest `limit` hits, oldest first, as one server would
 * have sent them. A part that fails fails the whole: results that leave
 * channels out are not every channel's.
 */
interface SearchGroup {
	requestId: number;
	/** Every attribute but `in`. */
	attrs: SearchAttrs;
	/** Channels not asked about yet. */
	queue: string[];
	hits: SearchHit[];
	/** Answered already (a newer search took its place): its part in flight is dropped. */
	done?: boolean;
}

/** The search over every channel still asking, per connection: a newer search ends it. */
const activeGroups = new WeakMap<IrcClient, SearchGroup>();

/**
 * A newer search replaces the one over every channel still asking: the rest of
 * its channels are not asked about, and it is answered now, as a failure (the
 * window has moved on and drops it). The part in flight stays tracked, so its
 * reply is still known for what it is, and is dropped.
 */
function supersedeGroup(client: IrcClient): void {
	const group = activeGroups.get(client);

	if (!group) {
		return;
	}

	activeGroups.delete(client);
	group.queue.length = 0;
	group.done = true;
	client.dispatchBus("search:results", {
		network: client.uuid,
		requestId: group.requestId,
		status: "fail",
		hits: [],
	});
}
/**
 * Servers that answered a search without `in=` with `FAIL SEARCH INVALID_PARAMS in`:
 * every later search over every channel on that connection goes out per channel.
 */
const needsIn = new WeakSet<IrcClient>();

/**
 * When each msgid seen in a search or context page on this connection was
 * said, for a server that takes `timestamp=` references and not `msgid=` ones
 * (soju: `MSGREFTYPES=timestamp`). Bounded: the oldest are let go.
 */
const timesByClient = new WeakMap<IrcClient, Map<string, Date>>();
const TIMES_MAX = 5000;

function noteTimes(client: IrcClient, lines: IrcMessage[]): void {
	if (takesMsgidRefs(client)) {
		return; // asked by msgid: nothing to look up
	}

	let times = timesByClient.get(client);

	if (!times) {
		times = new Map();
		timesByClient.set(client, times);
	}

	for (const line of lines) {
		const msgid = line.tags.get("msgid");

		if (msgid) {
			times.delete(msgid);
			times.set(msgid, client.timeOf(line));
		}
	}

	for (const key of times.keys()) {
		if (times.size <= TIMES_MAX) {
			break;
		}

		times.delete(key);
	}
}

/**
 * How to name `msgid` in `target` to this server: by msgid where it takes
 * those, else by when it was said, if this connection knows (a search or
 * context page brought it, or the channel shows it). Undefined when neither.
 */
function contextRef(client: IrcClient, target: string, msgid: string): string | undefined {
	if (takesMsgidRefs(client)) {
		return formatRef(client, {msgid, time: new Date(0)});
	}

	const chan = client.findChannel(target);
	const id = chan?.idOf(msgid);
	const time =
		(id === undefined ? undefined : chan?.msgRefs.get(id)?.time) ??
		timesByClient.get(client)?.get(msgid);
	return time ? formatRef(client, {time}) : undefined;
}

const pendingByClient = new WeakMap<IrcClient, PendingSearch[]>();
/** Reply parents asked for on this connection, `<chan id>:<msgid>`: each is worth one command. */
const parentsAsked = new WeakMap<IrcClient, Set<string>>();
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

function track(client: IrcClient, asked: Asked, label?: string): void {
	const request: PendingSearch = {
		...asked,
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

/** What a context page says beyond its rows. */
type ContextPage = {
	/** The server marked it the last on that side. */
	end?: boolean;
	/** Reactions and deletions of lines not in this page: an earlier page's, perhaps. */
	changes?: LineChange[];
	/**
	 * The msgids of the page's first and last lines, whatever they are: a page
	 * of reactions alone has no rows to take the next page's anchor from.
	 */
	edges?: {first?: string; last?: string};
};

function answer(
	client: IrcClient,
	request: Asked,
	status: SearchStatus,
	error?: string,
	hits: SearchHit[] = [],
	page: ContextPage = {}
): void {
	if (request.group) {
		answerPart(client, request.group, status, error, hits);
		return;
	}

	if (request.parent) {
		const {chan, msgid} = request.parent;
		const row = hits.find((hit) => hit.msg.msgid === msgid)?.msg;

		if (row) {
			client.dispatchBus("reply:parent", {
				chan: chan.id,
				msgid,
				nick: row.from?.nick ?? "",
				text: row.text ?? "",
			});
		}

		return;
	}

	const base = {network: client.uuid, requestId: request.requestId, status, error};

	if (request.kind === "results") {
		client.dispatchBus("search:results", {...base, hits});
	} else {
		client.dispatchBus("search:context", {
			...base,
			...page,
			messages: hits.map((hit) => hit.msg),
		});
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

/** One channel's part of a search over every channel is in: ask the next, or answer the whole. */
function answerPart(
	client: IrcClient,
	group: SearchGroup,
	status: SearchStatus,
	error: string | undefined,
	hits: SearchHit[]
): void {
	const base = {network: client.uuid, requestId: group.requestId};

	if (group.done) {
		return; // superseded: answered already
	}

	if (status !== "ok") {
		group.done = true;
		activeGroups.delete(client);
		client.dispatchBus("search:results", {...base, status, error, hits: []});
		return;
	}

	group.hits.push(...hits);

	if (group.queue.length > 0) {
		askNext(client, group);
		return;
	}

	const time = (hit: SearchHit) => new Date(hit.msg.time).getTime();
	const sorted = group.hits.toSorted((a, b) => time(a) - time(b));
	const kept = group.attrs.limit ? sorted.slice(-group.attrs.limit) : sorted;
	group.done = true;
	activeGroups.delete(client);
	client.dispatchBus("search:results", {...base, status: "ok", hits: kept});
}

function askNext(client: IrcClient, group: SearchGroup): void {
	const part: SearchAttrs = {in: group.queue.shift(), ...group.attrs};
	sendRequest(
		client,
		{kind: "results", requestId: group.requestId, attrs: part, group},
		true,
		"SEARCH",
		client.profile.searchParams?.(part) ?? specSearchParams(part),
		// A bouncer answers SEARCH from its own store: no ircd charges for it.
		!client.behindBouncer
	);
}

/**
 * Search every channel by asking about each (a server that wants `in=`). The
 * channels are those joined; private conversations are left out, as a server's
 * own search over every channel leaves them out. None joined (soju's control
 * connection): searched on the device instead.
 */
function fanOut(client: IrcClient, requestId: number, attrs: SearchAttrs): void {
	const queue = client.channels
		.filter((chan) => chan.type === ChanType.CHANNEL && chan.state === ChanState.JOINED)
		.map((chan) => chan.name);

	if (queue.length === 0) {
		client.dispatchBus("search:results", {
			network: client.uuid,
			requestId,
			status: "unsupported",
			hits: [],
		});
		return;
	}

	const {in: _all, ...rest} = attrs;
	const group: SearchGroup = {requestId, attrs: rest, queue, hits: []};
	activeGroups.set(client, group);
	askNext(client, group);
}

/** Send a request, which always gets its one answer, whatever happens. */
function sendRequest(
	client: IrcClient,
	request: Asked,
	available: boolean,
	command: string,
	params: string[],
	charge = true
): void {
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
		answer(client, request, "invalid", t("search.window.errorInvalid"));
		return;
	}

	if (!client.send(line, charge)) {
		answer(client, request, "offline");
		return;
	}

	track(client, request, label);
}

/** A context reply is told from a channel's own page by its label alone. */
function canAskContext(client: IrcClient): boolean {
	return (
		client.caps.hasCapability("draft/chathistory") &&
		client.caps.hasCapability("labeled-response") &&
		// The window is asked for by msgid, or by when it was said (soju).
		(takesMsgidRefs(client) || takesTimestampRefs(client))
	);
}

/** A reply's parent is known by its msgid alone. */
function canAskParent(client: IrcClient): boolean {
	return canAskContext(client) && takesMsgidRefs(client);
}

/** Send a `SEARCH`, answered by one `search:results`. */
export function requestSearch(client: IrcClient, requestId: number, attrs: SearchAttrs): void {
	const available = client.caps.hasCapability(SEARCH_CAP) && client.caps.hasCapability("batch");
	supersedeGroup(client);

	if (available && client.isWelcomed && !attrs.in && needsIn.has(client)) {
		fanOut(client, requestId, attrs);
		return;
	}

	sendRequest(
		client,
		{kind: "results", requestId, attrs},
		available,
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
	const ref = contextRef(client, target, msgid);

	sendRequest(
		client,
		{kind: "context", requestId},
		canAskContext(client) && ref !== undefined,
		"CHATHISTORY",
		[direction, target, ref ?? "", String(historyLimit(client, limit))]
	);
}

/**
 * Ask the server for the parent of a reply that is not loaded, once a connection,
 * answered by a `reply:parent` if the server has it. Background work, so a screenful
 * of replies cannot put the server's clock past its ceiling, but at the front:
 * someone is looking at this quote, and behind a reconnect's catch-up it took minutes.
 */
export function requestReplyParent(client: IrcClient, chan: Channel, msgid: string): void {
	const key = `${chan.id}:${msgid}`;
	let asked = parentsAsked.get(client);

	if (!asked) {
		asked = new Set();
		parentsAsked.set(client, asked);
	}

	if (asked.has(key)) {
		return;
	}

	asked.add(key);
	client.background.add(
		{
			key: `parent:${key}`,
			cost: PARENT_COST_MS,
			run() {
				sendRequest(
					client,
					{kind: "context", requestId: 0, parent: {chan, msgid}},
					canAskParent(client),
					"CHATHISTORY",
					["AROUND", chan.name, `msgid=${msgid}`, "1"]
				);
			},
		},
		{front: true}
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

/**
 * What the page's own lines say of its rows: reactions, deletions and edits. A
 * channel's page does this through ids the channel holds (`afterReplay`); these
 * rows are not the channel's, so nothing here may reach it.
 */
function withUpdates(
	client: IrcClient,
	hits: SearchHit[],
	lines: IrcMessage[],
	changes: LineChange[]
): SearchHit[] {
	const rows = hits.map((hit) => hit.msg);
	const byMsgid = new Map(rows.filter((m) => m.msgid).map((m) => [m.msgid, m]));

	for (const line of lines) {
		const nick = line.source?.name;

		if (!nick) {
			continue;
		}

		if (line.command === "TAGMSG") {
			const react = line.tags.get(REACT_TAG);
			const text = react || line.tags.get(UNREACT_TAG);
			const row = byMsgid.get(replyTagOf(line));
			const ignored =
				!client.isSelf(nick) &&
				ignoreListFor(client.uuid).matches(nick, line.source?.user, line.source?.host);

			if (text && !ignored) {
				const parent = replyTagOf(line);

				if (row) {
					applyReaction(row, text, nick, !react);
				} else if (parent) {
					changes.push({msgid: parent, react: {text, nick, remove: !react}});
				}
			}
		} else if (line.command === "REDACT") {
			const row = byMsgid.get(line.params[1]);
			const redact = {by: nick, reason: line.params[2], time: client.timeOf(line)};

			if (row) {
				applyRedaction(row, redact);
			} else if (line.params[1]) {
				changes.push({msgid: line.params[1], redact});
			}
		}
	}

	for (const row of [...rows]) {
		const original = row.editOf ? byMsgid.get(row.editOf) : undefined;

		if (original && sameAuthor(original, row)) {
			applyEdit(rows, original.id, row.id);
		}
	}

	const target = hits[0]?.target ?? "";
	return rows.map((msg) => ({target, msg}));
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
	hits?: () => SearchHit[],
	page?: () => ContextPage
): void {
	if (take(client, request) && !request.expired) {
		const rows = hits?.();
		answer(client, request, status, error, rows, page?.());
	}
}

/** A closed `search` batch: the answer to the request it names, else the oldest. */
export const searchBatch: BatchHandler = (client, batch) => {
	noteTimes(client, batch.messages);
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

	noteTimes(client, batch.messages);
	const changes: LineChange[] = [];
	settle(
		client,
		request,
		"ok",
		undefined,
		() =>
			withUpdates(
				client,
				collect(client, batch.messages, batch.params[0]),
				batch.messages,
				changes
			),
		() => ({
			end: batch.tags.has("draft/chathistory-end"),
			changes,
			edges: {
				first: batch.messages.find((m) => m.tags.get("msgid"))?.tags.get("msgid"),
				last: batch.messages.findLast((m) => m.tags.get("msgid"))?.tags.get("msgid"),
			},
		})
	);
	return true;
}

/** `FAIL SEARCH <code> [context] :text`: the window shows it, the lobby does not. */
export function searchFailed(client: IrcClient, msg: IrcMessage): void {
	const request = searchFor(client, msg.tags.get("label"));

	// `FAIL SEARCH INVALID_PARAMS in`: this server searches one channel at a
	// time (soju). Ask about each instead, now and for the rest of the connection.
	if (
		request &&
		!request.group &&
		request.attrs &&
		!request.attrs.in &&
		msg.params[1] === "INVALID_PARAMS" &&
		msg.params[2]?.toLowerCase() === "in"
	) {
		needsIn.add(client);

		if (take(client, request) && !request.expired) {
			fanOut(client, request.requestId, request.attrs);
		}

		return;
	}

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

	// The queue they waited in is gone with the socket; a new one asks afresh,
	// and the next server may be another (an edited network).
	parentsAsked.delete(client);
	activeGroups.delete(client);
	needsIn.delete(client);
	timesByClient.delete(client);
}
