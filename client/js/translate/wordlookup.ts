// The short-line lookup (spec docs/superpowers/plans/2026-09-18-single-word-lookup.md).
// A line of one to three words the function-word classifier (chatdetect.ts)
// cannot place is too short for trigrams and too thin for function words --
// "test", "hola", "danke" carry no grammar at all -- so it was left to the
// engine with no source named, and an engine handed one English word answers
// with that word. Here it is placed by frequency instead: a generated table
// (tools/generate-wordlist.py, client/js/translate/wordlist.json) lists the
// most frequent words of each of the 24 translation targets with their rank,
// and a language scores 1/rank for every word of the line it lists, so a word
// at rank 5 counts far more than one at rank 700.
//
// A verdict from here is a source, not a hint: it is not `weak`, so
// `sourceFor` translates *from* it and "test" read in Spanish becomes
// "prueba". That is only safe because the rule refuses to guess: one language
// carrying the words, or a runaway leader, or -- only when nothing leads --
// the channel's prior among the contenders; anything else returns an
// unplaced verdict and the engine places the line as before.
//
// Nothing is noted into the channel's prior from here: one word is no
// evidence about what a channel speaks.
//
// Vue-free, store-free; the table is a separate webpack chunk, fetched on the
// first short line that reaches the lookup.

import type {Detection, LanguagePrior} from "./detect";

/** `[tag, rank]`, rank 1 being the language's most frequent word. */
export type WordEntry = readonly [string, number];

export interface Wordlist {
	/** Lower-cased word → the languages listing it, with its rank in each. */
	words: Record<string, readonly WordEntry[]>;
	langs: string[];
	/** Languages whose words came from a stopword list, not a frequency one. */
	partial: string[];
}

/** Longest line the lookup will judge: beyond this the classifier or franc. */
export const LOOKUP_MAX_WORDS = 3;
/**
 * How far ahead of the runner-up a language must score to win without the
 * channel's prior backing it. Measured against the committed table: "hasta
 * luego" leads 17x (Spanish), while "muy bien" leads only 1.8x over French
 * and "ja so gut" 1.8x over Slovak -- lines a lower bar would place from the
 * wrong language, which costs a wrong translation rather than a chip.
 */
export const LOOKUP_LEAD = 3;
/**
 * The longest word any of the space-free languages (ja, zh, ko, th) has in
 * the table: Thai 9, Japanese 7, Korean 4, Chinese 3. `tokens()` splits on
 * spaces, so a whole Japanese sentence arrives as one token -- longer than
 * this, it can match nothing, and the 390 KB chunk is not worth fetching to
 * find that out. A lone word in one of those scripts still is (the table
 * places "ありがとう" as Japanese).
 */
export const LOOKUP_MAX_SCRIPTLESS = 9;

const SCRIPTLESS =
	/^[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}\p{sc=Thai}\u30fc\u3005\u3006]+$/u;
const HAS_LETTER = /\p{L}/u;

/** Whether any word of the line could be a key at all, without the table. */
function couldMatch(words: readonly string[]): boolean {
	return words.some(
		(word) =>
			HAS_LETTER.test(word) && !(SCRIPTLESS.test(word) && word.length > LOOKUP_MAX_SCRIPTLESS)
	);
}

let table: Wordlist | null = null;
let loading: Promise<Wordlist> | null = null;
let loader: (() => Promise<Wordlist>) | null = null;

/** Tests: the table without the chunk; `null` restores the real one. */
export function setWordlist(next: Wordlist | null): void {
	table = next;
	loading = null;
}

/**
 * Tests: what `loadWordlist` calls instead of the chunk import -- a loader
 * that rejects stands in for a chunk that cannot be fetched, and one that
 * throws proves the lookup never asked. `null` restores the import.
 */
export function setWordlistLoader(next: (() => Promise<Wordlist>) | null): void {
	loader = next;
	table = null;
	loading = null;
}

export function loadWordlist(): Promise<Wordlist> {
	if (table) {
		return Promise.resolve(table);
	}

	if (!loading) {
		const fetchTable =
			loader ??
			(() =>
				import(/* webpackChunkName: "wordlist" */ "./wordlist.json").then(
					(module) => (module.default ?? module) as unknown as Wordlist
				));

		loading = fetchTable()
			.then((next) => {
				table = next;
				return next;
			})
			.catch((error) => {
				loading = null;
				throw error;
			});
	}

	return loading;
}

const round = (value: number) => Math.round(value * 10000) / 10000;

/**
 * The verdict for a short line, or `null` when the lookup has nothing to say
 * (the line is too long, or no language lists any of its words) and the
 * caller's own answer stands.
 *
 * `exclude` is the language the reader already reads. It filters nothing: a
 * line placed in the reading language is placed all the same, and
 * `detectionSkip` then skips it as "same" -- which is the right answer for a
 * lone "hola" in a Spanish-reading channel.
 */
export async function lookupShortLine(
	words: readonly string[],
	prior: LanguagePrior | null,
	exclude?: string
): Promise<Detection | null> {
	if (words.length === 0 || words.length > LOOKUP_MAX_WORDS || !couldMatch(words)) {
		return null;
	}

	const list = await loadWordlist();
	const scores = new Map<string, number>();

	for (const word of words) {
		for (const [lang, rank] of list.words[word.toLowerCase()] ?? []) {
			scores.set(lang, (scores.get(lang) ?? 0) + 1 / rank);
		}
	}

	if (scores.size === 0) {
		return null;
	}

	const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
	const candidates = ranked.map(([lang]) => lang);
	const placed = (lang: string, score: number): Detection => ({
		lang,
		confidence: round(Math.min(1, score)),
		candidates,
	});

	if (ranked.length === 1) {
		return placed(ranked[0][0], ranked[0][1]);
	}

	// A landslide is not a tie: "the" scores 1.0 for English (rank 1) against
	// 0.0033 for Spanish (rank 301), and a Spanish channel's prior must not
	// turn a lone "the" into a line translated from Spanish. The lead is read
	// first; the prior decides only when nothing leads.
	if (ranked[0][1] >= ranked[1][1] * LOOKUP_LEAD) {
		return placed(ranked[0][0], ranked[0][1]);
	}

	const top = prior?.top() ?? null;

	if (top !== null && scores.has(top)) {
		return placed(top, scores.get(top)!);
	}

	// Several languages, none of them backed: today's answer, with the
	// contenders named for the chip's corrections menu. `short` is what tells
	// `detectionSkip` this is no evidence the line is already readable.
	return {lang: null, confidence: 0, candidates, short: true};
}
