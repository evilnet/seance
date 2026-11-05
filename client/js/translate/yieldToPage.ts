// A break in a long run of main-thread work, so the page can paint and take
// input between two steps. A history load runs its lines one after another
// (reader.ts `queueHistory`), and once the detector's chunk is in, every
// await in a line settles as a microtask: without a real task boundary, 40
// lines in a big channel were one long task of a few hundred milliseconds.
//
// Not `setTimeout(0)`: a replay after a reconnect often lands in a hidden
// tab, where chained timers are throttled to one a second or worse. A
// message posted to a `MessageChannel` is an ordinary task, never
// throttled; `scheduler.yield()` is preferred where the browser has it,
// since it resumes ahead of other queued work. Vue-free and DOM-free.

interface YieldingScheduler {
	yield(): Promise<void>;
}

export function yieldToPage(): Promise<void> {
	const scheduler = (globalThis as {scheduler?: Partial<YieldingScheduler>}).scheduler;

	if (scheduler && typeof scheduler.yield === "function") {
		return scheduler.yield();
	}

	return new Promise((resolve) => {
		const channel = new MessageChannel();

		channel.port1.onmessage = () => {
			channel.port1.close();
			resolve();
		};

		channel.port2.postMessage(null);
	});
}
