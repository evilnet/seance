// Function-word classification for chat-length text (spec
// docs/projects/translation-quality-and-ux.md §3.1). franc's trigram model
// misplaces short lines confidently ("I just woke up again." → Dutch 1.0);
// the function words of a language are near-perfect on chat text and
// misspelling-tolerant. Vue-free; the table is generated
// (tools/generate-stopwords.py) and committed.

import table from "./stopwords.json";

/** Languages whose words run without spaces: match by containment. */
const NO_SPACE = new Set(["ja", "zh", "ko"]);

export interface ChatVerdict {
	lang: string | null;
	/** Function-word hits behind the verdict (0 when null). */
	strength: number;
}

const TABLES: Record<string, Set<string>> = Object.fromEntries(
	Object.entries(table).map(([tag, words]) => [tag, new Set(words)])
);

/** The words of a line: the lookup (wordlookup.ts) counts the same ones. */
export function tokens(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((word) => word !== "");
}

export function chatDetect(text: string, only: readonly string[]): ChatVerdict {
	const allowed = only.filter((lang) => TABLES[lang]);
	const lower = text.toLowerCase();
	const words = tokens(text);
	const scores = new Map<string, number>();

	for (const lang of allowed) {
		const table_ = TABLES[lang];
		let hits = 0;

		if (NO_SPACE.has(lang)) {
			for (const word of table_) {
				if (word.length >= 1 && lower.includes(word)) {
					hits += 1;
				}
			}
		} else {
			for (const word of words) {
				if (table_.has(word)) {
					hits += 1;
				}
			}
		}

		if (hits > 0) {
			scores.set(lang, hits);
		}
	}

	const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
	const best = ranked[0];
	const second = ranked[1];

	if (!best) {
		return {lang: null, strength: 0};
	}

	// Decisive: a clear multi-hit lead, or a hit on a line too short for two
	// ("lol" is English, one function word decides a 3-word line; a stray
	// shared word on a longer line is not).
	const decisive =
		best[1] >= 2 && (!second || best[1] - second[1] >= 1)
			? true
			: words.length <= 3 && best[1] >= 1;

	return decisive ? {lang: best[0], strength: best[1]} : {lang: null, strength: best[1]};
}
