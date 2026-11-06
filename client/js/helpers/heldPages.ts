// A page of older history the store holds back is not in `channel.messages`
// yet: socket-events/more.ts waits for a moving list to settle before it
// prepends, and loading older history happens with the list scrolled up,
// so it nearly always waits. The IRC layer dispatches the updates that
// refer to that page's messages (`msg:edit`, `msg:react`, `msg:redact`)
// right after `more`, in the same tick, so applied at once they found
// nothing and were lost: an edit and its original both stayed on screen.
// Those consumers run their work through `afterHeldPage`, which waits for a
// page held for the same channel and keeps the order they arrived in.
// Vue-free: test/helpers/heldPages.ts.

const held = new Map<number, Promise<void>>();

/**
 * A page for `chan` is being held back. Call the function returned once it
 * is in the store (calling it again does nothing). A second page held
 * before the first lands queues behind it.
 */
export function holdPage(chan: number): () => void {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	const before = held.get(chan);
	const chained = before ? before.then(() => gate) : gate;

	held.set(chan, chained);

	return () => {
		release();
		void chained.then(() => {
			if (held.get(chan) === chained) {
				held.delete(chan);
			}
		});
	};
}

/** Run `work` now, or once a page held for `chan` is in the store. */
export function afterHeldPage(chan: number, work: () => void): void {
	const gate = held.get(chan);

	if (gate) {
		void gate.then(work);
	} else {
		work();
	}
}
