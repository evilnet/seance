import {h as createElement, VNode} from "vue";
import {layout, LayoutNode, toPlainText} from "./ircmessageparser/layout";
import {createFragment} from "./fragment";
import {confirmMismatch} from "./openLink";
import emojiMap from "./fullnamemap.json";
import LinkPreviewToggle from "../../components/LinkPreviewToggle.vue";
import LinkPreviewFileSize from "../../components/LinkPreviewFileSize.vue";
import CodeBlock from "../../components/CodeBlock.vue";
import InlineChannel from "../../components/InlineChannel.vue";
import MathSpan from "../../components/MathSpan.vue";
import Username from "../../components/Username.vue";
import {ClientMessage, ClientNetwork} from "../types";

const emojiModifiersRegex = /[\u{1f3fb}-\u{1f3ff}]|\u{fe0f}/gu;

export type ParseOptions = {
	markdown?: boolean;
};

type Rendered = VNode | string | undefined | Rendered[];
type WrapNode = Extract<LayoutNode, {kind: "wrap"}>;
type PartNode = Extract<LayoutNode, {kind: "link" | "channel" | "emoji" | "nick"}>;

function toggleSpoiler(event: Event) {
	(event.currentTarget as HTMLElement).classList.toggle("md-spoiler-shown");
}

// The spoiler is a role="button" in the tab order, so it has to answer Enter
// and Space the way a real button does.
function spoilerKeydown(event: KeyboardEvent) {
	if (event.key !== "Enter" && event.key !== " ") {
		return;
	}

	if (event.key === " ") {
		// Otherwise Space scrolls the message list
		event.preventDefault();
	}

	toggleSpoiler(event);
}

function wrapNode(
	node: WrapNode,
	children: Rendered[],
	message?: ClientMessage,
	network?: ClientNetwork
): VNode {
	switch (node.wrap) {
		case "quote":
			return createElement("span", {class: ["md-quote"]}, children);
		case "header":
			// Block-level, sized by level in the stylesheet
			return createElement("span", {class: ["md-header", "md-h" + node.level]}, children);

		case "list": {
			// One item per line: the wrap's text holds the newlines between
			// items, the way a header's does. The bullet or number is drawn by
			// the stylesheet, so a copy of the list yields the items and not
			// the markers that were typed.
			const ordered = node.list.startsWith("ol:");
			const items = splitNodes(node.children, "\n")
				.filter((item) => item.length > 0)
				.map((item) =>
					createElement("span", {class: ["md-li"]}, toVNodes(item, message, network))
				);

			return createElement(
				"span",
				{
					class: ["md-list", ordered ? "md-ol" : "md-ul"],
					style: ordered
						? {counterReset: `md-oli ${Number.parseInt(node.list.slice(3), 10) - 1}`}
						: undefined,
				},
				items
			);
		}

		case "table": {
			// Rows split at the newlines the range kept, cells at the pipes it
			// kept; the first row is the header. `table` carries one alignment
			// letter (`l`, `r`, `c`) per column, in order.
			const alignOf = (column: number) =>
				node.table[column] === "c"
					? "center"
					: node.table[column] === "r"
					? "right"
					: undefined;
			const cell = (tag: string, column: number, nodes: LayoutNode[]) =>
				createElement(
					tag,
					{style: {textAlign: alignOf(column)}},
					toVNodes(nodes, message, network)
				);
			const [head, ...body] = splitNodes(node.children, "\n").filter((row) => row.length > 0);
			const tableChildren: VNode[] = [];

			if (head) {
				tableChildren.push(
					createElement(
						"thead",
						{},
						createElement(
							"tr",
							{},
							splitNodes(head, "|").map((nodes, column) => cell("th", column, nodes))
						)
					)
				);
			}

			tableChildren.push(
				createElement(
					"tbody",
					{},
					body.map((row) =>
						createElement(
							"tr",
							{},
							splitNodes(row, "|").map((nodes, column) => cell("td", column, nodes))
						)
					)
				)
			);

			return createElement("table", {class: ["md-table"]}, tableChildren);
		}

		case "codeBlock":
			// The block's own characters, and only those: `CodeBlock` lays them
			// out as numbered lines and asks the highlighter for tokens. Any
			// part a finder made of the text (a URL is the one the verbatim
			// spans do not suppress) is flattened back into it — inside a code
			// block a link is code, like everything else there.
			return createElement(CodeBlock, {
				code: toPlainText(node.children),
				lang: node.lang,
				file: node.file,
			});
		case "math":
		case "mathBlock":
			// The block's own characters are the TeX; `MathSpan` renders them
			// with KaTeX once its chunk lands, and shows the TeX until then.
			return createElement(MathSpan, {
				tex: toPlainText(node.children),
				display: node.wrap === "mathBlock",
			});
		case "spoiler":
			return createElement(
				"span",
				{
					class: ["md-spoiler"],
					role: "button",
					tabindex: 0,
					onClick: toggleSpoiler,
					onKeydown: spoilerKeydown,
				},
				children
			);

		case "href": {
			// A masked link carries the destination in its title and the
			// `md-link` class, which is what tells it apart from a linkified
			// anchor (`test/e2e/markdown.spec.ts` picks it out that way). Its
			// text is free, so unless it is the destination the real host
			// follows it (a phone shows no title), and one whose text names
			// another address asks before opening (helpers/linkSafety.ts).
			// A long press's own "Open in new tab" cannot be intercepted: the
			// host is the warning there.
			const verdict = node.verdict;
			const ask =
				verdict.kind === "mismatch"
					? (ev: MouseEvent) => {
							ev.preventDefault();
							confirmMismatch(node.href, verdict.shown, verdict.host);
					  }
					: undefined;

			return createElement(
				"a",
				{
					class: ask ? ["md-link", "mismatch"] : ["md-link"],
					href: node.href,
					title: node.href,
					dir: "auto",
					target: "_blank",
					rel: "noopener",
					// A Ctrl/Cmd or Shift click arrives as a click, the middle
					// button as an auxclick. (Enter never reaches a chat link:
					// keybinds.ts sends it to the composer.)
					...(ask
						? {
								onClick: ask,
								onAuxclick(ev: MouseEvent) {
									if (ev.button === 1) {
										ask(ev);
									}
								},
						  }
						: {}),
				},
				verdict.kind === "honest"
					? children
					: [...children, createElement("span", {class: "md-link-host"}, verdict.host)]
			);
		}
	}
}

