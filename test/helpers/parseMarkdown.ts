import {expect} from "chai";
import {applyMarkdown} from "../../client/js/helpers/ircmessageparser/parseMarkdown";
import parseStyle, {ParsedStyle} from "../../client/js/helpers/ircmessageparser/parseStyle";

// The Markdown flags a rendered fragment can carry.
const FLAGS: (keyof ParsedStyle)[] = [
	"bold",
	"italic",
	"underline",
	"strikethrough",
	"monospace",
	"codeBlock",
	"quote",
	"spoiler",
	"href",
	"lang",
	"file",
	"header",
	"list",
	"table",
	"math",
	"mathBlock",
];

type Rendered = Record<string, unknown>;

// What the Markdown stage makes of `input`: the text with the markers removed,
// split into fragments, each carrying only the flags that are set. Reads like
// the spec's syntax table, and says nothing about offsets — where the tokenizer
// happens to put a fragment boundary is not behaviour.
function md(input: string): Rendered[] {
	const {fragments} = applyMarkdown(parseStyle(input));

	return fragments.map((fragment) => {
		const rendered: Rendered = {text: fragment.text};

		for (const flag of FLAGS) {
			if (fragment[flag]) {
				rendered[flag] = fragment[flag];
			}
		}

		return rendered;
	});
}

// The message as the user sees it, markers gone.
function plain(input: string): string {
	return applyMarkdown(parseStyle(input))
		.fragments.map((fragment) => fragment.text)
		.join("");
}

// The stretches nothing is interpreted inside, as text rather than as offsets.
function verbatimText(input: string): string[] {
	const {fragments, verbatim} = applyMarkdown(parseStyle(input));
	const text = fragments.map((fragment) => fragment.text).join("");

	return verbatim.map((range) => text.slice(range.start, range.end));
}

describe("markdown — bold", () => {
	it("renders **text** bold", () => {
		expect(md("a **b** c")).to.deep.equal([
			{text: "a "},
			{text: "b", bold: true},
			{text: " c"},
		]);
	});

	it("leaves an unmatched ** literal", () => {
		expect(md("**a")).to.deep.equal([{text: "**a"}]);
		expect(md("a**")).to.deep.equal([{text: "a**"}]);
	});
});

describe("markdown — italic", () => {
	it("renders *text* and _text_ italic", () => {
		expect(md("*a*")).to.deep.equal([{text: "a", italic: true}]);
		expect(md("_a_")).to.deep.equal([{text: "a", italic: true}]);
	});

	it("italicises asterisks inside words", () => {
		expect(md("un*believ*able")).to.deep.equal([
			{text: "un"},
			{text: "believ", italic: true},
			{text: "able"},
		]);
	});

	it("leaves underscores inside words alone", () => {
		expect(md("snake_case_name")).to.deep.equal([{text: "snake_case_name"}]);
		expect(md("foo__bar__baz")).to.deep.equal([{text: "foo__bar__baz"}]);
	});
});

describe("markdown — underline and strikethrough", () => {
	it("renders __text__ underlined", () => {
		expect(md("__a__")).to.deep.equal([{text: "a", underline: true}]);
	});

	it("renders ~~text~~ struck through", () => {
		expect(md("~~a~~")).to.deep.equal([{text: "a", strikethrough: true}]);
	});

	it("needs both tildes", () => {
		expect(md("~a~")).to.deep.equal([{text: "~a~"}]);
	});
});

describe("markdown — spoiler", () => {
	it("renders ||text|| as a spoiler", () => {
		expect(md("||a||")).to.deep.equal([{text: "a", spoiler: true}]);
	});

	it("needs both bars", () => {
		expect(md("|a|")).to.deep.equal([{text: "|a|"}]);
	});
});

describe("markdown — inline code", () => {
	it("renders `text` monospace and interprets nothing inside it", () => {
		expect(md("`a`")).to.deep.equal([{text: "a", monospace: true}]);
		expect(md("`**x**`")).to.deep.equal([{text: "**x**", monospace: true}]);
	});

	it("reports the code as verbatim, so the finders skip it", () => {
		expect(verbatimText("a `#chan` b")).to.deep.equal(["#chan"]);
		expect(verbatimText("a #chan b")).to.deep.equal([]);
	});

	it("leaves empty or unmatched backticks literal", () => {
		expect(md("``")).to.deep.equal([{text: "``"}]);
		expect(md("a ` b")).to.deep.equal([{text: "a ` b"}]);
	});
});

