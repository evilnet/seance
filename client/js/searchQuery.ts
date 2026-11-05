// The search window's one piece of state: the query string in the route
// (`?q=`). Typed filters and the chips edit the same string, so there is
// nothing to keep in step. Pure: no store, no DOM, runs under mocha.
//
//   fake lag "exact phrase" -docker from:kitten account:kit in:#seance
//   in:* has:link has:image after:2026-10-01 before:2026-11-01
//
// The server can do one nick, one substring and a time window, newest first
// (see `serverAttrs`). `matchesFilters` does the rest here, on what comes back.

import {findLinks} from "../../shared/linkify";
import {escapeRegExp} from "./highlight";
import type {SearchAttrs} from "../../shared/types/search";
import {MessageType, type SharedMsg} from "../../shared/types/msg";

/** Message types whose `text` is user chat rather than protocol noise. */
const SEARCHABLE_MESSAGE_TYPES: ReadonlySet<MessageType> = new Set<MessageType>([
	MessageType.MESSAGE,
	MessageType.ACTION,
	MessageType.NOTICE,
]);

export type SearchHas = "link" | "image";

export interface SearchFilters {
	/** All of these, each a word or a phrase. */
	words: string[];
	/** None of these. */
	without: string[];
	from?: string;
	account?: string;
	/** A channel or a nick; `*` is every channel the user is in. */
	in?: string;
	has: SearchHas[];
	/** `YYYY-MM-DD`, from the start of that day. */
	after?: string;
	/** `YYYY-MM-DD`, up to the start of that day. */
	before?: string;
}

export const ALL_CHANNELS = "*";

