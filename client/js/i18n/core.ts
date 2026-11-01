/* eslint-disable no-console -- the dev-only diagnostics in warnOnce() are the
 * one sanctioned console.warn in the i18n runtime; production never reaches
 * it (see the block below). */
// Vue-free catalog resolution — mocha loads this file, so: no Vue, no DOM,
// no storage (test/helpers/i18n.ts). The Vue/activation side lives in
// index.ts; the settings wiring in settings.ts; the pre-paint copy of the
// RTL set in client/js/prepaint.js is pinned by test/helpers/i18n.ts.

import enCatalog from "../../locales/en.json";
import {isTraditionalChinese} from "./traditionalChinese";

export {isTraditionalChinese};

/** Sentinel var value for frame-splitting call sites: "this placeholder is
 * known — leave it in the template". Components that split a translated
 * frame on a placeholder (frameSegments) pass KEEP for each name, so the
 * interpolation neither substitutes nor warns, and the split finds the
 * placeholder intact. */
export const KEEP = Symbol("i18n-keep-placeholder");

export type Vars = Record<string, string | number | typeof KEEP>;
export type Catalog = Record<string, string | Record<string, string>>;

// en is the active catalog from the first import: the IRC layer resolves its
// status strings through t() before — and without — the Vue side's
// activate() runs, and under mocha it must resolve real English, not keys.
// setCatalog() replaces this with the chosen locale's overlay on activation.
let catalog: Catalog = enCatalog;
let tag = "en";

/** Tags whose writing systems flow right-to-left. The pre-paint script in
 * client/js/prepaint.js carries the same list — test/helpers/i18n.ts pins them
 * together. */
export const RTL_TAGS = new Set(["ar", "fa", "he", "ur", "ps", "sd", "ug", "yi", "qqx"]);

const rulesCache = new Map<string, Intl.PluralRules>();

function rulesFor(locale: string): Intl.PluralRules {
	let rules = rulesCache.get(locale);

	if (!rules) {
		rules = new Intl.PluralRules(locale);
		rulesCache.set(locale, rules);
	}

	return rules;
}

// --- dev-only diagnostics -------------------------------------------------
// A build-time scanner (tools/i18n/check.ts) verifies every static t() call
// site against the pot, so a key that goes missing at runtime is by
// construction a dynamically composed one — `t(\`mode.${m}\`)`, a name built
// from data — or a key a refactor left behind. Development builds warn once
// per key (per locale) on the console; production compiles the check away:
// webpack replaces process.env.NODE_ENV, the branch folds, nothing warns or
// throws. setWarnMissing() exists for tests, which run under NODE_ENV=test.

/** Number vars format through the active locale's digits and decimal
 * separator, grouping off — a `{port}` stays 6667, a `{count}` in de stays
 * 1500, Arabic-EG writes ٦٦٦٧. Call sites that want grouping use
 * numbers.ts's formatNumber(). */
const plainNumbers = new Map<string, Intl.NumberFormat>();

function plainNumber(locale: string): Intl.NumberFormat {
	let fmt = plainNumbers.get(locale);

	if (!fmt) {
		fmt = new Intl.NumberFormat(locale, {useGrouping: false});
		plainNumbers.set(locale, fmt);
	}

	return fmt;
}

const frameCache = new Map<string, string[]>();

/** Whether this build carries the i18n diagnostics — and the dev-only
 * locales (the qqx rig) with them. The bundler folds it: a production build
 * removes every branch below, and every branch its importers hang on it. */
export const DEV_I18N = process.env.NODE_ENV !== "production";
const warned = new Set<string>();

// The keys the active locale's overlay carries — the rest of the en keys
// are UNTRANSLATED in this locale, and development builds say so (see the
// coverage warning in t()/tCount()). en itself has no overlay: nothing is
// untranslated when en is the active locale. The base catalog is whatever
// setCatalog was given as en (the en.json import in the live tree; a
// fixture under test).
const overlayKeys = new Set<string>();
let baseCatalog: Catalog = enCatalog;

let warnEnabled = DEV_I18N;

/** Flip the missing-key/var/coverage warnings (tests; production never runs
 * them). */
export function setWarnMissing(on: boolean): void {
	warnEnabled = on;
}

/** What has been warned about so far (key or template+var ids). A browser
 * scenario sweeps the UI and asserts this stays empty. */
export function missingKeys(): readonly string[] {
	return [...warned];
}

function warnOnce(id: string, message: string): void {
	if (!DEV_I18N || !warnEnabled || warned.has(id)) {
		return;
	}

	warned.add(id);
	console.warn(`[seance i18n] ${message}`);
}

