/**
 * Calls `fn` at most once per `wait` ms: the first call runs at once, and
 * calls inside the window collapse into one trailing call, with the latest
 * arguments, when it ends.
 */
export function throttle<A extends unknown[]>(
	fn: (...args: A) => void,
	wait: number
): (...args: A) => void {
	let last = -Infinity;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pending: A | undefined;

	const run = (args: A) => {
		last = Date.now();
		fn(...args);
	};

	return (...args: A) => {
		const remaining = wait - (Date.now() - last);

		if (remaining <= 0 && timer === undefined) {
			run(args);
			return;
		}

		pending = args;
		timer ??= setTimeout(() => {
			timer = undefined;
			const latest = pending as A;
			pending = undefined;
			run(latest);
		}, remaining);
	};
}
