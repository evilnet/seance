// Downloads Source Sans 3 and Newsreader — the ps theme's bundled type, the
// user's pick of 2026-09-26 ("M1, N2", docs/projects/ps-theme.md §8) — as
// Google Fonts' woff2 files, Latin, Latin Extended and Vietnamese as separate
// files, SIL OFL, from Google Fonts' CSS endpoint into client/themes/ps/,
// then writes their @font-face rules into client/themes/ps.css between the
// `/* ps:fonts:start` and `/* ps:fonts:end */` markers. Run once; the files
// and the block are committed.
//
//   node tools/ps/fetch-fonts.mjs
//
// Each face is fetched as the type review's options page loaded it
// (tmp/ps-type/build.mjs), so the theme draws the bytes the user picked by
// eye. The words' face, Source Sans 3, is one variable file per style
// (upright and italic) carrying the face's whole weight range, 200 to 900:
// the endpoint answers every weight range of it with the same file, so the
// range only sets the rules' font-weight descriptor. The names' face,
// Newsreader, is fetched at the one weight the theme sets it in,
// `family=Newsreader:wght@700`, which the endpoint answers with a static
// instance, "Newsreader 16pt Bold" (its optical-size axis pinned at 16): the
// file that keeps that axis (6 to 72) is nearly three times the size, and at
// the name's 20px its opsz-20 instance is about 5 % narrower than what the
// user saw.
//
// The endpoint hands Mac browsers a different build from Windows and Linux
// ones; the Windows/Linux build (also what Firefox gets) is the one
// bundled.
//
// Latin AND Latin Extended, not Latin alone: a face with ā or ő but not a-z
// (or the reverse) loads fine and then draws the *other* half of the text
// in the fallback font — the latin-ext trap docs/projects/ps-theme.md §8
// calls out, proven by rendering rather than by FontFace status in Step 5 of
// the task that wrote this tool. Vietnamese is the same trap one step on: its
// stacked letters (ệ, ễ, U+1EA0-1EF9) are in neither of those files, so
// "Nguyễn" drew partly in the fallback until the vietnamese subset shipped
// too. Google's endpoint answers one stylesheet per request with one
// @font-face block per script subset, the subset named in a comment
// immediately before its block; this tool keeps the latin, latin-ext and
// vietnamese blocks for each face and discards the rest (cyrillic, greek, …),
// so Cyrillic, Greek and every other script this theme does not bundle fall
// back to the system stack mid-line — Newsreader ships no Cyrillic or Greek
// at all, and Source Sans 3's is left unbundled here.
//
// The rules are written vietnamese first, then latin, then latin-ext. Where
// unicode-ranges overlap (ă, đ, ơ, ư, ₫ and a few combining marks are in the
// vietnamese block and in latin-ext; U+0304, U+0308 and U+0329 in all three),
// the face defined last is tried first, so every codepoint the latin and
// latin-ext files drew before the vietnamese file arrived is still drawn by
// them, and the vietnamese file draws only what they lack.
import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";

const THEMES = path.resolve("client/themes/ps");
const CSS_FILE = path.resolve("client/themes/ps.css");
// A modern UA makes the endpoint answer with woff2 URLs; Windows, Linux and
// Firefox UAs all get the same build.
const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

// One entry per style; each is fetched once from the endpoint and yields three
// files (latin, latin-ext, vietnamese) and three @font-face rules.
const FACES = [
	{
		family: "Source Sans 3",
		style: "normal",
		weight: "200 900",
		query: "family=Source+Sans+3:ital,wght@0,200..900",
		base: "source-sans-3",
	},
	{
		family: "Source Sans 3",
		style: "italic",
		weight: "200 900",
		query: "family=Source+Sans+3:ital,wght@1,200..900",
		base: "source-sans-3-italic",
	},
	{
		family: "Newsreader",
		style: "normal",
		weight: "700",
		query: "family=Newsreader:wght@700",
		base: "newsreader",
	},
];

const LICENCES = [
	[
		"OFL-SourceSans3.txt",
		"https://raw.githubusercontent.com/google/fonts/main/ofl/sourcesans3/OFL.txt",
	],
	[
		"OFL-Newsreader.txt",
		"https://raw.githubusercontent.com/google/fonts/main/ofl/newsreader/OFL.txt",
	],
];

/** The script subsets kept, in the order their rules are written (see above). */
const SUBSETS = ["vietnamese", "latin", "latin-ext"];

/**
 * `fetch`, refusing anything but a 2xx answer: a 404 or a rate-limit page
 * would otherwise be written into a .woff2 or an OFL text as if it were one.
 */
async function get(url, init) {
	const res = await fetch(url, init);
	if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
	return res;
}

/**
 * The latin, latin-ext and vietnamese @font-face blocks out of the endpoint's
 * stylesheet. Each subset's comment (cyrillic, latin-ext, latin, …) stands
 * BEFORE its @font-face block, so the pair has to be matched as a unit:
 * splitting on "@font-face" and looking for the comment inside a block finds
 * the block before the right one — the latin-ext file, which has ā and ő
 * but not a to z, loads fine and then draws every plain letter in the
 * fallback font.
 */
