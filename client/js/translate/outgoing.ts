// The composer's translation (spec § Composer), Vue-free and store-free:
// the gate, one draft translated as a unit — a multi-line draft as
// numbered lines so its line count survives — the languages of the round
// trip, and the rule for what a sent pair leaves in term memory. writer.ts
// is the store glue around it; ChatInput.vue renders the strip.

import {
	type EngineName,
	type PromptContext,
	type TranslateChunk,
	type TranslateRequest,
	emptyContext,
	type Device,
} from "./engine";
import {parseBatchedOutput, stripSentinel} from "./prompt";
import {
	type MarkerForm,
	type Protected,
	placeholdersIn,
	protect,
	restore,
	restoreAll,
} from "./spans";

/** A draft's translation is given up after this long (the queue's limit). */
export const WRITE_TIMEOUT_MS = 2 * 60 * 1000;
/** The composer's deadline on the language model on the CPU (queue.ts has the figures). */
export const CPU_WRITE_TIMEOUT_MS = 6 * 60 * 1000;
/** A draft this short (words) whose translation is also short is a term worth remembering. */
export const TERM_MAX_WORDS = 3;
export const TERM_MAX_CHARS = 40;
/**
 * How sure the detector must be (its best guess's lead over the runner-up,
 * `detect.ts` `Detection.confidence`) before the composer trusts it over the
 * user's reading language: three times the reading side's `DETECT_MIN_GAP`
 * (0.1), because a wrong source here sends the draft to the LLM in the
 * wrong language rather than just skipping a translation.
 */
export const WRITE_DETECT_MIN_GAP = 0.3;
export const TIMED_OUT = "timed out";
export const ABORTED = "aborted";
/**
 * The two failures that are the *answer's* rather than the engine's
 * (`writer.ts`, `queue.ts`): the engine completed, so neither marks a
 * candidate down or counts toward the queue's pause.
 */
export const UNCHANGED = "came back unchanged";
export const EMPTY_TRANSLATION = "empty translation";
/**
 * The answer is symbol garbage: runs of tildes, or a punctuation run the
 * source never had (OPUS-MT pads strings it cannot place with dozens of
 * dots — "Höchstgrenze.........." — and answers whole lines as "~ ~ ~");
 * measured on the i18n fill's output, 2026-09-16. The answer's failure,
 * like the ones above: retried bare once, then reported.
 */
export const DEGENERATE = "degenerate output";
/**
 * The model talked about the request instead of answering it -- "okay,
 * let's see. The user wants the translation of …" -- and ran out of tokens
 * before it got to a translation (measured on the offline runner,
 * 2026-09-12). The answer's failure, like the two above.
 */
export const NARRATION = "talked about the request instead of translating";
/**
 * The model answered a question it was asked to translate -- a Russian
 * read-back of "what time does the meeting start?" came back as an English
 * reply to it (live test, 2026-09-13). Judged by the question mark alone
 * (`isAnsweredQuestion`), so it does not depend on the model's wording. The
 * answer's failure, like the ones above.
 */
export const ANSWERED = "answered the question instead of translating it";
/**
 * The model got stuck repeating itself -- "Höfðu ekki ekki ekki ekki …",
 * "Nafaka ya kisasa kama kama kama …" (Qwen on Icelandic and Swahili
 * questions, 2026-09-12). The answer's failure, like the three above.
 */
export const REPETITION = "got stuck repeating itself";
/**
 * How many times in a row a word, or a run of two or three characters in a
 * script without spaces, makes a loop.
 */
export const REPEAT_MIN = 6;
/**
 * How many times in a row a single character of a script without spaces
 * makes a loop. Six is ordinary drawn-out speech there -- "ええええええ、本当に？",
 * "哈哈哈哈哈哈，太好了" (measured, tmp/judge-first-attempts.ts) -- while the
 * loops actually seen were whole words.
 */
export const SINGLE_REPEAT_MIN = 12;

/** Scripts written without spaces between words: a loop there is a repeated run of characters. */
const SPACELESS_CLASS =
	"[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Thai}\\p{Script=Lao}\\p{Script=Khmer}\\p{Script=Myanmar}]";
const SPACELESS_RUN_LOOP = new RegExp(`(${SPACELESS_CLASS}{2,3})\\1{${REPEAT_MIN - 1},}`, "u");
const SPACELESS_CHAR_LOOP = new RegExp(`(${SPACELESS_CLASS})\\1{${SINGLE_REPEAT_MIN - 1},}`, "u");

export type DraftKind = "empty" | "command" | "edit" | "ok" | "action";

export interface DraftGate {
	kind: DraftKind;
	/**
	 * The part of the draft a translation is of: the draft itself, or what
	 * follows `/me ` in an action. The composer keys its strip on this and
	 * puts the command back in front of the translation when it sends.
	 */
	text: string;
}

/** `/me ` and what follows it: an ACTION with something in it to translate. */
const ACTION_RX = /^\/me\s+(\S.*)$/is;

