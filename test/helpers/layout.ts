import {expect} from "chai";
import {
	codeBlocksOf,
	layout,
	LayoutNode,
	quoteLayout,
	Style,
	toPlainText,
} from "../../client/js/helpers/ircmessageparser/layout";
import {HeaderLevel} from "../../client/js/helpers/ircmessageparser/parseStyle";
import type {LinkVerdict} from "../../client/js/helpers/linkSafety";

// Builders, so the assertions read as the tree they describe.
const text = (value: string, style: Style = {}): LayoutNode => ({
	kind: "text",
	text: value,
	style,
});

const quote = (children: LayoutNode[]): LayoutNode => ({kind: "wrap", wrap: "quote", children});

const header = (level: HeaderLevel, children: LayoutNode[]): LayoutNode => ({
	kind: "wrap",
	wrap: "header",
	level,
	children,
});

const codeBlock = (children: LayoutNode[], lang?: string, file?: string): LayoutNode =>
	file !== undefined
		? {kind: "wrap", wrap: "codeBlock", lang, file, children}
		: lang === undefined
		? {kind: "wrap", wrap: "codeBlock", children}
		: {kind: "wrap", wrap: "codeBlock", lang, children};

const spoiler = (children: LayoutNode[]): LayoutNode => ({kind: "wrap", wrap: "spoiler", children});

const href = (url: string, children: LayoutNode[], verdict: LinkVerdict): LayoutNode => ({
	kind: "wrap",
	wrap: "href",
	href: url,
	verdict,
	children,
});

const markdown = {markdown: true};

describe("layout — text and styles", () => {
	it("renders plain text as one text node", () => {
		expect(layout("hello")).to.deep.equal([text("hello")]);
	});

	it("carries IRC styling on the text nodes", () => {
		expect(layout("\x02bold\x02 plain")).to.deep.equal([
			text("bold", {bold: true}),
			text(" plain"),
		]);
	});

	it("leaves the markers alone when Markdown is off", () => {
		expect(layout("**a** ||b||")).to.deep.equal([text("**a** ||b||")]);
	});

	it("nests Markdown styles on one text node", () => {
		expect(layout("**bold *and italic***", markdown)).to.deep.equal([
			text("bold ", {bold: true}),
			text("and italic", {bold: true, italic: true}),
		]);
	});
});

