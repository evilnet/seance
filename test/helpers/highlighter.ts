import fs from "fs";
import path from "path";
import {expect} from "chai";
import Prism from "prismjs/components/prism-core";
import {
	GUESS_MIN_CONFIDENCE,
	MIN_GUESS_LINES,
	ensureLanguage,
	guessLanguage,
	highlight,
	normalizeLang,
	splitLines,
} from "../../client/js/helpers/ircmessageparser/highlighter";

describe("highlighter — normalizeLang", () => {
	it("resolves Prism's aliases", () => {
		expect(normalizeLang("js")).to.equal("javascript");
		expect(normalizeLang("sh")).to.equal("bash");
		expect(normalizeLang("ts")).to.equal("typescript");
		expect(normalizeLang("yml")).to.equal("yaml");
	});

	it("takes the tag as written: case and surrounding space", () => {
		expect(normalizeLang("JS")).to.equal("javascript");
		expect(normalizeLang(" Python ")).to.equal("python");
	});

	it("knows the punctuation forms Prism's table has no alias for", () => {
		expect(normalizeLang("c++")).to.equal("cpp");
		expect(normalizeLang("c#")).to.equal("csharp");
	});

	it("says nothing for a tag Prism does not know", () => {
		expect(normalizeLang("nope")).to.equal(undefined);
		expect(normalizeLang("")).to.equal(undefined);
		expect(normalizeLang(undefined)).to.equal(undefined);
	});
});

describe("highlighter — splitLines", () => {
	it("splits on newlines", () => {
		expect(splitLines("a\nb\nc")).to.deep.equal(["a", "b", "c"]);
	});

	it("drops the empty line a trailing newline leaves", () => {
		expect(splitLines("a\nb\n")).to.deep.equal(["a", "b"]);
	});

	it("keeps a single line, empty or not", () => {
		expect(splitLines("a")).to.deep.equal(["a"]);
		expect(splitLines("")).to.deep.equal([""]);
	});
});

describe("highlighter — highlight", () => {
	before(() => {
		Prism.languages.stub = {kw: /\bfoo\b/};
	});

	after(() => {
		delete Prism.languages.stub;
	});

	it("names the token types and leaves the rest bare", () => {
		expect(highlight("foo bar", "stub")).to.deep.equal([
			[{text: "foo", type: "kw"}, {text: " bar"}],
		]);
	});

	it("breaks a token that spans a newline into one array per line", () => {
		expect(highlight("a foo\nfoo b", "stub")).to.deep.equal([
			[{text: "a "}, {text: "foo", type: "kw"}],
			[{text: "foo", type: "kw"}, {text: " b"}],
		]);
	});

	it("gives one array per line, empty lines included", () => {
		expect(highlight("foo\n\nfoo", "stub")).to.deep.equal([
			[{text: "foo", type: "kw"}],
			[],
			[{text: "foo", type: "kw"}],
		]);
	});

	it("says nothing when the grammar is not loaded", () => {
		expect(highlight("foo", "notloaded")).to.equal(undefined);
		expect(highlight("foo", undefined)).to.equal(undefined);
	});
});

describe("highlighter — ensureLanguage", () => {
	it("loads a grammar and its dependencies", async () => {
		expect(highlight("const x = 1;", "javascript")).to.equal(undefined);
		expect(await ensureLanguage("javascript")).to.be.true;
		// javascript extends clike, which has to be there first
		expect(Prism.languages.clike).to.not.equal(undefined);

		const lines = highlight("const x = 1;", "javascript");

		expect(lines).to.have.lengthOf(1);
		expect(lines![0][0]).to.deep.equal({text: "const", type: "keyword"});
	});

	it("takes an alias", async () => {
		expect(await ensureLanguage("js")).to.be.true;
	});

	it("says so when the language is not one of Prism's", async () => {
		expect(await ensureLanguage("nope")).to.be.false;
	});
});

describe("highlighter — guessLanguage", () => {
	it("does not guess a block shorter than MIN_GUESS_LINES", async () => {
		expect(MIN_GUESS_LINES).to.equal(2);
		expect(await guessLanguage("const x = 1;")).to.equal(undefined);
	});

	it("guesses a multi-line snippet and answers with a Prism id", async () => {
		const code = "def add(a, b):\n    return a + b\n\nprint(add(1, 2))";

		expect(await guessLanguage(code)).to.equal("python");
	});

	it("says nothing when nothing looks like code", async () => {
		expect(GUESS_MIN_CONFIDENCE).to.be.within(0, 1);
		expect(await guessLanguage("hello there\nnothing to see here\n")).to.equal(undefined);
	});
});

describe("highlighter — markup", () => {
	// `markup` pulls in no other grammar, so loading it here cannot satisfy
	// the "not loaded yet" assertions the `ensureLanguage` block makes.
	before(async () => {
		expect(await ensureLanguage("xml")).to.be.true;
	});

	it("names the token types the stylesheet colours", () => {
		const lines = highlight('<note id="1">\n  <to>Tove</to>\n</note>', "markup");

		expect(lines).to.have.lengthOf(3);
		expect(lines![0].slice(0, 2)).to.deep.equal([
			{text: "<", type: "punctuation"},
			{text: "note", type: "tag"},
		]);

		const types = new Set(lines!.flat().map((item) => item.type));

		for (const type of ["tag", "attr-name", "attr-value", "punctuation"]) {
			expect(types).to.include(type);
		}
	});

	it("keeps the prolog of an XML declaration whole", () => {
		const lines = highlight('<?xml version="1.0"?>\n<root/>', "markup");

		expect(lines![0]).to.deep.equal([{text: '<?xml version="1.0"?>', type: "prolog"}]);
	});
});

