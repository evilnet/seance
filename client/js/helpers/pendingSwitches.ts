/**
 * Switches that ask the server for something and show the answer, not the
 * tap. The Me tab's user modes use it (`Oper/OperMe.vue`): a tap sends
 * `/umode ±X` and the switch shows the asked-for state until the server's
 * MODE line makes the real mode match it, or until the wait passes with
 * no such line — a refusal, which nefarious2 often answers with silence —
 * and then shows the real mode again. Without it a refused mode stayed on:
 * the box is one-way bound, the model never changed, so Vue never wrote
 * `checked` back.
 *
 * The wait grows with the queue: nefarious2 charges every command ~2 s of
 * fake lag and answers them in order, so the third of three quick taps is
 * answered ~6 s later. Each request waits `timeoutMs` plus `stepMs` for
 * every request still waiting ahead of it.
 *
 * Vue-free (test/helpers/pendingSwitches.ts); a component wraps it in
 * `reactive()` and `shown()` re-renders when a request settles.
 */

/** Server-side fake lag per command (docs/resources/nefarious2-websocket.md § Fake lag). */
export const FAKE_LAG_MS = 2000;

export class PendingSwitches {
	private wanted = new Map<string, {on: boolean; timer: ReturnType<typeof setTimeout>}>();

	private readonly timeoutMs: number;
	private readonly stepMs: number;

	constructor(timeoutMs: number, stepMs = FAKE_LAG_MS) {
		this.timeoutMs = timeoutMs;
		this.stepMs = stepMs;
	}

	/** The user asked for `key` to be `on`. */
	request(key: string, on: boolean): void {
		const old = this.wanted.get(key);

		if (old) {
			clearTimeout(old.timer);
			this.wanted.delete(key);
		}

		const ahead = this.wanted.size;
		const timer = setTimeout(() => {
			this.wanted.delete(key);
		}, this.timeoutMs + ahead * this.stepMs);
		this.wanted.set(key, {on, timer});
	}

	/** The real state moved: drop every request it now satisfies. */
	reconcile(actual: (key: string) => boolean): void {
		for (const [key, {on, timer}] of this.wanted) {
			if (actual(key) === on) {
				clearTimeout(timer);
				this.wanted.delete(key);
			}
		}
	}

	/** What the switch for `key` shows, given its real state. */
	shown(key: string, actual: boolean): boolean {
		return this.wanted.get(key)?.on ?? actual;
	}

	/** Whether `key` is waiting for the server. */
	isPending(key: string): boolean {
		return this.wanted.has(key);
	}

	dispose(): void {
		for (const {timer} of this.wanted.values()) {
			clearTimeout(timer);
		}

		this.wanted.clear();
	}
}
