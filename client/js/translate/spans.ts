// Deterministic span protection (spec § prompt.ts): everything the client
// itself treats as syntax rather than prose — URLs, code, emoji shortcodes,
// IRC formatting codes, Markdown markers, a line's leading syntax and the
// channel's nicknames — is swapped for numbered placeholders before any
// engine sees the text and put back afterwards. Fidelity is the code's job,
// not the model's: for everything whose content is not to change, the
// engine only ever sees a placeholder where the syntax was.
//
// Three kinds of span, three restore policies (`restoreAll`):
//
//   verbatim  put back where it is found, appended at the end when lost
//   marker    one half of a pair; lose either half and neither goes back,
//             so a stray `*` is never left behind
//   prefix    a line's leading syntax; lost ⇒ re-prepended to its line
//
// `protect()` is the one canonical protection and always numbers every
// span. A marker pair is then *rendered* for the route the request is
// about to take (`renderMarkers`, `MarkerForm`), because a pair is the one
// span whose content the engine has to translate: a small LLM given
// `⟦1⟧German⟦2⟧` stops translating altogether, so the LLM route sees the
// marks themselves (`LLM_MARKERS`) while the seq2seq engines, which read no
// instructions, keep the placeholders. Rendering is a pure text pass over
// `protect()`'s output, so the reading queue can do it when the route is
// resolved rather than when the message was protected, and `restoreAll`
// reads whichever form its `Protected` says it is in.
//
// Vue-free and DOM-free, so mocha loads it (`test/translate/spans.ts`).

export const PLACEHOLDER_OPEN = "⟦"; // ⟦
export const PLACEHOLDER_CLOSE = "⟧"; // ⟧

export type SpanMeta =
	| {kind: "verbatim"}
	/**
	 * A placeholder the user typed (`protectTypedMarkers`). Verbatim in
	 * every restore policy, but never expanded as a nested span: its own
	 * text is placeholder-shaped, and reading it as one is the bug it is
	 * protected against.
	 */
	| {kind: "typed"}
	/** 1-based index of the other half of the pair. */
	| {kind: "marker"; partner: number}
	/** 0-based line of the protected text the prefix opened. */
	| {kind: "prefix"; line: number};

/**
 * How a marker pair is written in the text an engine sees. Everything else
 * — URLs, code, TeX, tables, nicknames, line prefixes — is a numbered
 * placeholder on every route, always.
 *
 *   placeholder  `⟦1⟧German⟦2⟧`, the seq2seq engines' form (no prompt to
 *                read an instruction from, so the code must do it all)
 *   literal      `*German*`, the marks as the user typed them
 *   tags         `<1>German</1>`, an XML-ish pair the number travels on
 *
 * The LLM route uses `LLM_MARKERS`; `tags` is reachable only from
 * `tools/translate-llm.ts --markers tags`, which is what it exists for.
 */
export type MarkerForm = "placeholder" | "literal" | "tags";

/**
 * What the LLM route asks `renderMarkers` for.
 *
 * Measured on the runner (`tools/translate-eval/markers.json`,
 * docs/resources/translation.md § Emphasis marks on the LLM route): with
 * bare `⟦n⟧` pairs *around words it must translate* the 1.7B model stops
 * translating — `please keep the *timestamps* in the log, I need the
 * **ordering**` came back as `⟧3⟧timestamps⟦4⟧ in der Log ⟦1⟧ordering⟦2⟧`,
 * the emphasised words untranslated and a mangled placeholder with them.
 * The same placeholders for URLs, code, nicknames and prefixes are fine,
 * because nothing inside them is meant to change; a mark is different, the
 * words between its halves have to move.
 */
export const LLM_MARKERS: MarkerForm = "literal";

export interface Protected {
	text: string;
	spans: string[];
	meta: SpanMeta[];
	/** The form `text`'s marker pairs are in; absent means `placeholder`. */
	markers?: MarkerForm;
}

export interface ProtectOptions {
	/** The channel's user list: a name is data, never something to translate. */
	nicks?: string[];
	/** The marker form for this route (`renderMarkers`); default `placeholder`. */
	markers?: MarkerForm;
}

