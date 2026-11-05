/**
 * Colour autocompletion (`autocompletion.ts`, `^C` and `^C<fg>,`): which of
 * the sixteen mIRC colours a typed term names.
 *
 * Three ways in, in this order: the wire code (`^C0` → `00`…`09`, the reason
 * this is not a plain name search), the name as the reader sees it, and the
 * English name in `constants.ts`, which stays the wire truth and matches in
 * every locale — a result found that way is still shown localized.
 *
 * Vue-free and store-free on purpose: `autocompletion.ts` imports both.
 */

import fuzzy from "fuzzy";

/** `[code, display]` pairs, the display possibly carrying `<b>` highlights. */
export function matchColorCodes(
	term: string,
	entries: ReadonlyArray<readonly [string, string]>,
	localize: (code: string, en: string) => string
): string[][] {
	const needle = term.toLowerCase();
	const matches: string[][] = [];

	for (const [code, en] of entries) {
		const localized = localize(code, en);

		// A code is matched by its first digits, not fuzzily: `0` means the
		// ten codes that start with it, never `10`.
		if (needle.length > 0 && code.startsWith(needle)) {
			matches.push([code, localized]);
			continue;
		}

		// `fuzzy` is case-insensitive by default and renders the string it
		// was given, so the display keeps its own capitalization.
		if (fuzzy.test(needle, localized)) {
			matches.push([
				code,
				fuzzy.match(needle, localized, {pre: "<b>", post: "</b>"})?.rendered ?? localized,
			]);
			continue;
		}

		if (fuzzy.test(needle, en)) {
			matches.push([code, localized]); // matched the English name, shown localized
		}
	}

	return matches;
}
