/**
 * Discord-style Markdown for message text.
 *
 * `applyMarkdown` is the interface: it takes the fragments `parseStyle`
 * produced, drops the marker characters, sets the Markdown flags and reports
 * the verbatim spans. The scan itself (`scan`/`cutPieces`) is private — nothing
 * outside this file needs the marker offsets.
 *
 * Imports nothing from Vue, the store or the DOM, so mocha loads it directly
 * (`test/helpers/parseMarkdown.ts`).
 */

import {findLinks} from "../../../../shared/linkify";
import {HeaderLevel, ParsedStyle, STYLE_KEYS} from "./parseStyle";

export type Range = {start: number; end: number};

// What the markers made of a piece of text. `verbatim` means "nothing is
// interpreted here" — the finders skip it; inline code also sets `monospace`,
// a fenced block sets `codeBlock` and, when the fence named one, `lang`.
export type PieceFlags = {
	bold?: true;
	italic?: true;
	underline?: true;
	strikethrough?: true;
	monospace?: true;
	codeBlock?: true;
	quote?: true;
	spoiler?: true;
	verbatim?: true;
	href?: string;
	lang?: string;
	// The file a `lang:file` fence tag named
	file?: string;
	header?: HeaderLevel;
	// The list the fragment is an item of: `ul`, or `ol:<first number>`
	list?: string;
	// The pipe table the fragment is a cell of: one alignment letter per
	// column, `l`, `r` or `c`
	table?: string;
	// TeX for KaTeX. The id keeps two identical spans from merging into one
	math?: string;
	mathBlock?: string;
	mathId?: number;
};

// What the Markdown stage makes of a message: the style fragments with the
// markers gone and the flags set, plus the spans nothing is interpreted inside
// (offsets into the marker-free text).
export type Markdown = {fragments: ParsedStyle[]; verbatim: Range[]};

// Characters a backslash can escape
const MARKER_CHARS = "*_~|`>#[]()\\-$";