describe("markdown — inline code with longer runs", () => {
	it("renders ``text`` and keeps a backtick inside it", () => {
		expect(md("``a `b` c``")).to.deep.equal([{text: "a `b` c", monospace: true}]);
	});

	it("takes a run literally when nothing of the same length closes it", () => {
		// As CommonMark: the unmatched `` is literal, and the lone `b` pair
		// behind it still makes its own span
		expect(md("``a `b`")).to.deep.equal([{text: "``a "}, {text: "b", monospace: true}]);
	});

	it("needs something between the delimiters", () => {
		expect(md("````")).to.deep.equal([{text: "````"}]);
		expect(md("`` ``")).to.deep.equal([{text: " ", monospace: true}]);
	});

	it("still reports the span as verbatim", () => {
		expect(verbatimText("a ``#chan`` b")).to.deep.equal(["#chan"]);
	});
});

describe("markdown — code block", () => {
	it("renders a single-line ```block```", () => {
		expect(md("```code```")).to.deep.equal([{text: "code", codeBlock: true}]);
	});

	it("keeps the language tag and drops the newlines around the fences", () => {
		expect(md("before\n```js\nlet x = 1;\n```\nafter")).to.deep.equal([
			{text: "before"},
			{text: "let x = 1;", codeBlock: true, lang: "js"},
			{text: "after"},
		]);
	});

	it("lower-cases the tag and accepts the `+`/`-` in one", () => {
		expect(md("```C++\ncode```")).to.deep.equal([{text: "code", codeBlock: true, lang: "c++"}]);
	});

	it("carries no tag when the fence line holds none", () => {
		expect(md("```\nlet x = 1;\n```")).to.deep.equal([{text: "let x = 1;", codeBlock: true}]);
	});

	it("carries no tag on a single-line block: the tag needs the newline", () => {
		expect(md("```js let x = 1;```")).to.deep.equal([{text: "js let x = 1;", codeBlock: true}]);
	});

	it("reports the block as verbatim", () => {
		expect(verbatimText("```code```")).to.deep.equal(["code"]);
	});

	it("leaves an unclosed fence literal", () => {
		expect(md("```nope")).to.deep.equal([{text: "```nope"}]);
	});

	it("lets a longer fence hold a shorter one", () => {
		expect(md("````\ncode with ``` inside\n````")).to.deep.equal([
			{text: "code with ``` inside", codeBlock: true},
		]);
	});

	it("closes a long fence only at a run as long or longer", () => {
		expect(md("````\na\n```\n````")).to.deep.equal([{text: "a\n```", codeBlock: true}]);
	});

	it("carries the file a `lang:file` tag named", () => {
		expect(md("```js:index.ts\nlet x = 1;\n```")).to.deep.equal([
			{text: "let x = 1;", codeBlock: true, lang: "js", file: "index.ts"},
		]);
		expect(md("```:notes.txt\ntext\n```")).to.deep.equal([
			{text: "text", codeBlock: true, file: "notes.txt"},
		]);
	});

	it("makes no code block inside a table row", () => {
		expect(md("| a |\n| - |\n| ``` |")).to.deep.equal([{text: "a\n```", table: "l"}]);
	});
});

describe("markdown — quote-everything-after", () => {
	it("quotes the rest of the message for `>>> `", () => {
		expect(md(">>> a\nb\nc")).to.deep.equal([{text: "a\nb\nc", quote: true}]);
	});

	it("strips the `> ` markers of lines inside it", () => {
		expect(md(">>> a\n> b")).to.deep.equal([{text: "a\nb", quote: true}]);
	});

	it("takes `>>>` only at the very start", () => {
		expect(md("a\n>>> b")).to.deep.equal([{text: "a\n>>> b"}]);
		expect(md(">>>b")).to.deep.equal([{text: ">>>b"}]);
	});

	it("still nests lists and styles inside the quote", () => {
		expect(md(">>> a\n- b")).to.deep.equal([
			{text: "a\n", quote: true},
			{text: "b", quote: true, list: "ul"},
		]);
	});
});

