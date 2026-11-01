// The reading-side scheduler (spec § queue.ts). One instance per network:
// a FIFO ordered by the caller's priority (the active channel first), then
// live lines before history ones, then arrival; one request in flight per
// engine so the GPU and CPU engines
// overlap, LLM items of one channel and pair batched as numbered lines,
// items that fell DROP_AFTER_LINES messages behind dropped, and an engine
// paused after PAUSE_AFTER_FAILURES consecutive failures — for
// PAUSE_RESUME_MS, since a pause is a minute off and not the end of
// reading, and never for a torn-down worker or a foreign abort, which put
// the batch back at the front of its engine's queue instead. A multi-line
// message is never batched with others and goes through the composer's own
// line logic (`translateDraft`), so every line of it is translated. The
// queue owns span restoration: items arrive protected and updates carry
// restored text — and since a message is protected when it arrives but
// routed when it runs, the marker form its engine reads (spans.ts
// `renderMarkers`) is chosen here, once the route has answered, and kept on
// the `Queued` record that both the request and the restore are built from.
// A line judged untranslated (an echo, a narration, an answered question)
// is retried once bare, the composer's `bareRetry` shape, before it fails.
// Vue-free; reader.ts feeds it and writes its updates to the store.

import {WORKER_DISPOSED} from "./client";
import {parseNeedsDownload} from "./consent";
import {
	BATCH_REFUSED,
	CONTEXT_OVERFLOW,
	Device,
	EngineName,
	type LineContext,
	PromptContext,
	TranslateChunk,
	TranslateRequest,
	emptyContext,
} from "./engine";
import {
	ABORTED,
	ANSWERED,
	DEGENERATE,
	EMPTY_TRANSLATION,
	NARRATION,
	type OutgoingDeps,
	REPETITION,
	UNCHANGED,
	armDeadline,
	hasNoLetters,
	isAnsweredQuestion,
	isDegenerate,
	isNarration,
	isRepetition,
	isUnchanged,
	tidyAnswer,
	translateDraft,
} from "./outgoing";
import {parseBatchedOutput} from "./prompt";
import {
	LLM_MARKERS,
	type Protected,
	type SpanMeta,
	renderMarkers,
	restore,
	restoreAll,
} from "./spans";

export const DROP_AFTER_LINES = 200;
export const BATCH_MAX_LINES = 6;
export const PAUSE_AFTER_FAILURES = 3;
/**
 * How long a paused engine waits before it tries again. A pause is meant to
 * stop a broken engine burning the battery, not to switch reading off for
 * the session: without this the only way back in was a user's retry on a
 * line that had already failed, so three background/return cycles on a
 * phone (each tearing the worker down mid-request) left every later line
 * pending for ever.
 */
export const PAUSE_RESUME_MS = 60 * 1000;
/**
 * How long a batch put back by a torn-down worker or a foreign abort waits
 * before its engine runs it again. Neither is the engine's failure, so
 * nothing is marked down — but nor is the line retried in a tight loop:
 * the wait is what keeps a worker that keeps dying to one attempt a second.
 */
export const REQUEUE_WAIT_MS = 1000;
export const REQUEST_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * The language model on the CPU (wllama, one thread): about 94 s for a cold
 * request and 16 s warm, so a batch is two lines, not six, and the deadline
 * is six minutes (translation-devices.md § The CPU context window). OPUS-MT
 * and NLLB-200 on the CPU are as quick as they always were: theirs stays
 * REQUEST_TIMEOUT_MS.
 */
export const CPU_BATCH_MAX_LINES = 2;
export const CPU_REQUEST_TIMEOUT_MS = 6 * 60 * 1000;

/** The language model on the CPU: the one route the longer figures are for. */
function slowLlm(engine: EngineName, device: Device): boolean {
	return engine === "llm" && device === "cpu";
}

function batchCapFor(engine: EngineName, device: Device): number {
	return slowLlm(engine, device) ? CPU_BATCH_MAX_LINES : BATCH_MAX_LINES;
}

function timeoutFor(engine: EngineName, device: Device): number {
	return slowLlm(engine, device) ? CPU_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
}

export const NO_ROUTE = "no translation engine can take this request";
export const TIMED_OUT = "timed out";