/** The active locale's keys that en has but the overlay does not — the
 * untranslated set. Intentionally-empty en copy (values with nothing in
 * them) is not "untranslated": there is no copy to translate. en active →
 * [] (en is the base catalog). */
export function untranslatedKeys(): string[] {
	if (tag === "en") {
		return [];
	}

	return Object.keys(baseCatalog).filter(
		(key) => !isEmptyEnValue(baseCatalog[key]) && !overlayKeys.has(key)
	);
}

/** True when the key resolves through en rather than the active locale's
 * overlay — the definition of untranslated (and never true for en). */
function isUntranslated(key: string): boolean {
	return tag !== "en" && !overlayKeys.has(key) && !isEmptyEnValue(baseCatalog[key]);
}

function isEmptyEnValue(value: string | Record<string, string> | undefined): boolean {
	return (
		value === "" ||
		(typeof value === "object" && value !== null && Object.keys(value).length === 0)
	);
}

/** Install the active catalog: en overlaid with the locale's entries. */
export function setCatalog(locale: string, en: Catalog, overlay: Catalog | undefined): void {
	tag = locale;
	baseCatalog = en;
	catalog = {...en, ...(overlay ?? {})};
	overlayKeys.clear();

	if (overlay) {
		for (const key of Object.keys(overlay)) {
			overlayKeys.add(key);
		}
	}

	warned.clear(); // a locale change re-derives what is worth warning about
	frameCache.clear();
}

export function activeLocale(): string {
	return tag;
}

export function isRTL(locale: string = tag): boolean {
	return RTL_TAGS.has(locale.split("-")[0]);
}

/** `{name}` interpolation; an unknown name stays visible for debugging (a
 * dev-only console.warn names it). A number var is written by the active
 * locale — digits, decimal separator, no grouping. */
export function interpolate(template: string, vars: Vars, label?: string): string {
	return template.replace(/\{(\w+)\}/g, (match, name: string) => {
		if (vars[name] === KEEP) {
			return match; // the caller splits on this placeholder itself
		}

		if (!Object.prototype.hasOwnProperty.call(vars, name)) {
			warnOnce(
				`${tag}\u0000var\u0000${label ?? template}\u0000${name}`,
				`unknown var {${name}} in ${
					label ? `"${label}"` : JSON.stringify(template)
				} (${tag}) — the placeholder stays visible`
			);
			return match;
		}

		const value = vars[name];
		return typeof value === "number" ? plainNumber(tag).format(value) : String(value);
	});
}

// Per-key census of a template's {placeholders} — the class-3 audit. The
// placeholder SHAPE is locale-independent (compile refuses a translation
// that loses one), so the cache survives setCatalog.
function frameVars(key: string): string[] {
	let names = frameCache.get(key);

	if (!names) {
		names = [];
		const entry = catalog[key];
		const texts = typeof entry === "string" ? [entry] : entry ? Object.values(entry) : [];

		for (const text of texts) {
			for (const m of String(text).matchAll(/\{(\w+)\}/g)) {
				if (!names.includes(m[1])) {
					names.push(m[1]);
				}
			}
		}

		frameCache.set(key, names);
	}

	return names;
}

/** The class-3 audit: a {var} frame's rendered text is assembled at
 * runtime from data (the translatable unit is the whole phrase — the
 * endorsed pattern — but it is a dynamic label, and development builds
 * name it once per key+locale so the census stays visible). */
function warnFrame(key: string): void {
	const names = frameVars(key);

	if (names.length > 0) {
		warnOnce(
			`${tag}\u0000frame\u0000${key}`,
			`dynamic label ({var} frame): "${key}" renders ${names.length} runtime value${
				names.length === 1 ? "" : "s"
			} (${names.join(
				", "
			)}) — the sentence is dynamic; the translatable unit is the whole phrase`
		);
	}
}

/** The class-2 audit: translated fragments combined into one line
 * (MessageCondensed's Intl.ListFormat). The conjunction is locale-correct,
 * but each fragment is translated without sentence context — development
 * builds say so once per session. */
export function warnFragmentJoin(count: number): void {
	warnOnce(
		"fragment-join",
		`dynamic label (fragment combination): ${count} translated fragments joined via Intl.ListFormat — the condensed line is assembled, not one phrase`
	);
}

/** The dynamic-key check, shared by t() and tCount(): a key that no static
 * call site in the tree resolves (client/js/i18n/call-sites.ts, generated
 * at compile) was ASSEMBLED at runtime — `t(\`mode.${m}\`)`, `"lobby." +
 * name`, a table-driven lookup — and composed keys translate
 * unpredictably, even when they happen to hit a catalog entry. Dev-only,
 * once per key+locale, INDEPENDENT of whether the lookup succeeds: the
 * warning is about how the label was built, not whether it resolves. */
