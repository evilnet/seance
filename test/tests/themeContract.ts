import {expect} from "chai";
import fs from "fs";
import path from "path";
import {transform} from "lightningcss";
import {lookThemes} from "../../client/js/helpers/messageLayout";

// The theme contract (docs/resources/themes.md § The theme contract), checked
// without a browser so it runs in CI: what a theme declares is read by
// something, and the colour pairs the app paints with each theme's tokens
// hold their contrast floor. tools/scenarios/themes.mjs measures rendered
// pages too, but needs a running ircd; this reads the files.

const ROOT = process.cwd();
const THEMES = path.join(ROOT, "client", "themes");
const themeNames = fs
	.readdirSync(THEMES)
	.filter((f) => f.endsWith(".css"))
	.map((f) => f.slice(0, -4));

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

type Block = {prelude: string; body: string; at: string};

/** Every block with its prelude, its own body and the at-rules around it. */
function blocks(css: string): Block[] {
	const text = stripComments(css);
	const out: Block[] = [];
	const stack: {prelude: string; pos: number}[] = [];
	let start = 0;

	for (let i = 0; i < text.length; i++) {
		if (text[i] === "{") {
			stack.push({prelude: text.slice(start, i).replace(/\s+/g, " ").trim(), pos: i + 1});
			start = i + 1;
		} else if (text[i] === "}") {
			const top = stack.pop();

			if (top) {
				out.push({
					prelude: top.prelude,
					body: text.slice(top.pos, i),
					at: stack.map((s) => s.prelude).join(" "),
				});
			}

			start = i + 1;
		} else if (text[i] === ";" && stack.length === 0) {
			start = i + 1;
		}
	}

	return out;
}

/** The custom properties a block body declares (its nested blocks left out). */
function customProperties(body: string): Record<string, string> {
	const out: Record<string, string> = {};

	for (const decl of body.replace(/\{[^}]*\}/g, "").split(";")) {
		const colon = decl.indexOf(":");
		const name = decl.slice(0, colon).trim();

		if (colon > 0 && name.startsWith("--")) {
			out[name] = decl.slice(colon + 1).trim();
		}
	}

	return out;
}

/** A theme and what it @imports, in cascade order, for one colour scheme. */
function chain(file: string, scheme: "light" | "dark", seen = new Set<string>()): string[] {
	if (seen.has(file)) {
		return [];
	}

	seen.add(file);
	const css = fs.readFileSync(path.join(THEMES, file), "utf8");
	const out: string[] = [];

	for (const m of stripComments(css).matchAll(/@import\s+"([^"]+)"\s*([^;]*);/g)) {
		if (!m[2].trim() || m[2].includes(`prefers-color-scheme: ${scheme}`)) {
			out.push(...chain(m[1], scheme, seen));
		}
	}

	out.push(css);
	return out;
}

const inScheme = (at: string, scheme: "light" | "dark") =>
	!at.includes("prefers-color-scheme") || at.includes(`prefers-color-scheme: ${scheme}`);

type Surface = {where: string; tokens: Record<string, string>; own?: Set<string>};

/** The tokens on :root once style.css and the theme's chain have cascaded, then each other
 * block of the theme's chain that re-maps one of `names` (zelenzy's dialogs, ps by night, a
 * contrast variant), as :root's tokens with that block's on top; `own` is what it re-maps. */
