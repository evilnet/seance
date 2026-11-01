import {findLinks} from "../../../../shared/linkify";
import {judgeLink, type LinkVerdict} from "../linkSafety";
import {colourReading} from "./colours";
import anyIntersection from "./anyIntersection";
import findChannels from "./findChannels";
import findEmoji from "./findEmoji";
import findNames from "./findNames";
import findShortcode, {ShortcodePart} from "./findShortcode";
import merge, {MergedParts, Part, PartWithFragments} from "./merge";
import {applyMarkdown, Range} from "./parseMarkdown";
import parseStyle, {HeaderLevel, ParsedStyle} from "./parseStyle";

export type LayoutOptions = {
	markdown?: boolean;
	channelPrefixes?: string[];
	userModes?: string[];
	users?: string[];
};

// What a text node looks like. Presentation only: the wraps are nodes of their
// own, and verbatim has done its job by the time the tree is built.
export type Style = Pick<
	ParsedStyle,
	| "bold"
	| "italic"
	| "underline"
	| "strikethrough"
	| "monospace"
	| "textColor"
	| "bgColor"
	| "hexColor"
	| "hexBgColor"
>;

// The layout tree: what a message renders as, as plain data. Every adapter
// (VNodes, plain text) walks this, so the rendering decision is made once and
// can be asserted without a browser.
export type LayoutNode =
	| {kind: "text"; text: string; style: Style}
	| {kind: "link"; link: string; children: LayoutNode[]}
	| {kind: "channel"; channel: string; children: LayoutNode[]}
	| {kind: "emoji"; emoji: string; children: LayoutNode[]}
	| {kind: "nick"; nick: string; children: LayoutNode[]}
	| {kind: "wrap"; wrap: "quote" | "spoiler" | "math" | "mathBlock"; children: LayoutNode[]}
	// `level` is how many hashes the header line opened with
	| {kind: "wrap"; wrap: "header"; level: HeaderLevel; children: LayoutNode[]}
	// `lang` is the fence's language tag, when it named one, and `file` the
	// name a `lang:file` tag carried
	| {kind: "wrap"; wrap: "codeBlock"; lang?: string; file?: string; children: LayoutNode[]}
	// `list` is `ul`, or `ol:<first item's number>` for an ordered one
	| {kind: "wrap"; wrap: "list"; list: string; children: LayoutNode[]}
	// `table` is one alignment letter (`l`, `r`, `c`) per column, the
	// separator row's word on how each column sits
	| {kind: "wrap"; wrap: "table"; table: string; children: LayoutNode[]}
	// A masked link; `verdict` compares its visible text with where it goes
	// (helpers/linkSafety.ts): parse.ts shows the host or asks before opening
	| {kind: "wrap"; wrap: "href"; href: string; verdict: LinkVerdict; children: LayoutNode[]};

// Flags that wrap a run of neighbouring nodes in one element, outermost first:
// a header sits inside the quote it was written in, never the other way round.
const WRAP_KEYS = [
	"quote",
	"header",
	"list",
	"table",
	"codeBlock",
	"spoiler",
	"mathBlock",
	"math",
	"href",
] as const;
type WrapKey = typeof WRAP_KEYS[number];
// `lang` is not a wrap of its own: it qualifies `codeBlock`, so that two
// blocks in different languages never end up under one element. A header's
// value is its level, so two levels never end up under one element either.
// `verdict` rides along on an href: the whole link's, judged once.
type Wrap = Partial<Record<WrapKey, boolean | string | number>> & {
	codeId?: number;
	lang?: string;
	file?: string;
	verdict?: LinkVerdict;
};
// A part, or one run of a part's text, and the wraps it sits in
type WrappedNodes = {nodes: LayoutNode[]; wrap: Wrap};