export interface QueueItem {
	/** The message's store id. */
	id: number;
	chanId: number;
	/** Protected text (spans.ts), its spans and what each of them is. */
	text: string;
	spans: string[];
	meta: SpanMeta[];
	/** null = the source language could not be detected. */
	from: string | null;
	to: string;
	context: PromptContext;
	/** `deps.arrivals(chanId)` when the item was queued. */
	arrivalsAtEnqueue: number;
	/** Never batch this item (a retry, or a batch that failed to parse). */
	single: boolean;
	/**
	 * Routing only (`TranslateRequest.hint`, never the prompt): a seq2seq
	 * route takes it as its source when `from` is null, so a line whose
	 * source the prompt must not name -- a weak verdict (detect.ts
	 * `sourceFor`) -- can still be routed on a CPU-only device. Left out, the
	 * item's `context.sourceHint` is the hint, as it was before the two were
	 * told apart.
	 */
	routeHint?: string | null;
	/**
	 * A history line (a join replay, or a page the reader loaded) rather
	 * than one that just arrived: it runs behind the channel's live items,
	 * and it is what a channel falling behind has left to drop.
	 */
	history?: true;
	/**
	 * This is the automatic bare retry of a line judged untranslated
	 * (`TranslateQueue.report`): it has had its second try, so the next
	 * judged failure is reported. A user's retry clears it.
	 */
	bare?: true;
}

export type QueueUpdate =
	| {status: "pending"; text: string; engine: EngineName}
	| {status: "done"; text: string; engine: EngineName}
	| {status: "failed"; error: string}
	| {status: "dropped"};

export interface QueueDeps {
	/**
	 * `hint` is the item's `routeHint`: a seq2seq route takes it as the
	 * source. A rejection fails the line with its message and counts toward
	 * no pause (a download the user declined, consent.ts).
	 */
	route(
		from: string | null,
		to: string,
		hint: string | null
	): Promise<{engine: EngineName; device: Device} | null>;
	translate(
		req: Omit<TranslateRequest, "id" | "model">,
		signal: AbortSignal
	): AsyncIterable<TranslateChunk>;
	/** Lower runs first; the active channel is 0. */
	priority(chanId: number): number;
	/** Messages that arrived in the channel so far (a counter the reader keeps). */
	arrivals(chanId: number): number;
	onUpdate(id: number, update: QueueUpdate): void;
	onPause(engine: EngineName, message: string): void;
	/**
	 * The engine runs again: the pause waited out (`PAUSE_RESUME_MS`) or
	 * someone asked for a line on it. The banner the pause raised clears
	 * here. Optional.
	 */
	onResume?(engine: EngineName): void;
	/**
	 * A counter that moves while a model downloads (service.ts `loadTicks`):
	 * the request deadline is re-armed while it moves (outgoing.ts
	 * `armDeadline`). Optional: without it the deadline is a plain timeout.
	 */
	loadTicks?(): number;
}

interface Queued {
	item: QueueItem;
	engine: EngineName;
	/** The device the route runs on: the batch cap and the deadline follow it. */
	device: Device;
	seq: number;
	/**
	 * The item's protected text in the marker form `engine` reads (spans.ts
	 * `renderMarkers`). The reader protects a message when it arrives, long
	 * before a route is resolved, so the form is chosen here — where the
	 * engine first becomes known — and the one `Protected` then both builds
	 * the request and restores the answer.
	 */
	info: Protected;
}

interface Running {
	chanIds: Set<number>;
	abort: () => void;
}

export class TranslateQueue {
	private waiting: Queued[] = [];
	private inFlight = new Map<EngineName, Running>();
	private failures = new Map<EngineName, number>();
	private pausedEngines = new Set<EngineName>();
	/** The pause's own resume timer, per engine; `resume()` disarms it.
	 *  The handle is whatever `this.timers()` hands back (`OutgoingDeps`). */
	private pauseTimers = new Map<EngineName, unknown>();
	/** Engines waiting out `REQUEUE_WAIT_MS` after a requeue: `pump()` skips them. */
	private requeueWaits = new Set<EngineName>();
	/** That wait's own timer, per engine, so `cancelAll()` can disarm it. */
	private requeueTimers = new Map<EngineName, unknown>();
	/** Per-channel generation, bumped by cancelChannel/cancelAll: a route
	 *  that resolves for an older generation is dropped instead of queued. */
	private cancelled = new Map<number, number>();
	/** Bumped by cancelAll alone: catches an item still mid-route for a
	 *  channel cancelAll never got to see (not yet in waiting or inFlight). */
	private globalGeneration = 0;
	private seq = 0;
	private held = false;
	private deps: QueueDeps;

