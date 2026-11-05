// The gettext plural-rules table (plural-rules.json) plus the small pieces
// of Plural-Forms parsing that compile.ts and merge.ts share. A new language
// adds one line to the table (documented in docs/resources/i18n.md); its
// expression is gettext's C plural form, restricted to what compile.ts's
// pluralEval allows.
import pluralRulesJson from "./plural-rules.json";

/** One language's gettext plural rule. */
export interface PluralRule {
	/** How many msgstr[N] slots a plural entry carries. */
	nplurals: number;
	/** gettext's C plural expression over `n`, e.g. "n != 1". */
	expr: string;
}

export const PLURAL_RULES = pluralRulesJson as Record<string, PluralRule>;

/** Parse a `Plural-Forms` header value into a rule; undefined when malformed. */
export function parsePluralForms(header: string): PluralRule | undefined {
	const nplurals = /nplurals\s*=\s*(\d+)/.exec(header);
	const expr = /plural\s*=\s*([^;]+)/.exec(header);

	if (!nplurals || !expr) {
		return undefined;
	}

	return {nplurals: Number(nplurals[1]), expr: expr[1].trim()};
}

/** Render a rule as the standard `Plural-Forms` header value. */
export function formatPluralForms(rule: PluralRule): string {
	return `nplurals=${rule.nplurals}; plural=(${rule.expr});`;
}

/** Evaluate gettext's C plural expression for `n`; the result indexes msgstr[N]. */
export function pluralEval(expr: string, n: number): number {
	if (!/^[n0-9 ():!=<>+\-*/%&|?:]+$/.test(expr)) {
		throw new Error(`unsafe plural expression: ${expr}`);
	}

	// gettext's C expressions yield 0/1; the JS forms of simple rules ("n != 1")
	// yield booleans, so coerce — the result indexes msgstr[N]. The regex
	// allowlist above is the only thing that reaches here.
	// eslint-disable-next-line @typescript-eslint/no-implied-eval
	return Number(Function("n", `"use strict"; return (${expr});`)(n));
}

const CLDR_CATEGORIES = ["zero", "one", "two", "few", "many", "other"] as const;

// How far the probe counts. Load-bearing, not arbitrary: it has to reach
// the first integer of every category a locale actually uses for chat
// counts (ar's "other" first appears at 100), and it has to STOP before
// the categories CLDR keeps for compact millions (pt/fr put 1e6 in
// "many"). A category the scan never sees is simply left out of the map,
// which is safe because core.ts's tCount falls back
// `entry[category] ?? entry.other`.
const PROBE_LIMIT = 199;

/**
 * CLDR category -> gettext msgstr index, mapped by the counts CLDR samples
 * each category with: "zero" at n = 0, "one" at n = 1, "two" at n = 2 and
 * "few"/"many"/"other" at the smallest n >= 2 that CLDR puts in them. The
 * naive reading — the first n from 0 that the gettext expression sends to a
 * slot — disagrees with CLDR wherever the two systems draw the line
 * differently (CLDR counts pt's 0 as "one" while `n != 1` sends it to the
 * plural slot; tr's `(n > 1)` is 0 at n = 0, which CLDR calls "other"), and
 * the runtime asks Intl.PluralRules, so CLDR's reading is the one that
 * matters.
 */