/**
 * What the first Enter does with a draft. A slash command never translates
 * (`//text` is the text `/text`, so it does); neither does a message edit —
 * startEdit pre-fills the draft with the sent text, already in the write
 * language.
 *
 * `/me …` is the exception among the commands: an ACTION is prose, and the
 * reading side translates everyone else's, so what follows the command is
 * the draft and the composer re-prefixes the translation. An action with
 * nothing after it is the command's own business.
 */
export function draftGate(text: string, editing: boolean): DraftGate {
	if (text.trim().length === 0) {
		return {kind: "empty", text};
	}

	if (editing) {
		return {kind: "edit", text};
	}

	if (text[0] === "/" && text[1] !== "/") {
		const action = ACTION_RX.exec(text);

		return action ? {kind: "action", text: action[1]} : {kind: "command", text};
	}

	return {kind: "ok", text};
}

/**
 * The composer's line for a translation the second Enter sends. A
 * translation is text, never a command: the model wrote it, from a prompt
 * that quotes the channel's topic and other people's lines, so a line of it
 * that begins with "/" must not run (`/quit`, `/msg NickServ …`, or any raw
 * line, since unknown commands go out as typed).
 *
 * The first line is the whole text's front, which the IRC layer reads as a
 * command in every mode: it is escaped (`//x` is sent as the text `/x`), and
 * an action's goes behind its `/me `. The later lines depend on the mode
 * (irc/commands dispatchInput): under `draft/multiline` a multi-line say or
 * action is one message and its lines go out verbatim, so they are left
 * alone (an escape would be sent as `//x`); without it (`splitsLines`) every
 * line is its own input and each one that begins with "/" is escaped.
 * Except where the draft's own line at the same place is a command (`/x`,
 * not the escaped text `//x`): the user typed that one, so the draft's line
 * goes in its place, as it would have untranslated — never the model's,
 * which could have swapped in a command of its own.
 */
export function sendableTranslation(
	gate: DraftGate,
	translated: string,
	splitsLines: boolean
): string {
	const lines = translated.split("\n");
	const draftLines = gate.text.split("\n");
	const aligned = draftLines.length === lines.length;
	const out = lines.map((line, i) => {
		if (i === 0 || !splitsLines) {
			return line;
		}

		const typed = aligned ? draftLines[i] : "";

		if (typed.startsWith("/") && !typed.startsWith("//")) {
			return typed;
		}

		return line.startsWith("/") ? `/${line}` : line;
	});

	if (gate.kind === "action") {
		return `/me ${out.join("\n")}`;
	}

	return out[0].startsWith("/") ? `/${out.join("\n")}` : out.join("\n");
}

/**
 * The source language sent with a write. A draft too short to place
 * (`detection.lang === null`) is taken as the user's reading language when
 * that differs from the target, else left to the LLM. A draft the detector
 * places in the reading language is trusted outright. A draft the detector
 * places somewhere else is trusted only when it is sure enough
 * (`WRITE_DETECT_MIN_GAP`) -- a weak verdict is more likely the detector
 * misplacing a short draft than the user actually switching languages, so
 * it falls back to the reading language rather than sending the draft to
 * the LLM under a source it probably is not.
 *
 * A fallback is never the target. "From German into German" is a request
 * the model answers by handing the line back -- measured -- so where the
 * reading language is the write target there is nothing to fall back to and
 * the source is left to the LLM. A draft the detector places in the target
 * with a strong verdict never reaches here: the caller sends it as typed.
 */
export function writeSource(
	detection: {lang: string | null; confidence: number},
	readingLanguage: string,
	writeTarget: string
): string | null {
	const fallback = readingLanguage !== writeTarget ? readingLanguage : null;

	if (!detection.lang) {
		return fallback;
	}

	// A verdict that agrees with the reading language is trusted outright —
	// unless that language is the target, where a weak verdict (the strong
	// one was sent as typed by the caller) is still no source: the target
	// is never named as the source, whichever branch would have named it.
	if (detection.lang === readingLanguage) {
		return fallback;
	}

	return detection.confidence >= WRITE_DETECT_MIN_GAP ? detection.lang : fallback;
}

/**
 * The language a translation is read back into: the user's reading
 * language, or null when it is the same as the write target (nothing to
 * read back into). The draft's detected source plays no part -- the
 * read-back is always for the person reading, in the language they read.
 */
export function reverseTarget(readingLanguage: string, writeTarget: string): string | null {
	return readingLanguage !== writeTarget ? readingLanguage : null;
}

/**
 * The language the composer's translate dialog opens on (ChatInput.vue).
 * Its source is the reading language, so a target equal to it is the
 * cleanup pass, which only the GPU model runs: opening on it made every
 * device without one -- most phones, Firefox -- open the dialog disabled,
 * "Correcting a message needs the GPU model", as though translation did
 * not work there at all. So a preselection the device cannot serve is
 * passed over, in this order:
 *
 * - the channel's last pick (`once`, else its send target);
 * - a language the channel declares, other than the reading language;
 * - the reading language itself -- the cleanup pass, where it runs;
 * - the first of `fallback` (the supported list, English first) that is
 *   not the reading language.
 *
 * `routes(to)` is the router's verdict for reading → `to`. When nothing
 * routes (the probe still running, both engines off) the old preselection
 * stands -- the last pick, else the reading language -- and the dialog
 * says why it cannot run.
 */
