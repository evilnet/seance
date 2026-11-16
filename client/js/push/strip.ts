/**
 * What a notification shows for one message: IRC formatting bytes gone
 * always, Markdown markers gone when the reader renders Markdown — through
 * the page's own layout tree, so the two agree (docs/projects/
 * push-payload-multiline.md §5.1). Vue-free and DOM-free.
 */
import {matchFormatting} from "../../../shared/irc";
import {layout, type LayoutNode} from "../helpers/ircmessageparser/layout";

/** IRC colour and style control codes removed; trimmed like cleanIrcMessage. */
export function stripFormatting(text: string): string {
	return text.replace(matchFormatting, "").trim();
}

/** The layout wraps that stand on their own lines. */
const BLOCK_WRAPS = new Set(["header", "codeBlock", "quote", "list", "table", "mathBlock"]);

/**
 * The tree as text, like layout.ts's toPlainText, except that a block-level
 * wrap keeps a line break on each side: the markers took their newlines
 * with them, and a notification body still has to read line by line.
 */
function plainText(nodes: LayoutNode[]): string {
	let out = "";
	let afterBlock = false;

	for (const node of nodes) {
		const block = node.kind === "wrap" && BLOCK_WRAPS.has(node.wrap);
		const text = node.kind === "text" ? node.text : plainText(node.children);

		if (text === "") {
			continue;
		}

		if ((block || afterBlock) && out !== "" && !out.endsWith("\n") && !text.startsWith("\n")) {
			out += "\n";
		}

		out += text;
		afterBlock = block;
	}

	return out;
}

/**
 * Markdown markers removed: the layout tree, flattened to its text. An
 * unclosed marker stays literal (CommonMark), so a partial text never
 * loses characters; a math span comes back as its TeX source. Line breaks
 * are preserved between block-level constructs so the text reads line by line.
 */
export function stripMarkdown(text: string): string {
	return plainText(layout(text, {markdown: true})).trim();
}

/** A CTCP ACTION split from its text; `action` is false for a plain message. */
export function splitAction(text: string): {action: boolean; body: string} {
	// An empty `/me` comes as `\x01ACTION\x01`, without the space: an action
	// with no text, as the page reads it, not a message reading "ACTION".
	const match = /^\x01ACTION(?: ([\s\S]*?))?\x01?$/.exec(text);

	return match ? {action: true, body: match[1] ?? ""} : {action: false, body: text};
}

/** The notification body for one message (a joined batch counts as one). */
export function notificationText(text: string, options: {markdown: boolean}): string {
	const {action, body} = splitAction(text);
	let out = stripFormatting(body);

	if (options.markdown) {
		out = stripMarkdown(out);
	}

	return action ? `*${out}*` : out;
}