const VALUE_KEYS = new Set(["from", "account", "in", "has", "after", "before"]);
const TOKEN = /(-)?(?:"([^"]*)"?|(\S+))/g;
const KEYED = /^([a-z]+):(.+)$/i;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const IMAGE = /\bhttps?:\/\/\S+\.(?:png|jpe?g|gif|webp|avif|svg)(?:[?#]\S*)?(?:\s|$)/i;

/** Local midnight of a `YYYY-MM-DD`, undefined when there is no such day. */
export function dayStart(value: string): Date | undefined {
	const match = DATE.exec(value);

	if (!match) {
		return undefined;
	}

	const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
	const date = new Date(year, month - 1, day);

	return date.getMonth() === month - 1 && date.getDate() === day ? date : undefined;
}

export function parseSearchQuery(raw: string): SearchFilters {
	const filters: SearchFilters = {words: [], without: [], has: []};

	for (const [, minus, quoted, bare] of raw.matchAll(TOKEN)) {
		if (quoted !== undefined) {
			if (quoted) {
				(minus ? filters.without : filters.words).push(quoted);
			}

			continue;
		}

		if (minus) {
			filters.without.push(bare);
			continue;
		}

		if (!applyKeyed(filters, bare)) {
			filters.words.push(bare);
		}
	}

	return filters;
}

/** A recognised `key:value`; anything else (`http://x`, `after:soon`) is a word. */
function applyKeyed(filters: SearchFilters, token: string): boolean {
	const match = KEYED.exec(token);
	const key = match?.[1].toLowerCase() ?? "";
	const value = match?.[2] ?? "";

	if (!VALUE_KEYS.has(key)) {
		return false;
	}

	switch (key) {
		case "from":
			filters.from = value;
			return true;
		case "account":
			filters.account = value;
			return true;
		case "in":
			filters.in = value;
			return true;
		case "has": {
			const kind = value.toLowerCase();

			if (kind !== "link" && kind !== "image") {
				return false;
			}

			if (!filters.has.includes(kind)) {
				filters.has.push(kind);
			}

			return true;
		}
		default:
			if (!dayStart(value)) {
				return false;
			}

			filters[key as "after" | "before"] = value;
			return true;
	}
}

function quoteIfNeeded(word: string): string {
	const clean = word.replaceAll('"', "");
	const keyed = KEYED.exec(clean);
	const needs =
		/\s/.test(clean) ||
		clean.startsWith("-") ||
		(keyed !== null && VALUE_KEYS.has(keyed[1].toLowerCase()));

	return needs ? `"${clean}"` : clean;
}

/** The query string for `filters`: words first, then the filters. */
export function formatSearchQuery(filters: SearchFilters): string {
	const parts = filters.words.map(quoteIfNeeded);

	for (const word of filters.without) {
		parts.push(`-${/\s/.test(word) ? `"${word.replaceAll('"', "")}"` : word}`);
	}

	for (const key of ["in", "from", "account"] as const) {
		const value = filters[key];

		if (value) {
			parts.push(`${key}:${value}`);
		}
	}

	parts.push(...filters.has.map((kind) => `has:${kind}`));

	for (const key of ["after", "before"] as const) {
		const value = filters[key];

		if (value) {
			parts.push(`${key}:${value}`);
		}
	}

	return parts.join(" ");
}

/** Whether there is anything to look for; `in:` and `-word` alone are not. */
export function hasCriteria(filters: SearchFilters): boolean {
	return (
		filters.words.length > 0 ||
		filters.has.length > 0 ||
		Boolean(filters.from || filters.account || filters.after || filters.before)
	);
}

/**
 * What goes to the server. It takes one substring: the longest word, the one
 * that narrows most. `has:` with no words asks for `http`, since a link has it.
 * `olderThan` is the paging cursor, the time of the oldest row so far.
 */
export function serverAttrs(
	filters: SearchFilters,
	defaultIn: string,
	olderThan?: Date,
	limit?: number
): SearchAttrs {
	const attrs: SearchAttrs = {};
	const target = filters.in ?? defaultIn;

	if (target !== ALL_CHANNELS) {
		attrs.in = target;
	}

	if (filters.from) {
		attrs.from = filters.from;
	}

	if (filters.words.length > 0) {
		attrs.text = filters.words.reduce((a, b) => (b.length > a.length ? b : a));
	} else if (filters.has.includes("image")) {
		attrs.text = "http";
	}

	if (filters.after) {
		attrs.after = dayStart(filters.after)?.toISOString();
	}

	const before = filters.before ? dayStart(filters.before) : undefined;
	const bound =
		olderThan && before ? (olderThan < before ? olderThan : before) : olderThan ?? before;

	if (bound) {
		attrs.before = bound.toISOString();
	}

	if (limit) {
		attrs.limit = limit;
	}

	return attrs;
}

type Identifiable = Pick<SharedMsg, "msgid" | "time" | "from" | "text">;

/** Who a row is across pages: its msgid, or what it says on a server without them. */
export function rowKey(msg: Identifiable): string {
	return msg.msgid ?? `${new Date(msg.time).getTime()}|${msg.from?.nick ?? ""}|${msg.text ?? ""}`;
}

type Searchable = Pick<SharedMsg, "text" | "type" | "time" | "from" | "fromAccount">;

/**
 * Whether `msg` passes every filter but `in`, which picks the conversations.
 * Server rows pass again what the server already checked; the loaded-messages
 * fallback relies on it all. Text is compared as sent, formatting codes and all.
 */
export function matchesFilters(msg: Searchable, filters: SearchFilters): boolean {
	if (!SEARCHABLE_MESSAGE_TYPES.has(msg.type ?? MessageType.MESSAGE)) {
		return false;
	}

	const text = msg.text ?? "";
	const lower = text.toLowerCase();

	if (!filters.words.every((word) => lower.includes(word.toLowerCase()))) {
		return false;
	}

	if (filters.without.some((word) => lower.includes(word.toLowerCase()))) {
		return false;
	}

	if (filters.from && msg.from?.nick?.toLowerCase() !== filters.from.toLowerCase()) {
		return false;
	}

	if (filters.account && msg.fromAccount?.toLowerCase() !== filters.account.toLowerCase()) {
		return false;
	}

	if (filters.has.includes("link") && findLinks(text).length === 0) {
		return false;
	}

	if (filters.has.includes("image") && !IMAGE.test(text)) {
		return false;
	}

	const time = new Date(msg.time).getTime();
	const after = filters.after ? dayStart(filters.after) : undefined;
	const before = filters.before ? dayStart(filters.before) : undefined;

	return !(after && time < after.getTime()) && !(before && time >= before.getTime());
}

/** Where `words` occur in `text`, as [start, end] offsets into `text` itself. */
export function matchSpans(text: string, words: string[]): [number, number][] {
	return words
		.filter((word) => word !== "")
		.flatMap((word) =>
			Array.from(
				text.matchAll(new RegExp(escapeRegExp(word), "giu")),
				(match): [number, number] => [match.index, match.index + match[0].length]
			)
		);
}
