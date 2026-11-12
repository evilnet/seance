// Offered in place (docs/resources/translation.md § Offered in place): with
// translation switched off by the user, a conversation whose recent lines
// from others are mostly in a language that is not theirs offers to switch
// it on. Its own small observation, apart from the reading pipeline, which
// does not run while off: the newest lines of the conversation on screen,
// placed by the sender's tag or the detector alone -- no translation
// service, no worker, no model. Vue-free and store-free: the caller hands in
// the messages and the detector, so mocha pins the rule.

import {type LanguageCount, SUGGEST_MIN_LINES, suggestedLanguage} from "./recent";

/** How many of the newest lines from others one observation looks at. */
export const DISCOVER_LINES = 20;

export interface DiscoverMessage {
	id: number;
	self?: boolean;
	type?: string;
	text?: string;
	/** The sender's `+draft/language` tag: the language of the text as sent. */
	language?: string;
	redacted?: unknown;
	supersededBy?: number;
}

/** A line's language by the detector alone, or null where it cannot place it. */
export type Detector = (text: string) => Promise<string | null>;

/**
 * Whether a line without a tag is worth asking the detector about (the
 * caller's word count: one or two words are a guess). Cheap, and asked
 * first: the detector is a download of its own, and it is not loaded for a
 * conversation that could not reach an offer whatever it said.
 */
export type Worth = (text: string) => boolean;

const PROSE = new Set(["message", "action"]);

function base(code: string): string {
	return code.split("-")[0].toLowerCase();
}

/**
 * The language to offer translating from, or null. The newest
 * `DISCOVER_LINES` prose lines from others are placed -- by the sender's
 * tag where it carries one (it names the language of the text on screen,
 * machine-translated or not: that is what the reader would be reading), else
 * by the detector -- and the conversation's language is the one the
 * channel write card would name (recent.ts `suggestedLanguage`: at least
 * five lines and half of every placed one). A language the user reads or
 * also reads is no reason to offer anything.
 */
export async function discoverLanguage(
	messages: readonly DiscoverMessage[],
	languages: {reading: string; alsoRead: readonly string[]},
	detect: Detector,
	worth: Worth = () => true
): Promise<string | null> {
	const counts = new Map<string, number>();
	const untagged: string[] = [];
	let looked = 0;

	for (let i = messages.length - 1; i >= 0 && looked < DISCOVER_LINES; i--) {
		const message = messages[i];

		if (
			message.self ||
			message.redacted ||
			message.supersededBy !== undefined ||
			!PROSE.has(message.type ?? "") ||
			!message.text?.trim()
		) {
			continue;
		}

		looked++;

		if (message.language) {
			counts.set(message.language, (counts.get(message.language) ?? 0) + 1);
		} else if (worth(message.text)) {
			untagged.push(message.text);
		}
	}

	// Too few lines that could be placed at all: no offer, and nothing asked.
	if ([...counts.values()].reduce((sum, n) => sum + n, 0) + untagged.length < SUGGEST_MIN_LINES) {
		return null;
	}

	for (const text of untagged) {
		const code = await detect(text);

		if (code) {
			counts.set(code, (counts.get(code) ?? 0) + 1);
		}
	}

	const sorted: LanguageCount[] = [...counts.entries()]
		.map(([code, count]) => ({code, count}))
		.sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
	const code = suggestedLanguage(sorted, languages.reading);

	if (!code) {
		return null;
	}

	const own = [languages.reading, ...languages.alsoRead].map(base);

	return own.includes(base(code)) ? null : code;
}
