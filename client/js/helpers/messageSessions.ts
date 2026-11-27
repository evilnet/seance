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
 * line said in the list, or one said SESSION_GAP_MS or more after the
 * newest line said before it. The newest, not the one before in the list:
 * a line that arrives late with an earlier time (a lagging server's, a
 * delayed relay's) starts nothing and does not turn the clock back, so the
 * quiet is always measured from the last thing anyone said. A row whose
 * time does not parse starts nothing and measures nothing. */
export function sessionStarts(rows: readonly SessionRow[]): boolean[] {
	let newest: number | undefined;

	return rows.map((row) => {
		if (!conversationTypes.has(row.type || "")) {
			return false;
		}

		const time = new Date(row.time).getTime();

		if (Number.isNaN(time)) {
			return false;
		}

		const starts = newest === undefined || time - newest >= SESSION_GAP_MS;
		newest = newest === undefined ? time : Math.max(newest, time);
		return starts;
	});
}
