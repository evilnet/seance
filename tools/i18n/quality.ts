/**
 * The i18n fill's quality gate: the same degenerate-output rule the app's
 * translation pipeline judges every answer by (`outgoing.ts` `isDegenerate`,
 * wired into `answerError` and the queue's `report`). One rule, two callers:
 * the fill rejects a garbage row at translate time, the sweep empties one it
 * already shipped, and the running app reports a garbage answer as a failed
 * translation instead of rendering it.
 *
 * This module exists so the fill/sweep can import the rule without executing
 * fill.ts (an argv-driven script with side effects). On top of it, the two
 * rules only a CATALOG entry can be judged by -- a UI string has a known
 * English source and a known target language, neither of which a chat line
 * has, so neither rule belongs in the runtime gate: a chat line legitimately
 * runs long ("brb" -> "je reviens tout de suite") and legitimately carries
 * whatever script its author typed.
 */
import {isDegenerate} from "../../client/js/translate/outgoing";
import {EXPECTED_SCRIPTS, OWN_SCRIPTS} from "./scripts";
import stopwords from "../../client/js/translate/stopwords.json";

export {isDegenerate};

/** How far past its English a translation may run: 4x its length, plus 20. */
export const LENGTH_FACTOR = 4;
export const LENGTH_ALLOWANCE = 20;

export type SuspectReason =
	| "degenerate"
	| "runaway-length"
	| "foreign-script"
	| "foreign-script:no-target-script";

/** A {placeholder}'s content is the deploy's, never the translator's. */
const PLACEHOLDER = /\{[^{}]*\}/g;

/**
 * Words a catalog legitimately carries unchanged in every language: the
 * acronyms and product names the pot uses (`grep` of messages.pot), plus the
 * assent every locale writes the same way. An answer counts as unchanged
 * only when its WHOLE text is these, so "Connected (TLS)" is still judged on
 * its own words while a bare "TLS" is let through.
 */
const IDENTICAL_EVERYWHERE = new Set(
	[
		"ok",
		"irc",
		"ircv3",
		"sasl",
		"tls",
		"webgpu",
		"websocket",
		"url",
		"opus",
		"mt",
		"opus-mt",
		"nllb",
		"nllb-200",
		"200",
		"qwen",
		"qwen3",
		"gpu",
		"cpu",
		"gib",
		"mib",
		"kib",
		"utc",
		"markdown",
		"emoji",
		// IRC and oper jargon the oper tools' keys tell translators to keep
		// as is (the #. context): a plural like "{count} G-line" is its own
		// translation in many languages, and refusing one slot sends the
		// whole entry back to English.
		"g-line",
		"g-lines",
		"gline",
		"shun",
		"shuns",
		"k-line",
		"z-line",
		"z-lines",
		"jupe",
		"jupes",
		"kill",
		"kills",
		"wallops",
		"snomask",
		"privs",
		"oper",
		"opers",
		"op",
		"halfop",
		"webirc",
		"iauth",
		"dnsbl",
		"gitsync",
		"cidr",
		"ip",
		"ipv4",
		"ipv6",
		"x3",
		"o3",
		"authserv",
		"chanserv",
	].map((word) => word.toLowerCase())
);

/**
 * The words of a text that could carry the target language: no
 * {placeholder}s (their content is the deploy's), none of the acronyms and
 * product names every language writes alike, and nothing under three
 * letters — a language tag ("de", "en") or an initial is no evidence of what
 * language a sentence is in, and "OPUS-MT de → en (CPU)" is a legitimate
 * row in every catalog.
 */
function bodyWords(text: string): string[] {
	return text
		.replace(PLACEHOLDER, " ")
		.toLowerCase()
		.split(/[^\p{L}\p{N}-]+/u)
		.filter(
			(word) =>
				word.length > 2 &&
				/\p{L}/u.test(word) &&
				!IDENTICAL_EVERYWHERE.has(word) &&
				!word.split("-").every((part) => part === "" || IDENTICAL_EVERYWHERE.has(part))
		);
}

/**
 * Why a catalog entry's translation cannot be what it claims to be, or null
 * if nothing is wrong with it. `source` is the English text THAT SLOT
 * translates (the msgid for the slot a language's singular reads, the
 * msgid_plural for every other), never the entry as a whole.
 *
 * The three rules, in the order a reader wants them reported: the model got
 * stuck and repeated itself, it answered with an essay where a label was
 * asked for, or it answered in a writing system the target language is not
 * written in. Each was measured against the 22 machine-filled catalogs this
 * branch dropped.
 */