describe("highlighter — guessLanguage reads a script's #! line", () => {
	const scripts: [string, string][] = [
		["#!/bin/bash\necho hi\nls -la", "bash"],
		["#!/bin/sh\nset -e\nmake", "bash"],
		["#! /bin/zsh\nprint hi", "bash"],
		["#!/usr/bin/env python3\nprint(1)\nx = 2", "python"],
		["#!/usr/bin/python3.11 -u\nprint(1)", "python"],
		["#!/usr/bin/env pypy3\nprint(1)", "python"],
		["#!/usr/bin/env -S node --no-warnings\nconsole.log(1)", "javascript"],
		["#!/usr/bin/env LANG=C perl\nprint 1;", "perl"],
		["#!/usr/local/bin/ruby2.7\nputs 1", "ruby"],
		["#!/usr/bin/env deno\nconsole.log(1)", "typescript"],
		["\n#!/usr/bin/env lua\nprint(1)", "lua"],
	];

	for (const [code, lang] of scripts) {
		it(`${code.trim().split("\n")[0]} → ${lang}`, async () => {
			expect(await guessLanguage(code)).to.equal(lang);
		});
	}

	it("names nothing for an interpreter it does not know", async () => {
		expect(await guessLanguage("#!/usr/bin/env frobnicate\nfrob 1\nfrob 2")).to.equal(
			undefined
		);
		expect(await guessLanguage("#!/usr/bin/env\nnothing named")).to.equal(undefined);
	});

	it("still needs MIN_GUESS_LINES", async () => {
		expect(await guessLanguage("#!/bin/sh")).to.equal(undefined);
	});

	it("reads #! only at the start of the block", async () => {
		expect(await guessLanguage("hello there\n#!/bin/sh\nnothing to see here")).to.equal(
			undefined
		);
	});
});

describe("highlighter — guessLanguage sees markup by its shape", () => {
	// flourite scores markup badly: these all used to come back undefined or,
	// worse, confidently wrong.
	const markup: Record<string, string> = {
		"attributes and no text": '<config debug="true">\n  <path value="/tmp"/>\n</config>',
		"a namespace URL": '<svg xmlns="http://www.w3.org/2000/svg">\n  <rect width="1"/>\n</svg>',
		"self-closing tags only": "<a/>\n<b/>",
		"one element over two lines": "<root>\n</root>",
		"a POM fragment": "<dependency>\n  <groupId>org.foo</groupId>\n</dependency>",
		"an XML declaration": '<?xml version="1.0"?>\n<root>ok</root>',
		"a leading comment": "<!-- a note -->\n<root>ok</root>",
		// The block that started this: one element, one word of text
		"an element around a word": "<xml>\ntest\n</xml>",
	};

	for (const [name, code] of Object.entries(markup)) {
		it(`guesses markup for ${name}`, async () => {
			expect(await guessLanguage(code)).to.equal("markup");
		});
	}

	it("still needs MIN_GUESS_LINES lines", async () => {
		expect(await guessLanguage("<a>b</a>")).to.equal(undefined);
	});

	it("leaves braces to the guesser, so JSX is not markup by shape", async () => {
		const code = "const App = () => (\n  <div className={cls}>\n    <Hi />\n  </div>\n);";

		expect(await guessLanguage(code)).to.not.equal("markup");
	});

	it("does not turn other languages into markup", async () => {
		expect(await guessLanguage("def add(a, b):\n    return a + b\n")).to.equal("python");
		expect(await guessLanguage("hello there\nnothing to see here\n")).to.equal(undefined);
	});
});

describe("highlighter — the token palette", () => {
	const css = fs.readFileSync(path.join(process.cwd(), "client", "css", "style.css"), "utf8");

	// The Prism token types the shipped grammars emit often enough that a
	// block would read as half-highlighted without them.
	const types = [
		"attr-name",
		"attr-value",
		"boolean",
		"builtin",
		"class-name",
		"comment",
		"function",
		"keyword",
		"number",
		"operator",
		"property",
		"punctuation",
		"regex",
		"selector",
		"string",
		"tag",
		"variable",
	];

	it("colours every type a shipped grammar commonly emits", () => {
		// A selector ends at a comma, a brace or space, so `.tok-attr` cannot
		// stand in for `.tok-attr-name`.
		const missing = types.filter((type) => !new RegExp(`\\.tok-${type}(?=[\\s,{])`).test(css));

		expect(missing).to.deep.equal([]);
	});

	it("leaves an unmapped type the block's own colour, in both themes", () => {
		const morning = fs.readFileSync(
			path.join(process.cwd(), "client", "themes", "morning.css"),
			"utf8"
		);

		expect(css).to.match(/--md-code-color:/);
		expect(morning).to.match(/--md-code-color:/);
		expect(css).to.match(/\.md-code-block\s*\{[^}]*color: var\(--md-code-color\)/);
	});
});