describe("layout — wraps", () => {
	it("wraps a quote", () => {
		expect(layout("> hi", markdown)).to.deep.equal([quote([text("hi")])]);
	});

	it("wraps a code block", () => {
		expect(layout("```x```", markdown)).to.deep.equal([codeBlock([text("x")])]);
	});

	it("carries the fence's language tag on the code block wrap", () => {
		expect(layout("```js\nlet x\n```", markdown)).to.deep.equal([
			codeBlock([text("let x")], "js"),
		]);
	});

	it("keeps two code blocks with different tags apart", () => {
		expect(layout("```js\na\n```\n```python\nb\n```", markdown)).to.deep.equal([
			codeBlock([text("a")], "js"),
			codeBlock([text("b")], "python"),
		]);
	});

	// The Vue adapter renders a code block from `toPlainText` of its children,
	// so this link is flattened back into the code: the verbatim spans suppress
	// the channel/nick/emoji finders inside a block, but not `findLinks`.
	it("still finds a link inside a code block", () => {
		expect(layout("```see https://example.com/ ok```", markdown)).to.deep.equal([
			codeBlock([
				text("see "),
				{
					kind: "link",
					link: "https://example.com/",
					children: [text("https://example.com/")],
				},
				text(" ok"),
			]),
		]);
	});

	// The other half of the rule above, and the one that decides what is on
	// screen: `parse.ts` builds a code block from `toPlainText` of its
	// children, so the link node never becomes an anchor. A code block renders
	// its characters and nothing else — inline `` `code` `` keeps its link.
	it("renders a code block from its characters alone", () => {
		const nodes = layout("```see https://example.com/ ok```", markdown);
		const block = nodes[0];

		expect(nodes).to.have.lengthOf(1);
		expect(block.kind).to.equal("wrap");

		if (block.kind !== "wrap") {
			return;
		}

		expect(toPlainText(block.children)).to.equal("see https://example.com/ ok");
	});

	it("says nothing extra in the plain text of a tagged block", () => {
		expect(toPlainText(layout("```js\nlet x\n```", markdown))).to.equal("let x");
	});

	it("wraps a spoiler", () => {
		expect(layout("||s||", markdown)).to.deep.equal([spoiler([text("s")])]);
	});

	it("wraps a masked link around its children", () => {
		expect(layout("[c](https://example.com/)", markdown)).to.deep.equal([
			href("https://example.com/", [text("c")], {kind: "masked", host: "example.com"}),
		]);
	});

	it("finds no link, channel or nick inside a masked link's label", () => {
		const kinds = (nodes: LayoutNode[]): string[] =>
			nodes.flatMap((n) => [n.kind, ...("children" in n ? kinds(n.children) : [])]);
		const [node] = layout("[paypal.com #help alice](https://evil.example)", {
			markdown: true,
			users: ["alice"],
		});
		expect(node.kind === "wrap" && node.wrap).to.equal("href");
		expect(
			kinds([node]).filter((k) => k === "link" || k === "channel" || k === "nick")
		).to.deep.equal([]);
		expect(toPlainText([node])).to.equal("paypal.com #help alice");
	});

	it("still finds links outside a masked link", () => {
		const nodes = layout("see https://x.org and [docs](https://example.org)", {markdown: true});
		expect(nodes.some((n) => n.kind === "link")).to.equal(true);
	});

	it("judges a label by what can be seen, not by text hidden in its own colours", () => {
		const [node] = layout(
			"[paypal.com\u200B \x0301,01evil.com\x03](https://evil.com/)",
			markdown
		);
		expect(node.kind === "wrap" && node.wrap === "href" && node.verdict.kind).to.equal(
			"mismatch"
		);
	});

	/** Every href node's verdict kind, in order. */
	const verdicts = (message: string) => {
		const out: string[] = [];

		const walk = (nodes: ReturnType<typeof layout>) => {
			for (const node of nodes) {
				if (node.kind === "wrap") {
					if (node.wrap === "href") {
						out.push(node.verdict.kind);
					}

					walk(node.children);
				}
			}
		};

		walk(layout(message, markdown));
		return out;
	};

	it("never calls a link honest on a host only faint text names", () => {
		for (const message of [
			// Hidden next to a lie a hair space hides
			"[paypal.c\u200Aom\x041C1A18,1C1A19 evil.com\x04](https://evil.com/login)",
			// Hidden, no lie at all: the reader sees "click here" and nothing else
			"[click here \x041C1A18,1C1A19evil.com\x04](https://evil.com/)",
			"[click here \x0301,88evil.com\x03](https://evil.com/)",
			"[click here \x0300,98evil.com\x03](https://evil.com/)",
			"[click here \x0300,01\x04000000evil.com\x04\x03](https://evil.com/)",
			// One colour: whether it reads depends on the theme
			"[click here \x041C1A18evil.com\x04](https://evil.com/)",
		]) {
			expect(verdicts(message), JSON.stringify(message)).to.not.include("honest");
		}
	});

	it("does not take faint text for a lie, nor a readable pair for a hidden one", () => {
		expect(verdicts("[paypal.com \x0301,01x\x03](https://paypal.com/)")).to.deep.equal([
			"honest",
		]);
		expect(verdicts("[\x0301,00paypal.com\x03](https://evil.example/)")).to.deep.equal([
			"mismatch",
		]);
		expect(verdicts("[\x0304paypal.com\x03](https://evil.example/)")).to.deep.equal([
			"mismatch",
		]);
	});

	it("judges a label a spoiler splits as one", () => {
		const kinds = verdicts("[paypal||.com||](https://evil.example/)");
		expect(kinds).to.have.length.above(1);
		expect(kinds.every((kind) => kind === "mismatch")).to.equal(true);
	});

	it("keeps an emoji shortcode from reaching across a label's edge", () => {
		const nodes = layout("[paypal.com:](https://evil.example/login)lock: verify now", markdown);
		const node = nodes[0];
		expect(node.kind === "wrap" && node.wrap === "href" && node.verdict.kind).to.equal(
			"mismatch"
		);
		expect(toPlainText([node])).to.equal("paypal.com:");
	});

	it("judges a masked link by its visible text", () => {
		const [node] = layout("[paypal.com](https://evil.example)", markdown);
		expect(node.kind === "wrap" && node.wrap === "href" && node.verdict).to.deep.equal({
			kind: "mismatch",
			host: "evil.example",
			shown: "paypal.com",
		});
	});

	it("judges a styled label by its text, not its markers", () => {
		const [node] = layout("[**click** here](https://example.org)", markdown);
		expect(node.kind === "wrap" && node.wrap === "href" && node.verdict).to.deep.equal({
			kind: "masked",
			host: "example.org",
		});
	});

	it("splits a run of text that crosses a wrap boundary", () => {
		expect(layout("> a\nb", markdown)).to.deep.equal([quote([text("a")]), text("b")]);
	});

	it("keeps consecutive quote lines in one wrap", () => {
		// Regression: the newline joining the lines used to escape the wrap
		expect(layout("> a *b*\n> c", markdown)).to.deep.equal([
			quote([text("a "), text("b", {italic: true}), text("\nc")]),
		]);
	});

	it("wraps a header", () => {
		expect(layout("# Title", markdown)).to.deep.equal([header(1, [text("Title")])]);
	});

	it("styles the text inside a header", () => {
		expect(layout("# a **b**", markdown)).to.deep.equal([
			header(1, [text("a "), text("b", {bold: true})]),
		]);
	});

	it("wraps a header inside the quote it sits in", () => {
		expect(layout("> # q", markdown)).to.deep.equal([quote([header(1, [text("q")])])]);
	});

	it("finds a channel inside a header", () => {
		const options = {markdown: true, channelPrefixes: ["#"], userModes: ["@"]};

		expect(layout("# see #chan", options)).to.deep.equal([
			header(1, [
				text("see "),
				{kind: "channel", channel: "#chan", children: [text("#chan")]},
			]),
		]);
	});

	it("leaves no stray newline around a header line", () => {
		expect(layout("x\n# H\ny", markdown)).to.deep.equal([
			text("x"),
			header(1, [text("H")]),
			text("y"),
		]);
	});

	it("keeps two header levels in wraps of their own", () => {
		expect(layout("# A\n## B", markdown)).to.deep.equal([
			header(1, [text("A")]),
			header(2, [text("B")]),
		]);
	});

	it("leaves the hashes alone when Markdown is off", () => {
		expect(layout("# Title")).to.deep.equal([text("# Title")]);
	});
});

