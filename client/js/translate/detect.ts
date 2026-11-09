// Language identification for the reading pipeline and the composer.
// Two identifiers are asked and a line is placed only where they agree
// (`decide`): fastText's lid.176 (a 176-language model in WebAssembly) and
// ELD (Efficient Language Detector, an n-gram table in JavaScript), loaded
// together in their own chunk on the first line there is to place
// (lid.real.ts). Measured on 339 hand-labelled chat lines
// (tools/translate-eval/lid.mts, results/2026-11-08-lid.md), the
// agreement rule calls 1 English line in 166 foreign and places 81% of the
// foreign ones; franc with the function-word classifier and the word list
// it replaces called 7 English lines foreign and placed 47%. A line neither
// is sure of is left unplaced, and the reader leaves an unplaced line alone.
// Vue-free.

import {isSupported} from "./languages";

export interface Detection {
	lang: string | null;
	confidence: number;
	/**
	 * The languages the identifiers ranked highest, best first (at most
	 * `DETECT_CANDIDATES`), whatever the verdict: the menu offers them as
	 * one-click corrections when detection got the source wrong. `lang` may
	 * be null while these still name the contenders.
	 */
	candidates: string[];
}

/** What the identifiers said of one line (lid.real.ts). */
export interface LidResult {
	/** fastText's ranking, best first, probabilities. */
	fast: {lang: string; p: number}[];
	/** ELD's verdict, and whether ELD itself calls it reliable. */
	eld: {lang: string | null; reliable: boolean};
}

export type Identifier = (text: string) => Promise<LidResult>;

/** fastText's probability a verdict ELD agrees with needs. */
export const AGREE_MIN = 0.3;
/** fastText's probability a language ELD cannot name needs on its own. */
export const ALONE_MIN = 0.6;
/** How far down fastText's ranking a rival to a lone verdict is looked for. */
export const RIVAL_DEPTH = 3;
export const PRIOR_WINDOW = 200;
/** How many contenders a `Detection` carries. */
export const DETECT_CANDIDATES = 3;
/** Shorter than this and a verdict is no evidence about the channel. */
export const DETECT_MIN_LENGTH = 10;

/**
 * The supported languages ELD's table does not carry: for these fastText
 * is the only witness, and is asked for more (`ALONE_MIN`).
 */
export const ELD_MISSING: readonly string[] = ["id", "gl", "ga", "cy", "sw", "af"];

/**
 * Scripts only one supported language writes: a line mostly in one of them
 * is placed by its letters, which no short-line statistics can beat
 * ("谢谢", "고마워"). Han without kana is Chinese; kana is Japanese, and a
 * Japanese line's Han counts toward it. A few such letters in a line of
 * another script ("the variable λ is unset") settle nothing: the line goes
 * to the identifiers.
 */
const SCRIPTS: [RegExp, string][] = [
	[/[぀-ヿ]/gu, "ja"],
	[/[가-힯ᄀ-ᇿ]/gu, "ko"],
	[/\p{Script=Han}/gu, "zh"],
	[/\p{Script=Thai}/gu, "th"],
	[/\p{Script=Hebrew}/gu, "he"],
	[/\p{Script=Greek}/gu, "el"],
	[/\p{Script=Bengali}/gu, "bn"],
	[/\p{Script=Tamil}/gu, "ta"],
];

const LETTERS = /\p{L}/gu;
const HAN = /\p{Script=Han}/gu;

const countOf = (text: string, re: RegExp): number => text.match(re)?.length ?? 0;

/** The language a line's script alone settles, or null. */
export function scriptLanguage(text: string): string | null {
	const letters = countOf(text, LETTERS);

	if (letters === 0) {
		return null;
	}

	for (const [script, lang] of SCRIPTS) {
		let own = countOf(text, script);

		if (own === 0) {
			continue;
		}

		if (lang === "ja") {
			own += countOf(text, HAN);
		}

		// The first script found decides, and only for a line mostly in it.
		return own * 2 >= letters ? lang : null;
	}

	return null;
}

