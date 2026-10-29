/* eslint-disable no-console */
// npx tsx tools/i18n/compile.ts [--pseudo]
//
// Compiles the catalogs the runtime loads: client/locales/messages.pot
// becomes en.json (the msgids ARE the English copy), every
// client/locales/<tag>.po becomes <tag>.json, and the qqx pseudo-RTL locale
// is generated from en on every run (Task 10's direction/length/plural test
// rig). Also regenerates client/js/i18n/available.ts and
// client/locales/tags.json, so the build never ships a stale catalog —
// package.json runs this before webpack.
//
// Fuzzy entries are skipped with a stderr warning (the runtime falls back to
// en per key); a translation that lost a {placeholder} the msgid has fails
// the run with the key named. [--pseudo] is accepted for CLI compatibility;
// there is no flag gating — qqx generation is unconditional.
//
// Before compiling, main() runs runSync() (tools/i18n/sync.ts), so the
// build itself tracks the language list: .po files for new targets are
// scaffolded and strays are moved into attic/ (a subdirectory, invisible
// to the compile's non-recursive listing).

import {mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {basename, dirname, resolve} from "node:path";
import {parsePo, PoEntry} from "./po";
import {
	categoryIndexMap,
	categoryReadsOtherCounts,
	PLURAL_RULES,
	parsePluralForms,
	PluralRule,
} from "./plural";

// Re-exported: the toolchain test (and anything older) imports it from here.
export {categoryIndexMap};
import {pseudo} from "./pseudo";
import {AVAILABLE_PATH, LOCALES_DIR} from "./paths";
import {DEV_ONLY_TAGS} from "./available-locales";
import {generateTargets} from "./targets";
import {collectStaticCallSiteKeys} from "./check";
import {runSync} from "./sync";

/** What the runtime loads: strings, plurals keyed by CLDR category. */
export type Catalog = Record<string, string | Record<string, string>>;

/** One entry of the generated locale list. */
export interface AvailableLocale {
	tag: string;
	devOnly?: boolean;
}

export interface CompileOptions {
	/** Directory holding messages.pot and <tag>.po files. Default client/locales. */
	localesDir?: string;
	/** Where the compiled <tag>.json catalogs are written. Default localesDir. */
	outDir?: string;
	/** Where available.ts is written. Default client/js/i18n/available.ts. */
	availablePath?: string;
	/** Where tags.json is written. Default <localesDir>/tags.json. */
	tagsPath?: string;
}

export interface CompileResult {
	/** Locale tags in generated order: en, the locales, qqx. */
	tags: string[];
	/** tag → catalog, for every file written: en, qqx and each locale. */
	catalogs: Record<string, Catalog>;
	/** The fuzzy-skip warnings (also printed on stderr). */
	warnings: string[];
	/** Catalog files removed from outDir: tags that are no longer targets. */
	pruned: string[];
}

/** A text's {name} tokens, sorted: what two texts must agree on. */
const tokens = (text: string): string => (text.match(/\{(\w+)\}/g) ?? []).sort().join(",");

/** {name} tokens must survive translation — an MT row that ate one is broken. */
function assertPlaceholders(entry: PoEntry): void {
	// A plural entry's forms may legitimately follow either source: the
	// singular can carry fewer tokens ("once" vs "{count} times"), so a
	// form matches when it agrees with the singular or the plural source.
	const sources = [entry.msgid, entry.msgidPlural].filter(Boolean) as string[];

	for (const text of entry.msgstr) {
		if (text && !sources.some((source) => tokens(text) === tokens(source))) {
			throw new Error(
				`compile: ${entry.msgctxt}: placeholder mismatch\n  source: ${sources
					.map(tokens)
					.join(" | ")}\n  translation: ${tokens(text)}`
			);
		}
	}
}

/** Entry → compiled value. Untranslated entries compile to "" — no invention. */
function compileEntry(
	entry: PoEntry,
	map: Record<string, number>
): string | Record<string, string> {
	if (entry.msgidPlural !== undefined) {
		const forms: Record<string, string> = {};

		for (const [category, index] of Object.entries(map)) {
			const text = entry.msgstr[index];

			// A half-filled plural used to compile to whatever categories it
			// had, and tCount then served the singular for every count. All
			// or nothing: an incomplete entry is dropped and en serves the
			// whole key.
			if (!text) {
				return {};
			}

			forms[category] = text;
		}

		return forms;
	}

	return entry.msgstr[0] ?? "";
}

/** A compiled value with nothing in it: an untranslated singular or plural. */
function isEmptyValue(value: string | Record<string, string>): boolean {
	return value === "" || Object.keys(value).length === 0;
}

/** en.json from the pot: msgid/msgid_plural with a fixed en mapping. */
function enCatalogFromPot(entries: PoEntry[]): Catalog {
	const catalog: Catalog = {};

	for (const entry of entries) {
		if (!entry.msgctxt) {
			continue;
		}

		// English's Plural-Forms (n != 1) puts gettext index 0 in CLDR "one"
		// and index 1 in "other", so a fixed mapping is correct for en alone.
		catalog[entry.msgctxt] =
			entry.msgidPlural === undefined
				? entry.msgid
				: {one: entry.msgid, other: entry.msgidPlural};
	}

	return catalog;
}

/** qqx from en: pseudo-translated, one text in every plural category. */
function pseudoCatalogFromEn(en: Catalog): Catalog {
	const catalog: Catalog = {};

	for (const [key, value] of Object.entries(en)) {
		// Empty en values (an intentional empty copy) have nothing to
		// pseudo-translate: leave the key out so en serves it at runtime.
		if (isEmptyValue(value)) {
			continue;
		}

		if (typeof value === "string") {
			catalog[key] = pseudo(value);
			continue;
		}

		// The plural plumbing (category lookup, fallback) is what the rig
		// exercises, so every category carries the same doubled text.
		const same = pseudo(value.one ?? Object.values(value)[0] ?? "");
		const forms: Record<string, string> = {};

		for (const category of Object.keys(value)) {
			forms[category] = same;
		}

		catalog[key] = forms;
	}

	return catalog;
}

function renderAvailable(available: AvailableLocale[]): string {
	// Nothing here is baked from NODE_ENV: the generated files are tracked,
	// and `yarn watch`, `yarn test:e2e` and a bare `webpack` skip the compile
	// altogether — whichever mode wrote them last would be the one those
	// builds shipped, and a production build would dirty the tree. The
	// dev-only entries are listed like any other and filtered at runtime by
	// the bundler's own NODE_ENV fold (client/js/i18n/core.ts `DEV_I18N`).
	return (
		"// Generated by tools/i18n/compile.ts — do not edit.\n" +
		`export const AVAILABLE = ${JSON.stringify(available, null, "\t")} as const;\n` +
		'export type AvailableLocale = (typeof AVAILABLE)[number]["tag"];\n'
	);
}

export function compileLocales(options: CompileOptions = {}): CompileResult {
	const localesDir = resolve(options.localesDir ?? LOCALES_DIR);
	const outDir = resolve(options.outDir ?? localesDir);
	const availablePath = resolve(options.availablePath ?? AVAILABLE_PATH);
	const tagsPath = resolve(options.tagsPath ?? resolve(localesDir, "tags.json"));
	const warnings: string[] = [];
	const catalogs: Record<string, Catalog> = {};

	// en from the pot — the msgids ARE the English copy.
	const pot = parsePo(readFileSync(resolve(localesDir, "messages.pot"), "utf8"));
	catalogs.en = enCatalogFromPot(pot.entries);

	// qqx from en: the pseudo-RTL rig, generated on every run (Task 10).
	catalogs.qqx = pseudoCatalogFromEn(catalogs.en);

	const poFiles = readdirSync(localesDir)
		.filter((file) => file.endsWith(".po"))
		.sort();
	const localeTags: string[] = [];

	for (const file of poFiles) {
		const tag = file.slice(0, -".po".length);

		// en and qqx are produced from the pot itself — a hand-written file
		// for either tag would be overwritten or listed twice.
		if (tag === "qqx" || tag === "en") {
			throw new Error(
				`compile: ${tag} is compiled from the pot — there is no hand-written ${tag}.po`
			);
		}

		const {headers, entries} = parsePo(readFileSync(resolve(localesDir, file), "utf8"));
		const rule = PLURAL_RULES[tag] ?? parsePluralForms(headers["plural-forms"] ?? "");

		if (!rule) {
			throw new Error(
				`compile: no plural rule for ${tag} — add it to tools/i18n/plural-rules.json`
			);
		}

		const catalog: Catalog = {};
		// A per-locale fact, not a per-entry one.
		const categories = categoryIndexMap(tag, rule.expr);
		const wideCategories = Object.keys(categories).filter((category) =>
			categoryReadsOtherCounts(tag, category)
		);

		for (const entry of entries) {
			if (entry.flags.includes("fuzzy")) {
				// gettext convention: a fuzzy entry is not trusted; the runtime
				// falls back to en for its key.
				const warning = `compile: skipping fuzzy ${entry.msgctxt}`;
				warnings.push(warning);
				console.warn(warning);
				continue;
			}

			assertPlaceholders(entry);
			const value = compileEntry(entry, categories);

			// A form CLDR also serves for counts other than 1 (fil's "one" at
			// 5, ru's at 21, fr's and pt's at 0) has to be the plural text:
			// "marked away once" compiled there read "once" for five. Dropped
			// like a fuzzy entry, so en serves the key until the slot is
			// refilled from msgid_plural (plural.ts planPluralSlots).
			const countless =
				typeof value === "object" &&
				entry.msgidPlural !== undefined &&
				wideCategories.find(
					(category) =>
						category in value &&
						tokens(value[category]) !== tokens(entry.msgidPlural as string)
				);

			if (countless) {
				const warning = `compile: skipping ${
					entry.msgctxt
				}: its "${countless}" form serves counts other than 1 and lacks ${tokens(
					entry.msgidPlural as string
				)}`;
				warnings.push(warning);
				console.warn(warning);
				continue;
			}

			// The runtime falls back to en on key ABSENCE, so an entry with
			// nothing compiled must be left out — a present "" (or an empty
			// plural object) would shadow en. en.json itself keeps every pot
			// msgid verbatim, including the intentional empty copies.
			if (!isEmptyValue(value)) {
				catalog[entry.msgctxt] = value;
			}
		}

		catalogs[tag] = catalog;
		localeTags.push(tag);
	}

	// qqx exists for development only, and is listed as such: the runtime
	// filters it out of a production build (core.ts `DEV_I18N`), so nothing
	// here depends on the mode this run happens to have.
	const available: AvailableLocale[] = [
		{tag: "en"},
		...localeTags.map((tag) => ({tag})),
		...DEV_ONLY_TAGS.map((tag) => ({tag, devOnly: true} as AvailableLocale)),
	];
	// The pre-paint script's list (webpack bakes it into js/prepaint.js) carries
	// the dev-only tags too, so a stored qqx pick gets its lang/dir from the
	// first paint like any other; webpack.config.ts drops them for a
	// production build, which is the one consumer that cannot check at
	// runtime.
	const tags = available.map((entry) => entry.tag);

	mkdirSync(outDir, {recursive: true});

	for (const [tag, catalog] of Object.entries(catalogs)) {
		writeFileSync(resolve(outDir, `${tag}.json`), JSON.stringify(catalog, null, 2) + "\n");
	}

	// A catalog whose tag is no longer a target has to go: sync.ts archives
	// the .po, but the compiled .json would stay behind and the build copies
	// whatever it finds into public/. The generated tag list is not a
	// catalog, so it is spared by name.
	const kept = new Set([
		...Object.keys(catalogs).map((tag) => `${tag}.json`),
		basename(tagsPath),
	]);
	const pruned: string[] = [];

	for (const file of readdirSync(outDir)) {
		if (file.endsWith(".json") && !kept.has(file)) {
			rmSync(resolve(outDir, file));
			pruned.push(file);
		}
	}

	mkdirSync(dirname(availablePath), {recursive: true});
	writeFileSync(availablePath, renderAvailable(available));
	mkdirSync(dirname(tagsPath), {recursive: true});
	// Bare list for the pre-paint script; webpack.config.ts substitutes it
	// into client/js/prepaint.js as it copies it (Task 3). Both
	// generated files are excluded from prettier — the generator owns their
	// formatting — so regeneration is byte-stable.
	writeFileSync(tagsPath, JSON.stringify(tags, null, "\t") + "\n");

	return {tags, catalogs, warnings, pruned};
}

function main(): void {
	// --pseudo is accepted for compatibility with the plan's CLI shape; qqx is
	// generated on every run, so there is nothing to switch on.
	const args = process.argv.slice(2).filter((arg) => arg !== "--pseudo");

	if (args.length > 0) {
		console.error(`compile: unknown argument ${args[0]}`);
		process.exitCode = 1;
		return;
	}

	// Track the language list immediately before compileLocales() lists the
	// directory: scaffold what the targets gained, archive what they lost.
	runSync();
	const result = compileLocales();
	const targets = generateTargets();

	// The runtime's dynamic-key truth: every key written as a static
	// literal call site (client/js/i18n/call-sites.ts, committed like the
	// catalogs, so staleness is a visible diff). core.ts warns for any key
	// OUTSIDE this set — an assembled key translates unpredictably even
	// when it happens to resolve.
	const callSites = [...collectStaticCallSiteKeys("client")].sort();
	writeFileSync(
		resolve("client/js/i18n/call-sites.ts"),
		"// Generated by tools/i18n/compile.ts — do not edit.\n" +
			"// The keys that appear as static literal call sites (t/tCount/brandingT)\n" +
			"// anywhere in client/, service worker included. The runtime's\n" +
			"// dynamic-key warning (core.ts) fires for any key OUTSIDE this set:\n" +
			"// a key assembled at runtime translates unpredictably, even when it\n" +
			"// happens to resolve.\n" +
			"export const STATIC_CALL_SITES = new Set<string>([\n" +
			callSites.map((key) => `\t${JSON.stringify(key)},`).join("\n") +
			"\n]);\n"
	);

	const locales = result.tags.filter((tag) => tag !== "en" && tag !== "qqx");
	console.log(
		`compile: en.json, qqx.json, ${locales.length} locale catalog(s), available.ts, tags.json, ${targets.length} target language(s), ${callSites.length} static call-site key(s)` +
			(result.warnings.length > 0
				? ` — ${result.warnings.length} skipped (fuzzy or a count-less plural form)`
				: "") +
			(result.pruned.length > 0 ? ` — pruned ${result.pruned.join(", ")}` : "")
	);
}

if (require.main === module) {
	main();
}
