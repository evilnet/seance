/**
 * Where a conversation picks up again after a quiet spell: Messenger shows
 * the time once, centred over the first line of each such stretch, as a
 * phone's messaging app does, instead of a time on every line
 * (MessageList.vue, style.css § Session times). Only what people said
 * counts (a message, a notice, an action): joins, parts and the rest come
 * and go without starting or continuing a conversation. Vue-free.
 */

/** How long a pause starts a new stretch: half an hour. Three times a run's
 * gap (messageRuns.ts RUN_GAP_MS), so a pause to fetch a coffee, which
 * only brings the nick back, leaves the time where it was, while coming
 * back to the conversation after lunch, or the next morning, gets one. */
export const SESSION_GAP_MS = 30 * 60 * 1000;

const conversationTypes: ReadonlySet<string> = new Set(["message", "notice", "action"]);

interface SessionRow {
	type?: string;
	time: Date | string | number;
}

/** For each row, whether a stretch of conversation starts there: the first
 * line said in the list, or one said SESSION_GAP_MS or more after the line
 * said before it. A row whose time does not parse starts nothing (and
 * leaves the line before it as the one to measure from). */
export function sessionStarts(rows: readonly SessionRow[]): boolean[] {
	let previous: number | undefined;

	return rows.map((row) => {
		if (!conversationTypes.has(row.type || "")) {
			return false;
		}

		const time = new Date(row.time).getTime();

		if (Number.isNaN(time)) {
			return false;
		}

		const starts = previous === undefined || time - previous >= SESSION_GAP_MS;
		previous = time;
		return starts;
	});
}