// Order matters: a code span swallows the URL inside it, a URL swallows the
// shortcode-looking `:80:` inside it. Placeholders never match a later
// pattern (no letters, no colons, no control characters).
// A shortcode body must contain at least one letter, but :+1: and :-1: are
// special cases.
const PATTERNS: RegExp[] = [
	/`[^`\n]+`/g,
	/\bhttps?:\/\/[^\s<>()]+/gi,
	/\bwww\.[^\s<>()]+/gi,
	/:(?:[+-]1|(?=[a-z0-9_+-]*[a-z])[a-z0-9_+-]{2,}):/gi,
	/\x03(?:\d{1,2}(?:,\d{1,2})?)?|[\x02\x0f\x11\x16\x1d\x1e\x1f]/g,
];

/** A placeholder as the engines see it; the spaces a model may insert are tolerated. */
const PLACEHOLDER_RX = /⟦\s*(\d+)\s*⟧/g;

// The client's own emphasis markers (parseMarkdown.ts `EMPHASIS`), longest
// first so `**bold**` is one pair and not two nested italics. Each is a full
// pass over the previous pass's output, so `**bold *italic* bold**` still
// finds the inner pair.
const EMPHASIS_MARKERS = ["**", "__", "~~", "||", "*", "_"];

// A line's leading syntax: quote markers (nested), then one of a header, a
// bullet or an ordered item. `parseMarkdown.ts` renders a narrower set (`- `
// and `1. ` only), and protecting a little more than it renders is safe —
// a prefix span is put back byte for byte.
const PREFIX_RX = /^((?:> )*(?:#{1,6} |[-*+] |\d+[.)] )?)(.*)$/;

// A Markdown link's target: the placeholder a URL already became (the URL
// stage runs first), or a scheme the client itself linkifies.
const LINK_RX = /\[([^\]\n]+)\]\((⟦\s*\d+\s*⟧|(?:https?:\/\/|web\+irc:)[^\s)]*)\)/g;

const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}_]/u.test(c);

export function placeholder(n: number): string {
	return `${PLACEHOLDER_OPEN}${n}${PLACEHOLDER_CLOSE}`;
}

/** The placeholder numbers `text` carries, in order, without duplicates. */
export function placeholdersIn(text: string): number[] {
	const found: number[] = [];

	for (const match of text.matchAll(PLACEHOLDER_RX)) {
		const index = Number(match[1]);

		if (!found.includes(index)) {
			found.push(index);
		}
	}

	return found;
}

/** Collects the spans as the stages find them, keeping numbering global. */
class Spans {
	readonly spans: string[] = [];
	readonly meta: SpanMeta[] = [];

	push(text: string, meta: SpanMeta): string {
		this.spans.push(text);
		this.meta.push(meta);

		return placeholder(this.spans.length);
	}

	/** Two halves that stand or fall together. */
	pair(open: string, close: string): [string, string] {
		const first = this.spans.length + 1;
		const second = first + 1;

		this.spans.push(open, close);
		this.meta.push({kind: "marker", partner: second}, {kind: "marker", partner: first});

		return [placeholder(first), placeholder(second)];
	}
}

// A fenced block is one span, fences and inner newlines included, so the
// block's content is never split across the requests a multi-line message
// is translated by. The closing fence stands on a line of its own and is at
// least as long as the opening one.
function protectFences(text: string, spans: Spans): string {
	const lines = text.split("\n");
	const out: string[] = [];
	let i = 0;

	while (i < lines.length) {
		const open = /^(`{3,})/.exec(lines[i]);
		let close = -1;

		if (open) {
			for (let k = i + 1; k < lines.length; k++) {
				const end = /^(`{3,})\s*$/.exec(lines[k]);

				if (end && end[1].length >= open[1].length) {
					close = k;
					break;
				}
			}
		}

		if (close === -1) {
			out.push(lines[i]);
			i += 1;
			continue;
		}

		out.push(spans.push(lines.slice(i, close + 1).join("\n"), {kind: "verbatim"}));
		i = close + 1;
	}

	return out.join("\n");
}

// TeX, the client's own two shapes (parseMarkdown.ts math scan and
// mathBlock()): display math `$$…$$`, block-level like a fence and free to
// span lines, and inline math `` $`…`$ `` — the dollar-backtick shape,
// closed on the same line — is what keeps "$5 and $10" out of the maths.
// Each match is one verbatim span, fences included, and this runs before
// the inline-code pattern (so a backtick inside the TeX is never read as a
// code span) and before emphasis (so `_`/`^` inside TeX are not markers).
function protectMath(text: string, spans: Spans): string {
	let out = "";
	let i = 0;

	while (i < text.length) {
		if (text[i] === "$" && text[i + 1] === "$") {
			const close = text.indexOf("$$", i + 2);

			if (close > i + 2) {
				out += spans.push(text.slice(i, close + 2), {kind: "verbatim"});
				i = close + 2;
				continue;
			}
		} else if (text[i] === "$" && text[i + 1] === "`") {
			const close = text.indexOf("`$", i + 2);
			const lineEnd = text.indexOf("\n", i + 2);

			if (close > i + 2 && (lineEnd === -1 || close < lineEnd)) {
				out += spans.push(text.slice(i, close + 2), {kind: "verbatim"});
				i = close + 2;
				continue;
			}
		}

		out += text[i];
		i += 1;
	}

	return out;
}

