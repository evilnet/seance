// How much of an English line survives a round trip: the share of its
// content words that the back-translation carries. A crude judge — it
// cannot see a paraphrase — but it never sleeps, and a low score is the
// list of cases a person then reads. Used by tools/translate-llm.ts
// --round-trip; tested by hand through that.

const STOP = new Set([
	"the",
	"and",
	"but",
	"for",
	"nor",
	"yet",
	"you",
	"your",
	"our",
	"its",
	"his",
	"her",
	"they",
	"them",
	"this",
	"that",
	"these",
	"those",
	"with",
	"from",
	"into",
	"onto",
	"are",
	"was",
	"were",
	"been",
	"have",
	"has",
	"had",
	"not",
	"can",
	"could",
	"should",
	"would",
	"will",
	"just",
	"than",
	"then",
	"there",
	"here",
	"what",
	"when",
	"where",
	"who",
	"how",
	"did",
	"does",
	"still",
	"also",
	"any",
	"some",
	"one",
	"all",
	"before",
	"after",
	"again",
	"more",
	"most",
	"very",
	"too",
	"off",
	"out",
	"over",
	"please",
	"let",
	"get",
	"got",
]);

/** The comparable words of a line: lower-cased, punctuation off, short and function words out. */
export function contentWords(text: string): string[] {
	const words = text
		.toLowerCase()
		.replace(/[`*_~|"'“”‘’«»]/g, " ")
		.split(/[\s,.;:!?()[\]{}]+/)
		.filter((w) => w.length >= 3 && !STOP.has(w));

	return [...new Set(words)];
}

export interface Overlap {
	/** Content words of the original found in the back-translation. */
	found: number;
	/** Content words of the original. */
	total: number;
	/** The ones that did not come back — what a person reads first. */
	missing: string[];
}

/**
 * Words are matched loosely — a shared 5-character stem counts — so
 * "merged"/"merge", "timestamps"/"timestamp" and "deploy"/"deployment" pass,
 * which is what a translation and its return do to inflection.
 */
export function contentOverlap(original: string, back: string): Overlap {
	const wanted = contentWords(original);
	const have = contentWords(back);
	const stems = new Set(have.map((w) => w.slice(0, 5)));
	const missing = wanted.filter((w) => !have.includes(w) && !stems.has(w.slice(0, 5)));

	return {found: wanted.length - missing.length, total: wanted.length, missing};
}