export function isSuspectCatalogEntry(
	tag: string,
	source: string,
	text: string
): SuspectReason | null {
	if (!text) {
		return null;
	}

	if (isDegenerate(text, source)) {
		return "degenerate";
	}

	if (text.length > LENGTH_FACTOR * source.length + LENGTH_ALLOWANCE) {
		return "runaway-length";
	}

	const own = OWN_SCRIPTS[tag];

	// A target with a script of its own has to answer in it. Latin is allowed
	// in every catalog (brand names, protocol words, {placeholder} names), so
	// an answer in French, Polish or invented pseudo-Welsh passed every other
	// rule and sat in the Ukrainian catalog looking well-formed. A body with
	// letters of its own and not one character of the target's script is not
	// in the target language at all.
	if (own && bodyWords(text).length > 0 && !own.some((script) => script.test(text))) {
		return "foreign-script:no-target-script";
	}

	const allowed = EXPECTED_SCRIPTS[tag];

	if (!allowed) {
		return null;
	}

	for (const ch of text.replace(PLACEHOLDER, "")) {
		if (!/\p{L}/u.test(ch)) {
			continue;
		}

		if (!allowed.some((script) => script.test(ch))) {
			return "foreign-script";
		}
	}

	return null;
}

/** Why a slot's fill cannot be kept: `isSuspectCatalogEntry`, plus the
 * {placeholder} braces the render and the compile depend on, plus an answer
 * that is its own English source, one that dropped the source's own leading
 * or trailing space, one carrying a machine-translation artifact, one with a
 * word written half in one script and half in another, and one that came back
 * with fewer sentences than it was given. */
export type SlotVerdict =
	| SuspectReason
	| "placeholder"
	| "unchanged"
	| "padding"
	| "artifact"
	| "mixed-script"
	| "stray-latin"
	| "english"
	| "sentences";

/**
 * The text as a comparison sees it: no {placeholder}s (their content is the
 * deploy's, not the translator's), no case, no punctuation, one space
 * between words. "Close" and "close." are the same answer.
 */
function echoForm(text: string): string {
	return text
		.replace(PLACEHOLDER, " ")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}-]+/gu, " ")
		.trim()
		.replace(/\s+/g, " ");
}

/**
 * True when `text` is `source` again rather than a translation of it. The
 * engines answer with the English they were given often enough that a
 * catalog fills up with it (uk came back 864 entries English), and nothing
 * else notices: English letters are allowed in every script, the length is
 * right and the placeholders match. The slot is better left empty — the
 * runtime serves English for a missing key anyway, and an empty slot is
 * what the next fill looks for.
 */
export function isUnchanged(source: string, text: string): boolean {
	const left = echoForm(source);

	// Nothing to translate: no letters at all, or only {placeholder}s and
	// punctuation.
	if (!left || !/\p{L}/u.test(left)) {
		return false;
	}

	if (left !== echoForm(text)) {
		return false;
	}

	return !left.split(" ").every((word) => IDENTICAL_EVERYWHERE.has(word));
}

const braces = (text: string): string => (text.match(PLACEHOLDER) ?? []).sort().join("|");

/** A string's own leading and trailing whitespace, as one comparable pair. */
const padding = (text: string): string =>
	`${/^\s*/.exec(text)![0]}|${text.trim() === "" ? "" : /\s*$/.exec(text)![0]}`;

/**
 * True when the translation dropped (or invented) the padding its English
 * carries. A msgid with a space at one end has it on purpose -- it is read
 * out beside something else, like the screen-reader prefix before a nick --
 * and every engine trims its answer, so all 23 catalogs came back with the
 * padding gone and the two texts run together. Whitespace is not copy: the
 * translation has to carry exactly what the source does.
 */
export function isMispadded(source: string, text: string): boolean {
	return padding(source) !== padding(text);
}

/**
 * The answer with the source's own padding put back around it. Whitespace at
 * the ends is structure, not copy -- no engine keeps it and no translator
 * should have to -- so the fill re-pads before judging, and `isMispadded`
 * stays the net under the catalogs nothing re-pads (a hand edit, a fill that
 * ran before this rule).
 */
export function repad(source: string, text: string): string {
	if (!text.trim()) {
		return text;
	}

	return `${/^\s*/.exec(source)![0]}${text.trim()}${/\s*$/.exec(source)![0]}`;
}

/**
 * The text an artifact is looked for in: no {placeholder}s and no code
 * spans. What a deploy writes inside a brace and what a msgid fences as
 * code is an identifier, not prose — `{old_name}` and `` `ctcp_type` ``
 * carry underscores that are nobody's mistake.
 */