describe("markdown — lists", () => {
	it("renders `- ` lines as one unordered list", () => {
		expect(md("- a\n- b")).to.deep.equal([{text: "a\nb", list: "ul"}]);
	});

	it("renders `1. ` lines as an ordered list starting at the first number", () => {
		expect(md("3. a\n4. b")).to.deep.equal([{text: "a\nb", list: "ol:3"}]);
		expect(md("1. a\n2. b")).to.deep.equal([{text: "a\nb", list: "ol:1"}]);
	});

	it("reads the markers inside an item", () => {
		expect(md("- **b**")).to.deep.equal([{text: "b", list: "ul", bold: true}]);
	});

	it("ends the list at a line that is not an item", () => {
		expect(md("- a\nb")).to.deep.equal([{text: "a", list: "ul"}, {text: "b"}]);
		expect(md("- a\n\n- b")).to.deep.equal([
			{text: "a", list: "ul"},
			{text: "\n"},
			{text: "b", list: "ul"},
		]);
	});

	it("keeps unordered and ordered lists apart", () => {
		expect(md("- a\n1. b")).to.deep.equal([
			{text: "a", list: "ul"},
			{text: "b", list: "ol:1"},
		]);
	});

	it("only makes a list of a marker at the start of a line", () => {
		expect(md("a - b")).to.deep.equal([{text: "a - b"}]);
		expect(md("-5 degrees")).to.deep.equal([{text: "-5 degrees"}]);
		expect(md("1.points")).to.deep.equal([{text: "1.points"}]);
		expect(md("- ")).to.deep.equal([{text: "- "}]);
	});

	it("takes a backslash-escaped dash literally", () => {
		expect(md("\\- not a list")).to.deep.equal([{text: "- not a list"}]);
	});

	it("makes no list inside a quote or a code block", () => {
		expect(md("> - a")).to.deep.equal([{text: "- a", quote: true}]);
		expect(md("```\n- a\n```")).to.deep.equal([{text: "- a", codeBlock: true}]);
	});
});

describe("markdown — pipe tables", () => {
	it("renders a table without its separator row", () => {
		expect(md("| a | b |\n| --- | --- |\n| 1 | 2 |")).to.deep.equal([
			{text: "a|b\n1|2", table: "ll"},
		]);
	});

	it("makes outer pipes and their padding optional", () => {
		expect(md("a | b\n--- | ---")).to.deep.equal([{text: "a|b", table: "ll"}]);
	});

	it("carries each column's alignment", () => {
		expect(md("| a | b | c | d |\n| :--- | ---: | :---: | --- |")).to.deep.equal([
			{text: "a|b|c|d", table: "lrcl"},
		]);
	});

	it("keeps the pipes of the rows as cell boundaries", () => {
		expect(plain("| a | b |\n| - | - |\n| 1 | 2 |")).to.equal("a|b\n1|2");
	});

	it("reads the markers and links inside a cell", () => {
		// The newline that separates the rows is part of the table's text, so
		// the header row here carries it
		expect(md("| x |\n| --- |\n| **b** |")).to.deep.equal([
			{text: "x\n", table: "l"},
			{text: "b", table: "l", bold: true},
		]);
	});

	it("needs a separator row of dashes, and as many cells as the header", () => {
		expect(md("a | b\nc | d")).to.deep.equal([{text: "a | b\nc | d"}]);
		// Not a table, and `- | - | -` is a `- ` list line, as on GitHub
		expect(md("a | b\n- | - | -")).to.deep.equal([
			{text: "a | b\n"},
			{text: "| - | -", list: "ul"},
		]);
		expect(md("a | b\n---")).to.deep.equal([{text: "a | b\n---"}]);
	});

	it("takes no table inside a code fence", () => {
		expect(md("```\n| a |\n| - |\n```")).to.deep.equal([
			{text: "| a |\n| - |", codeBlock: true},
		]);
	});

	it("makes no table of a spoiler's bars", () => {
		expect(md("||a||")).to.deep.equal([{text: "a", spoiler: true}]);
	});
});

