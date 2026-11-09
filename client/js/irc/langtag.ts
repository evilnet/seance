// The language client tags (docs/resources/translation.md § Language tags):
// `+draft/language` names the language a message's text is in (IRCv3 PR #424,
// a closed draft, BCP 47 values) and `+evilnet.github.io/machine-translated` says the
// text is machine output the sender's client made from the user's own words.
// Seance sends them only on a composer translation into a language the user
// picked; the reader takes them as a strong prior for its detector, never as
// an order. Store-free and DOM-free: mocha reaches it.

import {isTraditionalChinese} from "../i18n/traditionalChinese";
import {isSupported} from "../translate/languages";
import type {ClientTags} from "./wire";

export const LANGUAGE_TAG = "+draft/language";
export const MACHINE_TRANSLATED_TAG = "+evilnet.github.io/machine-translated";

/**
 * Seance's codes whose BCP 47 form differs: Seance's `zh` is Simplified
 * (NLLB `zho_Hans`), so it says so, and its `tl` is the interface's Filipino.
 */
const OUTBOUND: Readonly<Record<string, string>> = {zh: "zh-Hans", tl: "fil"};

/** Primary subtags other clients send for a language Seance knows by another code. */
const INBOUND_ALIASES: Readonly<Record<string, string>> = {
	fil: "tl",
	iw: "he",
	in: "id",
	no: "nb",
};

/** Valid BCP 47 that names no one language: undetermined, multiple, none, uncoded. */
const NO_LANGUAGE = new Set(["und", "mul", "zxx", "mis"]);

/** A well-formed language tag: a 2-3 letter primary, then 1-8 character subtags. */
const SHAPE = /^[a-z]{2,3}(?:-[a-z0-9]{1,8})*$/i;

/** A Seance language code as the `+draft/language` value other clients read. */
export function languageTagFor(code: string): string {
	return OUTBOUND[code] ?? code;
}

/**
 * The supported Seance language a `+draft/language` value names, or null
 * when it names none Seance can use as a source: malformed, private use,
 * `und`/`mul`/`zxx`, a language the engines lack, or Traditional Chinese
 * (Seance's `zh` is Simplified; a Traditional line is better detected than
 * handed to a Simplified model as if it were one).
 */
export function codeOfLanguageTag(value: string | undefined): string | null {
	if (!value || value.length > 35 || !SHAPE.test(value)) {
		return null;
	}

	const lower = value.toLowerCase();
	const primary = lower.split("-")[0];

	if (NO_LANGUAGE.has(primary)) {
		return null;
	}

	if (primary === "zh" && isTraditionalChinese(lower)) {
		return null;
	}

	const code = INBOUND_ALIASES[primary] ?? primary;

	return isSupported(code) ? code : null;
}

/** What the language tags of a message say, as message fields. */
export interface LanguageFields {
	/** The supported language the sender says the text is in. */
	language?: string;
	/** The sender's client machine-translated the text (only with `language`). */
	machineTranslated?: true;
}

/**
 * The fields a message's tags give it. The machine-translated flag means
 * nothing without the language it was translated into, so it is dropped
 * when the language tag is missing or unusable.
 */
export function languageFieldsOf(tag: (name: string) => string | undefined): LanguageFields {
	const language = codeOfLanguageTag(tag(LANGUAGE_TAG));

	if (!language) {
		return {};
	}

	return tag(MACHINE_TRANSLATED_TAG) === undefined
		? {language}
		: {language, machineTranslated: true};
}

/**
 * The tags for a line whose language Seance knows: `code`, and the
 * machine-translated flag when the composer translated it (not when it
 * only corrected the user's own language). No tags for no language.
 */
export function languageTags(code: string | undefined, machineTranslated = false): ClientTags {
	if (!code) {
		return {};
	}

	return machineTranslated
		? {[LANGUAGE_TAG]: languageTagFor(code), [MACHINE_TRANSLATED_TAG]: ""}
		: {[LANGUAGE_TAG]: languageTagFor(code)};
}