// A fence is a run of three or more backticks; the closing one has to be at
// least as long. A language tag — and a `lang:file` name — is only a tag when
// the fence line ends in a newline.
const fenceOpenRx = /^(`{3,})(?:([\w+.#-]*)(?::([^:\n]+))?)?\n/;
// The URL part allows one level of balanced parentheses, so Wikipedia-style
// links survive; the scheme is matched case-insensitively.
const linkRx = /^\[([^\]\n]+)\]\(((?:https?:\/\/|web\+irc:)(?:[^\s()]|\([^\s()]*\))+)\)/i;

type ScanFlag = keyof Omit<
	PieceFlags,
	"href" | "lang" | "file" | "header" | "list" | "table" | "math" | "mathBlock" | "mathId"
>;

// The flags a range can carry: a bare one, or one of the kind that name a value
type ScanRange =
	| (Range & {flag: ScanFlag})
	| (Range & {flag: "href"; href: string})
	| (Range & {flag: "lang"; lang?: string; file?: string})
	| (Range & {flag: "header"; level: HeaderLevel})
	| (Range & {flag: "list"; list: "ul" | "ol"; num: number})
	| (Range & {flag: "table"; table: string})
	| (Range & {flag: "math" | "mathBlock"; tex: string; id: number});

type Scan = {
	// Marker characters to drop from the text
	removals: Range[];
	// Flagged spans; may cover removed characters, which is harmless
	ranges: ScanRange[];
};

type EmphasisToken = {len: number; flag: ScanFlag};

// Emphasis delimiters, longest token first
const EMPHASIS: Record<string, EmphasisToken[]> = {
	"*": [
		{len: 2, flag: "bold"},
		{len: 1, flag: "italic"},
	],
	_: [
		{len: 2, flag: "underline"},
		{len: 1, flag: "italic"},
	],
	"~": [{len: 2, flag: "strikethrough"}],
	"|": [{len: 2, flag: "spoiler"}],
};

type OpenDelimiter = {char: string; len: number; flag: ScanFlag; pos: number};

const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}_]/u.test(c);
const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);
// A character that is neither a word, a space, an emphasis marker nor a
// backslash: what ASCII art is drawn with
const isSymbol = (c: string | undefined) =>
	c !== undefined && !isWordChar(c) && !isSpace(c) && !(c in EMPHASIS) && c !== "\\";
const isLineStart = (text: string, i: number) => i === 0 || text[i - 1] === "\n";

const sameStyle = (a: ParsedStyle, b: ParsedStyle) => STYLE_KEYS.every((key) => a[key] === b[key]);

const covers = (range: Range, start: number, end: number) =>
	range.start <= start && end <= range.end;

// Applies Markdown to the fragments produced by parseStyle: marker characters
// are dropped, flags are set, offsets are renumbered and equal neighbours
// merged. Returns the input untouched when the message holds no Markdown.
export function applyMarkdown(fragments: ParsedStyle[]): Markdown {
	if (fragments.length === 0) {
		return {fragments, verbatim: []};
	}

	const text = fragments.map((fragment) => fragment.text).join("");
	const scanned = scan(text);

	if (scanned.removals.length === 0 && scanned.ranges.length === 0) {
		return {fragments, verbatim: []};
	}

	// Fragment boundaries are cut points too: a piece must never straddle two
	// styles, or it would lose one of them
	const boundaries = fragments.flatMap((fragment) => [fragment.start, fragment.end]);
	const result: ParsedStyle[] = [];
	const verbatim: Range[] = [];
	let offset = 0;

	// Cuts and fragments both run left to right, and no cut crosses a
	// fragment boundary (each is a cut point): walk them together.
	let next = 0;

	for (const cut of cutPieces(text, scanned, boundaries)) {
		while (next < fragments.length && fragments[next].end <= cut.start) {
			next++;
		}

		const source = fragments[next];

		if (!source || !covers(source, cut.start, cut.end)) {
			continue;
		}

		const {verbatim: isVerbatim, ...flags} = cut.flags;
		const fragment: ParsedStyle = {
			...source,
			...flags,
			text: cut.text,
			start: offset,
			end: offset + cut.text.length,
		};

		if (isVerbatim) {
			const span = verbatim[verbatim.length - 1];

			if (span && span.end === fragment.start) {
				span.end = fragment.end;
			} else {
				verbatim.push({start: fragment.start, end: fragment.end});
			}
		}

		offset = fragment.end;
		const last = result[result.length - 1];

		if (last && sameStyle(last, fragment)) {
			last.text += fragment.text;
			last.end = fragment.end;
		} else {
			result.push(fragment);
		}
	}

	return {fragments: result, verbatim};
}

type Cut = Range & {text: string; flags: PieceFlags};

// Cuts `text` at every marker and flagged-span boundary (plus `extraCuts`),
// drops the marker characters and hands back the surviving segments with the
// flags covering them. Offsets are into `text`, markers included.
function cutPieces(text: string, {removals, ranges}: Scan, extraCuts: number[]): Cut[] {
	const points = new Set<number>([0, text.length, ...extraCuts]);

	for (const item of [...removals, ...ranges]) {
		points.add(item.start);
		points.add(item.end);
	}

	const sorted = [...points].sort((a, b) => a - b);
	const cuts: Cut[] = [];

	// Every item's ends are cut points, so a cut lies wholly inside an item
	// or wholly outside it. One sweep keeps what is open at each cut; asking
	// every item at every cut was quadratic (16 KB of "`a" took 360ms).
	const opens = new Map<number, number[]>();
	const closes = new Map<number, number[]>();
	const items = [...removals, ...ranges];

	const at = (map: Map<number, number[]>, point: number) => {
		let list = map.get(point);

		if (!list) {
			list = [];
			map.set(point, list);
		}

		return list;
	};

	items.forEach((item, index) => {
		if (item.start < item.end) {
			at(opens, item.start).push(index);
			at(closes, item.end).push(index);
		}
	});

	const open = new Set<number>();
	let openRemovals = 0;

	for (let k = 0; k < sorted.length - 1; k++) {
		const start = sorted[k];
		const end = sorted[k + 1];

		for (const index of closes.get(start) ?? []) {
			open.delete(index);
			openRemovals -= index < removals.length ? 1 : 0;
		}

		for (const index of opens.get(start) ?? []) {
			open.add(index);
			openRemovals += index < removals.length ? 1 : 0;
		}

		if (openRemovals > 0) {
			continue;
		}

		const flags: PieceFlags = {};

		// In the order the scan found them: a later range's flag wins
		for (const index of [...open].sort((a, b) => a - b)) {
			const range = items[index] as ScanRange;

			if (range.flag === "href") {
				flags.href = range.href;
			} else if (range.flag === "lang") {
				flags.lang = range.lang;

				if (range.file) {
					flags.file = range.file;
				}
			} else if (range.flag === "header") {
				flags.header = range.level;
			} else if (range.flag === "list") {
				flags.list = range.list === "ol" ? `ol:${range.num}` : "ul";
			} else if (range.flag === "table") {
				flags.table = range.table;
			} else if (range.flag === "math" || range.flag === "mathBlock") {
				flags[range.flag] = range.tex;
				flags.mathId = range.id;
			} else {
				flags[range.flag] = true;
			}
		}

		cuts.push({start, end, text: text.slice(start, end), flags});
	}

	return cuts;
}