/** Keys resolved through data tables rather than literal call sites — the
 * splash copy (client/js/i18n/index.ts's id/key table, fed by index.html's
 * static copy). Legitimately indirect; exempt from the dynamic-key
 * warning. The toolchain test pins these to their resolver. */
const INDIRECT_KEYS = new Set(["loading.requiresJs", "loading.slow", "loading.reload"]);

/**
 * The generated call-site table, loaded for development builds only: it is
 * ~1000 keys of diagnostics data with nothing to do in a production bundle.
 * The import sits in a branch the bundler's NODE_ENV fold removes whole —
 * written inline rather than through DEV_I18N so webpack evaluates the
 * condition at parse time and never records the dependency — and `eager`
 * keeps it in the same chunk, so it is there from the first microtask.
 * Until it is, a dynamic key simply does not warn.
 */
let staticCallSites: ReadonlySet<string> | null = null;

/** Resolved once the call-site table is in hand (immediately in a
 * production build, which loads none). Tests await it before asserting on
 * the dynamic-label warning. */
export let callSitesReady: Promise<void> = Promise.resolve();

if (process.env.NODE_ENV !== "production") {
	callSitesReady = import(/* webpackMode: "eager" */ "./call-sites").then((module) => {
		staticCallSites = module.STATIC_CALL_SITES;
	});
}

function warnDynamicKey(key: string): void {
	if (!DEV_I18N || !staticCallSites) {
		return;
	}

	if (!staticCallSites.has(key) && !INDIRECT_KEYS.has(key)) {
		warnOnce(
			`${tag}\u0000dynsite\u0000${key}`,
			`dynamic label: "${key}" was assembled at runtime (no static call site resolves it) — composed keys translate unpredictably; use a whole-phrase key`
		);
	}
}

/** A UI label. Unknown keys render as the key itself — check.ts fails first
 * for static call sites; development builds warn (see the diagnostics
 * block) for the dynamic ones. A key the active locale has not translated
 * yet warns too (dev only): the English copy shows, and the warning is how
 * the remaining work names itself while you browse. */
export function t(key: string, vars: Vars = {}): string {
	warnDynamicKey(key);
	const entry = catalog[key];

	if (typeof entry !== "string") {
		warnOnce(
			`${tag}\u0000key\u0000${key}`,
			`missing key "${key}" (${tag}) — a dynamically composed key, or one the pot lost`
		);
	} else {
		if (isUntranslated(key)) {
			warnOnce(
				`${tag}\u0000untranslated\u0000${key}`,
				`untranslated in "${tag}": "${key}" — the English copy shows`
			);
		}

		warnFrame(key);
	}

	return interpolate(typeof entry === "string" ? entry : key, vars, key);
}

/** A counted label: the entry carries CLDR plural categories from compile.ts. */
export function tCount(key: string, count: number, vars: Vars = {}): string {
	warnDynamicKey(key);
	const entry = catalog[key];

	if (typeof entry === "string") {
		if (isUntranslated(key)) {
			warnOnce(
				`${tag}\u0000untranslated\u0000${key}`,
				`untranslated in "${tag}": "${key}" — the English copy shows`
			);
		}

		warnFrame(key);
		return interpolate(entry, {...vars, count, n: count}, key);
	}

	if (typeof entry !== "object" || entry === null) {
		warnOnce(
			`${tag}\u0000key\u0000${key}`,
			`missing key "${key}" (${tag}) — a dynamically composed key, or one the pot lost`
		);
		return interpolate(key, {...vars, count, n: count}, key);
	}

	if (isUntranslated(key)) {
		warnOnce(
			`${tag}\u0000untranslated\u0000${key}`,
			`untranslated in "${tag}": "${key}" — the English copy shows`
		);
	}

	warnFrame(key);

	const category = rulesFor(tag).select(count);
	const template = entry[category] ?? entry.other ?? Object.values(entry)[0] ?? key;
	return interpolate(template, {...vars, count, n: count}, key);
}

/** The dynamic-label path the instrument loader (tools/i18n/
 * instrument-loader.mjs) routes every non-literal t()/tCount() call
 * through in development builds. The warning belongs to the CALL SITE —
 * how the label was built — not to what the string renders as: an
 * assembled key warns even when it resolves, in any language, once per
 * key+locale. Exposed as __tDyn/__tDynC globals below, because the loader
 * renames call sites in modules that never import core by name. */
