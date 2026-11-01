// Vue binding + activation for the i18n runtime: the components' useI18n(),
// the `locale` setting's activate(), and the pre-boot <html lang>/<html dir>
// hand-off with the pre-paint script, client/js/prepaint.js. The resolver
// itself is the Vue-free core.ts (mocha loads that one, not this file).

import {computed, ref} from "vue";
import {
	DEV_I18N,
	bestLocale,
	isRTL,
	missingKeys,
	resolvableTags,
	setCatalog,
	tDyn,
	untranslatedKeys,
	type Catalog,
	type Vars,
} from "./core";
import {brandingT} from "../branding";
import {AVAILABLE} from "./available";
import {TRANSLATION_TARGETS} from "./targets";
import enCatalog from "../../locales/en.json";
import {mirrorPushPrefs} from "../push-prefs";

/** Read during every template call, so a locale change re-renders whatever
 * rendered a label. The ACTIVE interface catalog's tag: the user's pick,
 * or en when that catalog is not compiled yet (its copy shows English). */
export const localeRef = ref("en");

/**
 * The user's language, unified with the interface's: the resolved locale
 * pick ("auto" resolves against the whole roadmap, not just the compiled
 * catalogs), before any catalog fallback. This is what reading translates
 * into — a Swedish pick reads Swedish translations while the interface
 * still shows English copy. A tag translation does not handle (the dev-only
 * qqx rig) names en; consumer-side mapping lives in translate/languages.ts
 * `fromLocaleTag`.
 */
export const userLanguageRef = ref("en");

const overlayCache = new Map<string, Catalog>();

/** How a locale's overlay catalog is fetched; swapped by tests. */
export type OverlayLoader = (tag: string) => Promise<Catalog>;

const importOverlay: OverlayLoader = async (tag) =>
	// One lazy webpack chunk per locale JSON. Overlay catalogs omit
	// untranslated entries (compile.ts), so missing keys fall to en. The
	// directory holds two JSONs that are no catalog: the qqx rig, which a
	// production build never activates, and the generated tag list the
	// pre-paint script is given at build time — a production build emits no
	// chunk for either. The condition is inline (not DEV_I18N) so webpack
	// folds it at parse time and reads only one of the two imports.
	process.env.NODE_ENV === "production"
		? (
				(await import(
					/* webpackExclude: /(qqx|tags)\.json$/ */ `../../locales/${tag}.json`
				)) as {default: Catalog}
		  ).default
		: ((await import(`../../locales/${tag}.json`)) as {default: Catalog}).default;

let overlayLoader: OverlayLoader = importOverlay;

/**
 * Swap how an overlay is fetched (tests: a real dynamic import cannot be
 * made to resolve out of order); `null` restores the bundler's import. The
 * cache is dropped with the loader, as {@link useStorageBackend} does in
 * helpers/settingsBackup.ts.
 */
export function useOverlayLoader(loader: OverlayLoader | null): void {
	overlayLoader = loader ?? importOverlay;
	overlayCache.clear();
}

async function loadOverlay(tag: string): Promise<Catalog | undefined> {
	if (tag === "en") {
		return undefined;
	}

	if (!overlayCache.has(tag)) {
		overlayCache.set(tag, await overlayLoader(tag));
	}

	return overlayCache.get(tag);
}

/**
 * Which activation is the current one. Two locale changes in quick
 * succession race on their overlay loads, and whichever resolved last used
 * to install its catalog — the older pick could overwrite the newer one.
 * Each call takes the next token and drops everything it was going to do
 * once the token has moved on.
 */
let activation = 0;

/**
 * Apply the `locale` setting ("auto" or a tag): resolve, load, install,
 * flip <html lang>/<html dir>, mirror to the push worker (it cannot read
 * localStorage). Runs from the setting's apply() at boot and on change.
 */
