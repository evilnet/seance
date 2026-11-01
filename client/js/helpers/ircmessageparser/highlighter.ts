/**
 * Syntax highlighting for the code blocks of the layout tree.
 *
 * Prism does the tokenising; this module owns everything around it: which id a
 * fence tag means, which grammar chunk to fetch, and how a Prism token tree
 * becomes plain `CodeToken` rows the Vue adapter can render as elements. No
 * HTML strings ever leave here, so a code block is as XSS-proof as the rest of
 * the pipeline.
 *
 * Only Prism's core is loaded up front. Every grammar and the language guesser
 * are `import()`ed on first use, so an untagged message costs nothing and a
 * fetch that fails (offline, unknown language) just leaves the block plain.
 *
 * Imports nothing from Vue, the store or the DOM, so mocha loads it directly
 * (`test/helpers/highlighter.ts`).
 */

// Must come first: the core reads `manual` off the global as it loads
import "./prism-manual";
import Prism from "prismjs/components/prism-core";
import type {Token} from "prismjs";
import components from "prismjs/components.json";
import {MIN_GUESS_LINES, splitLines} from "./codeLines";

// The block's shape is decided without any of this module; re-exported so the
// highlighting interface still reads as one.
export {MIN_GUESS_LINES, splitLines};

// One run of code that renders the same way. `type` is Prism's token type
// (`keyword`, `string`, ...) and is absent for text no rule matched.
export type CodeToken = {text: string; type?: string};

// The tokens of a code block, one array per line.
export type Highlighted = CodeToken[][];

// How far ahead of the runner-up flourite's answer has to be, as
// `points / (points + runner-up points)`. 0.5 means "strictly ahead".
export const GUESS_MIN_CONFIDENCE = 0.5;

type LanguageEntry = {
	alias?: string | string[];
	require?: string | string[];
	optional?: string | string[];
	modify?: string | string[];
};

// `components.json` is Prism's own table of ids, aliases and dependencies —
// the alternative is hand-maintaining both, and they change with every release.
const languages = components.languages as unknown as Record<string, LanguageEntry>;

const asList = (value: string | string[] | undefined): string[] =>
	value === undefined ? [] : Array.isArray(value) ? value : [value];

// tag → Prism id, for every id and every alias Prism knows.
const idByTag = new Map<string, string>();

for (const [id, entry] of Object.entries(languages)) {
	// Not a language: `meta` describes where the component files live
	if (id === "meta") {
		continue;
	}

	idByTag.set(id, id);

	for (const alias of asList(entry.alias)) {
		idByTag.set(alias, id);
	}
}

// The spellings people write that Prism's table has no alias for.
for (const [tag, id] of [
	["c++", "cpp"],
	["c#", "csharp"],
	["f#", "fsharp"],
	["objective-c", "objectivec"],
]) {
	if (languages[id]) {
		idByTag.set(tag, id);
	}
}

// The grammar files are plain scripts that reach for a global `Prism`. In a
// browser the core publishes itself on `window`; under Node its `_self` is a
// bare object, so publish it here for both.
(globalThis as unknown as {Prism: typeof Prism}).Prism = Prism;

// In-flight and finished grammar loads, so a language is fetched once a session
const loads = new Map<string, Promise<boolean>>();

// The Prism id a fence tag means, or undefined when Prism knows no such
// language. Case and surrounding space are the writer's, not the tag's.
export function normalizeLang(tag: string | undefined): string | undefined {
	if (!tag) {
		return undefined;
	}

	return idByTag.get(tag.trim().toLowerCase());
}

// The block's tokens, or undefined while the grammar is not loaded — the
// caller renders plain lines until `ensureLanguage` says otherwise.
export function highlight(code: string, lang: string | undefined): Highlighted | undefined {
	if (!lang) {
		return undefined;
	}

	const grammar = Prism.languages[lang];

	if (!grammar) {
		return undefined;
	}

	return toLines(flatten(Prism.tokenize(code, grammar), undefined));
}

