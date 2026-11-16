/**
 * Whether the message list is in motion (a fling running, a finger down),
 * for a history page that arrives mid-scroll. WebKit ignores a scroll
 * position written while the scroller moves, and the only way to place
 * the view then is to kill the momentum (MessageList `verifyAnchor`), a
 * visible jolt. Better: hold the page until the motion settles, then
 * insert and compensate in one go. The list reports its scroll and touch
 * events here; `socket-events/more.ts` waits on {@link settled} before
 * prepending into the channel on screen.
 */

/** No scroll event for this long, and no finger down, counts as settled. */
export const SETTLE_IDLE_MS = 150;
/** A page is never held longer than this, whatever the finger does. */
export const SETTLE_MAX_MS = 2000;

const realNow = (): number => Date.now();
const realAfter = (ms: number, fn: () => void): void => void setTimeout(fn, ms);

let lastScrollAt = 0;
let touching = false;
let now: () => number = realNow;
let after: (ms: number, fn: () => void) => void = realAfter;

/** Tests: drive the clock and the timers. */
export function useSettleClock(clock: typeof now, schedule: typeof after): void {
	now = clock;
	after = schedule;
}

/** Tests: the real clock and timers again, and nothing in motion, so a later
 * file that imports this module does not inherit a fake clock or a finger
 * left down (settled() would then wait on timers nobody runs). */
export function resetSettle(): void {
	now = realNow;
	after = realAfter;
	lastScrollAt = 0;
	touching = false;
}

export function noteScroll(): void {
	lastScrollAt = now();
}

export function noteTouch(down: boolean): void {
	touching = down;

	if (!down) {
		lastScrollAt = now(); // the lift itself is motion; momentum may follow
	}
}

export function inMotion(): boolean {
	return touching || now() - lastScrollAt < SETTLE_IDLE_MS;
}

/** Resolves once the list has settled, or after {@link SETTLE_MAX_MS}. */
export function settled(): Promise<void> {
	const deadline = now() + SETTLE_MAX_MS;

	return new Promise((resolve) => {
		const check = () => {
			if (!inMotion() || now() >= deadline) {
				resolve();
				return;
			}

			after(touching ? SETTLE_IDLE_MS : SETTLE_IDLE_MS - (now() - lastScrollAt), check);
		};

		check();
	});
}