function surfaces(theme: string, scheme: "light" | "dark", names: Set<string>): Surface[] {
	const base = fs.readFileSync(path.join(ROOT, "client", "css", "style.css"), "utf8");
	const themeCss = chain(`${theme}.css`, scheme);
	const root: Record<string, string> = {};
	const variants: Surface[] = [];

	for (const css of [base, ...themeCss]) {
		for (const b of blocks(css)) {
			if (
				b.prelude === ":root" &&
				(!b.at || b.at.includes(`prefers-color-scheme: ${scheme}`))
			) {
				Object.assign(root, customProperties(b.body));
			}
		}
	}

	// Every block with the same selector and conditions is one variant (ps
	// declares its night palette across several).
	const byWhere = new Map<string, Record<string, string>>();

	for (const css of themeCss) {
		for (const b of blocks(css)) {
			// :root under another condition (a width query, a contrast or platform
			// attribute is a selector of its own) is a variant too: a phone's
			// palette must hold its floors like the desk's.
			const scoped =
				b.prelude !== ":root" ||
				!!b.at.replace(/@media \(prefers-color-scheme: (light|dark)\)/g, "").trim();

			if (scoped && !b.prelude.startsWith("@") && inScheme(b.at, scheme)) {
				const where = b.at ? `${b.at} ${b.prelude}` : b.prelude;
				byWhere.set(where, {...byWhere.get(where), ...customProperties(b.body)});
			}
		}
	}

	for (const [where, props] of byWhere) {
		if (Object.keys(props).some((n) => names.has(n))) {
			// A block scoped inside another variant's selector (ps's night
			// chat under its night :root) inherits that variant's tokens too,
			// and so does one that qualifies it from above (zelenzy's dialogs
			// under Increase Contrast, `html[data-contrast="more"] <dialogs>`).
			const outer = [...byWhere.keys()]
				.filter(
					(w) =>
						w !== where &&
						((where.startsWith(w) && /^[\s:[]/.test(where.slice(w.length))) ||
							(where.endsWith(w) && /\s$/.test(where.slice(0, -w.length))) ||
							narrows(where, w))
				)
				.sort((a, b) => a.length - b.length);
			// Custom properties inherit their computed values: a block on a
			// descendant (zelenzy's dialogs) gets the values :root resolved, not
			// its declarations, while a block on <html> itself (a width query's
			// :root, ps by night) is cascaded with :root's and resolved with it.
			// The blocks on <html> cascade with :root and resolve there; the
			// blocks below it (this one, and those it sits in or that qualify
			// it) start from those computed values and resolve among themselves.
			const layers = [...outer, where];
			const atRoot = Object.assign(
				{},
				root,
				...layers.filter(onRoot).map((w) => byWhere.get(w))
			);
			const below = layers.filter((w) => !onRoot(w)).map((w) => byWhere.get(w));
			const resolved = below.length
				? resolveAll(Object.assign(resolveAll(atRoot), ...below))
				: resolveAll(atRoot);

			variants.push({where, tokens: resolved, own: new Set(Object.keys(props))});
		}
	}

	return [{where: ":root", tokens: root}, ...variants];
}

/** The selector without its at-rule conditions, split at its top-level commas. */
function branches(where: string): string[] {
	return topLevel(where.replace(/^(@[^{]*?\)\s*)+/, ""), ",");
}

/** Split at top-level occurrences of `sep` (a space or a comma), brackets and parens kept whole. */
function topLevel(text: string, sep: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let start = 0;

	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		depth += c === "(" || c === "[" ? 1 : c === ")" || c === "]" ? -1 : 0;

		if (c === sep && depth === 0) {
			out.push(text.slice(start, i).trim());
			start = i + 1;
		}
	}

	out.push(text.slice(start).trim());
	return out.filter(Boolean);
}

const SIMPLE = /:{1,2}[\w-]+(?:\((?:[^()]|\([^()]*\))*\))?|\[[^\]]*\]|[.#]?[\w-]+|\*/g;

/** Whether `where` is `outer` with more qualifiers on the same elements: the same at-rule
 * conditions, one branch each, the same compounds, and each of `outer`'s compounds contained
 * in `where`'s (ps's `:root[data-ps-text="light"] #chat .chat` under its shadow family's
 * `:root:is(…)[data-ps-text="light"] #chat .chat`). Whatever matches `where` matches `outer`. */
function narrows(where: string, outer: string): boolean {
	const at = (w: string) => /^(@[^{]*?\)\s*)+/.exec(w)?.[0].trim() ?? "";

	if (at(where) !== at(outer)) {
		return false;
	}

	const [inner] = branches(where);
	const [wide] = branches(outer);

	if (branches(where).length !== 1 || branches(outer).length !== 1) {
		return false;
	}

	const a = topLevel(inner, " ");
	const b = topLevel(wide, " ");

	return (
		a.length === b.length &&
		b.every((compound, i) => {
			const have = new Set(a[i].match(SIMPLE) ?? []);
			return (compound.match(SIMPLE) ?? []).every((s) => have.has(s));
		})
	);
}

/** Whether a block's selector names <html> itself (no descendant in any branch). */
function onRoot(where: string): boolean {
	return branches(where).every((b) =>
		/^(:root|html)\S*$/.test(b.replace(/\[[^\]]*\]|\([^)]*\)/g, ""))
	);
}

/** Every token with its var()s resolved where it is declared; a value that does not resolve is
 * kept as written, so the check that reads it reports it. */
function resolveAll(tokens: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};

	for (const [name, value] of Object.entries(tokens)) {
		out[name] = resolve(tokens, value) ?? value;
	}

	return out;
}