// Transform an IRC message potentially filled with styling control codes, URLs,
// nicknames, and channels into a string of HTML elements to display on the client.
function parse(
	text: string,
	message?: ClientMessage,
	network?: ClientNetwork,
	options: ParseOptions = {}
) {
	return toVNodes(
		// The finder defaults live in `layout`: pass what ISUPPORT said, or
		// nothing when the network has not said (or there is no network yet).
		layout(text, {
			markdown: options.markdown,
			channelPrefixes: network?.serverOptions.CHANTYPES,
			userModes: network?.serverOptions.PREFIX?.prefix?.map((pref) => pref.symbol),
			users: message ? message.users || [] : [],
		}),
		message,
		network
	);
}

// The Vue adapter: one element per layout node.
function toVNodes(
	nodes: LayoutNode[],
	message?: ClientMessage,
	network?: ClientNetwork
): Rendered[] {
	return nodes.map((node) => {
		if (node.kind === "text") {
			return createFragment(node);
		}

		const children = toVNodes(node.children, message, network);

		return node.kind === "wrap"
			? wrapNode(node, children, message, network)
			: renderPart(node, children, message, network);
	});
}

// Splits a run of nodes at a separator character that lives in text nodes —
// the newlines between a list's items, the pipes between a table row's cells —
// so the adapter can make an element of each. A wrap spanning a split is
// cloned around each side (a spoiler across two cells blacks both out); the
// finder-made parts (links, channels, emoji, nicks) never contain a separator.
function splitNodes(nodes: LayoutNode[], sep: string): LayoutNode[][] {
	const out: LayoutNode[][] = [];
	let run: LayoutNode[] = [];

	const flush = () => {
		out.push(run);
		run = [];
	};

	for (const node of nodes) {
		if (node.kind === "text") {
			const pieces = node.text.split(sep);

			run.push({kind: "text", text: pieces[0], style: node.style});

			for (const piece of pieces.slice(1)) {
				flush();

				if (piece) {
					run.push({kind: "text", text: piece, style: node.style});
				}
			}

			continue;
		}

		if (node.kind === "wrap") {
			const segments = splitNodes(node.children, sep);

			run.push({...node, children: segments[0]});

			for (const segment of segments.slice(1)) {
				flush();

				if (segment.length > 0) {
					run.push({...node, children: segment});
				}
			}

			continue;
		}

		run.push(node);
	}

	flush();

	return out;
}

// Wrap potentially styled fragments with links, channel buttons, emoji, nicks
function renderPart(
	node: PartNode,
	fragments: Rendered[],
	message?: ClientMessage,
	network?: ClientNetwork
): Rendered {
	switch (node.kind) {
		case "link": {
			const preview =
				message && message.previews && message.previews.find((p) => p.link === node.link);
			const link = createElement(
				"a",
				{
					href: node.link,
					dir: preview ? null : "auto",
					target: "_blank",
					rel: "noopener",
				},
				fragments
			);

			if (!preview) {
				return link;
			}

			const linkEls = [link];

			if (preview.size > 0) {
				linkEls.push(
					createElement(LinkPreviewFileSize, {
						size: preview.size,
					})
				);
			}

			linkEls.push(
				createElement(LinkPreviewToggle, {
					link: preview,
				})
			);

			// We wrap the link, size, and the toggle button into <span dir="auto">
			// to correctly keep the left-to-right order of these elements
			return createElement(
				"span",
				{
					dir: "auto",
				},
				linkEls
			);
		}

		case "channel":
			return createElement(
				InlineChannel,
				{
					channel: node.channel,
					network,
				},
				{
					default: () => fragments,
				}
			);

		case "emoji": {
			const emojiWithoutModifiers = node.emoji.replace(emojiModifiersRegex, "");
			const title = emojiMap[emojiWithoutModifiers]
				? `Emoji: ${emojiMap[emojiWithoutModifiers]}`
				: null;

			return createElement(
				"span",
				{
					class: ["emoji"],
					role: "img",
					"aria-label": title,
					title: title,
				},
				fragments
			);
		}

		case "nick":
			return createElement(
				Username,
				{
					user: {
						nick: node.nick,
					},
					network,
					dir: "auto",
				},
				{
					default: () => fragments,
				}
			);
	}
}

export default parse;