	constructor(deps: QueueDeps) {
		this.deps = deps;
	}

	enqueue(item: QueueItem): void {
		this.enqueueAt(item, false);
	}

	retry(item: QueueItem): void {
		this.enqueueAt(
			{
				...item,
				single: true,
				bare: undefined,
				// Someone asked for this line now, so it is no longer history:
				// a burst of live chat must not push a retry to the back.
				history: undefined,
				arrivalsAtEnqueue: this.deps.arrivals(item.chanId),
			},
			true
		);
	}

	cancelChannel(chanId: number): void {
		this.bumpGeneration(chanId);

		const dropped = this.waiting.filter((q) => q.item.chanId === chanId);

		this.waiting = this.waiting.filter((q) => q.item.chanId !== chanId);

		for (const q of dropped) {
			this.deps.onUpdate(q.item.id, {status: "dropped"});
		}

		for (const running of this.inFlight.values()) {
			if (running.chanIds.has(chanId)) {
				running.abort();
			}
		}
	}

	cancelAll(): void {
		this.globalGeneration++;

		const channels = new Set<number>();

		for (const q of this.waiting) {
			channels.add(q.item.chanId);
		}

		for (const running of this.inFlight.values()) {
			for (const chanId of running.chanIds) {
				channels.add(chanId);
			}
		}

		for (const chanId of channels) {
			this.bumpGeneration(chanId);
		}

		for (const q of this.waiting.splice(0)) {
			this.deps.onUpdate(q.item.id, {status: "dropped"});
		}

		for (const running of this.inFlight.values()) {
			running.abort();
		}

		// Both of the queue's own waits go with everything else: a requeue
		// wait left running would pump a queue that was emptied under it, and
		// an engine whose wait is never cleared is skipped by `pump()` for the
		// rest of the session.
		const timers = this.timers();

		for (const [engine, timer] of this.requeueTimers) {
			timers.clearTimeout(timer);
			this.requeueWaits.delete(engine);
		}

		this.requeueTimers.clear();

		// A pause is about work that no longer exists, and disarming the timer
		// that would lift it would park the engine for good — so the pause is
		// lifted rather than merely disarmed, through the one door back in.
		// The lift is engine-wide and so is the banner it takes down
		// (`state.translation.paused` is keyed by engine, and there is one
		// queue for every network): a quit on one network clears a banner
		// another network's traffic raised on the same engine, and the next
		// failure there raises it again. That is the accepted cost — the
		// alternative leaves an engine nothing ever lifts, silently skipped
		// by `pump()` for the rest of the session.
		for (const engine of [...this.pausedEngines]) {
			this.resume(engine);
		}

		for (const timer of this.pauseTimers.values()) {
			timers.clearTimeout(timer);
		}

		this.pauseTimers.clear();
	}

	paused(engine: EngineName): boolean {
		return this.pausedEngines.has(engine);
	}

	/**
	 * The one door back in: the pause's own timer and a user's retry both
	 * come through here, so the failure count goes back to zero, the waiting
	 * timer is disarmed (a retry must not be followed by a second resume a
	 * minute later) and whatever raised the banner is told to take it down.
	 */
	resume(engine: EngineName): void {
		const timer = this.pauseTimers.get(engine);

		if (timer !== undefined) {
			this.timers().clearTimeout(timer);
			this.pauseTimers.delete(engine);
		}

		const was = this.pausedEngines.delete(engine);

		this.failures.set(engine, 0);

		if (was) {
			this.deps.onResume?.(engine);
		}

		this.pump();
	}

	size(): number {
		return this.waiting.length;
	}

	/**
	 * Hold new runs: a composer request has the engines (spec § Composer);
	 * an item already in flight finishes. Idempotent.
	 */
	hold(): void {
		this.held = true;
	}

	release(): void {
		this.held = false;
		this.pump();
	}

	pauseForTest(): void {
		this.hold();
	}

	resumeForTest(): void {
		this.release();
	}

	private generation(chanId: number): number {
		return this.cancelled.get(chanId) ?? 0;
	}

	private bumpGeneration(chanId: number): void {
		this.cancelled.set(chanId, this.generation(chanId) + 1);
	}