// A row's cells, the client's own trimming rule (parseMarkdown.ts
// rowCells): the line must hold a pipe, and the outer pipes (with the
// padding right against them) are not cells.
function rowCells(line: string): string[] | undefined {
	if (!line.includes("|")) {
		return undefined;
	}

	let inner = line.trim();

	if (inner.startsWith("|")) {
		inner = inner.slice(1);
	}

	if (inner.endsWith("|")) {
		inner = inner.slice(0, -1);
	}

	return inner.split("|").map((cell) => cell.trim());
}

const SEP_CELL_RX = /^:?-+:?$/;

function protectRowPipes(line: string, spans: Spans): string {
	return line.replace(/\|/g, () => spans.push("|", {kind: "verbatim"}));
}

// A GFM pipe table, the client's own pre-pass (parseMarkdown.ts
// scanTables/tableAt): a header row, an alignment row (`|---|:-:|…`) with
// the same number of cells, then every following non-blank line that holds
// a pipe. The alignment row carries nothing to translate at all — one span
// for the whole line, re-prepended to its own line if the engine drops it —
// and every `|` that bounds a cell on the other rows is its own span, so
// what is left between them is the cell text, still open to every later
// stage (a URL or an emphasis pair inside a cell is still protected).
function protectTables(text: string, spans: Spans): string {
	const lines = text.split("\n");
	let i = 0;

	while (i < lines.length) {
		const head = rowCells(lines[i]);
		const sep = i + 1 < lines.length ? rowCells(lines[i + 1]) : undefined;

		if (
			!head ||
			!sep ||
			sep.length !== head.length ||
			!sep.every((cell) => SEP_CELL_RX.test(cell))
		) {
			i += 1;
			continue;
		}

		let end = i + 2;

		while (end < lines.length && lines[end].trim() !== "" && lines[end].includes("|")) {
			end += 1;
		}

		lines[i] = protectRowPipes(lines[i], spans);
		lines[i + 1] = spans.push(lines[i + 1], {kind: "prefix", line: i + 1});

		for (let row = i + 2; row < end; row++) {
			lines[row] = protectRowPipes(lines[row], spans);
		}

		i = end;
	}

	return lines.join("\n");
}

// `[text](target)`: the brackets are a marker pair and the link text is
// translated between them.
function protectLinks(text: string, spans: Spans): string {
	return text.replace(LINK_RX, (_match, label: string, target: string) => {
		const [open, close] = spans.pair("[", `](${target})`);

		return `${open}${label}${close}`;
	});
}

// The usual emphasis rule, conservatively: an opener has a non-word
// character (or nothing) before it and a word character after it, a closer
// the other way round. So `*German*` is emphasis and `2*3*4` is not.
function canOpen(text: string, at: number, len: number): boolean {
	return !isWordChar(text[at - 1]) && isWordChar(text[at + len]);
}

function canClose(text: string, at: number, len: number): boolean {
	return isWordChar(text[at - 1]) && !isWordChar(text[at + len]);
}

