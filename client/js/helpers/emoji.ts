/**
 * Emoji lookup for the reaction picker, and the rules a reaction's text obeys
 * before it goes on the wire.
 *
 * A reaction is not necessarily one emoji: `+draft/react` carries free text,
 * so "lol", "🎉🎉🎉" and ":tada:" are all reactions somebody can send, and the
 * picker's search field is also where they are typed. Everything here is
 * therefore string-in, string-out — no Vue, no store, no DOM, so mocha can
 * load it (`test/helpers/emoji.ts`).
 *
 * The catalog itself is a separate chunk (`emoji-catalog.ts`), fetched the
 * first time somebody opens the picker and kept for the rest of the session.
 */

import emojiRegExp from "emoji-regex";
import findShortcode from "./ircmessageparser/findShortcode";
import shortcodes from "./ircmessageparser/shortcodes.json";
import type {EmojiEntry, EmojiGroup} from "./emoji-catalog";

export type {EmojiEntry, EmojiGroup};

/**
 * Longest reaction we send, in code points. Reactions ride along as a message
 * tag, and `IrcClient.sendTagmsg` refuses a line over `MAX_LINE_BYTES`: 64
 * code points of emoji (4 bytes each, doubled by escaping in the worst case)
 * still leaves room for the reply tag and the target.
 */
export const MAX_REACTION_LENGTH = 64;

const emojiRx = emojiRegExp();

let pending: Promise<EmojiGroup[]> | undefined;

/**
 * The catalog, loaded once. Concurrent callers share the one request; a
 * failed load is not cached, so a picker opened again retries.
 */
export function loadEmojiCatalog(): Promise<EmojiGroup[]> {
	if (!pending) {
		pending = import("./emoji-catalog")
			.then((module) => module.default)
			.catch((error) => {
				pending = undefined;
				throw error;
			});
	}

	return pending;
}

/** How long a busy page may put the prefetch off before it goes anyway. */
const PREFETCH_TIMEOUT_MS = 10000;

/**
 * Fetch the catalog when the page has nothing better to do, so the first
 * picker opens on a grid and not on "Loading emoji…". Hover preloads it on a
 * desktop, but that gives a slow phone on a slow network well under a
 * second; the first conversation opening gives it the whole idle period
 * after connecting. `loadEmojiCatalog` is the memo: a second call while a
 * load is pending or done schedules nothing.
 */
export function prefetchEmojiCatalog(): void {
	if (pending) {
		return;
	}

	const go = () => void loadEmojiCatalog().catch(() => undefined);

	if (typeof requestIdleCallback === "function") {
		requestIdleCallback(go, {timeout: PREFETCH_TIMEOUT_MS});
	} else {
		// Safari: no idle callback, so a pause is what stands in for one.
		setTimeout(go, 3000);
	}
}

const aliases = shortcodes as Record<string, string>;

/**
 * The emoji `name` is an alias for, if there is one: `tada`, `:tada:` and
 * `TADA` all give 🎉. This is what decides whether somebody typing in the
 * picker meant an emoji or meant the words they typed — an exact alias is an
 * emoji, anything else is text until they pick otherwise.
 */
export function emojiForName(name: string): string | undefined {
	return aliases[
		name
			.trim()
			.toLowerCase()
			.replace(/^:+|:+$/g, "")
	];
}

/** Every entry of every group, in the order the picker lists them. */
export function flatten(groups: EmojiGroup[]): EmojiEntry[] {
	return groups.flatMap((group) => group.emoji);
}

/**
 * `:tada:` → `🎉`, for every alias the shortcode finder knows. Unknown
 * `:words:` are left alone: they are as likely to be part of a sentence
 * somebody means to send as a mistyped alias.
 */
export function expandShortcodes(text: string): string {
	const found = findShortcode(text);

	if (found.length === 0) {
		return text;
	}

	let out = "";
	let at = 0;

	for (const part of found) {
		out += text.slice(at, part.start) + part.emoji;
		at = part.end;
	}

	return out + text.slice(at);
}

/**
 * What a typed reaction becomes on the wire: shortcodes expanded, control
 * characters and runs of whitespace flattened to single spaces, trimmed, and
 * cut to {@link MAX_REACTION_LENGTH} code points (`slice` would split a
 * surrogate pair). Returns "" for anything that is only whitespace, which is
 * the caller's cue not to send.
 */