describe("layout — parts", () => {
	it("finds channels", () => {
		expect(layout("see #chan", {channelPrefixes: ["#"], userModes: ["@"]})).to.deep.equal([
			text("see "),
			{kind: "channel", channel: "#chan", children: [text("#chan")]},
		]);
	});

	it("finds nicks it was given", () => {
		expect(layout("hi alice", {users: ["alice"]})).to.deep.equal([
			text("hi "),
			{kind: "nick", nick: "alice", children: [text("alice")]},
		]);
	});

	it("finds emoji", () => {
		expect(layout("hi 😀")).to.deep.equal([
			text("hi "),
			{kind: "emoji", emoji: "😀", children: [text("😀")]},
		]);
	});

	it("finds links, keeping the styling of the text they cover", () => {
		expect(layout("**https://example.com/x**", markdown)).to.deep.equal([
			{
				kind: "link",
				link: "https://example.com/x",
				children: [text("https://example.com/x", {bold: true})],
			},
		]);
	});

	it("suppresses the finders inside verbatim text", () => {
		const options = {markdown: true, channelPrefixes: ["#"], userModes: ["@"]};

		expect(layout("`#chan`", options)).to.deep.equal([text("#chan", {monospace: true})]);
		expect(layout("#chan", options)).to.deep.equal([
			{kind: "channel", channel: "#chan", children: [text("#chan")]},
		]);
	});

	it("renders a known shortcode as the character it stands for", () => {
		expect(layout("hi :smile:", markdown)).to.deep.equal([
			text("hi "),
			{kind: "emoji", emoji: "😄", children: [text("😄")]},
		]);
	});

	it("leaves an unknown or code-spanned shortcode as text", () => {
		expect(layout(":notanemoji:", markdown)).to.deep.equal([text(":notanemoji:")]);
		expect(layout("`:smile:`", markdown)).to.deep.equal([text(":smile:", {monospace: true})]);
		// A timestamp is not an alias, so nothing fires at all
		expect(layout("at 10:30:45", markdown)).to.deep.equal([text("at 10:30:45")]);
	});
});