export function tDyn(key: string, vars: Vars = {}): string {
	warnOnce(
		`${tag}\u0000dynsite\u0000${key}`,
		`dynamic label: "${key}" was assembled at runtime — composed keys translate unpredictably; use a whole-phrase key`
	);
	return t(key, vars);
}

export function tDynC(key: string, count: number, vars: Vars = {}): string {
	warnOnce(
		`${tag}\u0000dynsite\u0000${key}`,
		`dynamic label: "${key}" was assembled at runtime — composed keys translate unpredictably; use a whole-phrase key`
	);
	return tCount(key, count, vars);
}

if (DEV_I18N) {
	(globalThis as unknown as Record<string, unknown>).__tDyn = tDyn;
	(globalThis as unknown as Record<string, unknown>).__tDynC = tDynC;
}

/** One piece of a translated frame: literal text, or the named
 * placeholder an element stands in. */
export type FramePiece = string | {name: string};

/** Split a translated frame on the named {placeholders} in the order the
 * TRANSLATION puts them -- "{target} は {nick} にキックされました" is as good a
 * frame as the English order. A placeholder not in `names` stays text. What
 * I18nFrame.vue renders, each name through the slot of that name; the
 * order-agnostic form of frameSegments, for any frame with two or more
 * elements. */
export function framePieces(template: string, names: readonly string[]): FramePiece[] {
	const pieces: FramePiece[] = [];
	let last = 0;

	for (const match of template.matchAll(/\{(\w+)\}/g)) {
		if (!names.includes(match[1])) {
			continue;
		}

		const at = match.index ?? 0;

		if (at > last) {
			pieces.push(template.slice(last, at));
		}

		pieces.push({name: match[1]});
		last = at + match[0].length;
	}

	if (last < template.length) {
		pieces.push(template.slice(last));
	}

	return pieces;
}

/** Split a translated frame on ONE {placeholder}: the segments
 * a component renders around the inline elements (the interactive
 * <Username>, a parsed hostmask) — so a translator writes one whole
 * sentence with the verbatim value where it belongs, and the interactive
 * element lands inside it. segments.length === names.length + 1. compile
 * guarantees every placeholder survives translation, so a miss here is a
 * degraded render, never a silent one. The segments come back in the
 * order of `names`, which a component renders its elements in -- so with
 * two or more names a translation that reorders them breaks the line: use
 * framePieces (I18nFrame.vue) there. */
export function frameSegments(template: string, names: string[]): string[] {
	const segments: string[] = [];
	let rest = template;

	for (const name of names) {
		const at = rest.indexOf(`{${name}}`);

		if (at === -1) {
			segments.push(rest);
			rest = "";
			continue;
		}

		segments.push(rest.slice(0, at));
		rest = rest.slice(at + name.length + 2);
	}

	segments.push(rest);
	return segments;
}

/** "auto" resolution: exact tag first, then base language, then en.
 *
 * The one exception to the base match: the only Chinese catalog is
 * Simplified (`zh`), and a reader of Traditional is better served by
 * English than by a script they did not ask for — so a Traditional tag
 * (`zh-TW`, `zh-HK`, `zh-MO`, `zh-Hant-*`) never falls to `zh`, and
 * neither does a bare `zh` after one (Chrome appends the base to every
 * regional tag: `zh-TW, zh, en-US, en`). An explicitly Simplified tag
 * later in the list (`zh-CN`, `zh-Hans`) still picks it. A Traditional
 * catalog, should one ever ship, matches its own tag exactly. */
export function bestLocale(preferred: readonly string[], available: readonly string[]): string {
	let traditional = false;

	for (const want of preferred) {
		const isTraditional = isTraditionalChinese(want);

		if (isTraditional) {
			traditional = true;
		} else if (traditional && want.toLowerCase() === "zh") {
			continue;
		}

		const exact = available.find((candidate) => candidate.toLowerCase() === want.toLowerCase());

		if (exact) {
			return exact;
		}

		if (isTraditional) {
			continue;
		}

		const base = want.split("-")[0].toLowerCase();
		const loose = available.find((candidate) => candidate.toLowerCase() === base);

		if (loose) {
			return loose;
		}
	}

	return "en";
}

/** The tags "auto" may resolve against — and the tags a stored pick may
 * activate (index.ts filters both through this): dev-only locales (the qqx
 * pseudo locale) exist for development testing only, so a production build
 * neither auto-picks, lists nor activates them. */
export function resolvableTags(
	available: ReadonlyArray<{tag: string; devOnly?: boolean}>,
	dev: boolean
): string[] {
	return available.filter((entry) => dev || !("devOnly" in entry)).map((entry) => entry.tag);
}