// Decides what a message renders as: IRC styling, Markdown, and the things the
// finders make interactive, as one tree.
export function layout(text: string, options: LayoutOptions = {}): LayoutNode[] {
	let fragments = parseStyle(text);
	let verbatim: Range[] = [];

	if (options.markdown) {
		const markdown = applyMarkdown(fragments);
		fragments = markdown.fragments;
		verbatim = markdown.verbatim;
	}

	const cleanText = fragments.map((fragment) => fragment.text).join("");

	// Nicks, channels and emoji are not looked up inside code
	const outsideVerbatim = (part: Part) => !verbatim.some((range) => anyIntersection(range, part));

	// Nor links, channels or nicks inside a masked link's label: an anchor
	// nested in its anchor would open the label's own address on a click,
	// and on a hover or long press show it, not where the link goes
	// (helpers/linkSafety.ts judges the label as text).
	const masked: Range[] = [];
	let offset = 0;

	for (const fragment of fragments) {
		if (fragment.href !== undefined) {
			masked.push({start: offset, end: offset + fragment.text.length});
		}

		offset += fragment.text.length;
	}

	const outsideMasked = (part: Part) => !masked.some((range) => anyIntersection(range, part));
	// An emoji may sit inside a label, but never reach across its edge: a
	// shortcode closed outside the brackets would pull outside text in.
	const crossesMasked = (part: Part) =>
		masked.some(
			(range) =>
				part.start < range.end &&
				part.end > range.start &&
				(part.start < range.start || part.end > range.end)
		);

	// On the plain text, find channels and URLs, returned as "parts". Parts are
	// objects containing start and end markers, as well as metadata depending on
	// what was found (channel or link).
	const channelPrefixes = options.channelPrefixes ?? ["#", "&"];
	const userModes = options.userModes ?? ["!", "@", "%", "+"];
	const channelParts = findChannels(cleanText, channelPrefixes, userModes)
		.filter(outsideVerbatim)
		.filter(outsideMasked);
	const linkParts = findLinks(cleanText).filter(outsideMasked);
	const emojiParts = findEmoji(cleanText)
		.filter(outsideVerbatim)
		.filter((part) => !crossesMasked(part));
	const shortcodeParts = findShortcode(cleanText)
		.filter(outsideVerbatim)
		.filter((part) => !crossesMasked(part));
	const nameParts = findNames(cleanText, options.users ?? [])
		.filter(outsideVerbatim)
		.filter(outsideMasked);

	const parts = (channelParts as MergedParts)
		.concat(linkParts)
		.concat(emojiParts)
		.concat(shortcodeParts as MergedParts)
		.concat(nameParts);

	// Merge the styling information with the channels / URLs / nicks / text
	// objects, then group what shares a wrap
	const wrapped: WrappedNodes[] = [];

	for (const part of merge(parts, fragments, cleanText)) {
		const found = partNode(part);

		if (found) {
			wrapped.push({nodes: [found], wrap: wrapOf(part.fragments[0])});
			continue;
		}

		if (part.fragments.length === 0) {
			wrapped.push({nodes: [], wrap: {}});
			continue;
		}

		// Plain text may cross a quote/code/spoiler/link boundary: split it there
		let run: LayoutNode[] = [];
		let runWrap = wrapOf(part.fragments[0]);

		for (const fragment of part.fragments) {
			const wrap = wrapOf(fragment);

			if (!sameWrap(wrap, runWrap) && run.length) {
				wrapped.push({nodes: run, wrap: runWrap});
				run = [];
			}

			runWrap = wrap;
			run.push(textNode(fragment));
		}

		wrapped.push({nodes: run, wrap: runWrap});
	}

	judgeLinks(wrapped);

	return options.markdown
		? groupNodes(wrapped)
		: wrapped.flatMap((wrappedNodes) => wrappedNodes.nodes);
}

// The message as text, markers and all interactivity gone (window titles).
export function toPlainText(nodes: LayoutNode[]): string {
	let out = "";

	for (const node of nodes) {
		out += node.kind === "text" ? node.text : toPlainText(node.children);
	}

	return out;
}

type TextNode = Extract<LayoutNode, {kind: "text"}>;

/**
 * A masked link's label as a reader may see it (`seen`: everything but text
 * drawn too faint to read) and as a reader surely sees it (`sure`: only text
 * in the theme's colours or in a readable pair the sender set — a single
 * colour may vanish into a theme's background).
 */
function labelText(nodes: LayoutNode[], out = {seen: "", sure: ""}) {
	for (const node of nodes) {
		if (node.kind !== "text") {
			labelText(node.children, out);
			continue;
		}

		const reading = colourReading(node.style);

		if (reading !== "hidden") {
			out.seen += node.text;
		}

		if (reading === "plain" || reading === "readable") {
			out.sure += node.text;
		}
	}

	return out;
}

/**
 * A label naming another site in anything a reader may see is a mismatch;
 * it is honest only when what a reader surely sees is.
 */
function judgeLabel(nodes: LayoutNode[], href: string): LinkVerdict {
	const {seen, sure} = labelText(nodes);
	const verdict = judgeLink(seen, href);

	if (verdict.kind !== "honest" || sure === seen) {
		return verdict;
	}

	const surely = judgeLink(sure, href);
	return surely.kind === "honest" ? verdict : surely;
}

/**
 * One verdict per link, whatever splits its label (a spoiler, a header):
 * the neighbouring runs that share an href are one label.
 */