	/**
	 * `resumePaused`: a paused engine gets another chance (a user's retry);
	 * the automatic bare retry never un-pauses one. `noRouteError`: what a
	 * route that finds no engine reports instead of NO_ROUTE (the bare
	 * retry's judged failure, which is what the line actually suffered).
	 * `seq`: the place in line, given by a caller putting several items
	 * back at the front in their order (`resplit`).
	 */
	private enqueueAt(
		item: QueueItem,
		front: boolean,
		resumePaused = front,
		noRouteError = NO_ROUTE,
		seq?: number
	): void {
		const generation = this.generation(item.chanId);
		const globalGeneration = this.globalGeneration;

		void this.deps.route(item.from, item.to, routeHintOf(item)).then(
			(routed) => {
				if (
					this.generation(item.chanId) !== generation ||
					this.globalGeneration !== globalGeneration
				) {
					this.deps.onUpdate(item.id, {status: "dropped"});
					return;
				}

				if (!routed) {
					this.deps.onUpdate(item.id, {status: "failed", error: noRouteError});
					return;
				}

				const {engine, device} = routed;

				const queued: Queued = {
					item,
					engine,
					device,
					seq: seq ?? (front ? -++this.seq : ++this.seq),
					info: renderMarkers(
						protectedOf(item),
						engine === "llm" ? LLM_MARKERS : "placeholder"
					),
				};

				this.waiting.push(queued);

				if (resumePaused && this.pausedEngines.has(engine)) {
					// A retry is someone asking for this line now: the engine its
					// failures paused gets another chance rather than leaving the
					// item waiting for ever. resume() pumps.
					this.resume(engine);
				} else {
					this.pump();
				}
			},
			(e) => {
				this.deps.onUpdate(item.id, {
					status: "failed",
					error: e instanceof Error ? e.message : String(e),
				});
			}
		);
	}

	private pump(): void {
		if (this.held) {
			return;
		}

		this.prune();

		// The active channel first, then what is being said now over what was
		// said then (a history page the reader loaded, or a join replay),
		// then the order they were queued in.
		this.waiting.sort(
			(a, b) =>
				this.deps.priority(a.item.chanId) - this.deps.priority(b.item.chanId) ||
				Number(a.item.history ?? false) - Number(b.item.history ?? false) ||
				a.seq - b.seq
		);

		for (const engine of ["llm", "seq2seq"] as EngineName[]) {
			if (
				this.inFlight.has(engine) ||
				this.pausedEngines.has(engine) ||
				this.requeueWaits.has(engine)
			) {
				continue;
			}

			const head = this.takeHead(engine);

			if (head) {
				void this.run(engine, head);
			}
		}
	}

	/** Drops every waiting item that fell DROP_AFTER_LINES messages behind,
	 *  including an engine's that stays paused and never reaches takeHead. */
	private prune(): void {
		const stale = new Set(
			this.waiting.filter(
				(q) =>
					this.deps.arrivals(q.item.chanId) - q.item.arrivalsAtEnqueue > DROP_AFTER_LINES
			)
		);

		if (stale.size === 0) {
			return;
		}

		this.waiting = this.waiting.filter((q) => !stale.has(q));

		for (const q of stale) {
			this.deps.onUpdate(q.item.id, {status: "dropped"});
		}
	}

	private takeHead(engine: EngineName): Queued[] | null {
		const index = this.waiting.findIndex((q) => q.engine === engine);

		if (index < 0) {
			return null;
		}

		const head = this.waiting[index];

		this.waiting.splice(index, 1);

		if (engine !== "llm" || head.item.single || isMultiline(head.item)) {
			return [head];
		}

		const batch = [head];

		for (const q of [...this.waiting]) {
			if (batch.length >= batchCapFor(engine, head.device)) {
				break;
			}

			if (
				q.engine === engine &&
				q.device === head.device &&
				!q.item.single &&
				!isMultiline(q.item) &&
				q.item.chanId === head.item.chanId &&
				q.item.from === head.item.from &&
				q.item.to === head.item.to
			) {
				batch.push(q);
				this.waiting.splice(this.waiting.indexOf(q), 1);
			}
		}

		return batch;
	}