export async function activate(setting: string): Promise<void> {
	const mine = ++activation;
	// "auto" and any stored tag resolve against one set: a production
	// build carries no qqx at all, so a stored qqx pick (a settings
	// restore from a dev machine, say) falls back to the automatic
	// resolution instead of activating the rig.
	// One resolvable set for both consumers: the whole roadmap (a pick
	// without a compiled catalog is still the user's language — the
	// interface falls back to English copy, reading does not fall back at
	// all) plus this build's own entries (qqx, dev-only).
	const resolvable = [
		...new Set([
			...TRANSLATION_TARGETS.map((entry) => entry.tag),
			...resolvableTags(AVAILABLE, DEV_I18N),
		]),
	];
	const pick =
		setting === "auto" || !resolvable.includes(setting)
			? bestLocale(navigator.languages ?? [], resolvable)
			: setting;

	// The interface's catalog tag: the pick, or en when that catalog is
	// not compiled (below). Everything that renders labels follows this.
	let tag = pick;
	let overlay: Catalog | undefined;

	// Best-effort, never a rejection: settingsBackup restores the whole
	// settings blob, so a stored tag this build has no compiled catalog for
	// reaches activate() through boot's `void activate()` — a rejecting
	// dynamic import there would cascade. Fall back to en, as the worker's
	// applyLocale() does (client/js/push/i18n.ts).
	try {
		overlay = await loadOverlay(pick);
	} catch {
		// No compiled catalog for the pick: the interface shows English.
		// The pick itself survives in userLanguageRef — the reading
		// language does not fall back with the interface's.
		tag = "en";
	}

	// A newer activation started while this one was loading: it owns the
	// catalog, the refs and the document from here on. Nothing below has run
	// yet, so there is nothing to undo.
	if (mine !== activation) {
		return;
	}

	setCatalog(tag, enCatalog, overlay);

	userLanguageRef.value = pick;

	// Development only: the translation-coverage summary. A locale whose
	// .po is partly filled shows the English copy for the rest, and this
	// one line says how much that is; the per-label warnings fire as the
	// labels render, and seanceI18n.untranslated() lists everything at
	// once. Production folds the whole block away.
	/* eslint-disable no-console -- the coverage summary is part of the same
	 * sanctioned dev diagnostics family as core.ts's warnOnce. */
	if (DEV_I18N && tag !== "en") {
		const untranslated = untranslatedKeys().length;

		if (untranslated > 0) {
			console.warn(
				`[seance i18n] ${tag}: ${untranslated} label(s) not translated yet — the English copy shows; seanceI18n.untranslated() lists them`
			);
		}
	}
	/* eslint-enable no-console */

	localeRef.value = tag;

	const root = document.documentElement;
	root.lang = tag;
	root.dir = isRTL(tag) ? "rtl" : "ltr";

	// The splash is still in the DOM until boot removes it — localize what the
	// reader would otherwise read flash by. Visitors without JavaScript still
	// see English: there is no code to translate it for them.
	for (const [id, key] of [
		["loading-page-message", "loading.requiresJs"],
		["loading-slow", "loading.slow"],
		["loading-reload", "loading.reload"],
	] as const) {
		const node = document.getElementById(id);

		if (node) {
			// The same override-aware resolver the components use: a deploy's
			// `strings` override of a splash key is live, not inert.
			node.textContent = brandingT(key);
		}
	}

	void mirrorPushPrefs({locale: tag});
}

/** `const {t, tCount} = useI18n()` in setup(). Each call reads localeRef so
 * the component re-renders on a language change. Both resolve through the
 * one override-aware helper (brandingT): the deploy's `strings` overrides
 * interpolate their `{var}`s — on flat, var-bearing and plural keys alike —
 * and a key with no override answers from the catalogs exactly as core
 * would. */
export function useI18n() {
	const t = (key: string, vars?: Vars): string => {
		void localeRef.value;
		return brandingT(key, vars);
	};

	const tCount = (key: string, count: number, vars?: Vars): string => {
		void localeRef.value;
		return brandingT(key, vars, count);
	};

	return {t, tCount, locale: computed(() => localeRef.value)};
}

// Development-only console hook: `seanceI18n.t("bogus.key")` in the devtools
// console shows exactly what the missing-key tripwire does (the placeholder
// renders, one console.warn fires), and `seanceI18n.missingKeys()` lists
// every key/var the session has tripped. Production builds (DEV_I18N false)
// never assign it — no hook, no surface, no warnings.
if (DEV_I18N && typeof window !== "undefined") {
	// The typeof guard keeps the module loadable under plain node (mocha
	// loads it through reader.ts since the language unification): a dev
	// build is browser-only anyway, so nothing real is folded away.
	(window as unknown as {seanceI18n?: unknown}).seanceI18n = {
		t: brandingT,
		tCount: (key: string, count: number, vars?: Vars) => brandingT(key, vars, count),
		// The ids are locale\u0000kind\u0000name internally; the console gets
		// the readable form ("en · key · bogus.demo.key").
		missingKeys: () => missingKeys().map((id) => id.split("\u0000").join(" · ")),
		// The active locale's untranslated keys, in pot order.
		untranslated: () => untranslatedKeys(),
		// Fire a genuine dynamic-label warning on demand: routes through the
		// same tDyn path the instrument loader gives every non-literal
		// t()/tCount() call site.
		demoDynamic: (key: string) => tDyn(key),
	};
}