/** The first closer for `marker` after `from`, on the same line; -1 when there is none. */
function findCloser(text: string, from: number, marker: string): number {
	for (let i = from; i < text.length; i++) {
		if (text[i] === "\n") {
			return -1;
		}

		if (i > from && text.startsWith(marker, i) && canClose(text, i, marker.length)) {
			return i;
		}
	}

	return -1;
}

function protectMarker(text: string, marker: string, spans: Spans): string {
	const len = marker.length;
	let out = "";
	let i = 0;

	while (i < text.length) {
		if (!text.startsWith(marker, i) || !canOpen(text, i, len)) {
			out += text[i];
			i += 1;
			continue;
		}

		const close = findCloser(text, i + len, marker);

		if (close === -1) {
			out += text[i];
			i += 1;
			continue;
		}

		const [open, closer] = spans.pair(marker, marker);

		out += `${open}${text.slice(i + len, close)}${closer}`;
		i = close + len;
	}

	return out;
}

function protectEmphasis(text: string, spans: Spans): string {
	let out = text;

	for (const marker of EMPHASIS_MARKERS) {
		out = protectMarker(out, marker, spans);
	}

	return out;
}

function protectPrefixes(text: string, spans: Spans): string {
	return text
		.split("\n")
		.map((line, index) => {
			const match = PREFIX_RX.exec(line);

			// Nothing after the marker is not a header or a list item, and not
			// a licence to protect the whole line either.
			if (!match || match[1] === "" || match[2].trim() === "") {
				return line;
			}

			return `${spans.push(match[1], {kind: "prefix", line: index})}${match[2]}`;
		})
		.join("\n");
}

/**
 * An IRC channel name: `#` or `&` and at least two more characters that are
 * neither whitespace nor a comma (the separator of a channel list), not
 * preceded by a word character, and never running into a placeholder an
 * earlier stage left. A name is an address — nothing in it is prose — so it
 * is one verbatim span.
 *
 * The stage runs *after* `protectPrefixes`, which is what keeps `### Heading`
 * a header: `###` satisfies "two more characters", so a channel stage run
 * first would eat the header's marker and leave a bogus span behind. By the
 * time this runs the prefix is already a placeholder and there is no `#`
 * left to match. It is still after PATTERNS, so a channel inside a code
 * span or a URL belongs to them, and before `protectNicks`.
 *
 * It carries the `g` flag, so it is safe under `String.replace` (which
 * resets `lastIndex`) and **only** there: a `.test()` or a bare `.exec()`
 * against it would carry state from the previous call and answer for the
 * wrong offset. `eligibility.ts` uses it the same way.
 */
export const CHANNEL_RX = /(?<![\p{L}\p{N}_])[#&][^\s,\u27e6\u27e7]{2,}/gu;

/**
 * A sentence's punctuation off the end of a channel name. `.` and `:` are
 * legal in a channel name, so only a *trailing* run is the sentence's:
 * `#a.b` is whole, `treffen in #seance.` keeps its full stop as text (the
 * model needs the sentence to end) and fences the name alone.
 */
const CHANNEL_TAIL = /[.,;:!?)]+$/;

function protectChannels(text: string, spans: Spans): string {
	return text.replace(CHANNEL_RX, (match: string) => {
		const name = match.replace(CHANNEL_TAIL, "");

		// Trimmed below the sigil and two characters it was never a channel
		// name to begin with, so it stays the text it is.
		if (name.length < 3) {
			return match;
		}

		return `${spans.push(name, {kind: "verbatim"})}${match.slice(name.length)}`;
	});
}