export function categoryIndexMap(tag: string, expr: string): Record<string, number> {
	const rules = new Intl.PluralRules(tag);
	const probed: Record<string, number> = {};

	const sample = (category: string, n: number) => {
		if (!(category in probed) && rules.select(n) === category) {
			probed[category] = pluralEval(expr, n);
		}
	};

	sample("zero", 0);
	sample("one", 1);
	sample("two", 2);

	for (let n = 2; n <= PROBE_LIMIT; n++) {
		const category = rules.select(n);

		if (category === "few" || category === "many" || category === "other") {
			sample(category, n);
		}
	}

	// Every locale has an "other", but in the Slavic rules it is the
	// fractions' category and no integer ever lands in it. gettext has no
	// such slot either: its catch-all branch — the highest index the
	// expression yields — is what those counts read, so "other" takes it.
	if (!("other" in probed)) {
		let catchAll = 0;

		for (let n = 0; n <= PROBE_LIMIT; n++) {
			catchAll = Math.max(catchAll, pluralEval(expr, n));
		}

		probed.other = catchAll;
	}

	// Emit in CLDR's canonical order so the compiled JSON reads stably.
	const map: Record<string, number> = {};

	for (const category of CLDR_CATEGORIES) {
		if (category in probed) {
			map[category] = probed[category];
		}
	}

	return map;
}

/** One gettext slot of a plural entry and which source text fills it. */
export interface PluralSlot {
	/** The msgstr[N] index. */
	index: number;
	/** Which of the entry's two English forms this slot translates. */
	source: "msgid" | "msgidPlural";
}

/**
 * The integer counts (0..PROBE_LIMIT) the runtime serves from msgstr[index]:
 * tCount asks Intl.PluralRules for the category and reads the slot
 * categoryIndexMap gives it, falling back to "other" for a category the map
 * left out. This, not the gettext expression, is what decides which counts
 * read a slot -- the two disagree for fil (CLDR's "one" covers 0-3, 5, 7, 8,
 * 10, … while `n != 1` says 1 alone), for ru/uk (21, 31, …) and for fr/pt (0).
 */
export function countsReadingSlot(tag: string, expr: string, index: number): number[] {
	const rules = new Intl.PluralRules(tag);
	const map = categoryIndexMap(tag, expr);
	const counts: number[] = [];

	for (let n = 0; n <= PROBE_LIMIT; n++) {
		if ((map[rules.select(n)] ?? map.other) === index) {
			counts.push(n);
		}
	}

	return counts;
}

/** True when CLDR puts some integer other than 1 into `category` for `tag`
 * -- a form compiled into it cannot say "once" or drop its {count}. */
export function categoryReadsOtherCounts(tag: string, category: string): boolean {
	const rules = new Intl.PluralRules(tag);

	for (let n = 0; n <= PROBE_LIMIT; n++) {
		if (n !== 1 && rules.select(n) === category) {
			return true;
		}
	}

	return false;
}

/**
 * Every gettext slot of a plural entry, with the source text each one
 * translates. Only a slot that n = 1 ALONE reads is the singular (msgid);
 * every other slot is the plural (msgid_plural), the form that carries
 * {count}. With `tag`, "reads" is the runtime's CLDR reading
 * (countsReadingSlot): fil's "one" slot also serves 0, 2, 3, 5, …, ru's 21
 * and 31, fr's and pt's 0, so those slots translate the plural text --
 * filling them from "marked away once" showed "once" for five. Without a tag
 * (synthetic rules in the tests), the gettext expression decides alone. A
 * one-form language (ja, zh, ko, th, vi) has no singular at all. Complete
 * and independent of what is already filled -- the caller decides which
 * slots it still needs.
 */
export function planPluralSlots(
	entry: {msgid: string; msgidPlural?: string},
	nplurals: number,
	expr: string,
	tag?: string
): PluralSlot[] {
	if (entry.msgidPlural === undefined) {
		return [];
	}

	// Only a language that HAS a singular gets one: with one form there is
	// nothing to contrast it with, and the count shows every time.
	let singular = nplurals > 1 ? pluralEval(expr, 1) : -1;

	if (singular !== -1 && tag !== undefined) {
		const counts = countsReadingSlot(tag, expr, singular);

		if (counts.some((n) => n !== 1)) {
			singular = -1;
		}
	}

	return Array.from({length: nplurals}, (_, index) => ({
		index,
		source: index === singular ? ("msgid" as const) : ("msgidPlural" as const),
	}));
}