export function onceTargetDefault(options: {
	reading: string;
	last: string;
	declared: readonly string[];
	fallback: readonly string[];
	routes: (to: string) => boolean;
}): string {
	const {reading, last, declared, fallback, routes} = options;
	const candidates = [
		last,
		...declared.filter((code) => code !== reading),
		reading,
		...fallback.filter((code) => code !== reading),
	];

	for (const code of candidates) {
		if (code && routes(code)) {
			return code;
		}
	}

	return last || reading;
}

/** What two texts are compared as by `isUnchanged`: the differences a model
 *  makes to a line it is handing back rather than translating. */
function echoForm(text: string): string {
	return (
		text
			.toLowerCase()
			// Marks the model wrapped the line in are packaging, not a change:
			// "*sounds good to me*" and "||no problem||" are still the line.
			.replace(/\*\*|__|~~|\|\||(^|\s)[*_]+|[*_]+(\s|$)/g, " ")
			.replace(/\s+/g, " ")
			.trim()
			.replace(/[.,!?…]+$/, "")
			.trim()
	);
}

/**
 * The answer is the source over again: the model echoed instead of
 * translating. That is what a request whose source was its own target
 * produced (`writeSource` no longer builds one), and it is what a model
 * does with a line that has nothing to translate -- "ok, brb", a bare nick.
 * Judged loosely on purpose: an answer differing only in case, in spacing
 * or in the full stop it dropped is still the line that went in.
 */
export function isUnchanged(source: string, translation: string): boolean {
	return echoForm(source) === echoForm(translation);
}

/**
 * Nothing in it a language could be -- `""`, `⟹ `, `⟦1⟧`, `--- ---`. A
 * model asked for a line with nothing to translate answers with punctuation
 * alone often enough to matter (`⟹ ⟦1⟧` was measured on the offline runner
 * for an English line in the write shape). Letters and digits of any script
 * are content, so `ok`, `42` and `Hallo` are answers; a placeholder is
 * span syntax rather than content, so its digit does not count (the same
 * strip `isProtectedOnly` does below -- restoration never leaves one, so
 * this only matters to a caller holding a protected text).
 */
export function hasNoLetters(text: string): boolean {
	return !/[\p{L}\p{N}]/u.test(text.replace(/⟦\s*\d+\s*⟧/g, ""));
}

/** The longest run of one repeated token, 2-gram or 3-gram a text is in. */
const REPEAT_BLOCK_MAX = 3;

/** How many times in a row a block has to repeat before it is a loop. */
const BLOCK_REPEAT_MIN = 4;

/**
 * The words of a text as the repetition rule compares them: lower-cased,
 * with the punctuation at either end taken off (`Kama,` and `KAMA.` are the
 * same word), and nothing that is punctuation all the way through.
 */
function repeatTokens(text: string): string[] {
	return text
		.toLowerCase()
		.split(/\s+/)
		.map((token) => token.replace(/^[\p{P}\p{S}]+/u, "").replace(/[\p{P}\p{S}]+$/u, ""))
		.filter((token) => token !== "");
}

/**
 * Is a text a model stuck on one word or one short phrase -- the same token,
 * or the same two or three tokens, BLOCK_REPEAT_MIN times in a row? Blocks
 * are compared end to end, not sliding, because a phrase repeated is what is
 * being looked for: the 2-grams of `एक बार एक बार …` alternate, so only the
 * ones starting every second token are equal. Three in a row is emphasis
 * ("ha ha ha"), four is the loop the shipped machine catalogs are full of.
 */
function isRepeatedBlock(text: string): boolean {
	const tokens = repeatTokens(text);

	for (let size = 1; size <= REPEAT_BLOCK_MAX; size++) {
		for (let start = 0; start + size * BLOCK_REPEAT_MIN <= tokens.length; start++) {
			const block = tokens.slice(start, start + size).join(" ");
			let repeats = 1;

			while (
				tokens.slice(start + repeats * size, start + (repeats + 1) * size).join(" ") ===
				block
			) {
				repeats++;

				if (repeats >= BLOCK_REPEAT_MIN) {
					return true;
				}
			}
		}
	}

	return false;
}

/**
 * Symbol garbage a degenerate model answer is: a run of tildes or @ signs
 * (three is enough — no chat line carries them), or a run of five or more
 * of the same other punctuation mark the *source* does not carry a run of
 * itself. The source check keeps a translation of an excited line honest:
 * "che meraviglia!!!!!" for a source that already had "!!!!!" is the
 * line's emphasis carried over, not the model padding. Letterless answers
 * are `hasNoLetters`'s verdict; this catches the ones wearing words as a
 * disguise. A word, or a two- or three-word phrase, four times in a row is
 * the same failure wearing words: the machine catalogs this rule was
 * measured against are full of it (`Κοντά Κοντά Κοντά Κοντά`). Both rules
 * stand down when the SOURCE is in the same shape: a line that really does
 * say it five times translates into one that does, and only the model
 * inventing the run is degenerate. Shared with the i18n fill's quality gate
 * (tools/i18n/quality.ts re-exports it), so the fill and the app reject the
 * same shapes.
 */