describe("markdown — math", () => {
	it("renders ``$`…`$`` inline, carrying the TeX", () => {
		expect(md("$`E=mc^2`$ done")).to.deep.equal([
			{text: "E=mc^2", math: "E=mc^2"},
			{text: " done"},
		]);
	});

	it("renders `$$…$$` display, dropping the newlines around it", () => {
		expect(md("before\n$$\nx = y\n$$\nafter")).to.deep.equal([
			{text: "before"},
			{text: "x = y", mathBlock: "x = y"},
			{text: "after"},
		]);
	});

	it("reports the TeX as verbatim, so the finders skip it", () => {
		expect(verbatimText("$`#chan`$")).to.deep.equal(["#chan"]);
	});

	it("leaves money alone", () => {
		expect(md("$5 and 50 cents")).to.deep.equal([{text: "$5 and 50 cents"}]);
		expect(md("costs $$")).to.deep.equal([{text: "costs $$"}]);
	});

	it("leaves an unclosed span literal", () => {
		expect(md("$`x")).to.deep.equal([{text: "$`x"}]);
		expect(md("$$\nx")).to.deep.equal([{text: "$$\nx"}]);
	});

	it("takes a backslash-escaped dollar literally", () => {
		expect(md("\\$5")).to.deep.equal([{text: "$5"}]);
	});

	it("keeps two identical spans apart", () => {
		const fragments = md("$`a`$$`a`$");

		expect(fragments).to.have.lengthOf(2);
	});
});

describe("markdown — quote", () => {
	it("renders a `> ` line as a quote without its marker", () => {
		expect(md("> hi *there*")).to.deep.equal([
			{text: "hi ", quote: true},
			{text: "there", italic: true, quote: true},
		]);
	});

	it("merges consecutive quote lines and ends the block at the blank line", () => {
		expect(md("> a\n> b\nc")).to.deep.equal([{text: "a\nb", quote: true}, {text: "c"}]);
	});

	it("merges consecutive quote lines when the first one holds inline markup", () => {
		// Regression: the newline joining the lines used to escape the block
		expect(md("> a *b*\n> c")).to.deep.equal([
			{text: "a ", quote: true},
			{text: "b", italic: true, quote: true},
			{text: "\nc", quote: true},
		]);
	});

	it("only quotes a `> ` at the start of a line", () => {
		expect(md("a > b")).to.deep.equal([{text: "a > b"}]);
		expect(md(">b")).to.deep.equal([{text: ">b"}]);
	});
});

describe("markdown — header", () => {
	it("renders a `# ` line as a header without its marker", () => {
		expect(md("# Title")).to.deep.equal([{text: "Title", header: 1}]);
	});

	it("still reads the markers inside a header", () => {
		expect(md("### a **b**")).to.deep.equal([
			{text: "a ", header: 3},
			{text: "b", header: 3, bold: true},
		]);
	});

	it("takes one to six hashes and no more", () => {
		expect(md("###### h")).to.deep.equal([{text: "h", header: 6}]);
		expect(md("####### h")).to.deep.equal([{text: "####### h"}]);
	});

	it("needs the space and something after it", () => {
		expect(md("#chan")).to.deep.equal([{text: "#chan"}]);
		expect(md("# ")).to.deep.equal([{text: "# "}]);
	});

	it("takes a backslash-escaped hash literally", () => {
		expect(md("\\# x")).to.deep.equal([{text: "# x"}]);
	});

	it("only makes a header of a `# ` at the start of a line", () => {
		expect(md("a # b")).to.deep.equal([{text: "a # b"}]);
	});

	it("drops the newlines the header line sits between", () => {
		expect(md("line\n## H\nrest")).to.deep.equal([
			{text: "line"},
			{text: "H", header: 2},
			{text: "rest"},
		]);
	});

	it("keeps consecutive headers of one level in one block", () => {
		expect(md("# A\n# B")).to.deep.equal([{text: "A\nB", header: 1}]);
	});

	it("keeps headers of different levels apart", () => {
		expect(md("# A\n## B")).to.deep.equal([
			{text: "A", header: 1},
			{text: "B", header: 2},
		]);
	});

	it("keeps a blank line the user typed between two headers", () => {
		expect(md("# A\n\n# B")).to.deep.equal([
			{text: "A", header: 1},
			{text: "\n"},
			{text: "B", header: 1},
		]);
	});

	it("nests a header inside a quote", () => {
		expect(md("> # q")).to.deep.equal([{text: "q", quote: true, header: 1}]);
		expect(md("> # a\n> # b")).to.deep.equal([{text: "a\nb", quote: true, header: 1}]);
	});

	it("makes no header of a hash inside code", () => {
		expect(md("```\n# not\n```")).to.deep.equal([{text: "# not", codeBlock: true}]);
		expect(md("`# not`")).to.deep.equal([{text: "# not", monospace: true}]);
	});
});

