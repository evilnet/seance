/**
 * Calls `fn` at most once per `wait` ms: at once when it has not run within
 * the last `wait` ms, otherwise once when that window ends.
 */
export function throttle(fn: () => void, wait: number): () => void {
	let last = -Infinity;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const run = () => {
		timer = undefined;
		last = Date.now();
		fn();
	};

	return () => {
		if (timer !== undefined) {
			return;
		}

		const remaining = last + wait - Date.now();

		if (remaining <= 0) {
			run();
		} else {
			timer = setTimeout(run, remaining);
		}
	};
}