// The channel's names, whole-word, longest first, never inside a
// placeholder an earlier stage left. The prompt still lists the names as
// data, so the model sees both the placeholder and the name it stands for.
//
// A big channel hands in a couple of thousand names for every line, so each
// is lowercased once and filed under its first (lowercased) character: a
// position only tries the names that can start there. Trying every name at
// every character cost ~20 ms for a 400-character line at 2000 names, and a
// history load runs 40 lines back to back.
function protectNicks(text: string, nicks: string[], spans: Spans): string {
	const candidates = [...new Set(nicks)]
		.filter((nick) => nick.length >= 2)
		.sort((a, b) => b.length - a.length);

	if (candidates.length === 0) {
		return text;
	}

	// Longest first within each bucket too: the sort above is stable and
	// the buckets are filled in its order.
	const byFirst = new Map<string, {nick: string; lower: string}[]>();

	for (const nick of candidates) {
		const lowerNick = nick.toLowerCase();
		const bucket = byFirst.get(lowerNick[0]);

		if (bucket) {
			bucket.push({nick, lower: lowerNick});
		} else {
			byFirst.set(lowerNick[0], [{nick, lower: lowerNick}]);
		}
	}

	const lower = text.toLowerCase();
	let out = "";
	let i = 0;

	while (i < text.length) {
		if (text[i] === PLACEHOLDER_OPEN) {
			const end = text.indexOf(PLACEHOLDER_CLOSE, i);

			if (end !== -1) {
				out += text.slice(i, end + 1);
				i = end + 1;
				continue;
			}
		}

		const nick = byFirst
			.get(lower[i])
			?.find(
				(candidate) =>
					lower.startsWith(candidate.lower, i) &&
					!isWordChar(text[i - 1]) &&
					!isWordChar(text[i + candidate.nick.length])
			)?.nick;

		if (nick) {
			out += spans.push(text.slice(i, i + nick.length), {kind: "verbatim"});
			i += nick.length;
			continue;
		}

		out += text[i];
		i += 1;
	}

	return out;
}

/**
 * Protect, stage by stage: each stage runs on the previous one's output, so
 * a placeholder never matches a later pattern. Fenced blocks, then TeX,
 * then pipe tables, then the opaque spans (code, URLs, shortcodes,
 * formatting codes), then links, emphasis pairs, line prefixes, the channel
 * names and finally the nicknames.
 */
export function protect(text: string, options: ProtectOptions = {}): Protected {
	const spans = new Spans();
	// The user's own brackets first, before anything can be numbered: `⟦2⟧`
	// is text somebody typed, and left alone it would be read as span 2 on
	// the way back and splice that span -- a URL, a nickname, half a code
	// span -- into the middle of the line. Protected here, it is a span like
	// any other: the engine never sees it, and it comes back as itself.
	let out = protectTypedMarkers(text, spans);

	out = protectFences(out, spans);

	out = protectMath(out, spans);
	out = protectTables(out, spans);

	for (const pattern of PATTERNS) {
		out = out.replace(pattern, (match: string) => spans.push(match, {kind: "verbatim"}));
	}

	out = protectLinks(out, spans);
	out = protectEmphasis(out, spans);
	out = protectPrefixes(out, spans);
	out = protectChannels(out, spans);
	out = protectNicks(out, options.nicks ?? [], spans);

	return renderMarkers(
		{text: out, spans: spans.spans, meta: spans.meta, markers: "placeholder"},
		options.markers ?? "placeholder"
	);
}

/**
 * A placeholder the user typed, as one verbatim span. First of the stages,
 * so no later pattern and no restore ever mistakes it for one of the
 * protection's own numbers; a single `replace` pass never re-reads its own
 * output, so the placeholder it leaves behind is not matched again.
 */
function protectTypedMarkers(text: string, spans: Spans): string {
	return text.replace(PLACEHOLDER_RX, (match: string) => spans.push(match, {kind: "typed"}));
}

/** `<1>` and `</1>`: a marker pair in `tags` form. */
const TAG_RX = /<(\/?)(\d+)>/g;

/** A marker half that is nothing but syntax: no span of its own inside it. */
function isPlainMarker(span: string): boolean {
	return !span.includes(PLACEHOLDER_OPEN);
}