// Fetches a grammar and everything it needs, once per language. Resolves false
// for a language Prism does not have and for a chunk that will not load.
export function ensureLanguage(lang: string): Promise<boolean> {
	const id = normalizeLang(lang);

	if (!id) {
		return Promise.resolve(false);
	}

	if (Prism.languages[id]) {
		return Promise.resolve(true);
	}

	let load = loads.get(id);

	if (!load) {
		load = loadLanguage(id);
		loads.set(id, load);
	}

	return load;
}

// What language an untagged block looks like, as a Prism id. Undefined when the
// block is too short to tell, when flourite is unsure, or when it will not load.
export async function guessLanguage(code: string): Promise<string | undefined> {
	if (splitLines(code).length < MIN_GUESS_LINES) {
		return undefined;
	}

	// A script says what runs it, and flourite cannot be asked: it reads only
	// `#!/usr/bin/env <name>` and `#!/bin/bash`, and answers those with no
	// points at all, which `confidence` takes for no answer.
	const interpreted = shebangLanguage(code);

	if (interpreted) {
		return interpreted;
	}

	// A document that opens with a tag and closes it is not in doubt, and
	// flourite is at its worst here: plain XML ties with C, a POM reads as
	// Julia. Deciding by shape also spares the guesser's chunk.
	if (looksLikeMarkup(code)) {
		return "markup";
	}

	let detect;

	try {
		detect = (await import(/* webpackChunkName: "flourite" */ "flourite")).default;
	} catch {
		return undefined;
	}

	const guess = detect(code, {shiki: false, heuristic: true});

	if (!guess.language || guess.language === "Unknown") {
		return undefined;
	}

	// A tie is 0.5 exactly, and a tie is not ahead of anything
	if (confidence(guess.language, guess.statistics) <= GUESS_MIN_CONFIDENCE) {
		return undefined;
	}

	return normalizeLang(guess.language);
}

// A `#!` line: the interpreter's path, then whatever follows it
const SHEBANG = /^\s*#![ \t]*(\S+)(?:[ \t]+([^\n]*))?/;

// The interpreters a `#!` line names, by the name they run as with any
// version left off (`python3.11`, `ruby2.7`), and the language they read.
const INTERPRETERS: Record<string, string> = {
	sh: "bash",
	bash: "bash",
	dash: "bash",
	ash: "bash",
	ksh: "bash",
	zsh: "bash",
	python: "python",
	pypy: "python",
	node: "javascript",
	nodejs: "javascript",
	bun: "javascript",
	deno: "typescript",
	"ts-node": "typescript",
	ruby: "ruby",
	perl: "perl",
	php: "php",
	lua: "lua",
	luajit: "lua",
	rscript: "r",
	pwsh: "powershell",
	julia: "julia",
	groovy: "groovy",
	elixir: "elixir",
	make: "makefile",
};

// The language a script's `#!` line names, as a Prism id. `env` is looked
// past, with its options and `NAME=value` settings (`env -S node --flag`).
function shebangLanguage(code: string): string | undefined {
	const line = SHEBANG.exec(code);

	if (!line) {
		return undefined;
	}

	const words = (line[2] ?? "").split(/\s+/).filter(Boolean);
	let program: string | undefined = baseName(line[1]);

	if (program === "env") {
		program = words.find((word) => !word.startsWith("-") && !word.includes("="));
	}

	if (!program) {
		return undefined;
	}

	const id =
		INTERPRETERS[
			baseName(program)
				.toLowerCase()
				.replace(/[\d.]+$/, "")
		];
	return id && languages[id] ? id : undefined;
}

