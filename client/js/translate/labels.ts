// The direction a translated line's chip names (TranslationLine.vue). Vue-free
// so mocha can pin it.

/** Contenders named when the source was not placed: more reads as noise. */
export const GUESS_NAMES = 2;

/**
 * "French → English" when the line's source is known. When the detector could
 * not place it (`from` is "", the engine was left to find the source), the
 * contenders it ranked stand in for it -- "Norwegian / Danish → English", or
 * "French? → English" for a single one -- rather than a bare "→ English"
 * that reads as a label with a word missing. The target is never a contender
 * (a line in the reading language would not have been translated), and no
 * contender at all is "? → English", the mark a skipped line uses. Only
 * language names and symbols: every word is in the reader's language.
 */
export function directionText(
	from: string,
	to: string,
	candidates: readonly string[],
	nameOf: (code: string) => string
): string {
	const target = nameOf(to);

	if (from) {
		return `${nameOf(from)} → ${target}`;
	}

	const guesses = candidates.filter((code) => code !== to).slice(0, GUESS_NAMES);

	if (guesses.length === 0) {
		return `? → ${target}`;
	}

	if (guesses.length === 1) {
		return `${nameOf(guesses[0])}? → ${target}`;
	}

	return `${guesses.map(nameOf).join(" / ")} → ${target}`;
}
