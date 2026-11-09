// The languages a channel has been written in lately, from the reading
// pipeline's own verdicts (store.state.translations), for the composer's
// language sheet ("Spoken in #linux lately") and its suggestion card
// ("Most of #linux writes in Portuguese"). Vue-free and store-free: the
// caller hands in the messages and the entries, so mocha pins the rules.

/** How far back the channel is looked at: its newest lines, others' only. */
export const RECENT_LINES = 60;

/** The suggestion needs at least this many placed lines in the language… */
export const SUGGEST_MIN_LINES = 5;

/** …and at least this share of all the placed lines looked at. */
export const SUGGEST_MIN_SHARE = 0.5;

export interface RecentMessage {
	id: number;
	self?: boolean;
	type?: string;
}

export interface RecentEntry {
	status: string;
	from: string;
}

export interface LanguageCount {
	code: string;
	count: number;
}

/**
 * Each language the channel's newest `RECENT_LINES` messages from others were
 * placed in, most lines first (ties by code, so the order is stable). A line
 * with no verdict yet, or one the detector could not place (`from` ""), is
 * not counted; one skipped as the reading language is, under that language.
 */
export function recentLanguages(
	messages: readonly RecentMessage[],
	entries: Readonly<Record<number, RecentEntry | undefined>>
): LanguageCount[] {
	const counts = new Map<string, number>();
	let looked = 0;

	for (let i = messages.length - 1; i >= 0 && looked < RECENT_LINES; i--) {
		const message = messages[i];

		if (message.self || (message.type !== "message" && message.type !== "action")) {
			continue;
		}

		looked++;
		const entry = entries[message.id];

		if (!entry || !entry.from || entry.status === "dropped") {
			continue;
		}

		counts.set(entry.from, (counts.get(entry.from) ?? 0) + 1);
	}

	return [...counts.entries()]
		.map(([code, count]) => ({code, count}))
		.sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

/**
 * The language to offer writing in: the channel's most written one, when it
 * is not the reader's own, carries at least `SUGGEST_MIN_LINES` lines and at
 * least `SUGGEST_MIN_SHARE` of every placed line. Null otherwise -- a mixed
 * channel, a quiet one, or one that already writes the reader's language.
 */
export function suggestedLanguage(
	counts: readonly LanguageCount[],
	reading: string
): string | null {
	const top = counts[0];

	if (!top || top.code === reading || top.count < SUGGEST_MIN_LINES) {
		return null;
	}

	const total = counts.reduce((sum, c) => sum + c.count, 0);

	return top.count / total >= SUGGEST_MIN_SHARE ? top.code : null;
}