export function isDegenerate(text: string, source = ""): boolean {
	if (isRepeatedBlock(text) && !isRepeatedBlock(source)) {
		return true;
	}

	// Whitespace out first: the padding this judges is often spaced —
	// "~ ~ ~ ~" — which no adjacent-run test would otherwise see.
	const packed = text.replace(/\s+/g, "");

	if (/[~@]{3,}/.test(packed)) {
		return true;
	}

	const run = /([^\p{L}\p{N}])\1{4,}/u.exec(packed);

	if (!run) {
		return false;
	}

	// The source's own longest run of that character: three or more and the
	// answer is carrying the line's emphasis over, not padding.
	let longest = 0;
	let current = 0;

	for (const ch of source.replace(/\s+/g, "")) {
		current = ch === run[1] ? current + 1 : 0;

		if (current > longest) {
			longest = current;
		}
	}

	return longest < 3;
}

/**
 * Is a streaming answer, so far, nothing but the source coming back? The
 * strip and the read-back row show a stream as it arrives, and a model that
 * is about to hand the line back writes it out word by word first -- which,
 * with the bare second try replacing it, read as the translation rewriting
 * itself. While this holds the row shows only its caret; the moment the
 * answer departs from the source, it shows the answer. Case and runs of
 * whitespace are ignored, as `isUnchanged` ignores them.
 */
export function echoingSoFar(source: string, partial: string): boolean {
	const so = partial.toLowerCase().replace(/\s+/g, " ").trim();

	if (so === "") {
		return false;
	}

	return source.toLowerCase().replace(/\s+/g, " ").trim().startsWith(so);
}

/**
 * What an answer amounts to: `null` when it is a translation, else the
 * failure it is -- `EMPTY_TRANSLATION` for nothing a language could be,
 * `REPETITION` for a model stuck in a loop,
 * `NARRATION` for the model talking about the request, `ANSWERED` for a
 * question answered rather than translated, `UNCHANGED` for the
 * source handed back. Both sides of the composer
 * (`writer.ts`: the draft's translation and the round trip's read-back) ask
 * this of every answer, so the order of the two rules is decided once: an
 * answer with no letters in it is reported as that even where it is also
 * the source over again.
 */
/**
 * Is an answer the model narrating the task? Two signs, either enough: it
 * quotes the source line (a translation never contains the line it
 * translates, in quotes), or it says both "the user" and "translat…" where
 * the source says neither. Both are English on purpose: the model narrates in
 * English whatever the target. Checked against every answer the offline
 * runner had produced (1,048 of them) with no false positive.
 */
export function isNarration(source: string, answer: string): boolean {
	const line = source.trim().toLowerCase();
	const said = answer.toLowerCase();

	if (line.length >= 4) {
		for (const [open, close] of [
			['"', '"'],
			["'", "'"],
			["\u201c", "\u201d"],
		]) {
			if (said.includes(`${open}${line}${close}`)) {
				return true;
			}
		}
	}

	const user = /\bthe user\b/i;
	const translate = /\btranslat/i;

	return (
		user.test(answer) &&
		translate.test(answer) &&
		!(user.test(source) && translate.test(source))
	);
}

/** The question marks a translation of a question keeps: Latin, full-width, Arabic. */
const QUESTION_MARKS = /[?\uff1f\u061f]/u;

/**
 * What can follow a question's mark at the end of a line: closing quotes and
 * brackets, emoji (with their joiners, variation selectors and skin tones)
 * and space. Taken off before the last character is looked at.
 */