// Scans `text` for Discord-style Markdown. Offsets in the result are into
// `text`; opaque spans (URLs) are never interpreted, and neither are the pipes
// and padding of a pipe table, which a pre-pass claims before the main loop
// runs.
function scan(text: string): Scan {
	const removals: Range[] = [];
	const ranges: ScanRange[] = [];
	const tables = scanTables(text);

	ranges.push(...tables.ranges);
	removals.push(...tables.removals);

	const skips: Range[] = [...opaqueSpans(text), ...tables.zones].sort(
		(a, b) => a.start - b.start
	);

	// `i` only moves forward, so the skips behind it are never asked again
	let firstSkip = 0;

	const skipAt = (pos: number): Range | undefined => {
		while (firstSkip < skips.length && skips[firstSkip].end <= pos) {
			firstSkip++;
		}

		for (let q = firstSkip; q < skips.length && skips[q].start <= pos; q++) {
			if (pos < skips[q].end) {
				return skips[q];
			}
		}

		return undefined;
	};

	const stack: OpenDelimiter[] = [];
	let i = 0;

	// A table row is never also a fence, quote, header or list line: the
	// line-level markup yields to the table that claimed the line
	const inTable = (pos: number) => tables.ranges.some((r) => r.start <= pos && pos < r.end);

	while (i < text.length) {
		const skip = skipAt(i);

		if (skip) {
			i = skip.end;
			continue;
		}

		const c = text[i];
		const escaped = text[i + 1];

		// Not `MARKER_CHARS.includes(escaped ?? "")`: every string contains the
		// empty string, so a backslash ending the text would swallow itself.
		if (c === "\\" && escaped !== undefined && MARKER_CHARS.includes(escaped)) {
			// The marker is literal either way. The backslash stays when it is
			// art — between two symbols, "¯\_(ツ)_/¯", which is what the rest
			// of the channel sees; next to a word ("snake\_case") or another
			// marker ("\*\*") it is an escape and goes, and "\\" always does.
			if (escaped === "\\" || !isSymbol(text[i - 1]) || !isSymbol(text[i + 2])) {
				removals.push({start: i, end: i + 1});
			}

			i += 2;
			continue;
		}

		if (c === "`") {
			const n = runAt(text, i);

			// A run of three or more backticks is a fence — unless a table got
			// the line first
			if (n >= 3 && !inTable(i)) {
				const after = codeBlock(text, i, removals, ranges);

				if (after !== -1) {
					i = after;
					continue;
				}

				i += n;
				continue;
			}

			// Inline code: a run of one or two backticks, closed by a run of
			// exactly the same length, so ``a `b` c`` holds backticks
			if (n <= 2) {
				const close = findRun(text, i + n, n, false);

				if (close > i + n) {
					removals.push({start: i, end: i + n}, {start: close, end: close + n});
					ranges.push({start: i + n, end: close, flag: "monospace"});
					ranges.push({start: i + n, end: close, flag: "verbatim"});
					i = close + n;
					continue;
				}
			}

			i += n;
			continue;
		}

		if (
			c === ">" &&
			i === 0 &&
			text.startsWith(">>>", 0) &&
			(text[3] === " " || text[3] === "\n")
		) {
			// Discord's quote-everything-after: the rest of the message is one
			// quote, and "> " lines inside it lose their markers below
			const end = text[3] === " " ? 4 : 3;

			removals.push({start: 0, end});
			ranges.push({start: end, end: text.length, flag: "quote"});
			i = end;
			continue;
		}

		if (c === ">" && text[i + 1] === " " && !inTable(i) && (i === 0 || text[i - 1] === "\n")) {
			quote(text, i, removals, ranges);
			i += 2;
			continue;
		}

		if (c === "-" && !inTable(i) && isLineStart(text, i) && text[i + 1] === " ") {
			i = listLine(text, i, 2, false, 1, removals, ranges);
			continue;
		}

		if (c >= "0" && c <= "9" && !inTable(i) && isLineStart(text, i)) {
			const marker = /^\d{1,9}\. /.exec(text.slice(i, i + 12));

			if (marker) {
				i = listLine(
					text,
					i,
					marker[0].length,
					true,
					Number.parseInt(marker[0], 10),
					removals,
					ranges
				);
				continue;
			}
		}

		if (c === "#" && !inTable(i)) {
			// A header may follow a quote marker, so that "> # t" nests one
			const quoted = text[i - 1] === " " && text[i - 2] === ">" && isLineStart(text, i - 2);
			const lineStart = quoted ? i - 2 : i;
			const level = isLineStart(text, lineStart) ? headerLevel(text, i) : undefined;

			if (level !== undefined) {
				header(text, i, {level, lineStart, quoted}, removals, ranges);
				i += level + 1;
				continue;
			}

			i += 1;
			continue;
		}

		if (c === "[") {
			const match = linkRx.exec(text.slice(i));

			if (match) {
				const textStart = i + 1;
				const textEnd = textStart + match[1].length;
				const end = i + match[0].length;
				removals.push({start: i, end: textStart}, {start: textEnd, end});
				ranges.push({start: textStart, end: textEnd, flag: "href", href: match[2]});
				// The link text is scanned normally; the "](url)" tail is not.
				// skipAt() needs skips sorted by start; every skip behind
				// firstSkip ends before i, so the insert never lands there
				const at = skips.findIndex((r) => r.start > textEnd);
				skips.splice(at === -1 ? skips.length : at, 0, {start: textEnd, end});
				i = textStart;
				continue;
			}

			i += 1;
			continue;
		}

		if (c === "$") {
			// `$$…$$` is display TeX, block-level the way a fence is
			if (text[i + 1] === "$") {
				const close = text.indexOf("$$", i + 2);

				if (close !== -1) {
					const after = mathBlock(text, i, close, removals, ranges);

					if (after !== -1) {
						i = after;
						continue;
					}
				}

				i += 2;
				continue;
			}

			// `$`…`$` is inline TeX, on one line: the dollar-backtick shape is
			// what keeps "$5 and 50 cents" out of the maths
			if (text[i + 1] === "`") {
				const close = text.indexOf("`$", i + 2);
				const lineEnd = text.indexOf("\n", i + 2);

				if (close > i + 2 && (lineEnd === -1 || close < lineEnd)) {
					ranges.push({
						start: i + 2,
						end: close,
						flag: "math",
						tex: text.slice(i + 2, close),
						id: ranges.length,
					});
					ranges.push({start: i + 2, end: close, flag: "verbatim"});
					removals.push({start: i, end: i + 2}, {start: close, end: close + 2});
					i = close + 2;
					continue;
				}
			}

			i += 1;
			continue;
		}

		if (c in EMPHASIS) {
			i = emphasis(text, i, stack, removals, ranges);
			continue;
		}

		i += 1;
	}

	return {removals, ranges};
}