function judgeLinks(wrapped: WrappedNodes[]): void {
	let i = 0;

	while (i < wrapped.length) {
		const href = wrapped[i].wrap.href;
		let j = i + 1;

		while (href && j < wrapped.length && wrapped[j].wrap.href === href) {
			j += 1;
		}

		if (href) {
			const verdict = judgeLabel(
				wrapped.slice(i, j).flatMap((item) => item.nodes),
				String(href)
			);

			for (const item of wrapped.slice(i, j)) {
				item.wrap.verdict = verdict;
			}
		}

		i = j;
	}
}

// A quote of the message (the reply quote under a message, the composer's
// "Replying to" bar): one line of styled text nodes, at most `maxLength`
// visible characters, an ellipsis where it was cut. Every wrap folds into a
// style — a code block or TeX is monospace, a header bold, a spoiler stays
// unread as "(spoiler)" — and the finder-made parts (links, channels, nicks,
// emoji) are their text: the quote sits inside a button, so nothing in it can
// be interactive. Whitespace collapses the way it does in a rendered line,
// and the cut counts characters the reader sees, never markers.
export function quoteLayout(text: string, maxLength = 80, options: LayoutOptions = {}): TextNode[] {
	const flat = foldQuote(layout(text, options), {});
	const out: TextNode[] = [];

	// Collapse runs of whitespace, across nodes too, and drop the leading run
	for (const node of flat) {
		let value = node.text.replace(/\s+/g, " ");
		const last = out[out.length - 1];

		if (value.startsWith(" ") && (!last || last.text.endsWith(" "))) {
			value = value.slice(1);
		}

		if (value) {
			out.push({kind: "text", text: value, style: node.style});
		}
	}

	// ...and the trailing one
	while (out.length) {
		const last = out[out.length - 1];
		last.text = last.text.replace(/ $/, "");

		if (last.text) {
			break;
		}

		out.pop();
	}

	// Cut at `maxLength` visible characters (code points, so an emoji is one)
	let seen = 0;

	for (let i = 0; i < out.length; i++) {
		const chars = Array.from(out[i].text);

		if (seen + chars.length <= maxLength) {
			seen += chars.length;
			continue;
		}

		const keep = chars.slice(0, Math.max(0, maxLength - 1 - seen)).join("");
		out.splice(i, out.length - i, {kind: "text", text: keep + "…", style: out[i].style});
		break;
	}

	return out;
}

// The wraps that take a line of their own: the parser eats the newline that
// ended them, so on one line a space has to stand in for it.
const BLOCK_WRAPS = new Set(["quote", "header", "list", "table", "codeBlock", "mathBlock"]);

function foldQuote(nodes: LayoutNode[], extra: Style): TextNode[] {
	const out: TextNode[] = [];
	const space = (): TextNode => ({kind: "text", text: " ", style: {}});

	for (const node of nodes) {
		if (node.kind === "text") {
			out.push({kind: "text", text: node.text, style: {...node.style, ...extra}});
			continue;
		}

		if (node.kind !== "wrap") {
			out.push(...foldQuote(node.children, extra));
			continue;
		}

		if (BLOCK_WRAPS.has(node.wrap)) {
			out.push(space());
		}

		if (node.wrap === "spoiler") {
			out.push({kind: "text", text: "(spoiler)", style: {}});
		} else if (node.wrap === "codeBlock" || node.wrap === "math" || node.wrap === "mathBlock") {
			out.push(...foldQuote(node.children, {...extra, monospace: true}));
		} else if (node.wrap === "header") {
			out.push(...foldQuote(node.children, {...extra, bold: true}));
		} else {
			out.push(...foldQuote(node.children, extra));
		}

		if (BLOCK_WRAPS.has(node.wrap)) {
			out.push(space());
		}
	}

	return out;
}

// Every code block in a tree, outermost first and in the order they render,
// as the characters each one holds — what a copy of a message's code is made
// of. A block's own children are text and (flattened) parts, never another
// block, so nothing recurses into one.
export function codeBlocksOf(nodes: LayoutNode[]): string[] {
	const blocks: string[] = [];

	for (const node of nodes) {
		if (node.kind === "text") {
			continue;
		}

		if (node.kind === "wrap" && node.wrap === "codeBlock") {
			blocks.push(toPlainText(node.children));
			continue;
		}

		blocks.push(...codeBlocksOf(node.children));
	}

	return blocks;
}

// The node a finder asked for, or undefined when the part is plain text.
function partNode(part: PartWithFragments<ParsedStyle>): LayoutNode | undefined {
	const children = part.fragments.map(textNode);

	if (part.link) {
		return {kind: "link", link: part.link, children};
	}

	if (part.channel) {
		return {kind: "channel", channel: part.channel, children};
	}

	if (part.emoji) {
		// A shortcode renders as the character it stands for, not as the
		// `:name:` that was typed
		if (part.shortcode) {
			return {
				kind: "emoji",
				emoji: part.emoji,
				children: [textNode({...part.fragments[0], text: part.emoji})],
			};
		}

		return {kind: "emoji", emoji: part.emoji, children};
	}

	if (part.nick) {
		return {kind: "nick", nick: part.nick, children};
	}

	return undefined;
}

