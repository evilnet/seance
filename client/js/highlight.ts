/**
 * Highlight detection for incoming messages.
 *
 * Ported from TheLounge's server-side implementation
 * (`attic/server/client.ts` `compileCustomHighlights` for the custom keyword
 * regex and `attic/server/models/network.ts` `setNick` for the nick regex).
 * Runs entirely in the browser now: no Node built-ins, no dependencies.
 *
 * Behaviour:
 * - matching is case-insensitive (with unicode case folding);
 * - the nick and every keyword are treated as literal strings;
 * - the nick must not be embedded in a longer alphanumeric word
 *   (`nickname` does not match `nick`, but `nick:` / `(nick)` / `nick's` do);
 * - keywords must be delimited by start/end of text or by the same
 *   punctuation set the old server used;
 * - IRC formatting codes (bold, colours, ...) are stripped before testing;
 * - if the text matches any highlight *exception* it is never a highlight.
 */

/** Escape every regular-expression metacharacter in `s` so it matches literally. */
export function escapeRegExp(s: string): string {
	return s.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/**
 * Split a comma-separated settings string (`highlights`, `highlightExceptions`)
 * into trimmed, non-empty tokens.
 */
export function parseKeywordList(value: string | undefined): string[] {
	if (typeof value !== "string") {
		return [];
	}

	return value
		.split(",")
		.map((keyword: string) => keyword.trim())
		.filter((keyword: string) => keyword.length > 0);
}

// Same set as shared/irc.ts cleanIrcMessage(), inlined to keep this module standalone.
const ircFormatting =
	/\x02|\x1D|\x1F|\x16|\x0F|\x11|\x1E|\x03(?:[0-9]{1,2}(?:,[0-9]{1,2})?)?|\x04(?:[0-9a-f]{6}(?:,[0-9a-f]{6})?)?/gi;

function stripIrcFormatting(text: string): string {
	return text.replace(ircFormatting, "");
}

// Characters allowed to surround a custom keyword (from the old server).
const keywordLeading = "[ .,+!?|/:<>(){}'\"@&~-]";
const keywordTrailing = "[ .,+!?|/:<>(){}'\"-]";

/** Pattern matching any of `keywords` as a delimited token, or null if none. */
function keywordPattern(keywords: string[]): string | null {
	const tokens = keywords
		.map((keyword: string) => escapeRegExp(keyword.trim()))
		.filter((keyword: string) => keyword.length > 0);

	if (tokens.length === 0) {
		return null;
	}

	return `(?:^|${keywordLeading})(?:${tokens.join("|")})(?:$|${keywordTrailing})`;
}

/** Pattern matching `nick` not embedded in a longer alphanumeric word, or null if empty. */
function nickPattern(nick: string): string | null {
	const trimmed = nick.trim();

	if (trimmed.length === 0) {
		return null;
	}

	return `(?:^|[^a-z0-9])${escapeRegExp(trimmed)}(?:[^a-z0-9]|$)`;
}

/**
 * Build a single case-insensitive regex that matches text mentioning `nick`
 * or any of `keywords`. When `exceptions` is given and non-empty, the regex
 * additionally refuses to match any text containing one of the exceptions.
 *
 * Returns null when there is nothing to match (empty nick and no keywords).
 * The returned regex is not global/sticky, so `test()` is stateless.
 */
export function buildHighlightRegex(
	nick: string,
	keywords: string[],
	exceptions?: string[]
): RegExp | null {
	const alternatives: string[] = [];
	const nickPart = nickPattern(nick);
	const keywordPart = keywordPattern(keywords);

	if (nickPart !== null) {
		alternatives.push(nickPart);
	}

	if (keywordPart !== null) {
		alternatives.push(keywordPart);
	}

	if (alternatives.length === 0) {
		return null;
	}

	const positive = `(?:${alternatives.join("|")})`;
	const exceptionPart = exceptions ? keywordPattern(exceptions) : null;

	if (exceptionPart === null) {
		return new RegExp(positive, "iu");
	}

	// Anchor at the start, reject the whole text if an exception occurs
	// anywhere, then scan forward for a positive match.
	return new RegExp(`^(?![\\s\\S]*?${exceptionPart})[\\s\\S]*?${positive}`, "iu");
}

/**
 * Whether `text` matches any highlight exception on its own. For highlights
 * not derived from the text (a private message auto-highlight, say) there is
 * no positive regex to fold the exceptions into; this checks them alone, the
 * way the old server ran its exception regex over every highlight
 * (`attic/server/plugins/irc-events/message.ts`). IRC formatting is stripped
 * first.
 */
export function isHighlightException(text: string, exceptions: string[]): boolean {
	const pattern = keywordPattern(exceptions);

	if (pattern === null) {
		return false;
	}

	return new RegExp(pattern, "iu").test(stripIrcFormatting(text));
}

/**
 * Whether `text` should be highlighted for a user with `nick` and the given
 * custom `keywords`, honouring `exceptions`. IRC formatting is stripped first.
 */
export function isHighlight(
	text: string,
	nick: string,
	keywords: string[],
	exceptions?: string[]
): boolean {
	const regex = buildHighlightRegex(nick, keywords, exceptions);

	if (regex === null) {
		return false;
	}

	return regex.test(stripIrcFormatting(text));
}

/**
 * {@link isHighlight} / {@link isHighlightException} with the compiled
 * regexes cached until the nick, keywords or exceptions change. One tester
 * per consumer (IrcClient keeps one per network): the cache holds a single
 * entry keyed on the inputs, so a settings or nick change simply recompiles.
 */
export function createHighlightTester() {
	// NUL never appears in a nick or a settings keyword, so joined keys
	// cannot collide (["a b"] vs ["a", "b"]).
	const SEP = "\x00";
	let key: string | null = null;
	let regex: RegExp | null = null;
	let exceptionKey: string | null = null;
	let exceptionRegex: RegExp | null = null;
	let findKey: string | null = null;
	let findRegex: RegExp | null = null;

	return {
		isHighlight(text: string, nick: string, keywords: string[], exceptions: string[]) {
			const wanted = [nick, ...keywords, SEP, ...exceptions].join(SEP);

			if (key !== wanted) {
				key = wanted;
				regex = buildHighlightRegex(nick, keywords, exceptions);
			}

			return regex !== null && regex.test(stripIrcFormatting(text));
		},
		isHighlightException(text: string, exceptions: string[]) {
			const wanted = exceptions.join(SEP);

			if (exceptionKey !== wanted) {
				exceptionKey = wanted;
				const pattern = keywordPattern(exceptions);
				exceptionRegex = pattern === null ? null : new RegExp(pattern, "iu");
			}

			return exceptionRegex !== null && exceptionRegex.test(stripIrcFormatting(text));
		},
		/**
		 * Where in `plain` (text without IRC formatting) the nick or a
		 * keyword first occurs, -1 if nowhere. Built without the exceptions,
		 * whose form is anchored at the start and so always matches at 0.
		 */
		mentionIndex(plain: string, nick: string, keywords: string[]) {
			const wanted = [nick, ...keywords].join(SEP);

			if (findKey !== wanted) {
				findKey = wanted;
				findRegex = buildHighlightRegex(nick, keywords);
			}

			return findRegex?.exec(plain)?.index ?? -1;
		},
	};
}