	private async run(engine: EngineName, batch: Queued[]): Promise<void> {
		const head = batch[0];
		const first = head.item;

		// A `draft/multiline` message is one message whose text carries
		// newlines. Sending it as one line would leave the engine's cut
		// keeping only the first, so it goes through the composer's own line
		// logic instead — numbered lines to an LLM, one line at a time to a
		// seq2seq engine, blank lines where they were.
		if (batch.length === 1 && isMultiline(first)) {
			await this.runMultiline(engine, head);
			return;
		}

		// Every item of a batch went through the same route, so the marker
		// form is the batch's, not each line's.
		const markers = head.info.markers;
		// The hint the head was routed on. Only LLM items batch, and the LLM
		// takes its source from the prompt rather than the hint, so a batch
		// whose lines were hinted differently is answered the same either way.
		const hint = routeHintOf(first);
		// The channel's own context -- the earlier lines, the topic, the names,
		// the terms -- is the head's and stands above the whole block; what a
		// line replies to is that line's alone, so it travels per line and the
		// prompt writes each note against its own number.
		const lineContexts = batch.map((q) => replyContext(q.item));
		const request: Omit<TranslateRequest, "id" | "model"> =
			batch.length > 1
				? {
						text: "",
						lines: batch.map((q) => q.info.text),
						from: first.from,
						hint,
						to: first.to,
						purpose: "read",
						context: first.context,
						markers,
						...(lineContexts.some((c) => c.replyTo) ? {lineContexts} : {}),
				  }
				: {
						text: head.info.text,
						from: first.from,
						hint,
						to: first.to,
						purpose: "read",
						context: first.context,
						markers,
				  };

		const controller = new AbortController();
		const iterator = this.deps.translate(request, controller.signal)[Symbol.asyncIterator]();
		let aborted = false;
		let timedOut = false;

		let signalAbort: () => void = () => {};

		const abortSignal = new Promise<void>((resolve) => {
			signalAbort = resolve;
		});
		const running: Running = {
			chanIds: new Set(batch.map((q) => q.item.chanId)),
			abort() {
				if (aborted) {
					return;
				}

				aborted = true;
				signalAbort();
				controller.abort();
				void iterator.return?.();
			},
		};

		this.inFlight.set(engine, running);

		for (const q of batch) {
			this.deps.onUpdate(q.item.id, {status: "pending", text: "", engine});
		}

		const timer = armDeadline(this.timers(), timeoutFor(head.engine, head.device), () => {
			timedOut = true;
			running.abort();
		});

		try {
			let last = "";

			for (;;) {
				const nextPromise = iterator.next().then((next) => ({kind: "next" as const, next}));

				// The loser of the race, if it later rejects (the stream threw
				// after a cancel already won), must not be an unhandled rejection.
				nextPromise.catch(() => {});

				const outcome = await Promise.race([
					nextPromise,
					abortSignal.then(() => ({kind: "abort" as const})),
				]);

				if (outcome.kind === "abort") {
					break;
				}

				if (outcome.next.done) {
					break;
				}

				const chunk = outcome.next.value;

				last = chunk.text;

				if (batch.length === 1 && !chunk.done) {
					this.deps.onUpdate(first.id, {
						status: "pending",
						text: this.restoreText(head.info, chunk.text, false),
						engine,
					});
				}
			}

			if (aborted) {
				if (timedOut) {
					this.fail(engine, batch, TIMED_OUT);
				} else {
					for (const q of batch) {
						this.deps.onUpdate(q.item.id, {status: "dropped"});
					}
				}

				return;
			}

			if (batch.length === 1) {
				this.report(engine, head, this.restoreText(head.info, last, true));
			} else {
				const lines = parseBatchedOutput(last, batch.length);

				if (!lines) {
					for (const q of batch) {
						this.waiting.push({...q, item: {...q.item, single: true}});
					}
				} else {
					batch.forEach((q, i) => {
						this.report(engine, q, this.restoreText(q.info, lines[i], true));
					});
				}
			}

			this.failures.set(engine, 0);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);

			// A worker torn down under the request, or an abort the queue did
			// not ask for, says nothing about the engine: the batch waits.
			// The queue's OWN abort usually leaves through the `aborted`
			// branch above, but an engine that rejects in the same turn the
			// cancel arrives lands here instead — and a line the reader
			// cancelled is dropped, not failed, or three cancels in a row
			// pause the engine. runMultiline has said so since it was
			// written.
			if (!aborted && notAFailure(message)) {
				this.requeue(engine, batch);
			} else if (!aborted && batch.length > 1 && message === BATCH_REFUSED) {
				this.resplit(batch);
			} else if (!aborted && message === CONTEXT_OVERFLOW) {
				this.overflowed(batch);
			} else if (aborted && !timedOut) {
				for (const q of batch) {
					this.deps.onUpdate(q.item.id, {status: "dropped"});
				}
			} else {
				this.fail(engine, batch, message);
			}
		} finally {
			timer.clear();
			this.inFlight.delete(engine);
			this.pump();
		}
	}

	/**
	 * A multi-line item, translated line by line through `translateDraft`
	 * (outgoing.ts): the same request shapes, the same fallback to singles
	 * when the numbering does not parse, the same protection — except that
	 * the text arrives protected, so the whole message's spans are one
	 * numbering and a fenced block is one of them.
	 */
	private async runMultiline(engine: EngineName, queued: Queued): Promise<void> {
		const item = queued.item;
		const info = queued.info;
		const controller = new AbortController();

		let aborted = false;
		let timedOut = false;

		let signalAbort: () => void = () => {};

		// Raced against the work, the way run() races the iterator: a cancel
		// frees the engine at once even if the stream behind it takes its
		// time noticing the signal.
		const abortRace = new Promise<{kind: "abort"}>((resolve) => {
			signalAbort = () => resolve({kind: "abort"});
		});
		const running: Running = {
			chanIds: new Set([item.chanId]),
			abort() {
				if (aborted) {
					return;
				}

				aborted = true;
				signalAbort();
				controller.abort();
			},
		};
		const deps: OutgoingDeps = {
			translate: (req, signal) => this.deps.translate(req, signal),
			setTimeout: (fn, ms) => setTimeout(fn, ms),
			clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
			loadTicks: () => this.deps.loadTicks?.() ?? 0,
		};

		this.inFlight.set(engine, running);
		this.deps.onUpdate(item.id, {status: "pending", text: "", engine});

		const timer = armDeadline(this.timers(), timeoutFor(queued.engine, queued.device), () => {
			timedOut = true;
			running.abort();
		});

		try {
			const work = translateDraft(
				deps,
				{
					text: info.text,
					protected: info,
					from: item.from,
					hint: routeHintOf(item),
					to: item.to,
					purpose: "read",
					context: item.context,
					batches: engine === "llm",
					markers: info.markers,
					device: queued.device,
					engine,
				},
				controller.signal,
				(partial) => {
					if (!aborted) {
						this.deps.onUpdate(item.id, {status: "pending", text: partial, engine});
					}
				}
			).then((text) => ({kind: "done" as const, text}));

			// The loser of the race, if it later rejects, must not be an
			// unhandled rejection.
			work.catch(() => {});

			const outcome = await Promise.race([work, abortRace]);

			if (outcome.kind === "abort") {
				if (timedOut) {
					this.fail(engine, [queued], TIMED_OUT);
				} else {
					this.deps.onUpdate(item.id, {status: "dropped"});
				}

				return;
			}

			this.report(engine, queued, outcome.text);
			this.failures.set(engine, 0);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);

			// The queue's own abort is a drop (or the deadline); a torn-down
			// worker or an abort from elsewhere puts the line back, still
			// pending; anything else is this engine's failure, and three in a
			// row pause it.
			if (timedOut) {
				this.fail(engine, [queued], TIMED_OUT);
			} else if (aborted) {
				this.deps.onUpdate(item.id, {status: "dropped"});
			} else if (notAFailure(message)) {
				this.requeue(engine, [queued]);
			} else if (message === CONTEXT_OVERFLOW) {
				this.overflowed([queued]);
			} else {
				this.fail(engine, [queued], message);
			}
		} finally {
			timer.clear();
			this.inFlight.delete(engine);
			this.pump();
		}
	}

	/**
	 * An answer, reported as the translation or as the failure it is. A
	 * translation that came back as the original (the model echoing rather
	 * than translating) or with nothing in it a language could be is the
	 * *answer's* failure, not the engine's: it never goes through `fail()`,
	 * so it marks nothing down and counts toward no pause — the engine did
	 * complete, and the line keeps its chip with Retry / Retranslate from…
	 * Both sides of the comparison are restored (`restoreAll`), so whichever
	 * marker form the route chose cancels out.
	 *
	 * An echo, a loop, a narration or an answered question is first retried once,
	 * bare (`retryBare`), the way the composer retries a draft: measured on
	 * casual English chat lines the bare shape translated all 8 of Qwen3-4B's
	 * echoes and 2 of Qwen3-1.7B's 5. Only a second such answer is reported.
	 */
	private report(engine: EngineName, q: Queued, answer: string): void {
		const original = restoreAll(q.info.text, q.info);
		// The model's packaging off first (a preamble about the translation, a
		// wrapper round the whole answer), so the checks and the store see the
		// translation itself.
		const text = tidyAnswer(original, answer);

		if (hasNoLetters(text)) {
			this.deps.onUpdate(q.item.id, {status: "failed", error: EMPTY_TRANSLATION});
			return;
		}

		// A model stuck repeating a word ("ekki ekki ekki …") has not
		// translated the line, and the engine did complete: judged like the
		// narration below, retried once bare as the composer retries it
		// (writer.ts), and counted toward no pause. Judged before the
		// degenerate rule, which covers a shorter word loop too, because
		// "got stuck repeating itself" is the truer report of one.
		if (isRepetition(text) && !isRepetition(original)) {
			this.failJudged(q, REPETITION);
			return;
		}

		// Symbol garbage the model padded its answer with (dozens of dots, a
		// tilde run), or a word four times over, is no more a translation
		// than a letterless answer: judged the same way.
		if (isDegenerate(text, original)) {
			this.failJudged(q, DEGENERATE);
			return;
		}

		// The model talking about the request ("okay, let's see. The user
		// wants …") is no more a translation than an echo is, and no more the
		// engine's fault.
		if (isNarration(original, text)) {
			this.failJudged(q, NARRATION);
			return;
		}

		// A question answered rather than translated ("what time does it
		// start?" → "It starts at nine.") is not a translation either, and
		// not the engine's failure.
		if (isAnsweredQuestion(original, text, q.item.to)) {
			this.failJudged(q, ANSWERED);
			return;
		}

		if (isUnchanged(original, text)) {
			this.failJudged(q, UNCHANGED);
			return;
		}

		this.deps.onUpdate(q.item.id, {status: "done", text, engine});
	}

	/**
	 * The request did not fit the GPU model's context window (engine.ts
	 * `CONTEXT_OVERFLOW`): every line again bare and alone, in its order —
	 * the context is what made it long — and a line that was already bare
	 * fails. The engine did nothing wrong, so nothing here goes through
	 * `fail` and it counts toward no pause; and the line is never put back
	 * as it was (`requeue`), which would overflow again.
	 */
	private overflowed(batch: Queued[]): void {
		const base = (this.seq += batch.length);

		batch.forEach((q, index) => {
			if (q.item.bare) {
				this.deps.onUpdate(q.item.id, {status: "failed", error: CONTEXT_OVERFLOW});
			} else {
				this.retryBare(q.item, CONTEXT_OVERFLOW, -(base - index));
			}
		});
	}

	/** A judged failure: the bare retry if the line has not had it, else failed. */
	private failJudged(q: Queued, error: string): void {
		if (q.item.bare) {
			this.deps.onUpdate(q.item.id, {status: "failed", error});
			return;
		}

		this.retryBare(q.item, error);
	}

	/**
	 * The line again in the composer's bare shape (outgoing.ts `bareRetry`,
	 * which takes an `OutgoingRequest` and so is duplicated here): the source
	 * left to the model, the context emptied but for formality and variant,
	 * and the source kept as the routing hint a seq2seq route reads. It goes
	 * to the front, like a user's retry, since the line is on screen now, and
	 * is dropped by whatever drops a queued item; its status stays pending.
	 */
	private retryBare(item: QueueItem, error: string, seq?: number): void {
		const context = emptyContext();

		context.formality = item.context.formality;

		if (item.context.variant) {
			context.variant = item.context.variant;
		}

		// The existing hint first, then the source, as `bareRetry` orders them.
		const hint = item.context.sourceHint ?? item.from;

		if (hint) {
			context.sourceHint = hint;
		}

		this.enqueueAt(
			{
				...item,
				from: null,
				context,
				single: true,
				bare: true,
				history: undefined,
				arrivalsAtEnqueue: this.deps.arrivals(item.chanId),
			},
			true,
			false,
			error,
			seq
		);
	}

	/** The request deadline's timers: the page's own, and the service's load counter. */
	private timers(): Pick<OutgoingDeps, "setTimeout" | "clearTimeout" | "loadTicks"> {
		return {
			setTimeout: (fn, ms) => setTimeout(fn, ms),
			clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
			loadTicks: () => this.deps.loadTicks?.() ?? 0,
		};
	}

	private fail(engine: EngineName, batch: Queued[], message: string): void {
		for (const q of batch) {
			this.deps.onUpdate(q.item.id, {status: "failed", error: message});
		}

		// A download the user said "not now" to (consent.ts) is their answer,
		// not the engine failing: it counts toward no pause, or a channel of
		// queued lines would take the engine out for a minute. (A line too
		// long for the context window never comes here: `overflowed`.)
		if (parseNeedsDownload(message)) {
			return;
		}

		const count = (this.failures.get(engine) ?? 0) + 1;

		this.failures.set(engine, count);

		if (count >= PAUSE_AFTER_FAILURES) {
			this.pausedEngines.add(engine);
			this.deps.onPause(engine, message);
			this.waitOutPause(engine);
		}
	}

	/** A pause is a minute off, not the end of reading: `resume()` after it. */
	private waitOutPause(engine: EngineName): void {
		const existing = this.pauseTimers.get(engine);
		const timers = this.timers();

		if (existing !== undefined) {
			timers.clearTimeout(existing);
		}

		this.pauseTimers.set(
			engine,
			timers.setTimeout(() => {
				this.pauseTimers.delete(engine);
				this.resume(engine);
			}, PAUSE_RESUME_MS)
		);
	}

	/**
	 * Not this engine's failure: the worker was torn down under the request
	 * (a pagehide, an idle unload) or something outside the queue aborted
	 * it. The batch goes back to the front of its engine's queue with its
	 * entries still pending — nothing is marked failed and nothing counts
	 * toward a pause — and the engine waits `REQUEUE_WAIT_MS` before it is
	 * pumped again, so a worker that keeps dying is retried rather than spun.
	 */
	private requeue(engine: EngineName, batch: Queued[]): void {
		// One base for the whole batch, counting down through it: a sequence
		// number of its own per item made the last line the most negative and
		// the batch came back reversed, so the reader read a paragraph from
		// the bottom up.
		const base = (this.seq += batch.length);

		batch.forEach((q, index) => {
			this.waiting.push({...q, seq: -(base - index)});
		});

		this.requeueWaits.add(engine);

		const timers = this.timers();

		this.requeueTimers.set(
			engine,
			timers.setTimeout(() => {
				this.requeueTimers.delete(engine);
				this.requeueWaits.delete(engine);
				this.pump();
			}, REQUEUE_WAIT_MS)
		);
	}

	/**
	 * A batch the route sent to an engine that does not batch: the GPU
	 * model was switched off, or failed to load and was marked down, after
	 * the lines were batched for it (the service routes again at run time).
	 * Not the engine's failure -- nothing is failed and nothing counts
	 * toward a pause -- so every line goes back to the front as a single,
	 * in its order, and is routed again: its marker form is the new
	 * engine's (`enqueueAt` renders it), not the LLM's it was batched with.
	 */
	private resplit(batch: Queued[]): void {
		const base = (this.seq += batch.length);

		batch.forEach((q, index) => {
			this.enqueueAt({...q.item, single: true}, true, false, NO_ROUTE, -(base - index));
		});
	}

	/** Missing spans (spans.ts) are appended only to the final text: a
	 *  streaming chunk restores placeholders in place but does not yet know
	 *  whether a later chunk will still be missing one. */
	private restoreText(info: Protected, text: string, final: boolean): string {
		return final ? restoreAll(text, info) : restore(text, info.spans, info.meta).text;
	}
}

/** The item's protected text as spans.ts hands it around: the reader's own
 *  canonical protection, marker pairs still numbered. */
function protectedOf(item: QueueItem): Protected {
	return {text: item.text, spans: item.spans, meta: item.meta, markers: "placeholder"};
}

/**
 * What the router is told about the source (`QueueItem.routeHint`): an item
 * from before the prompt's hint and the router's were told apart carries
 * only the one.
 */
function routeHintOf(item: QueueItem): string | null {
	return item.routeHint !== undefined ? item.routeHint : item.context.sourceHint ?? null;
}

/** What a batched line replies to, as the request carries it (`LineContext`). */
function replyContext(item: QueueItem): LineContext {
	return item.context.replyTo ? {replyTo: item.context.replyTo} : {};
}

/** A `draft/multiline` message: one message, several lines. */
function isMultiline(item: QueueItem): boolean {
	return item.text.includes("\n");
}

/**
 * An error that is not the engine's: the worker was disposed under the
 * request, or something outside the queue aborted it. The line is put back
 * rather than failed (`TranslateQueue.requeue`).
 */
function notAFailure(message: string): boolean {
	return message === WORKER_DISPOSED || message === ABORTED;
}