describe("markdown — masked links", () => {
	it("renders [text](url) with the url behind the text", () => {
		expect(md("[site](https://example.com/a)")).to.deep.equal([
			{text: "site", href: "https://example.com/a"},
		]);
	});

	it("accepts web+irc: links", () => {
		expect(md("[c](web+irc://irc.example.org/#chan)")).to.deep.equal([
			{text: "c", href: "web+irc://irc.example.org/#chan"},
		]);
	});

	it("allows one level of balanced parentheses in the url", () => {
		expect(md("[wiki](https://en.wikipedia.org/wiki/Foo_(bar))")).to.deep.equal([
			{text: "wiki", href: "https://en.wikipedia.org/wiki/Foo_(bar)"},
		]);
	});

	it("matches the scheme case-insensitively", () => {
		expect(md("[x](HTTPS://e.test)")).to.deep.equal([{text: "x", href: "HTTPS://e.test"}]);
	});

	it("interprets markup in the link text", () => {
		expect(md("[**b**](https://e.com)")).to.deep.equal([
			{text: "b", bold: true, href: "https://e.com"},
		]);
	});

	it("rejects other schemes and malformed syntax", () => {
		expect(md("[x](javascript:alert(1))")).to.deep.equal([{text: "[x](javascript:alert(1))"}]);
		expect(md("[x](ftp://e.com)")).to.deep.equal([{text: "[x](ftp://e.com)"}]);
		expect(md("[x] (https://e.com)")).to.deep.equal([{text: "[x] (https://e.com)"}]);
	});

	it("keeps the url tail opaque when a later url is opaque too", () => {
		expect(md("[a](https://x/*) b* https://y.com")).to.deep.equal([
			{text: "a", href: "https://x/*"},
			{text: " b* https://y.com"},
		]);
	});
});

describe("markdown — escapes", () => {
	it("takes a backslash-escaped marker literally", () => {
		expect(md("\\*not italic\\*")).to.deep.equal([{text: "*not italic*"}]);
		expect(md("\\\\")).to.deep.equal([{text: "\\"}]);
	});

	it("leaves a backslash before an ordinary character alone", () => {
		expect(md("a\\b")).to.deep.equal([{text: "a\\b"}]);
	});

	it("keeps a backslash at the end of the text", () => {
		// Regression: the trailing backslash used to swallow itself
		expect(md("a\\")).to.deep.equal([{text: "a\\"}]);
		expect(md("C:\\")).to.deep.equal([{text: "C:\\"}]);
	});

	it("keeps a backslash that sits between two symbols: that is art, not an escape", () => {
		// The shrug is what everyone else on the channel sees; the marker it
		// touches still opens nothing
		expect(md("¯\\_(ツ)_/¯")).to.deep.equal([{text: "¯\\_(ツ)_/¯"}]);
		expect(md("(\\_/)")).to.deep.equal([{text: "(\\_/)"}]);
		// The kept marker is no delimiter: the emphasis around it still pairs
		expect(md("*a (\\*) b*")).to.deep.equal([{text: "a (\\*) b", italic: true}]);
	});

	it("still escapes a marker that touches a word, another marker or the end", () => {
		expect(md("snake\\_case")).to.deep.equal([{text: "snake_case"}]);
		expect(md("\\_\\_init\\_\\_")).to.deep.equal([{text: "__init__"}]);
		expect(md("\\*\\*not bold\\*\\*")).to.deep.equal([{text: "**not bold**"}]);
		expect(md("(\\*")).to.deep.equal([{text: "(*"}]);
		// A doubled backslash is one backslash wherever it sits
		expect(md("(\\\\)")).to.deep.equal([{text: "(\\)"}]);
	});
});