// The stretches the scanner never looks inside: URLs, so that
// "https://x/a_b_c" or "https://x/**" survive intact.
function opaqueSpans(text: string): Range[] {
	return findLinks(text).map((link) => trimTrailingEmphasis(text, link));
}

// linkify-it greedily swallows a trailing run of emphasis characters into the
// URL ("**https://x**" matches "https://x**"), which would leave the opening
// marker unclosed. Peel them back off so the tokenizer still sees them.
function trimTrailingEmphasis(text: string, span: Range): Range {
	let end = span.end;

	while (end > span.start && text[end - 1] in EMPHASIS) {
		end -= 1;
	}

	return {start: span.start, end};
}

// Handles a run of identical emphasis characters starting at `i`; returns the
// index after the run.
function emphasis(
	text: string,
	i: number,
	stack: OpenDelimiter[],
	removals: Range[],
	ranges: ScanRange[]
): number {
	const c = text[i];
	let n = 1;

	while (text[i + n] === c) {
		n += 1;
	}

	const prev = text[i - 1];
	const next = text[i + n];
	let canOpen = !isSpace(next);
	let canClose = !isSpace(prev);

	if (c === "_") {
		canOpen = canOpen && !isWordChar(prev);
		canClose = canClose && !isWordChar(next);
	}

	let pos = i;
	let remaining = n;

	if (canClose) {
		while (remaining > 0) {
			const idx = findLastIndex(stack, (o) => o.char === c && o.len <= remaining);

			if (idx === -1) {
				break;
			}

			const open = stack[idx];
			// Anything opened after this delimiter stays literal
			stack.length = idx;
			ranges.push({start: open.pos + open.len, end: pos, flag: open.flag});
			removals.push({start: open.pos, end: open.pos + open.len});
			removals.push({start: pos, end: pos + open.len});
			pos += open.len;
			remaining -= open.len;
		}
	}

	if (remaining > 0 && canOpen) {
		for (const token of EMPHASIS[c]) {
			while (remaining >= token.len) {
				stack.push({char: c, len: token.len, flag: token.flag, pos});
				pos += token.len;
				remaining -= token.len;
			}
		}
	}

	return i + n;
}

