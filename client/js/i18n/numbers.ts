// Vue-free number formatters, memoized per tag+options — the numbers side of
// the shape dates.ts established for dates. The active locale writes the
// digits and the separators: en "1,500" / de "1.500" / ar-EG "١٬٥٠٠"; the
// compact form for tight spots (unread badges) is the locale's own
// abbreviation — en "1.5K", de "15.000" and "1,5 Mio." (German has no "K"
// for thousands), ar "1.5 ألف".
//
// This directory is skipped by tools/i18n/check.ts's call-site scan: number
// PATTERNS are Intl's business, not the catalog's. Numeric {vars} inside
// translated frames interpolate through core.ts's own plain (grouping-off)
// formatter — this module is for standalone numbers a call site renders
// directly.

import {activeLocale} from "./core";

const groupedCache = new Map<string, Intl.NumberFormat>();
const compactCache = new Map<string, Intl.NumberFormat>();

function formatter(
	cache: Map<string, Intl.NumberFormat>,
	tag: string,
	options: Intl.NumberFormatOptions
): Intl.NumberFormat {
	const key = `${tag}\u0000${JSON.stringify(options)}`;
	let fmt = cache.get(key);

	if (!fmt) {
		fmt = new Intl.NumberFormat(tag, options);
		cache.set(key, fmt);
	}

	return fmt;
}

/** A number in the active locale's digits, separators and grouping
 * ("1,500" / "1.500" / "١٬٥٠٠"). */
export function formatNumber(n: number): string {
	const tag = activeLocale();
	return formatter(groupedCache, tag, {}).format(n);
}

/** Compact notation — "1.5K" (en), "15.000" (de), "١٫٥ ألف" (ar-EG) — for
 * tight spots like the unread badge. The locale owns both the abbreviation
 * and the threshold: German starts abbreviating at 10,000, not 1,000, so a
 * de badge may read 1500 where the en one reads 1.5K. */
export function formatCompact(n: number): string {
	const tag = activeLocale();
	return formatter(compactCache, tag, {notation: "compact"}).format(n);
}
