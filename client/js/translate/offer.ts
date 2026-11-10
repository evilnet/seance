// The composer's writing offers (docs/resources/translation.md § Suggested
// writing): "Reply in Portuguese" when the user starts a reply to a line in
// another language, "Write to Ana in Polish" in a query whose other person
// writes in one. Vue-free and store-free: the caller hands in the messages,
// the reading pipeline's verdicts and the user's languages, so mocha pins
// the rules. An offer is only an offer: nothing is sent translated unless the
// user takes it for that message (or chose a language for the conversation).

/** How many of the other person's newest lines a query's offer looks at. */
export const QUERY_LINES = 5;

export interface OfferMessage {
	id: number;
	self?: boolean;
	type?: string;
	text?: string;
	/** The sender's `+draft/language` tag (irc/langtag.ts). */
	language?: string;
	/** The sender's client machine-translated the text. */
	machineTranslated?: boolean;
	redacted?: unknown;
	supersededBy?: number;
	pending?: boolean;
}

/** The reading pipeline's verdict for a line (store.state.translations). */
export interface OfferEntry {
	status: string;
	from: string;
	reason?: string;
}

export type OfferEntries = Readonly<Record<number, OfferEntry | undefined>>;

export interface OfferLanguages {
	/** The language the user reads (reader.ts `readingLanguage`). */
	reading: string;
	/** "I also read" (reader.ts `alsoReadLanguages`). */
	alsoRead: readonly string[];
	/** Whether the device can write from `reading` into `to` (reader.ts `pairVerdict`). */
	routes: (to: string) => boolean;
}

export type OfferKind = "reply" | "query";

export interface WriteOffer {
	kind: OfferKind;
	/** The language offered for this message. */
	code: string;
}

const PROSE = new Set(["message", "action"]);

/**
 * The language a line is written in, as far as an offer may go by it: the
 * reader's verdict, else (a conversation that does not read) the sender's
 * own tag. Null when the line says nothing a reply could go by:
 *
 * - it was machine-translated: its tag names the language of the text that
 *   was sent, not the one its author reads, and the other person's client
 *   translates a reply for them anyway;
 * - the detector could not place it (`unsure`, or a source left to the
 *   engine), or it has not been looked at yet and carries no tag.
 */
export function lineLanguage(message: OfferMessage, entry: OfferEntry | undefined): string | null {
	if (message.machineTranslated) {
		return null;
	}

	if (entry && entry.status !== "dropped") {
		if (entry.status === "skipped" && entry.reason === "unsure") {
			return null;
		}

		return entry.from || null;
	}

	return message.language || null;
}

/** The base of a language code: "pt-BR" is Portuguese, for "is this one I read". */
function base(code: string): string {
	return code.split("-")[0].toLowerCase();
}

/** A language worth offering: not one the user reads, and one the device can write. */
function offerable(code: string | null, languages: OfferLanguages): string | null {
	if (!code) {
		return null;
	}

	const own = [languages.reading, ...languages.alsoRead].map(base);

	if (own.includes(base(code))) {
		return null;
	}

	return languages.routes(code) ? code : null;
}

/**
 * "Reply in …": the language of the line replied to, when it is someone
 * else's, placed, not machine-translated and not one the user reads. A reply
 * to the user's own line offers nothing: its raw text is in whatever the
 * user sent it in, and what they see may be its read-back.
 */
export function replyOffer(
	parent: OfferMessage,
	entry: OfferEntry | undefined,
	languages: OfferLanguages
): string | null {
	if (parent.self || parent.redacted || !PROSE.has(parent.type ?? "")) {
		return null;
	}

	return offerable(lineLanguage(parent, entry), languages);
}

/**
 * "Write to Ana in …": the language of the other person's newest placed
 * line among their `QUERY_LINES` newest. Lines that say nothing are passed
 * over -- the user's own, machine-translated ones, redacted, superseded or
 * still pending ones, a notice, and lines the detector could not place (an
 * emoji, a code paste, one word) -- so one of those never changes the offer.
 * Ambiguous is no offer: the two newest placed lines name different
 * languages (a person switching, or a one-line mistake of the detector's).
 */
export function queryOffer(
	messages: readonly OfferMessage[],
	entries: OfferEntries,
	languages: OfferLanguages
): string | null {
	const placed: string[] = [];
	let looked = 0;

	for (let i = messages.length - 1; i >= 0 && looked < QUERY_LINES && placed.length < 2; i--) {
		const message = messages[i];

		if (
			message.self ||
			message.pending ||
			message.redacted ||
			message.supersededBy !== undefined ||
			!PROSE.has(message.type ?? "")
		) {
			continue;
		}

		looked++;

		if (message.machineTranslated) {
			continue;
		}

		const code = lineLanguage(message, entries[message.id]);

		if (code) {
			placed.push(code);
		}
	}

	if (placed.length === 0 || (placed.length === 2 && base(placed[0]) !== base(placed[1]))) {
		return null;
	}

	return offerable(placed[0], languages);
}

export interface OfferInput {
	/** The conversation is a query (a channel offers only a reply). */
	query: boolean;
	/** The line being replied to, if any. */
	replyTo: OfferMessage | null;
	messages: readonly OfferMessage[];
	entries: OfferEntries;
	/** The draft is an edit: it bypasses translation, so nothing is offered. */
	editing: boolean;
	/** The conversation has a language to write in (or the cleanup pass): it is the user's choice. */
	writeTarget: string | null;
	/** The user said "Not now" to offers in this conversation. */
	declined: boolean;
	languages: OfferLanguages;
}

/**
 * The one offer the composer shows, or none. A reply's offer comes before a
 * query's: replying to a line is the stronger hint. Nothing is offered over a
 * language the user chose for the conversation, over an edit, or after a
 * decline here.
 */
export function composerOffer(input: OfferInput): WriteOffer | null {
	if (input.editing || input.writeTarget || input.declined) {
		return null;
	}

	if (input.replyTo) {
		const code = replyOffer(input.replyTo, input.entries[input.replyTo.id], input.languages);

		if (code) {
			return {kind: "reply", code};
		}

		// A reply to a line that names no language offers nothing, not the
		// query's language: the user is answering that line.
		return null;
	}

	if (input.query) {
		const code = queryOffer(input.messages, input.entries, input.languages);

		return code ? {kind: "query", code} : null;
	}

	return null;
}