// A fenced code block starting at the run of `n` (3+) backticks at `i`.
// Returns the index after the block, or -1 when the fence is not closed or
// empty.
function codeBlock(text: string, i: number, removals: Range[], ranges: ScanRange[]): number {
	const n = runAt(text, i);
	const close = findRun(text, i + n, n, true);

	if (close === -1) {
		return -1;
	}

	// A tag only when the fence line ended in a newline; on one line the tag
	// is content, as on Discord
	const fence = fenceOpenRx.exec(text.slice(i));
	let contentStart = i + n;
	let contentEnd = close;
	let lang: string | undefined;
	let file: string | undefined;

	if (fence && i + fence[0].length <= close) {
		lang = fence[2] ? fence[2].toLowerCase() : undefined;
		file = fence[3];
		contentStart = i + fence[0].length;
	}

	if (text[contentEnd - 1] === "\n" && contentEnd - 1 >= contentStart) {
		contentEnd -= 1;
	}

	if (contentEnd <= contentStart) {
		return -1;
	}

	// Block-level: swallow the newline before the opening and after the closing fence
	const removeStart = text[i - 1] === "\n" ? i - 1 : i;
	let removeEnd = close + runAt(text, close);

	if (text[removeEnd] === "\n") {
		removeEnd += 1;
	}

	removals.push({start: removeStart, end: contentStart}, {start: contentEnd, end: removeEnd});
	ranges.push({start: contentStart, end: contentEnd, flag: "codeBlock"});
	ranges.push({start: contentStart, end: contentEnd, flag: "verbatim"});

	if (lang || file) {
		ranges.push({start: contentStart, end: contentEnd, flag: "lang", lang, file});
	}

	return removeEnd;
}

// The length of the run of backticks starting at `i`.
function runAt(text: string, i: number): number {
	let n = 0;

	while (text[i + n] === "`") {
		n += 1;
	}

	return n;
}

// The first run of backticks after `from` that is exactly `n` long (inline
// code) or at least `n` long (fences). Returns the run's start, or -1.
function findRun(text: string, from: number, n: number, atLeast: boolean): number {
	for (let k = from; k < text.length; ) {
		if (text[k] !== "`") {
			k += 1;
			continue;
		}

		const len = runAt(text, k);

		if (len === n || (atLeast && len > n)) {
			return k;
		}

		k += len;
	}

	return -1;
}

