/**
 * Whether a message continues the run of the one before it: the same nick,
 * both plain messages, and no more than RUN_GAP_MS between them. A message
 * that continues a run gets `previous-source` (MessageList.vue), which the
 * ps theme reads to show a run's nick and time once (docs/projects/ps-theme.md
 * §8). A quiet spell starts a new run, so a line written hours later never
 * sits under an old header as if it followed straight on. Vue-free.
 */

/** The longest pause inside one run (the user's pick, 2026-10-06: about ten minutes). */
export const RUN_GAP_MS = 10 * 60 * 1000;

interface RunMessage {
	type: string;
	time: Date | string | number;
	from?: {nick?: string} | null;
}

export function continuesRun(previous: RunMessage | undefined, current: RunMessage): boolean {
	if (
		!previous ||
		current.type !== "message" ||
		previous.type !== "message" ||
		!current.from?.nick ||
		current.from.nick !== previous.from?.nick
	) {
		return false;
	}

	// Either way round: an edit takes its original's time, which can be older
	// than the line before it. A time that does not parse starts a new run.
	const gap = new Date(current.time).getTime() - new Date(previous.time).getTime();
	return Math.abs(gap) <= RUN_GAP_MS;
}