/**
 * `protect()`'s output with its marker pairs written in `form`. Only marker
 * spans move; a URL, a code span, a nickname, a table or a line prefix is a
 * numbered placeholder on every route, and the numbering itself never
 * changes — so the same `Protected` restores the answer whichever form it
 * went out in.
 *
 * `literal` puts every half back into the text as the user typed it (`*`,
 * `**`, `~~`, `||`, and a link's `[` and `](⟦n⟧)` both), and with it goes
 * the guarantee that a pair cannot be half-lost: what the model returns is
 * what the user sees, marks included, and a mark the model drops is simply
 * gone — which still leaves a correctly translated sentence, unlike a
 * placeholder it mangles. A link's target stays hidden all the same: its
 * `](…)` half carries the placeholder the URL stage already made of it, so
 * the model is shown well-formed markdown around a number it cannot read.
 * Handing it the brief's half-literal `[the log⟦3⟧` instead was measured
 * and cost the case: `*now*` came back untranslated.
 *
 * `tags` renders a pair as `<n>…</n>` on the *opening* half's number (the
 * halves of a pair are always pushed consecutively, so its partner is
 * `n + 1`); a pair that is not symmetrical syntax — the link again — keeps
 * its placeholders.
 */
export function renderMarkers(info: Protected, form: MarkerForm): Protected {
	if (form === "placeholder" || (info.markers ?? "placeholder") === form) {
		return info;
	}

	const text = info.text.replace(PLACEHOLDER_RX, (match, n: string) => {
		const index = Number(n);
		const own = info.meta[index - 1];

		if (!own || own.kind !== "marker") {
			return match;
		}

		const open = Math.min(index, own.partner);
		const close = Math.max(index, own.partner);

		if (form === "tags") {
			const symmetrical =
				isPlainMarker(info.spans[open - 1]) && isPlainMarker(info.spans[close - 1]);

			if (!symmetrical) {
				return match;
			}

			return index === open ? `<${open}>` : `</${open}>`;
		}

		return info.spans[index - 1];
	});

	// The numbering and what each span is are untouched: only how a pair is
	// written changed, so `info`'s own spans and meta restore the answer.
	return {text, spans: info.spans, meta: info.meta, markers: form};
}

/**
 * A `tags` answer as the rest of the module reads it: every tag the spans
 * actually account for back to its placeholder, so the orphan rule, the
 * missing report and `expandSpan` all work on one form. A tag number that
 * is not a marker pair's opening half is text the engine (or the user)
 * wrote — `<3>` is left alone.
 */
function untag(text: string, info: Protected): string {
	return text.replace(TAG_RX, (match, slash: string, digits: string) => {
		const index = Number(digits);
		const meta = info.meta[index - 1];

		if (!meta || meta.kind !== "marker" || meta.partner !== index + 1) {
			return match;
		}

		return placeholder(slash === "" ? index : index + 1);
	});
}

/**
 * A span's own text, with any placeholder inside it resolved as well: a
 * link's `](target)` half carries the placeholder the URL stage already
 * made of its target, and a span put back by a plain `replace` would
 * otherwise leave that number showing. `seen` collects what came back that
 * way, so a nested span is never also reported lost.
 */
function expandSpan(
	spans: string[],
	index: number,
	seen: Set<number>,
	depth = 0,
	meta?: SpanMeta[]
): string {
	const raw = spans[index - 1];

	// A placeholder the user typed is its own text, whatever number is in it.
	if (depth >= 4 || meta?.[index - 1]?.kind === "typed" || !raw.includes(PLACEHOLDER_OPEN)) {
		return raw;
	}

	return raw.replace(PLACEHOLDER_RX, (match, n: string) => {
		const nested = Number(n);

		if (nested < 1 || nested > spans.length || nested === index) {
			return match;
		}

		seen.add(nested);

		return expandSpan(spans, nested, seen, depth + 1, meta);
	});
}

/** `meta` tells a placeholder the user typed from one of the protection's own. */
export function restore(
	text: string,
	spans: string[],
	meta?: SpanMeta[]
): {text: string; missing: number[]} {
	const seen = new Set<number>();
	const out = text.replace(PLACEHOLDER_RX, (match, n: string) => {
		const index = Number(n);

		if (index >= 1 && index <= spans.length) {
			seen.add(index);
			return expandSpan(spans, index, seen, 0, meta);
		}

		return match;
	});
	const missing = spans.map((_, i) => i + 1).filter((i) => !seen.has(i));

	return {text: out, missing};
}

/** The lost spans, in order, after the text: better shown late than lost. */
export function appendMissing(text: string, spans: string[], missing: number[]): string {
	if (missing.length === 0) {
		return text;
	}

	return `${text} ${missing.map((i) => spans[i - 1]).join(" ")}`;
}