function subsets(css) {
	const pair = /\/\* (\S+) \*\/\s*@font-face \{([^}]*)\}/g;
	const found = {};
	for (const m of css.matchAll(pair)) {
		if (!SUBSETS.includes(m[1])) continue;
		const url = m[2].match(/url\((https:[^)]+\.woff2)\)/)?.[1];
		const unicodeRange = m[2].match(/unicode-range:\s*([^;]+);/)?.[1]?.trim();
		if (!url || !unicodeRange) continue;
		found[m[1]] = {url, unicodeRange};
	}
	if (!found.latin) throw new Error("no latin block in the endpoint's answer");
	if (!found.latin.unicodeRange.startsWith("U+0000-00FF")) {
		throw new Error("the latin block does not start at U+0000: the picker is off");
	}
	if (!found["latin-ext"]) throw new Error("no latin-ext block in the endpoint's answer");
	if (!found.vietnamese) throw new Error("no vietnamese block in the endpoint's answer");
	// The stacked letters (ạ … ỹ) are what the vietnamese file is bundled for.
	if (!found.vietnamese.unicodeRange.split(/,\s*/).includes("U+1EA0-1EF9")) {
		throw new Error("the vietnamese block does not carry U+1EA0-1EF9: the picker is off");
	}
	return found;
}

/**
 * A family as a font-family value names it: quoted where the name has a
 * space or a figure (stylelint's font-family-name-quotes,
 * always-where-recommended), bare otherwise. Unquoted, `Source Sans 3` is no
 * family name at all (an identifier cannot start with a figure), and the
 * browser drops the whole rule.
 */
const familyName = (family) => (/[\s\d]/.test(family) ? `"${family}"` : family);

/**
 * One @font-face rule, the family as familyName writes it (the tests match
 * it that way). unicode-range is left exactly as Google served it, on one
 * line — stylelint's max-line-length is disabled for it, same as the scene's
 * other generated gradient lists, since config-standard's multi-line list
 * rules would force one codepoint per line rather than a narrower wrap.
 */
function faceRule(family, style, weight, file, unicodeRange) {
	return `@font-face {
	font-family: ${familyName(family)};
	font-style: ${style};
	font-weight: ${weight};
	font-display: swap;
	src: url("ps/${file}") format("woff2");
	/* stylelint-disable-next-line max-line-length -- Google's unicode-range list, unbroken as served */
	unicode-range: ${unicodeRange};
}`;
}

await mkdir(THEMES, {recursive: true});

const rules = [];
for (const face of FACES) {
	const stylesheet = await (
		await get(`https://fonts.googleapis.com/css2?${face.query}&display=swap`, {
			headers: {"User-Agent": UA},
		})
	).text();
	const found = subsets(stylesheet);

	// In SUBSETS' order, in both the files fetched and the rules written.
	for (const subset of SUBSETS) {
		const {url, unicodeRange} = found[subset];
		const file = `${face.base}-${subset}.woff2`;
		const bytes = new Uint8Array(await (await get(url)).arrayBuffer());
		await writeFile(path.join(THEMES, file), bytes);
		console.log(`${file} ${bytes.length} bytes ← ${url}`);
		rules.push(faceRule(face.family, face.style, face.weight, file, unicodeRange));
	}
}

// GitHub serves some of these with CRLF line ends and the committed copies
// are LF, so a re-fetch would show every line changed: written LF.
for (const [file, url] of LICENCES) {
	const text = (await (await get(url)).text()).replace(/\r\n/g, "\n");
	await writeFile(path.join(THEMES, file), text);
	console.log(file);
}

const header = `/* ps:fonts:start — Source Sans 3 and Newsreader, fetched by
 * \`node tools/ps/fetch-fonts.mjs\`: Google Fonts' woff2 files (Source Sans 3
 * variable, 200 to 900, upright and italic; Newsreader's static 700), Latin,
 * Latin Extended and Vietnamese as separate files (a face needs all of
 * them, or plain, accented or Vietnamese text draws partly in the
 * fallback font — the latin-ext trap, docs/projects/ps-theme.md §8).
 * Vietnamese is written first, so where the ranges overlap the Latin files
 * still draw what they drew before it came. Cyrillic, Greek and every other
 * script this theme does not bundle fall back to the system stack mid-line. */`;
const block = `${header}\n\n${rules.join("\n\n")}\n\n/* ps:fonts:end */`;

const cssText = await readFile(CSS_FILE, "utf8");
const FONTS_HEADING = "/* ---- fonts ---- */";
const TOKENS_HEADING = "/* ---- tokens ---- */";

let updated;
if (cssText.includes("/* ps:fonts:start")) {
	const start = cssText.indexOf("/* ps:fonts:start");
	const endMarker = "/* ps:fonts:end */";
	const endAt = cssText.indexOf(endMarker);
	if (start === -1 || endAt === -1) {
		throw new Error("ps.css has a start marker but no matching end marker");
	}
	updated = cssText.slice(0, start) + block + cssText.slice(endAt + endMarker.length);
} else {
	const headingAt = cssText.indexOf(FONTS_HEADING);
	const tokensAt = cssText.indexOf(TOKENS_HEADING);
	if (headingAt === -1 || tokensAt === -1) {
		throw new Error(
			"ps.css has no /* ---- fonts ---- */ … /* ---- tokens ---- */ section to replace"
		);
	}
	const before = cssText.slice(0, headingAt + FONTS_HEADING.length);
	const after = cssText.slice(tokensAt);
	updated = `${before}\n\n${block}\n\n${after}`;
}

await writeFile(CSS_FILE, updated);
console.log("client/themes/ps.css updated");