function baseName(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

// How a markup document opens: an XML declaration, a doctype, a comment, or
// an element. Leading blank lines are the writer's, not the block's.
const MARKUP_HEAD = /^\s*<(\?xml[\s?]|!--|!doctype\s|[a-z][\w.:-]*[\s/>])/i;

// ... and, somewhere in it, a tag that closes: `</name>` or `<name … />`.
const MARKUP_CLOSE = /<\/[a-z][\w.:-]*\s*>|<[a-z][\w.:-]*(?:\s[^<>]*)?\/>/i;

// Braces mean the tags are JSX inside JavaScript, or a template language
// around another one — both of which flourite reads better than a shape does.
const MARKUP_NOT = /[{}]/;

// Whether the block is markup on the strength of its own structure, so that
// the guesser is never asked about the one family it is unreliable on.
function looksLikeMarkup(code: string): boolean {
	return MARKUP_HEAD.test(code) && MARKUP_CLOSE.test(code) && !MARKUP_NOT.test(code);
}

async function loadLanguage(id: string): Promise<boolean> {
	const entry = languages[id];

	if (!entry) {
		return false;
	}

	// Prism's own order: what the grammar extends, then what it reads if
	// present. The table is acyclic, so awaiting the whole chain is safe; an
	// optional one that will not load is not worth failing over.
	for (const dep of asList(entry.require)) {
		if (!(await ensureLanguage(dep))) {
			return false;
		}
	}

	for (const dep of [...asList(entry.modify), ...asList(entry.optional)]) {
		await ensureLanguage(dep);
	}

	try {
		// One named chunk per grammar. The `webpackInclude` list is what this
		// deploy ships: the languages worth carrying for a chat client, closed
		// over Prism's own require/modify/optional links (`components.json`) —
		// every language flourite can name included, since the guess is the
		// path nobody types.
		// All ~300 of Prism's grammars would be 1.3 MB of chunks and put a
		// 300-entry filename map in the main bundle, which is what loading them
		// on demand was for. A tag outside the list simply stays plain.
		await import(
			/* webpackChunkName: "[request]" */
			/* webpackInclude: /prism-(actionscript|ansi|apacheconf|bash|batch|c|clike|clojure|cmake|coffeescript|cpp|csharp|csp|css|css-extras|dart|diff|docker|elixir|erlang|flow|fsharp|git|go|graphql|groovy|haskell|hpkp|hsts|http|ini|java|javadoclike|javascript|js-extras|js-templates|jsdoc|json|json5|jsx|julia|kotlin|lua|makefile|markdown|markup|markup-templating|matlab|n4js|nginx|objectivec|ocaml|pascal|perl|php|powershell|properties|protobuf|python|r|regex|rest|ruby|rust|scala|sql|swift|toml|tsx|typescript|uri|vim|yaml)\.js$/ */
			`prismjs/components/prism-${id}`
		);
	} catch {
		// Not shipped, not fetchable: the block stays plain
		return false;
	}

	return Prism.languages[id] !== undefined;
}

// How sure flourite is: its points for the winner against the best other
// positive score. Scores can be negative, so a share of the total says nothing.
function confidence(language: string, statistics: Record<string, number>): number {
	const points = statistics[language] ?? 0;

	if (points <= 0) {
		return 0;
	}

	let runnerUp = 0;

	for (const [name, score] of Object.entries(statistics)) {
		if (name !== language && score > runnerUp) {
			runnerUp = score;
		}
	}

	return points / (points + runnerUp);
}

// Prism tokens nest; a `CodeToken` does not. The innermost type wins, because
// it is the one that says what the characters are, and text a nested rule did
// not claim keeps the type of the token it sits in.
function flatten(nodes: Array<string | Token>, type: string | undefined): CodeToken[] {
	const out: CodeToken[] = [];

	for (const node of nodes) {
		if (typeof node === "string") {
			out.push(token(node, type));
			continue;
		}

		const inner = node.type || type;

		if (typeof node.content === "string") {
			out.push(token(node.content, inner));
		} else {
			out.push(...flatten(([] as Array<string | Token>).concat(node.content), inner));
		}
	}

	return out;
}

function token(text: string, type: string | undefined): CodeToken {
	return type === undefined ? {text} : {text, type};
}

// One array per line: a token whose text crosses a newline is cut at it.
function toLines(tokens: CodeToken[]): Highlighted {
	const lines: Highlighted = [[]];

	for (const item of tokens) {
		const parts = item.text.split("\n");

		for (let i = 0; i < parts.length; i++) {
			if (i > 0) {
				lines.push([]);
			}

			if (parts[i].length > 0) {
				lines[lines.length - 1].push(token(parts[i], item.type));
			}
		}
	}

	if (lines.length > 1 && lines[lines.length - 1].length === 0) {
		lines.pop();
	}

	return lines;
}