describe("markdown — nesting and malformed markers", () => {
	it("nests ***bold italic***", () => {
		expect(md("***a***")).to.deep.equal([{text: "a", bold: true, italic: true}]);
	});

	it("nests italic inside bold", () => {
		expect(md("**bold *and italic* text**")).to.deep.equal([
			{text: "bold ", bold: true},
			{text: "and italic", bold: true, italic: true},
			{text: " text", bold: true},
		]);
	});

	it("needs a non-space next to the markers", () => {
		expect(md("** a **")).to.deep.equal([{text: "** a **"}]);
		expect(md("2 * 3 * 4")).to.deep.equal([{text: "2 * 3 * 4"}]);
	});

	it("merges neighbouring spans that end up identical", () => {
		expect(md("**a****b**")).to.deep.equal([{text: "ab", bold: true}]);
	});
});

describe("markdown — urls are opaque", () => {
	it("never reads markers inside a url", () => {
		expect(md("see https://example.com/a_b_c_d ok")).to.deep.equal([
			{text: "see https://example.com/a_b_c_d ok"},
		]);
	});

	it("still styles markup wrapped around a url", () => {
		// linkify-it swallows the trailing "**" into the url; the tokenizer
		// trims it back off so the bold span closes
		expect(md("**https://example.com/x**")).to.deep.equal([
			{text: "https://example.com/x", bold: true},
		]);
	});
});

describe("markdown — composition", () => {
	it("composes with IRC control codes", () => {
		expect(md("\x02x *y*\x02 z")).to.deep.equal([
			{text: "x ", bold: true},
			{text: "y", bold: true, italic: true},
			{text: " z"},
		]);
	});

	it("splits a styled fragment around a marker", () => {
		expect(md("\x1dab `c` d\x1d")).to.deep.equal([
			{text: "ab ", italic: true},
			{text: "c", italic: true, monospace: true},
			{text: " d", italic: true},
		]);
	});

	// `verbatim` is not a style key, so an IRC monospace run and the inline code
	// next to it are one fragment and render as one `.irc-monospace` pill.
	it("merges an IRC monospace run into the inline code beside it", () => {
		expect(md("\x11a\x11`b`")).to.deep.equal([{text: "ab", monospace: true}]);
	});

	it("carries every wrap flag at once", () => {
		expect(md("[t](https://e.com) ||s||")).to.deep.equal([
			{text: "t", href: "https://e.com"},
			{text: " "},
			{text: "s", spoiler: true},
		]);
		expect(md("> q\n```c```")).to.deep.equal([
			{text: "q", quote: true},
			{text: "c", codeBlock: true},
		]);
	});

	it("leaves plain text and its fragments untouched", () => {
		const input = parseStyle("plain");

		expect(applyMarkdown(input).fragments).to.equal(input);
		expect(applyMarkdown(input).verbatim).to.deep.equal([]);
	});

	it("handles empty input", () => {
		expect(applyMarkdown([]).fragments).to.deep.equal([]);
	});
});

// A message can run to `draft/multiline`'s 16 KB, and anyone can send one
// built to be slow: each of these took 200–360ms before the scan went linear.
describe("markdown — cost of a hostile 16 KB message", () => {
	const shapes: [string, string][] = [
		["code spans", "`a".repeat(8000)],
		["emphasis markers", "*_".repeat(8000)],
		["a 4000-column table", "|a".repeat(4000) + "\n" + "|-".repeat(4000)],
		["colours between markers", "\x0304a\x0305 **b** ".repeat(1500)],
	];

	for (const [name, text] of shapes) {
		it(`stays fast on ${name}`, () => {
			const fragments = parseStyle(text);
			const started = Date.now();
			applyMarkdown(fragments);
			expect(Date.now() - started).to.be.below(120);
		});
	}
});