const CODE_SPAN = /`[^`\n]*`/g;

const withoutIdentifiers = (text: string): string =>
	text.replace(CODE_SPAN, " ").replace(PLACEHOLDER, " ");

/**
 * Control tokens the seq2seq engines write out as text when they run out of
 * sentence, found by comparing every 23 catalogs' msgstrs against their own
 * msgids: NLLB's `_BAR_` for a pipe, its sentencepiece word mark, the
 * end-of-stream tags, and the musical notes it pads a short answer with.
 * None of them appears in any English source, so any of them is an artifact
 * wherever it is found.
 */
const ARTIFACT_TOKENS = /_BAR_|<\/?s>|<unk>|<pad>|▁|[♪♫♬]/u;

/** An HTML entity: the engines escape a character the source writes plainly. */
const ENTITY = /&(?:quot|amp|lt|gt|apos|nbsp|#\d+);/gi;

/**
 * The alphabetic scripts a single word is judged across. A letter belongs to
 * exactly one of them in practice, so a word touching two of them is half in
 * one language and half in another.
 */
const WORD_SCRIPTS: RegExp[] = [
	/\p{Script_Extensions=Latin}/u,
	/\p{Script_Extensions=Cyrillic}/u,
	/\p{Script_Extensions=Greek}/u,
	/\p{Script_Extensions=Arabic}/u,
	/\p{Script_Extensions=Hebrew}/u,
	/\p{Script_Extensions=Thai}/u,
	/\p{Script_Extensions=Devanagari}/u,
	/\p{Script_Extensions=Armenian}/u,
	/\p{Script_Extensions=Georgian}/u,
];

/**
 * The scripts that write without spaces between words. A "word" in such a run
 * is a whole clause, and legitimately holds several scripts at once — Han,
 * Hiragana, Katakana and a Latin brand name in Japanese; a Latin token glued
 * to Thai, which is how th renders "…that carries a msgid". Nothing in such a
 * run is judged by the mixed-script rule; the rule cannot tell a clause from a
 * word there, and refusing the clause threw away good translations.
 */
const UNSEGMENTED = new RegExp(
	"[" +
		["Han", "Hiragana", "Katakana", "Hangul", "Thai", "Lao", "Khmer", "Myanmar", "Tibetan"]
			.map((script) => `\\p{Script_Extensions=${script}}`)
			.join("") +
		"]",
	"u"
);

/**
 * True when one WORD of the answer is written in two scripts at once. ru came
 * back with `нickname` — a Cyrillic н glued to the English word the model gave
 * up translating — and nothing saw it: the answer is otherwise Cyrillic, so
 * the script rules pass, and the English is not the whole text, so the echo
 * rule passes.
 *
 * A whole Latin word inside Cyrillic prose is how every catalog writes a
 * protocol word or a brand name, so the rule is per word, and a hyphen, an
 * apostrophe or a {placeholder} ends a word like any other separator
 * (`IRC-сеть` is two words, not one mixed one).
 */
export function hasMixedScriptWord(text: string): boolean {
	for (const word of text.replace(PLACEHOLDER, " ").split(/[^\p{L}\p{M}\p{N}]+/u)) {
		if (!word || UNSEGMENTED.test(word)) {
			continue;
		}

		// A combining mark belongs to whatever letter it sits on: U+0301 (the
		// Russian stress accent, `сло́во`) and U+0308 carry the Script_Extensions
		// of every script that uses them, so leaving them in makes every marked
		// word look mixed.
		const letters = word.replace(/\p{M}/gu, "");
		let seen = 0;

		for (const script of WORD_SCRIPTS) {
			if (script.test(letters)) {
				seen += 1;
			}
		}

		if (seen > 1) {
			return true;
		}
	}

	return false;
}

/** A run of Latin letters, a hyphen inside it kept (`G-line` is one token). */
const LATIN_TOKEN = /[A-Za-zÀ-ɏ]+(?:-[A-Za-zÀ-ɏ]+)*/gu;

/**
 * True when a non-Latin answer carries a Latin token its English never had:
 * a stray of the English the model gave up on, glued straight onto the
 * target's own script, or a word of another Latin language. ja came back
 * with `変iaz` for "Variant", `あなたをmentionsする` for "…that mention
 * you", th with `การเรnder` for "rendering", ar with a Spanish `líneas`, and
 * every other rule passed them: Han and Thai run without spaces, so the
 * mixed-script rule cannot tell a clause from a word and skips the run, and
 * the target's script is there, so the own-script rule is satisfied.
 *
 * Two shapes, both judged against the Latin words of the source:
 * - a token touching a character of an unsegmented script (Han, kana,
 *   Hangul, Thai) — how ja and th write a Latin word into a sentence; it is
 *   copy only when the source has the word, or a word it begins (the
 *   answer dropped an ending: `kill` for "Killed", `G-line` for "G-lines");
 * - in a catalog with a script of its own, any token with a letter outside
 *   ASCII — no English source word has one, so it is another language.
 * An all-capitals token is an acronym or a command (IRC, WHO) and is left
 * alone, as everywhere else.
 */
export function hasStrayLatin(tag: string, source: string, text: string): boolean {
	if (!OWN_SCRIPTS[tag]) {
		return false;
	}

	const sourceWords: string[] = Array.from(
		withoutIdentifiers(source).matchAll(LATIN_TOKEN),
		(match) => match[0].toLowerCase()
	);

	const fromSource = (token: string) => {
		const lower = token.toLowerCase();

		return sourceWords.some((word) => word.startsWith(lower));
	};

	const body = withoutIdentifiers(text);

	for (const match of body.matchAll(LATIN_TOKEN)) {
		const token = match[0];

		if (token === token.toUpperCase() || fromSource(token)) {
			continue;
		}

		if (/[^\x00-\x7F]/u.test(token)) {
			return true;
		}

		const start = match.index ?? 0;
		const before = body[start - 1] ?? "";
		const after = body[start + token.length] ?? "";

		if (UNSEGMENTED.test(before) || UNSEGMENTED.test(after)) {
			return true;
		}
	}

	return false;
}

/**
 * True when the answer padded the end of a sentence the source had already
 * finished: ru came back with `…в этом браузере..` and `…сеть IRC...` for
 * msgids ending in one period. The rule is as narrow as the evidence — the
 * source's trailing run of periods is exactly one and the answer's is two or
 * more — because an ellipsis IS the copy in a good many msgids ("Loading…",
 * and the pot says so in their contexts), and a source that writes three
 * periods wants three back.
 */
function doublesTerminator(source: string, text: string): boolean {
	const run = (value: string) => (/\.+$/.exec(value.trimEnd()) ?? [""])[0].length;

	return run(source) === 1 && run(text) >= 2;
}

/**
 * True when the answer carries a machine-translation artifact its English
 * never did. 22 ru entries shipped one — `…подключения._`,
 * `…каналов._BAR_`, `♫ Aliases.ий` — and every other gate found them
 * well-formed: the length is right, the script is right, the placeholders
 * match.
 *
 * A doubled full stop is one of these too (`doublesTerminator`).
 *
 * The stray `_` and `|` are the delicate half. An underscore BETWEEN two
 * alphanumerics is snake_case, and an underscore the source itself carries
 * is copy (two msgids name the character: "letters, digits, _ and -"), so
 * the rule fires only on a character the English has nowhere and that is
 * not sitting inside a word — the `_` glued onto the end of a sentence, or
 * onto the front of the English the model gave up translating.
 */
export function hasMtArtifact(source: string, text: string): boolean {
	if (ARTIFACT_TOKENS.test(text)) {
		return true;
	}

	if (doublesTerminator(source, text)) {
		return true;
	}

	for (const entity of text.match(ENTITY) ?? []) {
		if (!source.includes(entity)) {
			return true;
		}
	}

	const body = withoutIdentifiers(text);
	const english = withoutIdentifiers(source);

	for (const character of ["_", "|"]) {
		if (english.includes(character)) {
			continue;
		}

		for (let i = body.indexOf(character); i >= 0; i = body.indexOf(character, i + 1)) {
			const before = body[i - 1];
			const after = body[i + 1];

			if (!/[\p{L}\p{N}]/u.test(before ?? "") || !/[\p{L}\p{N}]/u.test(after ?? "")) {
				return true;
			}
		}
	}

	return false;
}

/**
 * Abbreviations whose full stop ends no sentence. English only: the source
 * is always the pot's English, and only the source is counted strictly.
 */
const SENTENCE_ABBR = /\b(?:e\.g|i\.e|etc|vs)\./giu;

/**
 * A sentence BREAK in the English source: a full stop, bang or question
 * mark with another sentence behind it. Only an internal break counts — a
 * translation that merely drops the final full stop has dropped no copy —
 * and the next sentence has to open with a capital, a digit or a
 * {placeholder}, so `Downloading {model}… {percent}%` is the continuation
 * it looks like rather than two sentences. `…` is never a source break: the
 * pot uses it for progress, not for prose.
 */
const SOURCE_BREAK = /[.!?]+\s+(?=[\p{Lu}\p{N}{])/gu;

/**
 * The same break in an answer, counted generously — the gate is about copy
 * that went missing, so anything a target legitimately breaks a sentence
 * with counts: an ellipsis, a semicolon, the Arabic question mark, the Urdu
 * full stop, and the CJK marks, which take no space after them.
 */
const ANSWER_BREAK = /[.!?…;؟۔]+\s+(?=[\p{L}\p{N}{])|[。！？；]+\s*(?=[\p{L}\p{N}{])/gu;

/**
 * Targets that mark a sentence break with a space rather than with
 * punctuation, so there is nothing here to count. Thai writes no full stop
 * at all; counting terminators there refused 38 sound translations.
 */
const NO_SENTENCE_PUNCTUATION = new Set(["th"]);

/**
 * True when the answer came back with fewer sentences than its English had.
 * A destructive confirmation lost the sentence that said so — de's
 * clear-history dialog kept "Are you sure…?" and dropped "This cannot be
 * undone." — and three more strings dropped "Not reconnecting."; nothing
 * else notices, because what is left is a good translation of what is left.
 */
export function dropsSentences(tag: string, source: string, text: string): boolean {
	if (NO_SENTENCE_PUNCTUATION.has(tag)) {
		return false;
	}

	const wanted = (source.replace(SENTENCE_ABBR, "@").match(SOURCE_BREAK) ?? []).length;

	if (wanted === 0) {
		return false;
	}

	return (text.match(ANSWER_BREAK) ?? []).length < wanted;
}

/**
 * English function words: two of them in a row are a sentence of English,
 * not a protocol word or a quoted menu name ("Add to Dock" has one). A word
 * the target itself uses (its own stopword table) never counts -- "in" is
 * German, "do" Portuguese and Polish.
 */
const ENGLISH_FUNCTION_WORDS = new Set(
	(
		"the have has had been being is are was were will would could should cannot can't " +
		"not now known currently instead of to from with without by for this that these " +
		"those your you they their there here which who what when where it its an and or " +
		"but if then than into unable does did do all any some only also already yet still " +
		"please can be"
	).split(" ")
);

const OWN_STOPWORDS = stopwords as Record<string, string[]>;

/**
 * True when a non-English answer carries a run of English: two English
 * function words in a row, outside {placeholder}s and code spans. The echo
 * rule (`isUnchanged`) only sees an answer that is ALL its current English;
 * a model that gave up halfway ("{nick} が now known as {newNick} になりました",
 * "Вы currently disconnected, unable to initiate upload process.") or the
 * English of an OLDER msgid ("{count} users have been kicked" against "…were
 * kicked") passed every rule. An all-capitals word is a command or an
 * acronym (WHO, IRC) and breaks a run rather than joining one.
 */
export function hasEnglishRun(tag: string, text: string): boolean {
	if (tag === "en") {
		return false;
	}

	const own = new Set((OWN_STOPWORDS[tag] ?? []).map((word) => word.toLowerCase()));
	let run = 0;

	for (const raw of withoutIdentifiers(text).split(/\s+/)) {
		const word = raw.replace(/^[^\p{L}]+|[^\p{L}']+$/gu, "");
		const lower = word.toLowerCase();
		const english =
			lower !== "" &&
			word !== word.toUpperCase() &&
			ENGLISH_FUNCTION_WORDS.has(lower) &&
			!own.has(lower);

		run = english ? run + 1 : 0;

		if (run >= 2) {
			return true;
		}
	}

	return false;
}

/**
 * The one verdict the fill and the sweep both judge a filled slot by, so
 * that the fill refuses exactly what the sweep would empty: anything else
 * is a loop, each writing back what the other takes away. `source` is the
 * English text THAT SLOT translates, never the entry as a whole.
 */
export function slotVerdict(tag: string, source: string, text: string): SlotVerdict | null {
	if (!text) {
		return null;
	}

	if (braces(source) !== braces(text)) {
		return "placeholder";
	}

	if (isMispadded(source, text)) {
		return "padding";
	}

	if (hasMtArtifact(source, text)) {
		return "artifact";
	}

	if (hasMixedScriptWord(text)) {
		return "mixed-script";
	}

	if (isUnchanged(source, text)) {
		return "unchanged";
	}

	if (hasEnglishRun(tag, text)) {
		return "english";
	}

	// After `unchanged`: an answer that is the English again has every
	// sentence the English had, and reporting it as the echo it is keeps the
	// sweep's counts honest.
	if (dropsSentences(tag, source, text)) {
		return "sentences";
	}

	// Last: an answer with none of the target's script in it is foreign
	// as a whole, which is the better report.
	return (
		isSuspectCatalogEntry(tag, source, text) ??
		(hasStrayLatin(tag, source, text) ? "stray-latin" : null)
	);
}
