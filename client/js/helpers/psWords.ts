// How the ps theme draws the words of the message column over the plains
// (Settings → Appearance → Words over the plains, shown while ps is the
// theme; docs/projects/ps-words.md). Six treatments in two families: on a
// surface (a card per row, the whole column on glass, a graded scrim), where
// the words are plain and the surface holds the legibility floor; or with a
// shadow (today's outline, a rim tinted from the sky, a soft glow), where the
// words carry a text-shadow. The value is applied as a `data-ps-words`
// attribute on <html> (settings.ts) and ps.css reads it; a missing attribute
// renders as Bubbles, the default. Vue-free: test/helpers/psWords.ts.

export const psWords = ["bubbles", "glass", "scrim", "outline", "rim", "glow"] as const;

export type PsWords = (typeof psWords)[number];

export const defaultPsWords: PsWords = "bubbles";

/** The words plain on a surface. */
export const SURFACE_WORDS: readonly PsWords[] = ["bubbles", "glass", "scrim"];

/** The words carrying a text-shadow over the open plains. */
export const SHADOW_WORDS: readonly PsWords[] = ["outline", "rim", "glow"];

export const psWordsLabels: Record<PsWords, string> = {
	bubbles: "Bubbles",
	glass: "Glass",
	scrim: "Scrim",
	outline: "Outline",
	rim: "Tinted rim",
	glow: "Soft glow",
};

export const psWordsHints: Record<PsWords, string> = {
	bubbles: "each message on a translucent card: paper by day, dark at night",
	glass: "the whole column on frosted glass, the plains a wash behind it",
	scrim: "a soft wash across the column, stronger near the edge, no blur",
	outline: "white words in a dark outline; ink on snowy days",
	rim: "a thinner rim in the sky's own colour; by day it reads under the usual floor",
	glow: "a soft dark glow and nothing else; by day it reads well under the usual floor",
};

/** A stored setting can be anything (a stale key, hand-edited localStorage); anything that is not one of the six means the default. */
export function normalizePsWords(value: unknown): PsWords {
	return psWords.includes(value as PsWords) ? (value as PsWords) : defaultPsWords;
}
