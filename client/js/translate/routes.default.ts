// The shipped route tables, one per GPU model, placed by measurement: the
// share of an English line's content words that came back after a round
// trip through each engine (tools/translate-eval/results/2026-09-12-languages.md,
// with Qwen3-1.7B re-scored on the web build's own 4-bit weights in
// 2026-09-13-web-weights.md). Small samples, so a difference under ~10 points
// is a tie. Each language is placed in both directions, since the
// measurement is a round trip.
//
// - NLLB first, the LLM as a fallback class, where NLLB came back ahead by
//   more than the tie band.
// - The LLM and NLLB in one class where they tie: a downloaded NLLB is
//   preferred, the LLM otherwise (router.ts).
// - The OPUS-MT pairs: first, whatever the measurement, as the cheapest
//   engine that can take the line (a pair is ~100 MB and a line takes
//   under a second on the CPU, where the LLM is a 1-2 GB download and a
//   GPU). Least to most resource-intensive: the system translator (Apple's,
//   service.ts, ahead of any table), then a pair, then the LLM. The LLM
//   measured ahead of OPUS-MT for fr, es and it, and tied for de, nl and ru
//   (`opusTied`, which still records that and steers tools/i18n/fill.ts);
//   that is no longer worth a 2 GB question in a chat client. Once the
//   LLM is on the device anyway, the languages it measured ahead in
//   (`llmAhead`) take it first (router.ts `llmFirstIfCached`), and Settings
//   → Advanced's "Prefer" puts it first everywhere (`translatePrefer`).
// - Every other language: the LLM first, NLLB next.
//
// A larger GPU model moves the line between "NLLB is better" and "the LLM
// is", so each model has its own lists: re-placing a language for one model
// is an edit of that model's lists, never of the code that builds a table.
// A model with no lists of its own (a deploy's) gets 1.7B's.

import {Candidate, DEFAULT_OPUS_PAIRS, QWEN3_1_7B_ID, QWEN3_4B_ID} from "./models";
import {RouteEntry, RouteTable} from "./router";

/** Where one GPU model's measurement placed the languages. */
export interface RoutePlacement {
	/** NLLB came back ahead of the LLM by more than the tie band. */
	nllbFirst: readonly string[];
	/** The LLM and NLLB within the tie band: one class. */
	nllbTied: readonly string[];
	/**
	 * OPUS-MT pair languages whose pairs tied with or beat the LLM. A record
	 * of the measurement (and tools/i18n/fill.ts's engine choice): the app's
	 * tables put every pair first, tied or not (`opusEntry`).
	 */
	opusTied: readonly string[];
	/**
	 * OPUS-MT pair languages where the LLM came back ahead of the pair by
	 * more than the tie band. The pair still routes first, since it is the
	 * cheaper download; once the LLM's copy is on the device, these take it
	 * first instead (`llmAheadOf`).
	 */
	llmAhead: readonly string[];
	/**
	 * Languages whose best measured engine brought back under 55% of a line's
	 * content words: translations into and out of them are often wrong
	 * whichever engine takes them, and the language pickers say so.
	 */
	limited: readonly string[];
}

// ---- Qwen3-1.7B (measured) ----

/** NLLB came back ahead of the LLM by more than the tie band. */
export const NLLB_FIRST: readonly string[] = [
	"sr",
	"hr",
	"sl",
	"el",
	"he",
	"fa",
	"bn",
	"ta",
	"eu",
	"cy",
	"sw",
	"af",
	"tl",
	"ur",
	"fi",
	"hu",
	"hi",
	// Not "ar", though NLLB measured ahead of the LLM (29 points on the web
	// weights): the LLM reads the channel's context (recent lines, names, the
	// reply target), which the seq2seq models ignore, and their edge on short
	// benchmark-like lines overstates them in chat. Arabic stays LLM-first.
];

/** The LLM and NLLB within the tie band: one class. */
export const NLLB_TIED: readonly string[] = ["sk", "ms", "gl", "th", "cs", "nb", "bg", "id"];

/** OPUS-MT pair languages whose pairs tie with or beat the LLM (a record; every pair routes first). */
export const OPUS_TIED: readonly string[] = ["de", "nl", "ru", "fr"];

/** OPUS-MT pair languages the LLM beat by more than the tie band (es 74/60, it 76/63). */
export const LLM_AHEAD: readonly string[] = ["es", "it"];

/** Under 55% of a line's content words back from the best engine (see `RoutePlacement`). */
export const LIMITED_LANGUAGES: readonly string[] = ["hi", "bn", "hu", "sk", "ko"];

export const QWEN3_1_7B: RoutePlacement = {
	nllbFirst: NLLB_FIRST,
	nllbTied: NLLB_TIED,
	opusTied: OPUS_TIED,
	llmAhead: LLM_AHEAD,
	limited: LIMITED_LANGUAGES,
};

// ---- Qwen3-4B (measured on its own 4-bit web weights, 2026-09-13-web-weights.md) ----
// 4B brings back far more than 1.7B on the long tail (56% against 36%), so
// NLLB leads by more than the tie band in fewer languages, and 4B leads
// outright in pl, cs, sk, hu, hi and th.

export const QWEN3_4B_NLLB_FIRST: readonly string[] = [
	"hr",
	"sl",
	"el",
	"he",
	"ta",
	"eu",
	"ga",
	"cy",
	"sw",
	"tl",
	"ur",
	// Not "ar" (4B 72%, NLLB 67%: a tie on these lines, and LLM-first by the
	// same ruling as 1.7B's list).
];