describe("layout — lists, tables and math", () => {
	const list = (kind: string, children: LayoutNode[]): LayoutNode => ({
		kind: "wrap",
		wrap: "list",
		list: kind,
		children,
	});

	const table = (align: string, children: LayoutNode[]): LayoutNode => ({
		kind: "wrap",
		wrap: "table",
		table: align,
		children,
	});

	it("wraps a list, carrying its kind", () => {
		expect(layout("- a\n- b", markdown)).to.deep.equal([list("ul", [text("a\nb")])]);
		expect(layout("3. a\n4. b", markdown)).to.deep.equal([list("ol:3", [text("a\nb")])]);
	});

	it("nests the styles and parts of an item inside the list", () => {
		expect(layout("- **b** and #chan", {markdown: true, channelPrefixes: ["#"]})).to.deep.equal(
			[
				list("ul", [
					text("b", {bold: true}),
					text(" and "),
					{kind: "channel", channel: "#chan", children: [text("#chan")]},
				]),
			]
		);
	});

	it("wraps a table, carrying the columns' alignment", () => {
		expect(layout("| a | b |\n| :--- | ---: |\n| 1 | 2 |", markdown)).to.deep.equal([
			table("lr", [text("a|b\n1|2")]),
		]);
	});

	it("wraps inline and display TeX, with the TeX as the text", () => {
		expect(layout("$`a`$ b", markdown)).to.deep.equal([
			{kind: "wrap", wrap: "math", children: [text("a")]},
			text(" b"),
		]);
		expect(layout("$$\na\n$$", markdown)).to.deep.equal([
			{kind: "wrap", wrap: "mathBlock", children: [text("a")]},
		]);
	});

	it("carries the file of a `lang:file` fence tag", () => {
		expect(layout("```js:index.ts\nlet x\n```", markdown)).to.deep.equal([
			codeBlock([text("let x")], "js", "index.ts"),
		]);
	});

	// The adapter splits the wrap's text at the newlines and pipes it kept, so
	// they have to survive `toPlainText` exactly once per boundary.
	it("reads a table's rows and cells back out of the plain text", () => {
		expect(toPlainText(layout("| a | b |\n| - | - |\n| 1 | 2 |", markdown))).to.equal(
			"a|b\n1|2"
		);
	});

	it("keeps two tables with the same alignment apart", () => {
		expect(layout("| a |\n| - |\n| b |\n\n| c |\n| - |\n| d |", markdown)).to.deep.equal([
			table("l", [text("a\nb")]),
			text("\n"),
			table("l", [text("c\nd")]),
		]);
	});
});

describe("layout — monospace blocks", () => {
	const motd = "_____\n|  x  |\n \\_ _/";

	it("leaves a monospace block exactly as it came off the wire", () => {
		// Regression: the MOTD banner lost its `\_` when Markdown ran on it,
		// which is why monospace_block.vue renders with Markdown off
		expect(layout(motd)).to.deep.equal([text(motd)]);
	});

	it("still splits it per style run", () => {
		expect(layout("a\x02b\x02c")).to.deep.equal([
			text("a"),
			text("b", {bold: true}),
			text("c"),
		]);
	});
});

describe("layout — code blocks side by side", () => {
	it("keeps adjacent code blocks in different languages apart", () => {
		expect(layout("```js\na\n```\n```py\nb\n```", markdown)).to.deep.equal([
			codeBlock([text("a")], "js"),
			codeBlock([text("b")], "py"),
		]);
	});

	it("keeps two fences written back to back apart, in the same language or none", () => {
		expect(layout("```\na\n```\n```\nb\n```", markdown)).to.deep.equal([
			codeBlock([text("a")]),
			codeBlock([text("b")]),
		]);
		expect(layout("```js\na\n```\n\n```js\nb\n```", markdown)).to.deep.equal([
			codeBlock([text("a")], "js"),
			codeBlock([text("b")], "js"),
		]);
	});
});

describe("toPlainText", () => {
	it("concatenates the text of every node, markers gone", () => {
		expect(toPlainText(layout("**a** `b` [c](https://example.com/)", markdown))).to.equal(
			"a b c"
		);
	});

	it("keeps what is not a marker", () => {
		expect(toPlainText(layout("> quoted\n> lines", markdown))).to.equal("quoted\nlines");
		expect(toPlainText(layout("**a** ||b||"))).to.equal("**a** ||b||");
	});

	it("says a header as the line it is", () => {
		expect(toPlainText(layout("# Title", markdown))).to.equal("Title");
	});

	it("reads through parts", () => {
		expect(
			toPlainText(layout("see #chan", {channelPrefixes: ["#"], userModes: ["@"]}))
		).to.equal("see #chan");
	});
});