/**
 * The full restore: placeholders put back where the engine left them, each
 * kind of lost span handled by its own policy, and a placeholder number the
 * engine invented dropped rather than shown.
 *
 * `expected` is the spans that were in *this* request's input — the lines of
 * one message are translated separately but share one numbering, so a line's
 * restore must not go looking for another line's spans. Given it, a lost
 * prefix goes to the front of the output; without it (a whole text restored
 * in one go) it goes back to its own line, as long as the line count held.
 */
export function restoreAll(text: string, info: Protected, expected?: number[]): string {
	// A `tags` answer is read as placeholders: the pairs the spans account
	// for become `⟦n⟧` again and everything below is one code path.
	const carried = info.markers === "tags" ? untag(text, info) : text;
	// What the engine was given, not every span there is: a span nested
	// inside another (a link's target) travels with its parent.
	const want = expected ?? placeholdersIn(info.text);
	const found = new Set(placeholdersIn(carried).filter((i) => i >= 1 && i <= info.spans.length));
	// Half a pair is no use: put back neither, rather than a stray `*`.
	const orphaned = new Set(
		[...found].filter((i) => {
			const meta = info.meta[i - 1];

			return meta.kind === "marker" && !found.has(meta.partner);
		})
	);

	let out = carried.replace(PLACEHOLDER_RX, (_match, n: string) => {
		const index = Number(n);

		if (index < 1 || index > info.spans.length || orphaned.has(index)) {
			return "";
		}

		return expandSpan(info.spans, index, found, 0, info.meta);
	});

	const missing = want.filter((i) => !found.has(i) || orphaned.has(i));
	const prefixes = missing.filter((i) => info.meta[i - 1]?.kind === "prefix");

	if (prefixes.length > 0) {
		const lines = out.split("\n");
		const perLine = expected === undefined && lines.length === info.text.split("\n").length;

		for (const index of prefixes) {
			const meta = info.meta[index - 1];
			const line = perLine && meta.kind === "prefix" ? meta.line : 0;

			lines[line] = `${info.spans[index - 1]}${lines[line]}`;
		}

		out = lines.join("\n");
	}

	// A lost marker takes its partner with it and neither is appended; a
	// lost prefix is back on its line. What is left is verbatim: better
	// shown late than lost.
	const lost = missing.filter((i) => {
		const kind = info.meta[i - 1]?.kind;

		return kind === "verbatim" || kind === "typed";
	});

	return lost.length === 0
		? out
		: `${out} ${lost.map((i) => expandSpan(info.spans, i, new Set(), 0, info.meta)).join(" ")}`;
}

/**
 * A sender's name the model copied from the context, off the front of a
 * translation. The prompt renders the earlier lines as `nick: text`, so the
 * model picks that shape up as readily as the `<nick>` one `cleanOutput`
 * strips — and `cleanOutput` cannot strip this one generically, because
 * `Moment: bitte warten` is a translation, not a prefix. So only a name the
 * channel actually has counts: the token before the separator is matched
 * case-insensitively (the model capitalises freely) against the channel's
 * own list. The separator is `:`, `-` or `–` followed by a space, so the
 * strip never crosses into the next line of a multi-line translation.
 * Vue-free, store-free, DOM-free.
 */
export function stripNickPrefix(text: string, nicks: string[]): string {
	const match = /^[ \t]*(\S{1,32}?)[ \t]*[:\-–][ \t]+/.exec(text);

	if (!match) {
		return text;
	}

	const found = match[1].toLowerCase();

	if (!nicks.some((nick) => nick.toLowerCase() === found)) {
		return text;
	}

	return text.slice(match[0].length);
}

/**
 * The prefix off a translation — unless the text it was translated from
 * carried one too. `alice: kannst du das prüfen?` is the commonest shape
 * there is on IRC, and nick protection sees it through the engine intact,
 * so stripping it would throw away who the line was addressed to. Only a
 * prefix the model added is the model's to lose.
 */
export function stripCopiedNickPrefix(
	translation: string,
	source: string,
	nicks: string[]
): string {
	return stripNickPrefix(source, nicks) === source
		? stripNickPrefix(translation, nicks)
		: translation;
}