const QUESTION_TAIL =
	// eslint-disable-next-line no-misleading-character-class
	/[\s"'\u00bb\u201d\u2019\u203a\u300d\u300f)\]}\uff09\uff3d\uff5d\u3011\u3009\u300b\p{Extended_Pictographic}\u200d\ufe0f\u{1f3fb}-\u{1f3ff}]+$/u;

/**
 * Targets whose translation of a question often ends without a question
 * mark (a particle such as Japanese か, Korean 까, Thai ไหม, or the Greek
 * `;`), so a missing mark there says nothing.
 */
const QUESTION_MARK_OPTIONAL = new Set(["ja", "zh", "ko", "th", "el"]);

/**
 * Did the model answer a question instead of translating it? The source
 * ends in a question mark (`?`, `？`, `؟`; closing quotes, brackets and emoji
 * after it aside) and the answer carries none -- a translation of a question
 * keeps its mark. Never judged into a language whose questions often go
 * without one (`QUESTION_MARK_OPTIONAL`). A mark inside the source ("Memorizar?
 * Hm...") does not make the line a question.
 */
/**
 * A cleanup that dropped its question's mark: the draft ended in one, the
 * corrected line has none, and the line is still mostly the draft's words
 * (at least half of them, case and punctuation aside). A copy editor that
 * loses a "?" made a slip, not an answer -- the web 1.7B handed back
 * "wanna come" for "…, wanna come?", which isAnsweredQuestion then failed
 * as an answered question. The mark goes back on; an actual answer, which
 * shares few of the draft's words, is left for answerError to refuse.
 */
export function keepQuestionMark(draft: string, corrected: string): string {
	const last = draft.replace(QUESTION_TAIL, "").slice(-1);

	if (last === "" || !QUESTION_MARKS.test(last) || QUESTION_MARKS.test(corrected)) {
		return corrected;
	}

	const words = (text: string) =>
		text
			.toLowerCase()
			.split(/\s+/)
			.map((w) => w.replace(/[\p{P}\p{S}]+/gu, ""))
			.filter((w) => w !== "");
	const draftWords = words(draft);
	const kept = new Set(words(corrected));
	const shared = draftWords.filter((w) => kept.has(w)).length;

	if (draftWords.length === 0 || shared * 2 < draftWords.length) {
		return corrected;
	}

	return corrected.replace(/\s+$/, "") + last;
}

export function isAnsweredQuestion(source: string, answer: string, to: string): boolean {
	if (QUESTION_MARK_OPTIONAL.has(to)) {
		return false;
	}

	const last = source.replace(QUESTION_TAIL, "").slice(-1);

	return last !== "" && QUESTION_MARKS.test(last) && !QUESTION_MARKS.test(answer);
}

/**
 * Is an answer a model stuck in a loop? The same word REPEAT_MIN or more
 * times in a row (case and punctuation aside), or in a script written
 * without spaces the same run of two or three characters REPEAT_MIN or more
 * times, or the same single character SINGLE_REPEAT_MIN or more. "no no no
 * no" and "hahahaha" are not: four in a row, and a Latin word is only ever
 * compared as a whole word; nor are "ええええええ" and "哈哈哈哈哈哈", six of one
 * character.
 */
export function isRepetition(answer: string): boolean {
	let previous = "";
	let run = 0;

	for (const token of answer.toLowerCase().split(/\s+/)) {
		const word = token.replace(/[\p{P}\p{S}]+/gu, "");

		if (word === "") {
			continue;
		}

		if (word === previous) {
			run++;

			if (run >= REPEAT_MIN) {
				return true;
			}
		} else {
			previous = word;
			run = 1;
		}
	}

	return SPACELESS_RUN_LOOP.test(answer) || SPACELESS_CHAR_LOOP.test(answer);
}

/** A mark with nothing but an ellipsis inside, at the end or the start. */
const EMPTY_MARK_AFTER = /\s*(\|\||~~|\*\*|__|\*|_)\s*(?:\u2026|\.{2,})\s*\1\s*$/;
const EMPTY_MARK_BEFORE = /^\s*(\|\||~~|\*\*|__|\*|_)\s*(?:\u2026|\.{2,})\s*\1\s*/;

/** The wrappers a model puts round a whole answer: open, close. */
const ANSWER_WRAPPERS: [string, string][] = [
	["||", "||"],
	["~~", "~~"],
	["**", "**"],
	["__", "__"],
	["*", "*"],
	["_", "_"],
	['"', '"'],
	["\u201c", "\u201d"],
	["\u201e", "\u201c"],
	["\u00ab", "\u00bb"],
];

/**
 * An answer with the model's packaging taken off, judged against the line it
 * translates. Two kinds, both seen from Qwen on a read-back once the request
 * carried the channel's context ("Output only the translation of the last
 * message" is in that prompt, and the model echoed the phrase):
 *
 * - a leading clause about the translation ending in a colon -- "Here comes
 *   the translation of the last message: …" -- unless the source line has a
 *   colon of its own or itself talks about a translation;
 * - bold, italics or quotes round the whole answer (a full stop after the
 *   closing mark included) when the source line has no such wrapper and the
 *   answer has no second one inside.
 *
 * What is left is what the judge (`answerError`) sees and what the user is
 * shown; an answer that was nothing but a preamble is left as it was, so the
 * judge still refuses it.
 */
export function tidyAnswer(source: string, answer: string): string {
	let text = answer.trim();
	const line = source.trim();

	const preamble = /^([^:\n]{0,100}):\s+(\S[\s\S]*)$/.exec(text);

	// Only where the source line has no colon of its own: a colon the
	// message carries ("Übersetzung für die Doku: fertig") comes through in
	// its translation, and the clause before it is content, not packaging.
	if (
		preamble &&
		/\btranslat/i.test(preamble[1]) &&
		!/[:\uff1a]/.test(line) &&
		!/\btranslat/i.test(line)
	) {
		text = preamble[2].trim();
	}

	// An empty mark the source does not have, at either end: "||…||",
	// "~~...~~". Measured on the web build's 1.7B weights, which copied
	// the marks sentence's own example onto 7 of 45 casual lines
	// ("sounds good to me ||…||").
	for (const edge of [EMPTY_MARK_AFTER, EMPTY_MARK_BEFORE]) {
		const found = edge.exec(text);

		if (found && !line.includes(found[1]) && text.replace(edge, "").trim() !== "") {
			text = text.replace(edge, "").trim();
		}
	}

	for (const [open, close] of ANSWER_WRAPPERS) {
		if (!text.startsWith(open) || line.startsWith(open)) {
			continue;
		}

		const trailing = /[.!?\u2026]*$/.exec(text)?.[0] ?? "";
		const body = text.slice(0, text.length - trailing.length);

		if (body.length <= open.length + close.length || !body.endsWith(close)) {
			continue;
		}

		const inner = body.slice(open.length, body.length - close.length);

		if (!/[\p{L}\p{N}]/u.test(inner) || inner.includes(open) || inner.includes(close)) {
			continue;
		}

		text = `${inner.trim()}${trailing}`;
		break;
	}

	return text;
}

/**
 * `to` is the language the answer should be in: the question rule
 * (`isAnsweredQuestion`) is not applied to targets whose questions often
 * end without a mark.
 */
/**
 * The label a polish's user turn carries ("Correct: …"), copied in front of
 * the answer by a smaller model (measured on Qwen3-1.7B, 2026-09-18): off
 * it comes, as a copied nick prefix does.
 */
export function stripPolishLabel(answer: string): string {
	return answer.replace(/^\s*correct(?:ed|ion)?\s*:\s*/i, "");
}

export function answerError(source: string, translation: string, to: string): string | null {
	if (hasNoLetters(translation)) {
		return EMPTY_TRANSLATION;
	}

	// A line that repeats itself translates into one that does. The loop
	// rule is judged first because isDegenerate now covers a shorter word
	// loop too, and "got stuck repeating itself" is the truer report of one.
	if (isRepetition(translation) && !isRepetition(source)) {
		return REPETITION;
	}

	// Symbol garbage (a dot-padded line, a tilde run) is no translation
	// either, and neither is a word four times over.
	if (isDegenerate(translation, source)) {
		return DEGENERATE;
	}

	if (isNarration(source, translation)) {
		return NARRATION;
	}

	if (isAnsweredQuestion(source, translation, to)) {
		return ANSWERED;
	}

	if (isUnchanged(source, translation)) {
		return UNCHANGED;
	}

	return null;
}

function wordCount(text: string): number {
	return text.split(/\s+/).filter((w) => w !== "").length;
}

/**
 * The pair a sent translation leaves in the channel's term memory, or
 * null: only a term-sized draft (one line, at most TERM_MAX_WORDS words and
 * TERM_MAX_CHARS characters) with a short translation that differs from
 * it. Sentences would fill TERM_CAP and poison every later prompt's Terms
 * line.
 */
export function termPair(draft: string, translation: string): [string, string] | null {
	const source = draft.trim();
	const target = translation.trim();

	if (source.includes("\n") || target.includes("\n")) {
		return null;
	}

	if (source.length === 0 || source.length > TERM_MAX_CHARS || target.length > TERM_MAX_CHARS) {
		return null;
	}

	if (wordCount(source) > TERM_MAX_WORDS || wordCount(target) > TERM_MAX_WORDS * 2) {
		return null;
	}

	if (source.startsWith("/") || source.includes("⟦") || target.includes("⟦")) {
		return null;
	}

	// A side with nothing in it a language could be is no term: an answer of
	// punctuation alone would be quoted into every later prompt as the
	// translation of a real word.
	if (hasNoLetters(source) || hasNoLetters(target)) {
		return null;
	}

	if (source.toLowerCase() === target.toLowerCase()) {
		return null;
	}

	return [source, target];
}

export interface OutgoingDeps {
	translate(
		req: Omit<TranslateRequest, "id" | "model">,
		signal: AbortSignal
	): AsyncIterable<TranslateChunk>;
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
	/**
	 * A counter that moves while a model downloads (service.ts `loadTicks`).
	 * Optional: without it a deadline is a plain timeout.
	 */
	loadTicks?(): number;
}

export interface Deadline {
	clear(): void;
}

/**
 * A request's deadline that waits out a model download: when `ms` has
 * passed and the load counter has moved since the deadline was armed (the
 * model this request waits for is downloading), it is armed again for
 * another `ms` instead of expiring. A download that stalls stops the
 * counter, and the next expiry fires. An NLLB download is ~620 MB, which
 * two minutes do not cover on most links, and ruling C routes a weak
 * language to it whether it is downloaded or not.
 */
export function armDeadline(
	timers: Pick<OutgoingDeps, "setTimeout" | "clearTimeout" | "loadTicks">,
	ms: number,
	onExpire: () => void
): Deadline {
	let handle: unknown = null;
	let ticks = timers.loadTicks?.() ?? 0;
	let cleared = false;

	const arm = () => {
		handle = timers.setTimeout(() => {
			if (cleared) {
				return;
			}

			const now = timers.loadTicks?.() ?? 0;

			if (now !== ticks) {
				ticks = now;
				arm();
				return;
			}

			onExpire();
		}, ms);
	};

	arm();

	return {
		clear() {
			cleared = true;
			timers.clearTimeout(handle);
		},
	};
}

export interface OutgoingRequest {
	/** The draft as typed: unprotected, may carry newlines. */
	text: string;
	from: string | null;
	/** Routing only (`TranslateRequest.hint`): a seq2seq route's source when `from` is null. */
	hint?: string | null;
	to: string;
	purpose: "write" | "read" | "polish";
	context: PromptContext;
	/** The route's engine takes numbered lines (the LLM does; seq2seq does not). */
	batches: boolean;
	/** The channel's names, protected like any other span (spans.ts). */
	nicks?: string[];
	/**
	 * The marker form the route's engine reads (spans.ts `renderMarkers`):
	 * `LLM_MARKERS` on the LLM route, `placeholder` everywhere else. It
	 * travels with the request as well as into the protection, so the
	 * prompt can say what the text it is looking at carries.
	 */
	markers?: MarkerForm;
	/** The device the route runs on. */
	device?: Device;
	/**
	 * The route's engine: the language model on the CPU gets the longer
	 * deadline (CPU_WRITE_TIMEOUT_MS); OPUS-MT and NLLB-200 there do not.
	 */
	engine?: EngineName | null;
	/**
	 * Already protected, `text` being its protected form: the reading queue
	 * protects a whole message once (a fenced block is one span across its
	 * lines) and hands the lines here. Without it the text is protected
	 * here — once, before it is split, for the same reason.
	 */
	protected?: Protected;
}

/**
 * The routing hint a draft's request carries (`TranslateRequest.hint`, never
 * the prompt): the named source when there is one, else the detector's
 * verdict however weak, unless that verdict is the target itself. A seq2seq
 * route takes the hint as its source (router.ts), so a draft whose source is
 * left to the LLM (`writeSource` returned null) can still reach NLLB or
 * OPUS-MT.
 */
export function sourceHintFor(
	detection: {lang: string | null},
	source: string | null,
	to: string
): string | null {
	if (source) {
		return source;
	}

	return detection.lang && detection.lang !== to ? detection.lang : null;
}

/**
 * The judged failures a bare second try can answer: the answer's own
 * failures, every one of them the same model looking at the same
 * confounding request. The reading queue retries all five (`queue.ts`
 * `failJudged`) and the composer tests membership here, so the two cannot
 * drift apart again -- a draft the model looped on in four or five repeats
 * (DEGENERATE) used to get no second try while a six-repeat one
 * (REPETITION) did.
 */
export const BARE_RETRY_ERRORS: ReadonlySet<string> = new Set([
	UNCHANGED,
	NARRATION,
	ANSWERED,
	REPETITION,
	DEGENERATE,
]);

/**
 * The second try for an answer that came back unchanged: the same draft,
 * the source left to the model, no context but the register. The routing
 * hint (`hint`, not part of the prompt) stays, because a seq2seq route
 * takes it as its source: the retry goes down the same route, and without
 * it that route would have no source at all.
 *
 * The bare request is the shape a model answers most reliably, and the two
 * things that make one hand a line back rather than translate it -- a
 * source that is wrong for the draft, and a context that confounds it --
 * are exactly what this removes. The route is kept (`batches`, `markers`,
 * `protected`), so the retry goes to the same engine over the same
 * protected text; only what the prompt says about it changes.
 */
export function bareRetry(request: OutgoingRequest): OutgoingRequest {
	const context = emptyContext();

	context.formality = request.context.formality;

	if (request.context.variant) {
		context.variant = request.context.variant;
	}

	return {...request, from: null, hint: request.hint ?? request.from, context};
}

/**
 * One attempt as a development build records it (`writer.ts`, behind
 * `BUILD === "dev"`, onto `window.seanceTranslateLog`): everything the
 * offline runner needs to send the same request again
 * (`tools/translate-llm.ts --capture`), and what came back.
 */
export interface TranslateCapture {
	/** The draft's translation, or the round trip reading one back. */
	kind: "write" | "check";
	/** ISO time the attempt finished. */
	at: string;
	/** The text that went in: the draft, or the translation being read back. */
	draft: string;
	from: string | null;
	to: string;
	model: string | null;
	engine: EngineName | null;
	markers: MarkerForm;
	/** This was the bare second try (`bareRetry`). */
	retry: boolean;
	context: PromptContext;
	/** The answer, restored and with a copied nick prefix stripped. */
	text: string;
	/** `answerError`'s verdict, the thrown message, or null. */
	error: string | null;
}

/** Nothing here but placeholders: a fenced code block's line, say. */
function isProtectedOnly(line: string): boolean {
	return placeholdersIn(line).length > 0 && line.replace(/⟦\s*\d+\s*⟧/g, "").trim() === "";
}

/** One translation of the already-protected `line`, streamed through `onChunk` (restored). */
async function translateOne(
	deps: OutgoingDeps,
	request: OutgoingRequest,
	info: Protected,
	line: string,
	signal: AbortSignal,
	onChunk: (text: string) => void
): Promise<string> {
	let last = "";

	for await (const chunk of deps.translate(
		{
			text: line,
			from: request.from,
			hint: request.hint,
			to: request.to,
			purpose: request.purpose,
			context: request.context,
			markers: request.markers,
		},
		signal
	)) {
		last = chunk.text;
		onChunk(restore(chunk.text, info.spans).text);
	}

	return restoreAll(last, info, placeholdersIn(line));
}

/** The numbered stream as it stands, numbers stripped and spans restored, for the strip. */
function batchedPreview(raw: string, info: Protected): string {
	return stripSentinel(raw)
		.split("\n")
		.map((line) => {
			const match = /^\s*\d+\.\s?(.*)$/.exec(line);

			return restore(match ? match[1] : line, info.spans).text;
		})
		.join("\n");
}

/**
 * The non-blank lines of a multi-line draft as one numbered request; null
 * when the answer's numbering does not parse (the caller then goes line by
 * line).
 */
async function translateBatched(
	deps: OutgoingDeps,
	request: OutgoingRequest,
	info: Protected,
	lines: string[],
	signal: AbortSignal,
	onChunk: (text: string) => void
): Promise<string[] | null> {
	let last = "";

	for await (const chunk of deps.translate(
		{
			text: "",
			lines,
			from: request.from,
			hint: request.hint,
			to: request.to,
			purpose: request.purpose,
			context: request.context,
			markers: request.markers,
		},
		signal
	)) {
		last = chunk.text;
		onChunk(batchedPreview(chunk.text, info));
	}

	const parsed = parseBatchedOutput(last, lines.length);

	if (!parsed) {
		return null;
	}

	return parsed.map((text, i) => restoreAll(text, info, placeholdersIn(lines[i])));
}

/**
 * Translate a text as a unit — the composer's draft, and (through the
 * queue) a multi-line message someone sent. The whole text is protected
 * once and only then split, so a fenced block is one span rather than a
 * fence per line, and a line that holds nothing but a placeholder is put
 * back rather than translated. Resolves the translation with the text's
 * line structure (blank lines in place); rejects with TIMED_OUT after
 * WRITE_TIMEOUT_MS, ABORTED when `signal` aborts, or the engine's error.
 * `onChunk` gets the text so far, restored, for the strip to stream.
 */
export async function translateDraft(
	deps: OutgoingDeps,
	request: OutgoingRequest,
	signal: AbortSignal,
	onChunk: (text: string) => void
): Promise<string> {
	const controller = new AbortController();
	const abort = () => controller.abort();
	let timedOut = false;

	if (signal.aborted) {
		throw new Error(ABORTED);
	}

	signal.addEventListener("abort", abort, {once: true});

	// Waits out a model download (armDeadline): the first draft in a weak
	// language may be what downloads NLLB.
	const timer = armDeadline(
		deps,
		request.engine === "llm" && request.device === "cpu"
			? CPU_WRITE_TIMEOUT_MS
			: WRITE_TIMEOUT_MS,
		() => {
			timedOut = true;
			controller.abort();
		}
	);

	// A stream that ended because of the timeout or the caller's abort ends
	// normally (client.ts closes it at once), so the result is checked, not
	// trusted.
	const finish = (text: string): string => {
		if (timedOut) {
			throw new Error(TIMED_OUT);
		}

		if (signal.aborted) {
			throw new Error(ABORTED);
		}

		return text;
	};

	try {
		// Once, on the whole text: a fenced code block is one span across
		// its lines, and a placeholder's number is the same in every line.
		const info =
			request.protected ??
			protect(request.text, {nicks: request.nicks, markers: request.markers});
		const lines = info.text.split("\n");
		const filled: [string, number][] = [];
		// A line that is nothing but protected syntax (a code block) has
		// nothing to translate: it is put back as it was.
		const kept: number[] = [];

		lines.forEach((line, index) => {
			if (line.trim() === "") {
				return;
			}

			if (isProtectedOnly(line)) {
				kept.push(index);
				return;
			}

			filled.push([line, index]);
		});

		if (filled.length <= 1 && kept.length === 0) {
			const only = filled.length === 1 ? filled[0][0] : info.text;
			const text = await translateOne(deps, request, info, only, controller.signal, onChunk);

			return finish(text);
		}

		const out = [...lines];

		for (const index of kept) {
			out[index] = restoreAll(lines[index], info, placeholdersIn(lines[index]));
		}

		let translated: string[] | null = null;

		if (request.batches && filled.length > 1) {
			let streamed = false;

			try {
				translated = await translateBatched(
					deps,
					request,
					info,
					filled.map(([l]) => l),
					controller.signal,
					(preview) => {
						streamed = true;

						const partial = preview.split("\n");

						filled.forEach(([, index], n) => {
							out[index] = partial[n] ?? "";
						});
						onChunk(out.join("\n"));
					}
				);
			} catch (e) {
				// The service resolves the route again and may land on another
				// candidate — a seq2seq one refuses a batched request outright.
				// A refusal before anything was yielded is the same case as
				// numbering that does not parse: go line by line. A failure
				// mid-stream, an abort and the timeout are real.
				if (streamed || timedOut || signal.aborted) {
					throw e;
				}

				translated = null;
			}
		}

		if (!translated) {
			translated = [];

			for (const [line, index] of filled) {
				const text = await translateOne(
					deps,
					request,
					info,
					line,
					controller.signal,
					(partial) => {
						out[index] = partial;
						onChunk(out.join("\n"));
					}
				);

				translated.push(text);
				out[index] = text;
			}
		}

		filled.forEach(([, index], n) => {
			out[index] = translated![n];
		});

		return finish(out.join("\n"));
	} catch (e) {
		if (timedOut) {
			throw new Error(TIMED_OUT);
		}

		if (signal.aborted) {
			throw new Error(ABORTED);
		}

		throw e;
	} finally {
		timer.clear();
		signal.removeEventListener("abort", abort);
	}
}