/** A value with every var() replaced, fallbacks included; undefined if one is missing. */
function resolve(tokens: Record<string, string>, value: string, depth = 0): string | undefined {
	if (depth > 20) {
		return undefined;
	}

	let missing = false;
	const out = value.replace(
		/var\((--[\w-]+)(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g,
		(_, name: string, fallback?: string) => {
			const next = tokens[name] ?? fallback;
			const resolved = next === undefined ? undefined : resolve(tokens, next, depth + 1);

			if (resolved === undefined) {
				missing = true;
				return "";
			}

			return resolved;
		}
	);

	return missing ? undefined : out;
}

type RGBA = [number, number, number, number];

/** Any CSS colour as sRGB: Lightning CSS lowers oklch(), color-mix() and the rest for an old
 * target, then reads the lowered colour back (a name such as navy included) through a visitor. */
function toRGBA(value: string): RGBA | undefined {
	if (/currentcolor/i.test(value)) {
		return undefined;
	}

	const lowered = transform({
		filename: "colour.css",
		code: Buffer.from(`a{color:${value}}`),
		minify: true,
		targets: {safari: 9 << 16},
	}).code.toString();
	const colour = /color:([^;}]+)/.exec(lowered)?.[1].trim() ?? "";

	// light-dark() and the like lower to var() pairs, which are not one colour.
	if (!colour || colour.includes("var(")) {
		return undefined;
	}

	let rgba: RGBA | undefined;
	transform({
		filename: "colour.css",
		code: Buffer.from(`a{color:${colour}}`),
		visitor: {
			Color(c) {
				if (c.type === "rgb") {
					rgba = [c.r, c.g, c.b, c.alpha];
				}

				return c;
			},
		},
	});
	return rgba;
}

const over = (fg: RGBA, bg: RGBA): RGBA => [
	fg[0] * fg[3] + bg[0] * (1 - fg[3]),
	fg[1] * fg[3] + bg[1] * (1 - fg[3]),
	fg[2] * fg[3] + bg[2] * (1 - fg[3]),
	1,
];

const luminance = (c: RGBA) =>
	[c[0], c[1], c[2]]
		.map((x) => x / 255)
		.map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
		.reduce((sum, x, i) => sum + x * [0.2126, 0.7152, 0.0722][i], 0);

function contrast(a: RGBA, b: RGBA): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

describe("the theme contract (themes.md § The theme contract)", function () {
	describe("every custom property a theme declares is read by something", function () {
		const walk = (dir: string): string[] =>
			fs.readdirSync(dir, {withFileTypes: true}).flatMap((e) => {
				const p = path.join(dir, e.name);
				return e.isDirectory() ? walk(p) : /\.(css|ts|vue|js)$/.test(e.name) ? [p] : [];
			});
		const sources = walk(path.join(ROOT, "client"))
			.map((f) => stripComments(fs.readFileSync(f, "utf8")))
			.join("\n");
		const read = new Set([
			...[...sources.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]),
			// Read or written by name from script (getPropertyValue, setProperty).
			...[...sources.matchAll(/["'`](--[\w-]+)["'`]/g)].map((m) => m[1]),
		]);
		// ps's animals are switched off, not removed (themes.md § The animals):
		// their slots stay declared for the block that brings them back.
		const KEPT = /^--ps-(horse|deer|puppy|bunny|kitten|frog|ladybug|bird)(-far|-h)?$/;

		for (const theme of themeNames) {
			it(theme, function () {
				const css = stripComments(
					fs.readFileSync(path.join(THEMES, `${theme}.css`), "utf8")
				);
				const declared = new Set(
					[...css.matchAll(/(?:^|[;{\s])(--[\w-]+)\s*:/g)].map((m) => m[1])
				);
				const unread = [...declared].filter((name) => !read.has(name) && !KEPT.test(name));
				expect(unread, `${theme}.css declares what nothing reads`).to.deep.equal([]);
			});
		}
	});

	describe("each theme's tokens hold their contrast floor", function () {
		// [surface, ink, floor]: what the app paints the token on, at WCAG's
		// 4.5:1 for text and 3:1 for the join line's marks.
		const PAIRS: [string, string, number, string?][] = [
			["--window-bg-color", "--body-color", 4.5],
			["--window-bg-color", "--body-color-muted", 4.5],
			["--window-bg-color", "--link-color", 4.5],
			["--highlight-bg-color", "--body-color", 4.5],
			["--chat-bg", "--chat-fg", 4.5],
			["--chat-bg", "--chat-fg-muted", 4.5],
			["--chat-bg", "--event-join", 3],
			// The rail is a gradient between these two: both ends hold.
			["--rail-bg-top", "--rail-fg", 4.5],
			["--rail-bg-bottom", "--rail-fg", 4.5],
			// Messenger (style.css § The looks), in the themes that offer the
			// looks: the words, the times and the links on every kind of bubble.
			["--bubble-bg", "--body-color", 4.5],
			["--bubble-bg", "--bubble-fg-muted", 4.5],
			["--bubble-bg", "--bubble-link", 4.5],
			["--bubble-own-bg", "--body-color", 4.5],
			["--bubble-own-bg", "--bubble-fg-muted", 4.5],
			["--bubble-own-bg", "--bubble-link", 4.5],
			["--bubble-highlight-bg", "--body-color", 4.5],
			["--bubble-highlight-bg", "--bubble-fg-muted", 4.5],
			["--bubble-highlight-bg", "--bubble-link", 4.5],
			["--bubble-bg", "--bubble-notice", 4.5],
			// Workspace, in the same themes: its rows take the same inks as a
			// bubble, and its words, times, links and a notice's words hold on
			// the plain row, the hover tint, the mention band and our own band.
			...[
				"--window-bg-color",
				"--workspace-hover",
				"--highlight-bg-color",
				"--workspace-own",
			].flatMap((surface) =>
				["--body-color", "--bubble-fg-muted", "--bubble-link", "--bubble-notice"].map(
					(ink) => [surface, ink, 4.5, "looks"] as [string, string, number, string]
				)
			),
		];
		// The looks are drawn only in the themes that offer them.
		const LOOKS_ONLY = (theme: string, surface: string, only?: string) =>
			(only === "looks" || surface.startsWith("--bubble-")) && !lookThemes.has(theme);
		// What a Workspace row is painted with, as style.css spells it on the
		// row rather than on :root: the hover tint (`--msg-acting-bg`, the
		// row's text colour 8% unless a theme names `--msg-hover-bg`) and our
		// own band under Your own messages: highlighted row (`--own-bg`, else
		// the text colour 7%). Each is measured over the window.
		const ROW_TOKENS: Record<string, string> = {
			"--workspace-hover-tint": "color-mix(in srgb, var(--body-color) 8%, transparent)",
			"--workspace-hover": "var(--msg-hover-bg, var(--workspace-hover-tint))",
			"--workspace-own-tint": "color-mix(in srgb, var(--body-color) 7%, transparent)",
			"--workspace-own": "var(--own-bg, var(--workspace-own-tint))",
		};
		// Known and recorded, not to be copied: day is TheLounge's original
		// light theme, kept as it was (docs/projects/accessibility.md).
		// Each is a floor of its own, at today's ratio: the exception keeps the
		// colour as it is, and anything worse still fails.
		const KNOWN: Record<string, number> = {
			// TheLounge's own link green, 3.03:1.
			"day --link-color on --window-bg-color": 3.03,
		};

		// An ink a theme restates by selector where it paints it, so the token
		// is not what shows there: measured as the colour the theme writes,
		// which must still be in its file. Princess draws a mention's links a
		// step darker on its strong band (princess.css), Workspace's band too.
		const RESTATED: Record<string, string> = {
			"princess --bubble-link on --highlight-bg-color": "#1558c9",
		};

		// What each surface is painted over, out to the page's own canvas: a
		// translucent surface is measured on what shows through it.
		const GROUND: Record<string, string> = {
			"--highlight-bg-color": "--window-bg-color",
			"--window-bg-color": "--body-bg-color",
			"--chat-bg": "--body-bg-color",
			"--rail-bg-top": "--body-bg-color",
			"--rail-bg-bottom": "--body-bg-color",
			"--bubble-bg": "--window-bg-color",
			"--bubble-own-bg": "--window-bg-color",
			"--bubble-highlight-bg": "--window-bg-color",
			"--workspace-hover": "--window-bg-color",
			"--workspace-own": "--window-bg-color",
		};
		// Surfaces with nothing opaque under them in CSS (a shell's material or a
		// scene would show through) have no ratio to compute from the files. None
		// do today; one added here is a decision, not an accident.
		const SEE_THROUGH = new Set<string>();
		// Blocks whose text is painted on a picture, not on the surface tokens:
		// ps's light words sit on the scene, and tools/scenarios/theme-ps.mjs
		// measures them there. Named, so any other block that re-maps one side
		// of a pair is measured against what it inherits.
		const ON_A_PICTURE = [/^ps .*\[data-ps-text="light"\]/];
		// The chat's own surfaces are painted inside #chat only (style.css's
		// `#chat … .msg.highlight`, the chat pane), so a block scoped away from
		// it (zelenzy's dialogs) has none of them.
		const CHAT_ONLY = new Set([
			"--chat-bg",
			"--highlight-bg-color",
			"--bubble-bg",
			"--bubble-own-bg",
			"--bubble-highlight-bg",
			"--workspace-hover",
			"--workspace-own",
		]);
		const LOUNGE_ONLY = new Set(["day", "morning"]);
		const names = new Set([
			...PAIRS.flatMap(([surface, ink]) => [surface, ink]),
			"--msg-hover-bg",
			"--own-bg",
		]);

		for (const theme of themeNames) {
			it(theme, function () {
				const failures: string[] = [];
				const seeThrough = new Set<string>();
				let checked = 0;

				for (const scheme of ["light", "dark"] as const) {
					for (const {where, tokens: declared, own} of surfaces(theme, scheme, names)) {
						const tokens = {...ROW_TOKENS, ...declared};
						const colour = (token: string) => {
							const value = resolve(tokens, tokens[token]);
							const rgba = value ? toRGBA(value) : undefined;
							expect(
								Array.isArray(rgba) && rgba.every((n) => Number.isFinite(n)),
								`${theme} ${token} in ${where} resolves to a colour (${value})`
							).to.equal(true);
							return rgba as RGBA;
						};
						// The surface laid over its grounds; undefined if it stays see-through.
						const ground = (token: string): RGBA | undefined => {
							const fill = colour(token);
							const under = GROUND[token];

							if (fill[3] >= 1) {
								return fill;
							}

							const below =
								under && tokens[under] !== undefined ? ground(under) : undefined;
							return below && over(fill, below);
						};

						for (const [surface, ink, floor, only] of PAIRS) {
							if (LOOKS_ONLY(theme, surface, only)) {
								continue;
							}

							const missing = [surface, ink].filter((t) => tokens[t] === undefined);

							if (missing.length) {
								// day and morning set TheLounge's variables alone, so the
								// handoff's pairs are not theirs; every other theme has them.
								if (where === ":root" && !LOUNGE_ONLY.has(theme)) {
									failures.push(
										`${theme} defines no ${missing.join(" or ")} (${scheme})`
									);
								}

								continue;
							}

							// A block that re-maps only one side of a pair is painted over
							// something this file cannot see (ps's light words go on the
							// scene), so it is measured only where it sets both.
							if (own && !own.has(surface) && !own.has(ink)) {
								continue;
							}

							// Painted on the scene: a block that sets the ink and leaves
							// the surface. One that sets both paints its own surface.
							const onPicture =
								ON_A_PICTURE.some((re) => re.test(`${theme} ${where}`)) &&
								!own?.has(surface);
							// Scoped away from the chat in every branch of its selector.
							const outsideChat =
								CHAT_ONLY.has(surface) &&
								branches(where).every((b) => b.includes(":not(#chat)"));

							if (own && (onPicture || outsideChat)) {
								continue;
							}

							const label = `${theme} ${ink} on ${surface}`;
							const bg = ground(surface);

							if (!bg) {
								seeThrough.add(`${theme} ${surface}`);
								continue;
							}

							const restated = RESTATED[label];
							const inkColour = restated ? toRGBA(restated) : colour(ink);

							if (restated) {
								expect(
									fs.readFileSync(path.join(THEMES, `${theme}.css`), "utf8"),
									`${label} is restated in ${theme}.css`
								).to.include(restated);
							}

							const ratio = contrast(over(inkColour as RGBA, bg), bg);
							expect(
								Number.isFinite(ratio),
								`${label} (${where}) is a number`
							).to.equal(true);
							checked++;

							const effective = KNOWN[label] ?? floor;

							if (ratio < effective) {
								failures.push(
									`${label} (${scheme}, ${where}): ${ratio.toFixed(
										2
									)} < ${effective}`
								);
							}
						}
					}
				}

				expect(checked, "pairs checked").to.be.greaterThan(0);
				expect(
					[...seeThrough].filter((s) => !SEE_THROUGH.has(s)),
					"surfaces with nothing opaque under them"
				).to.deep.equal([]);
				expect(failures).to.deep.equal([]);
			});
		}
	});
});
