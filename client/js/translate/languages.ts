// The languages the router knows, their display names and their NLLB codes.
// Names come from `Intl.DisplayNames` in the app's language, with a bundled
// English table behind it for engines that do not have the locale; the UI
// always shows a full name, never a code (spec § Decisions).

import {isTraditionalChinese} from "../i18n/traditionalChinese";

export const SUPPORTED_LANGUAGES: readonly string[] = [
	"en",
	"de",
	"fr",
	"es",
	"it",
	"pt",
	"nl",
	"sv",
	"da",
	"nb",
	"fi",
	"pl",
	"cs",
	"sk",
	"hu",
	"ro",
	"bg",
	"ru",
	"uk",
	"sr",
	"hr",
	"sl",
	"el",
	"tr",
	"ar",
	"he",
	"fa",
	"hi",
	"bn",
	"ta",
	"th",
	"vi",
	"id",
	"ms",
	"zh",
	"ja",
	"ko",
	"ca",
	"eu",
	"gl",
	"ga",
	"cy",
	"sw",
	"af",
	"tl",
	"ur",
];

export function isSupported(code: string): boolean {
	return SUPPORTED_LANGUAGES.includes(code);
}

/** ISO 639-1 → FLORES-200 code, what NLLB's tokenizer wants. */
export const NLLB_CODES: Record<string, string> = {
	en: "eng_Latn",
	de: "deu_Latn",
	fr: "fra_Latn",
	es: "spa_Latn",
	it: "ita_Latn",
	pt: "por_Latn",
	nl: "nld_Latn",
	sv: "swe_Latn",
	da: "dan_Latn",
	nb: "nob_Latn",
	fi: "fin_Latn",
	pl: "pol_Latn",
	cs: "ces_Latn",
	sk: "slk_Latn",
	hu: "hun_Latn",
	ro: "ron_Latn",
	bg: "bul_Cyrl",
	ru: "rus_Cyrl",
	uk: "ukr_Cyrl",
	sr: "srp_Cyrl",
	hr: "hrv_Latn",
	sl: "slv_Latn",
	el: "ell_Grek",
	tr: "tur_Latn",
	ar: "arb_Arab",
	he: "heb_Hebr",
	fa: "pes_Arab",
	hi: "hin_Deva",
	bn: "ben_Beng",
	ta: "tam_Taml",
	th: "tha_Thai",
	vi: "vie_Latn",
	id: "ind_Latn",
	ms: "zsm_Latn",
	zh: "zho_Hans",
	ja: "jpn_Jpan",
	ko: "kor_Hang",
	ca: "cat_Latn",
	eu: "eus_Latn",
	gl: "glg_Latn",
	ga: "gle_Latn",
	cy: "cym_Latn",
	sw: "swh_Latn",
	af: "afr_Latn",
	tl: "tgl_Latn",
	ur: "urd_Arab",
};

export function nllbCode(code: string): string | null {
	return NLLB_CODES[code] ?? null;
}

const FALLBACK_NAMES: Record<string, string> = {
	en: "English",
	de: "German",
	fr: "French",
	es: "Spanish",
	it: "Italian",
	pt: "Portuguese",
	nl: "Dutch",
	sv: "Swedish",
	da: "Danish",
	nb: "Norwegian Bokmål",
	fi: "Finnish",
	pl: "Polish",
	cs: "Czech",
	sk: "Slovak",
	hu: "Hungarian",
	ro: "Romanian",
	bg: "Bulgarian",
	ru: "Russian",
	uk: "Ukrainian",
	sr: "Serbian",
	hr: "Croatian",
	sl: "Slovenian",
	el: "Greek",
	tr: "Turkish",
	ar: "Arabic",
	he: "Hebrew",
	fa: "Persian",
	hi: "Hindi",
	bn: "Bangla",
	ta: "Tamil",
	th: "Thai",
	vi: "Vietnamese",
	id: "Indonesian",
	ms: "Malay",
	zh: "Chinese",
	ja: "Japanese",
	ko: "Korean",
	et: "Estonian",
	lv: "Latvian",
	lt: "Lithuanian",
	ca: "Catalan",
	eu: "Basque",
	gl: "Galician",
	ga: "Irish",
	cy: "Welsh",
	is: "Icelandic",
	sw: "Swahili",
	af: "Afrikaans",
	tl: "Tagalog",
	ur: "Urdu",
};

export function languageName(code: string, locale = "en"): string {
	try {
		const names = new Intl.DisplayNames([locale], {type: "language"});
		const name = names.of(code);

		if (name && name !== code) {
			return name;
		}
	} catch {
		// an unknown locale or a runtime without Intl.DisplayNames
	}

	return FALLBACK_NAMES[code] ?? code;
}

const endonymCache = new Map<string, string>();

/**
 * The language's own name in its own locale — `Deutsch` for `de`, `日本語`
 * for `ja` — falling back to the bundled English table when the runtime has
 * no data for that locale (the constructor throws, or `.of()` hands back the
 * code itself).
 */
export function languageEndonym(code: string): string {
	const cached = endonymCache.get(code);

	if (cached !== undefined) {
		return cached;
	}

	let endonym: string | undefined;

	try {
		const names = new Intl.DisplayNames([code], {type: "language"});
		const name = names.of(code);

		if (name && name !== code) {
			endonym = name;
		}
	} catch {
		// an unknown locale or a runtime without Intl.DisplayNames
	}

	// CLDR spells some endonyms lowercase mid-sentence ("français"), but a
	// picker option stands alone, so a real endonym takes an initial capital
	// in its own locale — a no-op for a script without case ("日本語"). The
	// bundled-English/code fallback is left as `languageName` already spells
	// it — capitalising an unknown code would turn "xx" into "Xx".
	const resolved = endonym
		? endonym.charAt(0).toLocaleUpperCase(code) + endonym.slice(1)
		: languageName(code, "en");

	endonymCache.set(code, resolved);

	return resolved;
}

/**
 * An interface locale tag (the unified language: `TRANSLATION_TARGETS`,
 * so Tagalog arrives as "fil") as a supported reading language. The one
 * alias the two lists disagree on, and English for anything translation
 * does not handle — the dev-only qqx rig, unknown tags.
 */
export function fromLocaleTag(tag: string): string {
	const primary = (tag ?? "").toLowerCase().split(/[-_]/)[0];
	const code = primary === "fil" ? "tl" : primary;

	return isSupported(code) ? code : "en";
}

/** `navigator.language` → a supported code; English when nothing matches.
 * Traditional Chinese (`zh-TW`, `zh-HK`, `zh-Hant-*`) is English too, as
 * the interface's automatic choice has it (i18n/core.ts `bestLocale`):
 * `zh` here is Simplified (NLLB's `zho_Hans`). */
export function browserLanguage(navigatorLanguage: string | undefined): string {
	if (isTraditionalChinese(navigatorLanguage ?? "")) {
		return "en";
	}

	const primary = (navigatorLanguage ?? "").toLowerCase().split(/[-_]/)[0];

	return isSupported(primary) ? primary : "en";
}