// What the message toolbar's "Copy code" action puts on the clipboard: the
// blocks a message renders, each as its own characters.
describe("codeBlocksOf", () => {
	it("finds nothing in a message without a block", () => {
		expect(codeBlocksOf(layout("plain `inline` text", markdown))).to.deep.equal([]);
	});

	it("finds nothing when Markdown is off", () => {
		expect(codeBlocksOf(layout("```let x = 1;```"))).to.deep.equal([]);
	});

	it("returns a block's characters, fence and tag gone", () => {
		expect(codeBlocksOf(layout("```js\nlet x = 1;\n```", markdown))).to.deep.equal([
			"let x = 1;",
		]);
	});

	it("returns back-to-back fences as separate blocks", () => {
		expect(codeBlocksOf(layout("```\na\n```\n```\nb\n```", markdown))).to.deep.equal([
			"a",
			"b",
		]);
	});

	it("keeps a URL inside a block as text", () => {
		expect(codeBlocksOf(layout("```see https://example.com/```", markdown))).to.deep.equal([
			"see https://example.com/",
		]);
	});

	it("returns several blocks in the order they render", () => {
		expect(codeBlocksOf(layout("```one``` between ```two```", markdown))).to.deep.equal([
			"one",
			"two",
		]);
	});

	it("reads a block out of the wrap it sits in", () => {
		expect(codeBlocksOf(layout("> quoted ```inside```", markdown))).to.deep.equal(["inside"]);
	});
});

// A quote of a message (the reply quote, the "Replying to" bar): one line of
// styled text nodes, every wrap folded into a style, cut at N visible
// characters.
describe("quoteLayout", () => {
	const md = {markdown: true};

	it("keeps IRC and markdown styles as styles, the markers gone", () => {
		expect(
			quoteLayout("\x02bold\x02 **strong** `code` \x0304red\x03 ~~gone~~", 80, md)
		).to.deep.equal([
			text("bold", {bold: true}),
			text(" "),
			text("strong", {bold: true}),
			text(" "),
			text("code", {monospace: true}),
			text(" "),
			text("red", {textColor: 4}),
			text(" "),
			text("gone", {strikethrough: true}),
		]);
	});

	it("leaves markdown markers alone when markdown is off", () => {
		expect(quoteLayout("\x02b\x02 **s**", 80)).to.deep.equal([
			text("b", {bold: true}),
			text(" **s**"),
		]);
	});

	it("folds a code block to monospace text and a header to bold, on one line", () => {
		expect(quoteLayout("```js\nconst a = 1;\nconst b = 2;\n```", 80, md)).to.deep.equal([
			text("const a = 1; const b = 2;", {monospace: true}),
		]);
		// the parser eats the newline after a block, a space stands in for it
		expect(quoteLayout("# Title\nbody", 80, md)).to.deep.equal([
			text("Title", {bold: true}),
			text(" "),
			text("body"),
		]);
		expect(toPlainText(quoteLayout("> quoted\n- a\n- b\ntail", 80, md))).to.equal(
			"quoted a b tail"
		);
	});

	it("renders links, channels, nicks and shortcodes as their text", () => {
		const nodes = quoteLayout("see https://x.test/a and #chan :tada: nick1", 80, {
			...md,
			users: ["nick1"],
		});
		expect(toPlainText(nodes)).to.equal("see https://x.test/a and #chan 🎉 nick1");
		expect(nodes.every((node) => node.kind === "text" && !Object.keys(node.style).length)).to.be
			.true;
	});

	it("does not leak a spoiler", () => {
		expect(quoteLayout("the ||secret|| is", 80, md)).to.deep.equal([
			text("the "),
			text("(spoiler)", {}),
			text(" is"),
		]);
	});

	it("collapses whitespace across nodes and trims the ends", () => {
		// a space stays in the run the source put it in
		expect(quoteLayout("  a \x02 b \x02\n\n c  ", 80)).to.deep.equal([
			text("a "),
			text("b ", {bold: true}),
			text("c"),
		]);
	});

	it("cuts at the visible length with an ellipsis, inside a styled run too", () => {
		expect(quoteLayout("**" + "x".repeat(100) + "**", 80, md)).to.deep.equal([
			text("x".repeat(79) + "…", {bold: true}),
		]);
		expect(quoteLayout("abc **def** ghi", 6, md)).to.deep.equal([
			text("abc "),
			text("d…", {bold: true}),
		]);
		expect(quoteLayout("abcdef", 6)).to.deep.equal([text("abcdef")]);
	});
});