// A list item whose marker starts at `i` (`- ` or `1. `). Consecutive items
// of one kind of list share a range, the way quote lines do, and an ordered
// list keeps the number of its first item.
function listLine(
	text: string,
	i: number,
	markerLen: number,
	ordered: boolean,
	num: number,
	removals: Range[],
	ranges: ScanRange[]
): number {
	const nl = text.indexOf("\n", i);
	const lineEnd = nl === -1 ? text.length : nl;

	// An item with nothing after its marker is not a list, and not a licence
	// to wipe the line out either
	if (lineEnd <= i + markerLen) {
		return i + markerLen;
	}

	removals.push({start: i, end: i + markerLen});

	// Not just the last range: inline markup on the previous item pushes its
	// own ranges after that item's list range, so search backwards
	const kind = ordered ? "ol" : "ul";
	const idx = findLastIndex(
		ranges,
		(r) => r.flag === "list" && r.list === kind && r.end === i - 1
	);

	if (idx === -1) {
		ranges.push({start: i + markerLen, end: lineEnd, flag: "list", list: kind, num});
	} else {
		ranges[idx].end = lineEnd;
	}

	if (text[lineEnd] === "\n" && listMarkerAt(text, lineEnd + 1, ordered) === 0) {
		removals.push({start: lineEnd, end: lineEnd + 1});
	}

	return i + markerLen;
}

// The list marker at `pos`: its length, or 0 when that line starts with
// something else.
function listMarkerAt(text: string, pos: number, ordered: boolean): number {
	if (ordered) {
		const marker = /^\d{1,9}\. /.exec(text.slice(pos, pos + 12));

		return marker ? marker[0].length : 0;
	}

	return text.startsWith("- ", pos) ? 2 : 0;
}

// A `$$…$$` display-math span. Returns the index after the block, or -1 when
// there is nothing between the markers.
function mathBlock(
	text: string,
	i: number,
	close: number,
	removals: Range[],
	ranges: ScanRange[]
): number {
	let contentStart = i + 2;
	let contentEnd = close;

	if (text[contentStart] === "\n") {
		contentStart += 1;
	}

	if (text[contentEnd - 1] === "\n" && contentEnd - 1 >= contentStart) {
		contentEnd -= 1;
	}

	if (contentEnd <= contentStart) {
		return -1;
	}

	// Block-level: swallow the newline before the opening and after the
	// closing marker
	const removeStart = text[i - 1] === "\n" ? i - 1 : i;
	let removeEnd = close + 2;

	if (text[removeEnd] === "\n") {
		removeEnd += 1;
	}

	removals.push({start: removeStart, end: contentStart}, {start: contentEnd, end: removeEnd});
	ranges.push({
		start: contentStart,
		end: contentEnd,
		flag: "mathBlock",
		tex: text.slice(contentStart, contentEnd),
		id: ranges.length,
	});
	ranges.push({start: contentStart, end: contentEnd, flag: "verbatim"});

	return removeEnd;
}

// One source line, offsets into `text`: `stop` is the newline's index or the
// text's end, `next` where the following line starts.
type Line = {start: number; stop: number; next: number};

function lineOf(text: string, start: number): Line {
	const stop = text.indexOf("\n", start);

	return stop === -1
		? {start, stop: text.length, next: text.length}
		: {start, stop, next: stop + 1};
}

// The tables in `text`, found before the main scan so their pipes are never
// spoiler markers and their rows are never list, header or quote lines. Whole
// fences are stepped over first, the same way `codeBlock` will consume them,
// so a pipe inside one is never read as a table row.
function scanTables(text: string): {ranges: ScanRange[]; removals: Range[]; zones: Range[]} {
	const ranges: ScanRange[] = [];
	const removals: Range[] = [];
	const zones: Range[] = [];
	let i = 0;

	while (i < text.length) {
		if (text[i] === "`") {
			const n = runAt(text, i);

			if (n >= 3) {
				const close = findRun(text, i + n, n, true);

				if (close === -1) {
					i += n;
				} else {
					i = close + runAt(text, close);

					if (text[i] === "\n") {
						i += 1;
					}
				}

				continue;
			}

			i += n;
			continue;
		}

		const line = lineOf(text, i);
		const table = tableAt(text, i, line, ranges, removals, zones);

		if (table !== -1) {
			i = table;
			continue;
		}

		i = line.next;
	}

	return {ranges, removals, zones};
}