// Only the keys that are set, so an unstyled run carries an empty style
function textNode(fragment: ParsedStyle): LayoutNode {
	const style: Style = {};

	if (fragment.bold) {
		style.bold = true;
	}

	if (fragment.italic) {
		style.italic = true;
	}

	if (fragment.underline) {
		style.underline = true;
	}

	if (fragment.strikethrough) {
		style.strikethrough = true;
	}

	if (fragment.monospace) {
		style.monospace = true;
	}

	// Colour 0 is white, so these are set-or-not, not truthy-or-not
	if (fragment.textColor !== undefined) {
		style.textColor = fragment.textColor;
	}

	if (fragment.bgColor !== undefined) {
		style.bgColor = fragment.bgColor;
	}

	if (fragment.hexColor !== undefined) {
		style.hexColor = fragment.hexColor;
	}

	if (fragment.hexBgColor !== undefined) {
		style.hexBgColor = fragment.hexBgColor;
	}

	return {kind: "text", text: fragment.text, style};
}

function wrapOf(fragment: ParsedStyle | undefined): Wrap {
	const wrap: Wrap = {};

	if (!fragment) {
		return wrap;
	}

	for (const key of WRAP_KEYS) {
		if (fragment[key]) {
			wrap[key] = fragment[key];
		}
	}

	if (fragment.codeBlock && fragment.codeId !== undefined) {
		wrap.codeId = fragment.codeId;
	}

	if (fragment.codeBlock && fragment.lang) {
		wrap.lang = fragment.lang;
	}

	if (fragment.codeBlock && fragment.file) {
		wrap.file = fragment.file;
	}

	return wrap;
}

function sameWrap(a: Wrap, b: Wrap) {
	return (
		WRAP_KEYS.every((key) => a[key] === b[key]) &&
		a.codeId === b.codeId &&
		a.lang === b.lang &&
		a.file === b.file
	);
}

function wrapNode(key: WrapKey, wrap: Wrap, children: LayoutNode[]): LayoutNode {
	if (key === "href") {
		const target = String(wrap.href);
		return {
			kind: "wrap",
			wrap: "href",
			href: target,
			verdict: wrap.verdict ?? judgeLabel(children, target),
			children,
		};
	}

	if (key === "header") {
		return {kind: "wrap", wrap: "header", level: wrap.header as HeaderLevel, children};
	}

	if (key === "codeBlock") {
		return wrap.file !== undefined
			? {
					kind: "wrap",
					wrap: "codeBlock",
					lang: wrap.lang as string | undefined,
					file: wrap.file,
					children,
			  }
			: wrap.lang === undefined
			? {kind: "wrap", wrap: "codeBlock", children}
			: {kind: "wrap", wrap: "codeBlock", lang: wrap.lang, children};
	}

	if (key === "list") {
		return {kind: "wrap", wrap: "list", list: String(wrap.list), children};
	}

	if (key === "table") {
		return {kind: "wrap", wrap: "table", table: String(wrap.table), children};
	}

	return {kind: "wrap", wrap: key, children};
}

// Groups neighbouring nodes that share a wrap flag under one node, nesting
// quote > header > list > table > codeBlock > spoiler > mathBlock > math > href.
function groupNodes(nodes: WrappedNodes[], level = 0): LayoutNode[] {
	if (level === WRAP_KEYS.length) {
		return nodes.flatMap((wrappedNodes) => wrappedNodes.nodes);
	}

	const key = WRAP_KEYS[level];
	const out: LayoutNode[] = [];
	let i = 0;

	while (i < nodes.length) {
		const wrap = nodes[i].wrap;
		const value = wrap[key];
		// A code block only continues within one fence, and while its language
		// — and `lang:file` name — stay the same
		const codeId = key === "codeBlock" ? wrap.codeId : undefined;
		const lang = key === "codeBlock" ? wrap.lang : undefined;
		const file = key === "codeBlock" ? wrap.file : undefined;
		let j = i + 1;

		while (
			j < nodes.length &&
			nodes[j].wrap[key] === value &&
			(key !== "codeBlock" ||
				(nodes[j].wrap.codeId === codeId &&
					nodes[j].wrap.lang === lang &&
					nodes[j].wrap.file === file))
		) {
			j += 1;
		}

		const children = groupNodes(nodes.slice(i, j), level + 1);

		if (value) {
			out.push(wrapNode(key, wrap, children));
		} else {
			out.push(...children);
		}

		i = j;
	}

	return out;
}