export function normalizeReaction(text: string): string {
	const flattened = expandShortcodes(text)
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();

	const points = Array.from(flattened);

	return points.length > MAX_REACTION_LENGTH
		? points.slice(0, MAX_REACTION_LENGTH).join("").trim()
		: flattened;
}

/**
 * `addition` tacked onto the reaction `current` is being built: how a
 * shift-click in the picker grows `🎉` into `🎉🔥`. Emoji sit flush against
 * each other, which is the whole point; anything with a word in it keeps a
 * space so the words stay words. An addition that would take the reaction
 * past {@link MAX_REACTION_LENGTH} is refused rather than silently cut, since
 * the caller can still see what it already has.
 */
export function appendReaction(current: string, addition: string): string {
	const add = addition.trim();

	if (add.length === 0) {
		return current;
	}

	const joined =
		current.length === 0
			? add
			: isEmojiOnly(current) && isEmojiOnly(add)
			? current + add
			: `${current.replace(/\s+$/, "")} ${add}`;

	return Array.from(joined).length > MAX_REACTION_LENGTH ? current : joined;
}

/** True when `text` is emoji and nothing else — how a badge decides its size. */
export function isEmojiOnly(text: string): boolean {
	const trimmed = text.trim();

	return trimmed.length > 0 && trimmed.replace(emojiRx, "").trim().length === 0;
}

/**
 * True when `text` is exactly one emoji — a flag, a keycap or a ZWJ family
 * counts as one, `🎉🎉🎉` and `👍 ❤️` do not. What fits in a toolbar button
 * the width of a glyph.
 */
export function isSingleEmoji(text: string): boolean {
	const trimmed = text.trim();
	const found = Array.from(trimmed.matchAll(emojiRx));

	return found.length === 1 && found[0][0] === trimmed;
}

// A query is split on whitespace and the separators shortcodes use, so
// "flag de", "thumbs_up" and "thumbs up" all find what they mean to.
const SEPARATORS = /[\s_-]+/;

/**
 * How well `entry` matches one search token — lower is better, undefined is
 * "not a match". The ladder is the usual one: the name someone typed in full
 * beats a name they started typing, which beats a word from the description,
 * which beats a fragment from anywhere.
 */
function scoreToken(entry: EmojiEntry, token: string): number | undefined {
	if (entry.emoji === token) {
		return 0; // pasted the emoji itself
	}

	if (entry.name === token) {
		return 1;
	}

	if (entry.name.startsWith(token)) {
		return 2;
	}

	if (entry.haystack.includes(` ${token}`)) {
		return 3; // start of some word in the description or keywords
	}

	return entry.haystack.includes(token) ? 4 : undefined;
}

/**
 * The emoji matching `query`, best first, at most `limit` of them. Every
 * token has to match something (`red heart` finds ❤️, not every red thing),
 * and entries that tie keep catalog order, which is Unicode's.
 */
export function searchEmoji(groups: EmojiGroup[], query: string, limit = 120): EmojiEntry[] {
	// `:tada:` and `tada` are the same search; so are "Thumbs Up" and "thumbs up".
	const cleaned = query
		.trim()
		.toLowerCase()
		.replace(/^:+|:+$/g, "");
	const tokens = cleaned.split(SEPARATORS).filter((token) => token.length > 0);

	if (tokens.length === 0) {
		return [];
	}

	// The whole query as one name, so `sweat_smile` (which tokenises into two
	// words) still ranks as the exact hit it is.
	const asName = cleaned.replace(/[\s_-]+/g, "_");
	const scored: {entry: EmojiEntry; score: number; index: number}[] = [];
	let index = 0;

	for (const entry of flatten(groups)) {
		let score = entry.name === asName ? -1 : 0;

		for (const token of tokens) {
			const part = scoreToken(entry, token);

			if (part === undefined) {
				score = NaN;
				break;
			}

			score += part;
		}

		if (!Number.isNaN(score)) {
			scored.push({entry, score, index});
		}

		index++;
	}

	scored.sort((a, b) => a.score - b.score || a.index - b.index);

	return scored.slice(0, limit).map((hit) => hit.entry);
}