/** The declared codes this build can route, deduplicated, order kept. */
export function declaredLanguages(declared: readonly string[]): string[] {
	const out: string[] = [];

	for (const code of declared) {
		if (isSupported(code) && !out.includes(code)) {
			out.push(code);
		}
	}

	return out;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/**
 * The verdict on one line from what the identifiers said. In order:
 *
 * 1. fastText's best, at `AGREE_MIN` or more, with ELD naming the same
 *    language;
 * 2. a language ELD cannot name (`ELD_MISSING`), fastText at `ALONE_MIN`,
 *    with the reading language nowhere in its top `RIVAL_DEPTH`;
 * 3. ELD's verdict where ELD calls it reliable, the reading language again
 *    nowhere in fastText's top `RIVAL_DEPTH`;
 * 4. a language the channel declared, where either identifier names it;
 * 5. nothing: the line is unplaced.
 *
 * `reading` is the reader's language ("en" when nobody says): the rival
 * the lone verdicts must not have, since a line that might already be
 * readable is better left alone than translated from a guess ("ya" is
 * Swahili to fastText at 0.96, "sus" Spanish to both).
 */
export function decide(
	result: LidResult,
	reading: string = "en",
	declared: readonly string[] = []
): Detection {
	const fast = result.fast.filter((entry) => isSupported(entry.lang));
	const top = fast[0];
	const rivals = fast.slice(0, RIVAL_DEPTH).map((entry) => entry.lang);
	const eld = result.eld.lang && isSupported(result.eld.lang) ? result.eld.lang : null;
	const candidates: string[] = [];

	for (const lang of [...rivals, ...(eld ? [eld] : [])]) {
		if (!candidates.includes(lang) && candidates.length < DETECT_CANDIDATES) {
			candidates.push(lang);
		}
	}

	const placed = (lang: string, confidence: number): Detection => ({
		lang,
		confidence: round(confidence),
		candidates: [lang, ...candidates.filter((code) => code !== lang)].slice(
			0,
			DETECT_CANDIDATES
		),
	});

	if (top && top.p >= AGREE_MIN && eld === top.lang) {
		return placed(top.lang, top.p);
	}

	if (top && ELD_MISSING.includes(top.lang) && top.p >= ALONE_MIN && !rivals.includes(reading)) {
		return placed(top.lang, top.p);
	}

	if (eld && result.eld.reliable && !rivals.includes(reading)) {
		return placed(eld, fast.find((entry) => entry.lang === eld)?.p ?? AGREE_MIN);
	}

	const ours = declaredLanguages(declared).find(
		(lang) => lang !== reading && (lang === top?.lang || lang === eld)
	);

	if (ours) {
		return placed(ours, AGREE_MIN);
	}

	return {lang: null, confidence: 0, candidates};
}

/**
 * Why the reading pipeline leaves a detected line alone, or null when it
 * translates it: `same` when the detector placed it in the reading language
 * `to` or in one the user also reads (`alsoRead`, Settings → Language's "I
 * also read"), `unsure` when it could not place it at all. An unplaced line might
 * be readable as it is ("lol", "brb", "mmm tweaking"): handed to an engine
 * with no source named, such lines came back "from Polish". The toolbar's
 * Translate still translates it.
 */
export type DetectionSkip = "same" | "unsure" | null;

export function detectionSkip(
	detection: Detection,
	to: string,
	alsoRead: readonly string[] = []
): DetectionSkip {
	if (detection.lang === to || (detection.lang !== null && alsoRead.includes(detection.lang))) {
		return "same";
	}

	if (detection.lang === null) {
		return "unsure";
	}

	return null;
}

/**
 * What the reader translates a line *from*, whether the source is left to
 * the engine, and what the router may still be told.
 *
 * `source` is a source someone chose (the menu, a retry) as it stands, even
 * when it is the reading language -- they asked for that translation -- or
 * else the detector's verdict when it named a language that is not the one
 * being read. `unsure` says the prompt names no source, so an LLM places
 * the line itself (only a forced line gets there unplaced).
 *
 * `routeHint` is routing only (`QueueItem.routeHint` →
 * `TranslateRequest.hint`, never the prompt): a seq2seq model has no prompt
 * to detect a source in, so a request with no source at all cannot be
 * routed to one (router.ts). The channel's prior steers it then.
 */
export function sourceFor(
	detection: Detection,
	from: string | null,
	to: string,
	priorTop: string | null = null
): {source: string | null; unsure: boolean; routeHint: string | null} {
	if (from) {
		return {source: from, unsure: false, routeHint: from};
	}

	if (detection.lang === null) {
		return {source: null, unsure: true, routeHint: null};
	}

	const source = detection.lang === to ? null : detection.lang;

	return {source, unsure: false, routeHint: source ?? priorTop};
}

/**
 * How sure the detector must be to overrule the language the sender's
 * client named (`+draft/language`, irc/langtag.ts). Above every lone
 * verdict's floor (`ALONE_MIN`): a tag is the sender's own word, so only a
 * verdict close to certain -- a script only one language writes (1), or
 * both identifiers agreeing near the top -- outweighs it.
 */
export const SENDER_OVERRULE_MIN = 0.9;

/**
 * The detection with the sender's language (`sender`, a supported code
 * from the message's `+draft/language`) taken as a strong prior, never an
 * order: an unplaced or weak verdict becomes the sender's language, an
 * agreeing one stands, and only a verdict at `SENDER_OVERRULE_MIN` or more
 * for another language overrules it -- the sender's language then stays on
 * the menu as a one-click correction. A tag cannot make a line the
 * detector is sure of look like the reader's own, nor send a line it is
 * sure of to an engine from the wrong source.
 */
export function withSenderLanguage(detection: Detection, sender: string | undefined): Detection {
	if (!sender || !isSupported(sender)) {
		return detection;
	}

	const others = detection.candidates.filter((code) => code !== sender);

	if (detection.lang !== null && detection.lang !== sender) {
		if (detection.confidence >= SENDER_OVERRULE_MIN) {
			return {
				...detection,
				candidates: [
					detection.lang,
					sender,
					...others.filter((c) => c !== detection.lang),
				].slice(0, DETECT_CANDIDATES),
			};
		}
	}

	return {
		lang: sender,
		confidence: detection.lang === sender ? detection.confidence : AGREE_MIN,
		candidates: [sender, ...others].slice(0, DETECT_CANDIDATES),
	};
}

/** The dominant language of a channel's recent messages. */
export class LanguagePrior {
	private recent: string[] = [];
	private window: number;

	constructor(window: number = PRIOR_WINDOW) {
		this.window = window;
	}

	note(lang: string): void {
		this.recent.push(lang);

		if (this.recent.length > this.window) {
			this.recent.shift();
		}
	}

	top(): string | null {
		const counts = new Map<string, number>();

		for (const lang of this.recent) {
			counts.set(lang, (counts.get(lang) ?? 0) + 1);
		}

		let top: string | null = null;
		let topCount = 0;

		for (const [lang, count] of counts) {
			if (count > topCount) {
				top = lang;
				topCount = count;
			}
		}

		return top;
	}
}

let identifier: Identifier | null = null;
let loading: Promise<Identifier> | null = null;

/** Tests: a scripted identifier; `null` restores the real one. */
export function setIdentifier(next: Identifier | null): void {
	identifier = next;
	loading = null;
}

export function loadIdentifier(): Promise<Identifier> {
	if (identifier) {
		return Promise.resolve(identifier);
	}

	if (!loading) {
		loading = import("./lid.real")
			.then((module) => module.makeIdentifier())
			.then((made) => {
				identifier = made;
				return made;
			})
			.catch((error) => {
				loading = null;
				throw error;
			});
	}

	return loading;
}

/**
 * `declared` is the channel's own languages (channelStore.ts `languages`);
 * `options.exclude` is the language the reader already reads. The writer
 * passes neither: a draft is the user's own language, not a channel
 * matter. The channel's prior learns from a placed line at least
 * `DETECT_MIN_LENGTH` long that is not the user's own (`learn: false`):
 * own lines say what the user writes, not what the channel does.
 */
export async function detectLanguage(
	text: string,
	prior: LanguagePrior | null,
	declared: string[] = [],
	options: {exclude?: string; learn?: boolean} = {}
): Promise<Detection> {
	const byScript = scriptLanguage(text);
	const result: Detection = byScript
		? {lang: byScript, confidence: 1, candidates: [byScript]}
		: decide(await (await loadIdentifier())(text), options.exclude, declared);

	if (
		options.learn !== false &&
		prior &&
		result.lang &&
		isSupported(result.lang) &&
		text.length >= DETECT_MIN_LENGTH
	) {
		prior.note(result.lang);
	}

	return result;
}
