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

export type PsWords = typeof psWords[number];

export const defaultPsWords: PsWords = "bubbles";

/** The words plain on a surface. */
export const SURFACE_WORDS: readonly PsWords[] = ["bubbles", "glass", "scrim"];

/** The words carrying a text-shadow over the open plains. */
export const SHADOW_WORDS: readonly PsWords[] = ["outline", "rim", "glow"];

// The labels and hints are the pot's (settings.appearance.psWords<Value> and …Hint), read with t() in Appearance.vue.

/** A stored setting can be anything (a stale key, hand-edited localStorage); anything that is not one of the six means the default. */
export function normalizePsWords(value: unknown): PsWords {
	return psWords.includes(value as PsWords) ? (value as PsWords) : defaultPsWords;
}