// A GFM pipe table whose header row starts at `line.start`: the next line is
// a `---` separator row, and every line after it that holds a pipe is a body
// row. Pushes one range for the whole table (its value is the columns'
// alignment), removes the separator row and the outer pipes with their
// padding, and zones every pipe it keeps — those are cell boundaries the
// adapter splits on. Returns the position after the last row, or -1.
function tableAt(
	text: string,
	start: number,
	line: Line,
	ranges: ScanRange[],
	removals: Range[],
	zones: Range[]
): number {
	const head = rowCells(text.slice(line.start, line.stop));

	if (!head) {
		return -1;
	}

	const sepLine = lineOf(text, line.next);
	const sep = rowCells(text.slice(sepLine.start, sepLine.stop));

	if (!sep || sep.length !== head.length || !sep.every((cell) => /^:?-+:?$/.test(cell))) {
		return -1;
	}

	// Body rows: every following line that holds a pipe
	const rows: Line[] = [line];
	let cursor = lineOf(text, sepLine.next);

	while (cursor.stop > cursor.start && rowCells(text.slice(cursor.start, cursor.stop))) {
		rows.push(cursor);
		cursor = lineOf(text, cursor.next);
	}

	const lastRow = rows[rows.length - 1];

	// The separator row goes entirely, with the newline after it — but the
	// header's own newline stays, inside the range: it is what the rows are
	// split on once the markers are gone
	removals.push({start: sepLine.start, end: Math.min(sepLine.stop + 1, text.length)});

	// Whitespace just before `end` (not before `floor`) / from `start` (not past `ceil`).
	// Counted, not `/\s*$/` on a slice: that was per pipe, quadratic in a wide row.
	const spaceBefore = (end: number, floor: number) => {
		let n = 0;

		while (end - n > floor && /\s/.test(text[end - n - 1])) {
			n++;
		}

		return n;
	};

	const spaceAfter = (from: number, ceil: number) => {
		let n = 0;

		while (from + n < ceil && /\s/.test(text[from + n])) {
			n++;
		}

		return n;
	};

	for (const row of rows) {
		// Leading and trailing pipe, with the cell padding around them
		const raw = text.slice(row.start, row.stop);
		const lead = /^\s*\|/.exec(raw);
		let leadEnd = row.start;

		if (lead) {
			const pipe = row.start + lead[0].length - 1;
			const after = spaceAfter(pipe + 1, row.stop);

			removals.push({start: row.start, end: pipe + 1 + after});
			leadEnd = pipe + 1 + after;
		}

		const trail = /\|\s*$/.exec(raw);
		let trailStart = row.stop;

		if (trail && trail[0].length !== raw.length) {
			const pipe = row.stop - trail[0].length;
			const before = spaceBefore(pipe, row.start);

			removals.push({start: pipe - before, end: row.stop});
			trailStart = pipe - before;
		}

		// Every pipe the row keeps is a cell boundary, never a marker — and the
		// padding in front of one goes, the way the outer pipes' does, so a cell
		// reads `Item` and not `Item `
		for (let k = row.start; k < row.stop; k++) {
			if (text[k] !== "|") {
				continue;
			}

			if (k >= leadEnd && k < trailStart) {
				const before = spaceBefore(k, row.start);
				const after = spaceAfter(k + 1, row.stop);

				// A cell is trimmed on both sides of the pipe that bounds it
				if (before > 0) {
					removals.push({start: k - before, end: k});
				}

				if (after > 0) {
					removals.push({start: k + 1, end: k + 1 + after});
				}
			}

			zones.push({start: k, end: k + 1});
		}
	}

	// The newline after the last row goes with the table, the way a quote's
	// final newline does
	if (text[lastRow.stop] === "\n") {
		removals.push({start: lastRow.stop, end: lastRow.stop + 1});
	}

	ranges.push({
		start,
		end: lastRow.stop,
		flag: "table",
		table: sep.map(sepAlign).join(""),
	});

	return lastRow.next;
}

// A row's cells: the line must hold a pipe; the outer pipes and the spaces
// around them are padding, the rest splits at the pipes it kept.
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