export const QWEN3_4B_NLLB_TIED: readonly string[] = [
	"nb",
	"fi",
	"bg",
	"sr",
	"fa",
	"bn",
	"id",
	"ms",
	"ca",
	"gl",
	"af",
];

export const QWEN3_4B_OPUS_TIED: readonly string[] = ["de", "nl", "ru"];

/** fr 76/63, es 84/60, it 79/63. */
export const QWEN3_4B_LLM_AHEAD: readonly string[] = ["fr", "es", "it"];

// Empty: the four languages 4B measured under 55% (et lv lt is) were under it
// for every engine, and are no longer offered (languages.ts).
export const QWEN3_4B_LIMITED_LANGUAGES: readonly string[] = [];

export const QWEN3_4B: RoutePlacement = {
	nllbFirst: QWEN3_4B_NLLB_FIRST,
	nllbTied: QWEN3_4B_NLLB_TIED,
	opusTied: QWEN3_4B_OPUS_TIED,
	llmAhead: QWEN3_4B_LLM_AHEAD,
	limited: QWEN3_4B_LIMITED_LANGUAGES,
};

const PLACEMENTS: Record<string, RoutePlacement> = {
	[QWEN3_1_7B_ID]: QWEN3_1_7B,
	[QWEN3_4B_ID]: QWEN3_4B,
};

/** The placements for a GPU model; any model without its own gets 1.7B's. */
export function placementFor(llmModelId: string | null | undefined): RoutePlacement {
	return (llmModelId && PLACEMENTS[llmModelId]) || QWEN3_1_7B;
}

export function limitedLanguagesFor(llmModelId: string | null | undefined): readonly string[] {
	return placementFor(llmModelId).limited;
}

/** Is `code` one of the limited languages of this GPU model (1.7B's when none is named)? */
export function isLimitedLanguage(
	code: string | null | undefined,
	llmModelId: string | null = QWEN3_1_7B_ID
): boolean {
	return !!code && limitedLanguagesFor(llmModelId).includes(code);
}

/**
 * Did this GPU model measure ahead of the shipped OPUS-MT pair for this
 * pair (`RoutePlacement.llmAhead`)? Only a shipped pair's languages count:
 * a pair with no OPUS-MT model already routes the LLM first, or NLLB by
 * measurement.
 */
export function llmAheadOf(
	llmModelId: string | null | undefined,
	from: string | null,
	to: string
): boolean {
	if (!from || !DEFAULT_OPUS_PAIRS[`${from}-${to}`]) {
		return false;
	}

	const ahead = placementFor(llmModelId).llmAhead;

	return ahead.includes(from) || ahead.includes(to);
}

/** The entry for a pair without an OPUS-MT model; `"*"` stands for any language. */
function entryFor(placement: RoutePlacement, from: string, to: string): RouteEntry {
	const sides = [from, to];

	if (sides.some((code) => placement.nllbFirst.includes(code))) {
		return ["nllb", "llm"];
	}

	if (sides.some((code) => placement.nllbTied.includes(code))) {
		return [["llm", "nllb"]];
	}

	return ["llm", "nllb"];
}

/** An OPUS-MT pair's entry: the pair first, the cheapest engine (see the header). */
function opusEntry(pairKey: string): RouteEntry {
	const candidate: Candidate = `opus:${pairKey}`;

	return [candidate, "llm", "nllb"];
}

/** A route table from one model's placements. */
export function buildRoutes(placement: RoutePlacement): RouteTable {
	const placed = [...placement.nllbFirst, ...placement.nllbTied];
	const table: RouteTable = {"*": {"*": ["llm", "nllb"]}};

	// A placed language as the source, into a target with no row of its own.
	for (const from of placed) {
		table["*"][from] = entryFor(placement, from, "*");
	}

	// A placed language as the target, from anything.
	for (const to of placed) {
		table[to] = {"*": entryFor(placement, "*", to)};
	}

	for (const pairKey of Object.keys(DEFAULT_OPUS_PAIRS)) {
		const [from, to] = pairKey.split("-");

		(table[to] ??= {})[from] = opusEntry(pairKey);
	}

	// Every target with a row gets a row for every placed source, so a
	// target's own wildcard never hides a weak source.
	for (const to of Object.keys(table)) {
		if (to === "*") {
			continue;
		}

		for (const from of placed) {
			if (from !== to && !table[to][from]) {
				table[to][from] = entryFor(placement, from, to);
			}
		}
	}

	return table;
}

const TABLES = new Map<RoutePlacement, RouteTable>();

/**
 * The shipped route table for a GPU model: 4B's for Qwen3-4B, 1.7B's for
 * Qwen3-1.7B and for any model without placements of its own. Built once
 * per placement; callers merge a deploy's overrides over a copy
 * (`mergeRoutes` copies), never into it.
 */
export function routesFor(llmModelId: string | null | undefined): RouteTable {
	const placement = placementFor(llmModelId);
	let table = TABLES.get(placement);

	if (!table) {
		table = buildRoutes(placement);
		TABLES.set(placement, table);
	}

	return table;
}

export const DEFAULT_ROUTES: RouteTable = routesFor(QWEN3_1_7B_ID);