// What a separator cell asks of its column: `:---` left, `---:` right,
// `:---:` centred, plain `---` left too.
function sepAlign(cell: string): string {
	const left = cell.startsWith(":");
	const right = cell.endsWith(":");

	return left && right ? "c" : right ? "r" : "l";
}

// The header the run of "#" at `i` opens: one to six of them, one space, and
// something after it on the line. Undefined when that is not what is there.
function headerLevel(text: string, i: number): HeaderLevel | undefined {
	let n = 0;

	while (text[i + n] === "#") {
		n += 1;
	}

	if (n === 0 || n > 6 || text[i + n] !== " ") {
		return undefined;
	}

	let lineEnd = text.indexOf("\n", i + n + 1);

	if (lineEnd === -1) {
		lineEnd = text.length;
	}

	return text.slice(i + n + 1, lineEnd).trim() === "" ? undefined : (n as HeaderLevel);
}

// The header the line beginning at `lineStart` opens, for a neighbouring line:
// a quote marker may come first, and only a line of the same kind counts (a
// quoted header and a bare one are not neighbours of one another).
function headerLevelAt(text: string, lineStart: number, quoted: boolean): HeaderLevel | undefined {
	if (text.startsWith("> ", lineStart) !== quoted) {
		return undefined;
	}

	return headerLevel(text, quoted ? lineStart + 2 : lineStart);
}

// A "# " … "###### " header line whose marker starts at `i`. The line is a
// block, so the newlines that bound it go with the marker — except between two
// headers of one level, which share a range (and so a wrap) the way
// consecutive quote lines do, and except a blank line the user typed.
function header(
	text: string,
	i: number,
	{level, lineStart, quoted}: {level: HeaderLevel; lineStart: number; quoted: boolean},
	removals: Range[],
	ranges: ScanRange[]
) {
	let lineEnd = text.indexOf("\n", i);

	if (lineEnd === -1) {
		lineEnd = text.length;
	}

	// The marker: the hashes and the one space after them
	removals.push({start: i, end: i + level + 1});

	const prevIsBlank = lineStart >= 2 && text[lineStart - 2] === "\n";
	const prevLine = lineStart >= 2 ? text.lastIndexOf("\n", lineStart - 2) + 1 : 0;
	const prevIsHeader = !prevIsBlank && headerLevelAt(text, prevLine, quoted) === level;

	if (lineStart > 0 && text[lineStart - 1] === "\n" && !prevIsBlank && !prevIsHeader) {
		removals.push({start: lineStart - 1, end: lineStart});
	}

	const nextIsHeader =
		text[lineEnd] === "\n" && headerLevelAt(text, lineEnd + 1, quoted) === level;

	if (text[lineEnd] === "\n" && !nextIsHeader) {
		removals.push({start: lineEnd, end: lineEnd + 1});
	}

	// The newline joining two headers of one level stays inside the range, so
	// that the lines end up in one block instead of running together
	ranges.push({
		start: i + level + 1,
		end: nextIsHeader ? lineEnd + 1 : lineEnd,
		flag: "header",
		level,
	});
}

// A "> " quote line starting at `i`. Consecutive quote lines share one range.
function quote(text: string, i: number, removals: Range[], ranges: ScanRange[]) {
	let lineEnd = text.indexOf("\n", i);

	if (lineEnd === -1) {
		lineEnd = text.length;
	}

	removals.push({start: i, end: i + 2});

	// Not just the last range: inline markup on the previous quote line pushes
	// its own ranges after that line's quote range, so search backwards for the
	// quote block that ends on the newline right before this line.
	const idx = findLastIndex(ranges, (r) => r.flag === "quote" && r.end === i - 1);
	const last = idx === -1 ? undefined : ranges[idx];

	if (last) {
		last.end = lineEnd;
	} else {
		ranges.push({start: i + 2, end: lineEnd, flag: "quote"});
	}

	const nextIsQuote = text.startsWith("> ", lineEnd + 1);

	if (text[lineEnd] === "\n" && !nextIsQuote) {
		removals.push({start: lineEnd, end: lineEnd + 1});
	}
}

function findLastIndex<T>(list: T[], pred: (item: T) => boolean): number {
	for (let k = list.length - 1; k >= 0; k--) {
		if (pred(list[k])) {
			return k;
		}
	}

	return -1;
}
