import {expect} from "chai";
import sinon from "ts-sinon";
import {WORKER_DISPOSED} from "../../client/js/translate/client";
import {
	BATCH_REFUSED,
	emptyContext,
	type TranslateChunk,
	type TranslateRequest,
} from "../../client/js/translate/engine";
import {
	ABORTED,
	ANSWERED,
	EMPTY_TRANSLATION,
	NARRATION,
	REPETITION,
	UNCHANGED,
} from "../../client/js/translate/outgoing";
import {
	BATCH_MAX_LINES,
	CPU_BATCH_MAX_LINES,
	CPU_REQUEST_TIMEOUT_MS,
	DROP_AFTER_LINES,
	PAUSE_AFTER_FAILURES,
	PAUSE_RESUME_MS,
	REQUEST_TIMEOUT_MS,
	REQUEUE_WAIT_MS,
	TranslateQueue,
	type QueueDeps,
	type QueueItem,
	type QueueUpdate,
} from "../../client/js/translate/queue";
import {placeholder, protect} from "../../client/js/translate/spans";

type Script = (req: Omit<TranslateRequest, "id" | "model">) => string[] | Error;

function rig(script: Script = (req) => [`[en] ${req.lines ? req.lines.join(" | ") : req.text}`]) {
	const clock = sinon.useFakeTimers();
	const updates: [number, QueueUpdate][] = [];
	const requests: Omit<TranslateRequest, "id" | "model">[] = [];
	const paused: [string, string][] = [];
	const resumed: string[] = [];
	const arrivals = new Map<number, number>();
	let engineFor: (from: string | null, to: string) => "llm" | "seq2seq" | null = () => "llm";
	let deviceFor: (engine: string) => "gpu" | "cpu" = () => "gpu";
	const deps: QueueDeps = {
		route(from, to, _hint) {
			const engine = engineFor(from, to);

			return Promise.resolve(engine ? {engine, device: deviceFor(engine)} : null);
		},
		translate(req, _signal) {
			requests.push(req);
			return (async function* (): AsyncIterable<TranslateChunk> {
				await Promise.resolve();
				const out = script(req);

				if (out instanceof Error) {
					throw out;
				}

				for (const text of out) {
					yield {id: 0, text, done: false};
				}

				yield {id: 0, text: out[out.length - 1], done: true};
			})();
		},
		priority: (chanId) => (chanId === 1 ? 0 : chanId),
		arrivals: (chanId) => arrivals.get(chanId) ?? 0,
		onUpdate: (id, update) => updates.push([id, update]),
		onPause: (engine, message) => paused.push([engine, message]),
		onResume: (engine) => resumed.push(engine),
	};
	const queue = new TranslateQueue(deps);

	return {
		queue,
		deps,
		clock,
		updates,
		requests,
		paused,
		resumed,
		arrivals,
		setEngine(fn: typeof engineFor) {
			engineFor = fn;
		},
		setDevice(fn: typeof deviceFor) {
			deviceFor = fn;
		},
	};
}

function item(id: number, text: string, overrides: Partial<QueueItem> = {}): QueueItem {
	const protectedText = protect(text);

	return {
		id,
		chanId: 1,
		text: protectedText.text,
		spans: protectedText.spans,
		meta: protectedText.meta,
		from: "de",
		to: "en",
		context: emptyContext(),
		arrivalsAtEnqueue: 0,
		single: false,
		...overrides,
	};
}

async function settle(clock: sinon.SinonFakeTimers, rounds = 20) {
	for (let i = 0; i < rounds; i++) {
		await clock.tickAsync(1);
	}
}

describe("translate/queue", () => {
	let clock: sinon.SinonFakeTimers | null = null;

	afterEach(() => {
		clock?.restore();
		clock = null;
	});

	// The marker form is the route's, and the route is only known here: a
	// message is protected when it arrives (reader.ts), so the queue renders
	// its pairs for whichever engine took it (spans.ts `renderMarkers`).
	it("sends the marks themselves to the LLM and numbered pairs to seq2seq", async () => {
		const r = rig((req) => [`[en] ${req.text}`]);
		clock = r.clock;
		r.queue.enqueue(item(1, "das ist *wichtig*"));
		await settle(r.clock);

		expect(r.requests[0].text).to.equal("das ist *wichtig*");
		expect(r.requests[0].markers).to.equal("literal");

		r.setEngine(() => "seq2seq");
		r.queue.enqueue(item(2, "das ist *wichtig*"));
		await settle(r.clock);

		expect(r.requests[1].text).to.equal(`das ist ${placeholder(1)}wichtig${placeholder(2)}`);
		expect(r.requests[1].markers).to.equal("placeholder");

		// Either way the reader is shown one thing: the marks, around the
		// words the engine put them around.
		expect(
			r.updates
				.filter(([, u]) => u.status === "done")
				.map(([, u]) => (u as {text: string}).text)
		).to.deep.equal(["[en] das ist *wichtig*", "[en] das ist *wichtig*"]);
	});

	// The prompt's hint and the router's are two different things (detect.ts
	// `sourceFor`): a weak verdict must not put "probably Vietnamese" in
	// front of the model, but a seq2seq route has no other way to know a
	// source, and on a CPU-only device an unhinted request routes nowhere.
	it("routes on the item's routeHint and leaves the prompt's source hint alone", async () => {
		const r = rig((req) => [`[en] ${req.text}`]);
		clock = r.clock;

		const hints: (string | null)[] = [];
		const route = r.deps.route.bind(r.deps);

		r.deps.route = (from, to, hint) => {
			hints.push(hint);
			return route(from, to, hint);
		};

		r.setEngine(() => "seq2seq");
		r.queue.enqueue(
			item(1, "das ist eine zeile hier", {
				from: null,
				routeHint: "de",
				context: emptyContext(),
			})
		);
		await settle(r.clock);

		expect(hints).to.deep.equal(["de"]);
		expect(r.requests[0].hint).to.equal("de");
		expect(r.requests[0].from).to.equal(null);
		expect(r.requests[0].context.sourceHint).to.equal(undefined);

		// An item from before the two were told apart still routes on its
		// prompt hint.
		r.queue.enqueue(
			item(2, "eine weitere zeile hier", {
				from: null,
				context: {...emptyContext(), sourceHint: "fr"},
			})
		);
		await settle(r.clock);

		expect(hints).to.deep.equal(["de", "fr"]);
		expect(r.requests[1].hint).to.equal("fr");
	});

	it("translates one item, streaming, and restores the placeholders", async () => {
		const r = rig((req) => [`[en] ${req.text}`]);
		clock = r.clock;
		r.queue.enqueue(item(1, "siehe https://x.test bitte"));
		await settle(r.clock);

		expect(r.updates.map(([id, u]) => [id, u.status])).to.deep.equal([
			[1, "pending"],
			[1, "pending"],
			[1, "done"],
		]);
		expect(r.updates[2][1].text).to.equal("[en] siehe https://x.test bitte");
		expect(r.updates[2][1].engine).to.equal("llm");
		expect(r.requests[0].purpose).to.equal("read");
	});

	it("the active channel goes first, then arrival order", async () => {
		const r = rig();
		clock = r.clock;
		r.queue.pauseForTest();
		r.queue.enqueue(item(10, "eins zwei drei", {chanId: 2}));
		r.queue.enqueue(item(11, "vier fünf sechs", {chanId: 2, from: "fr"}));
		r.queue.enqueue(item(12, "sieben acht neun", {chanId: 1, from: "es"}));
		await settle(r.clock, 3);
		r.queue.resumeForTest();
		await settle(r.clock);

		expect(r.requests.map((q) => q.from)).to.deep.equal(["es", "de", "fr"]);
	});

	// What is being said now over what was said then: a history line (a join
	// replay, or a page the reader loaded) waits behind its channel's live
	// items whatever order they were queued in.
	it("a live item runs before the history items queued before it", async () => {
		const r = rig((req) => {
			if (!req.lines) {
				return [`[en] ${req.text}`];
			}

			return [req.lines.map((line, i) => `${i + 1}. [en] ${line}`).join("\n") + "\nEND"];
		});

		clock = r.clock;
		r.queue.pauseForTest();

		for (let i = 1; i <= 5; i++) {
			r.queue.enqueue(item(i, `alte zeile ${i} hier`, {history: true, from: "fr"}));
		}

		r.queue.enqueue(item(10, "das ist gerade eben"));
		await settle(r.clock, 3);
		r.queue.resumeForTest();
		await settle(r.clock);

		// The live line alone first, then the five history lines as one batch.
		expect(r.requests.map((q) => q.from)).to.deep.equal(["de", "fr"]);
		expect(r.requests[0].text).to.equal("das ist gerade eben");
		expect(r.requests[1].lines?.length).to.equal(5);
	});

	// A retry is someone asking for that line now, so it stops being
	// history: a burst of live chat must not push it to the back.
	it("a retried history item is no longer held behind live lines", async () => {
		const r = rig();
		clock = r.clock;
		r.queue.pauseForTest();
		r.queue.enqueue(item(10, "das ist gerade eben", {from: "de"}));
		r.queue.retry(item(1, "alte zeile hier", {history: true, from: "fr"}));
		await settle(r.clock, 3);
		r.queue.resumeForTest();
		await settle(r.clock);

		expect(r.requests.map((q) => q.from)).to.deep.equal(["fr", "de"]);
	});

	it("history items are what a channel that fell behind has left to drop", async () => {
		const r = rig();
		clock = r.clock;
		r.queue.pauseForTest();

		// The page the reader loaded, queued when the channel had seen
		// nothing; then DROP_AFTER_LINES live lines arrive, the last of them
		// queued for translation too.
		for (let i = 1; i <= 5; i++) {
			r.queue.enqueue(
				item(i, `alte zeile ${i} hier`, {history: true, from: "fr", arrivalsAtEnqueue: 0})
			);
		}

		r.arrivals.set(1, DROP_AFTER_LINES + 1);
		r.queue.enqueue(item(10, "das ist gerade eben", {arrivalsAtEnqueue: DROP_AFTER_LINES + 1}));
		await settle(r.clock, 3);
		r.queue.resumeForTest();
		await settle(r.clock);

		expect(r.updates.filter(([, u]) => u.status === "dropped").map(([id]) => id)).to.deep.equal(
			[1, 2, 3, 4, 5]
		);
		expect(r.requests.map((q) => q.text)).to.deep.equal(["das ist gerade eben"]);
	});

	it("runs one request per engine, so the GPU and CPU engines overlap", async () => {
		const r = rig();
		clock = r.clock;
		r.setEngine((from) => (from === "de" ? "llm" : "seq2seq"));
		let inFlight = 0;
		let peak = 0;
		// eslint-disable-next-line @typescript-eslint/unbound-method
		const original = r.deps.translate;

		r.deps.translate = (req, signal) => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			const stream = original(req, signal);
			return (async function* () {
				for await (const chunk of stream) {
					yield chunk;
				}

				inFlight--;
			})();
		};

		r.queue.enqueue(item(1, "eins zwei drei"));
		r.queue.enqueue(item(2, "quatre cinq six", {from: "fr"}));
		r.queue.enqueue(item(3, "vier fünf sechs"));
		await settle(r.clock);

		expect(peak).to.equal(2);
		expect(r.updates.filter(([, u]) => u.status === "done").length).to.equal(3);
	});

	it("batches queued LLM items of one channel and pair, up to BATCH_MAX_LINES", async () => {
		const r = rig((req) => {
			if (!req.lines) {
				return [`[en] ${req.text}`];
			}

			return [req.lines.map((line, i) => `${i + 1}. [en] ${line}`).join("\n") + "\nEND"];
		});
		clock = r.clock;
		r.queue.pauseForTest();

		for (let i = 1; i <= BATCH_MAX_LINES + 2; i++) {
			r.queue.enqueue(item(i, `zeile ${i} hier`));
		}

		await settle(r.clock, 3);
		r.queue.resumeForTest();
		await settle(r.clock);

		expect(r.requests.length).to.equal(2);
		expect(r.requests[0].lines?.length).to.equal(BATCH_MAX_LINES);
		expect(r.requests[1].lines?.length).to.equal(2);
		const done = r.updates.filter(([, u]) => u.status === "done");

		expect(done.length).to.equal(BATCH_MAX_LINES + 2);
		expect(done[0][1].text).to.equal("[en] zeile 1 hier");
	});

	it("a CPU language model batches at most CPU_BATCH_MAX_LINES lines", async () => {
		const r = rig((req) =>
			req.lines
				? [req.lines.map((line, i) => `${i + 1}. [en] ${line}`).join("\n") + "\nEND"]
				: [`[en] ${req.text}`]
		);
		clock = r.clock;
		r.setDevice(() => "cpu");
		r.queue.pauseForTest();

		for (let i = 1; i <= CPU_BATCH_MAX_LINES + 1; i++) {
			r.queue.enqueue(item(i, `zeile ${i} hier`));
		}

		await settle(r.clock, 3);
		r.queue.resumeForTest();
		await settle(r.clock);

		expect(r.requests.length).to.equal(2);
		expect(r.requests[0].lines?.length).to.equal(CPU_BATCH_MAX_LINES);
	});

	it("a batch never mixes devices", async () => {
		const r = rig((req) =>
			req.lines
				? [req.lines.map((line, i) => `${i + 1}. [en] ${line}`).join("\n") + "\nEND"]
				: [`[en] ${req.text}`]
		);
		clock = r.clock;
		let n = 0;

		r.setDevice(() => (n++ === 0 ? "gpu" : "cpu"));
		r.queue.pauseForTest();
		r.queue.enqueue(item(1, "zeile eins hier"));
		r.queue.enqueue(item(2, "zeile zwei hier"));
		await settle(r.clock, 3);
		r.queue.resumeForTest();
		await settle(r.clock);

		expect(r.requests.length).to.equal(2);
		expect(r.requests.every((q) => !q.lines)).to.equal(true);
	});

	describe("the deadline", () => {
		const run = async (
			engine: "llm" | "seq2seq",
			device: "gpu" | "cpu",
			text = "eins zwei drei"
		) => {
			const r = rig();
			const c = r.clock;

			r.setEngine(() => engine);
			r.setDevice(() => device);
			r.deps.translate = (_req, _signal) =>
				(async function* () {
					await new Promise<void>(() => {});
					yield {id: 0, text: "never", done: true};
				})();
			r.queue.enqueue(item(1, text, {single: true}));
			await settle(c, 3);
			await c.tickAsync(REQUEST_TIMEOUT_MS + 1);
			await settle(c);
			const after = r.updates.filter(([id]) => id === 1).map(([, u]) => u.status);

			await c.tickAsync(CPU_REQUEST_TIMEOUT_MS - REQUEST_TIMEOUT_MS);
			await settle(c);
			const end = r.updates.filter(([id]) => id === 1).map(([, u]) => u.status);

			c.restore();

			return {after, end};
		};

		it("is CPU_REQUEST_TIMEOUT_MS for the language model on the CPU, REQUEST_TIMEOUT_MS on the GPU", async () => {
			expect((await run("llm", "gpu")).after).to.deep.equal(["pending", "failed"]);
			const cpu = await run("llm", "cpu");

			expect(cpu.after).to.deep.equal(["pending"]);
			expect(cpu.end).to.deep.equal(["pending", "failed"]);
		});

		it("stays REQUEST_TIMEOUT_MS for OPUS-MT or NLLB-200 on the CPU", async () => {
			expect((await run("seq2seq", "cpu")).after).to.deep.equal(["pending", "failed"]);
			// A multi-line message goes through translateDraft: the same rule.
			expect((await run("seq2seq", "cpu", "zeile eins\nzeile zwei")).after).to.deep.equal([
				"pending",
				"failed",
			]);
			const llm = await run("llm", "cpu", "zeile eins\nzeile zwei");

			expect(llm.after).to.deep.equal(["pending"]);
			expect(llm.end).to.deep.equal(["pending", "failed"]);
		});
	});

	it("a batch whose numbering does not match is redone one line at a time", async () => {
		let batched = 0;
		const r = rig((req) => {
			if (req.lines) {
				batched++;
				return ["1. only one line"];
			}

			return [`[en] ${req.text}`];
		});
		clock = r.clock;
		r.queue.pauseForTest();
		r.queue.enqueue(item(1, "eins zwei drei"));
		r.queue.enqueue(item(2, "vier fünf sechs"));
		await settle(r.clock, 3);
		r.queue.resumeForTest();
		await settle(r.clock);

		expect(batched).to.equal(1);
		expect(r.requests.filter((q) => !q.lines).length).to.equal(2);
		expect(r.updates.filter(([, u]) => u.status === "done").map(([id]) => id)).to.deep.equal([
			1, 2,
		]);
	});

	describe("a multi-line message", () => {
		const MULTILINE = "erste Zeile hier\nzweite Zeile hier\ndritte Zeile hier";
		const numbered: Script = (req) =>
			req.lines
				? [req.lines.map((line, i) => `${i + 1}. [en] ${line}`).join("\n") + "\nEND"]
				: [`[en] ${req.text}`];

		it("goes to an LLM as one numbered request and comes back with its lines", async () => {
			const r = rig(numbered);
			clock = r.clock;
			r.queue.enqueue(item(1, MULTILINE));
			await settle(r.clock, 40);

			expect(r.requests).to.have.length(1);
			expect(r.requests[0].lines).to.deep.equal([
				"erste Zeile hier",
				"zweite Zeile hier",
				"dritte Zeile hier",
			]);

			const done = r.updates.find(([id, u]) => id === 1 && u.status === "done");

			expect(done?.[1].text).to.equal(
				"[en] erste Zeile hier\n[en] zweite Zeile hier\n[en] dritte Zeile hier"
			);
		});

		it("goes to a seq2seq engine one line at a time", async () => {
			const r = rig(numbered);
			clock = r.clock;
			r.setEngine(() => "seq2seq");
			r.queue.enqueue(item(1, MULTILINE));
			await settle(r.clock, 40);

			expect(r.requests.map((q) => q.text)).to.deep.equal([
				"erste Zeile hier",
				"zweite Zeile hier",
				"dritte Zeile hier",
			]);

			const done = r.updates.find(([id, u]) => id === 1 && u.status === "done");

			expect(done?.[1].text.split("\n")).to.have.length(3);
		});

		it("is never batched with the single-line items around it", async () => {
			const r = rig(numbered);
			clock = r.clock;
			r.queue.pauseForTest();
			r.queue.enqueue(item(1, MULTILINE));
			r.queue.enqueue(item(2, "eine kurze Zeile"));
			r.queue.enqueue(item(3, "noch eine kurze"));
			await settle(r.clock, 3);
			r.queue.resumeForTest();
			await settle(r.clock, 40);

			// The multi-line message's own batch, then the two short lines
			// batched together — never one request carrying all three.
			expect(r.requests.map((q) => q.lines?.length ?? 0)).to.deep.equal([3, 2]);
			expect(r.updates.filter(([, u]) => u.status === "done")).to.have.length(3);
		});

		it("keeps a fenced code block whole and does not send it for translation", async () => {
			const r = rig(numbered);
			clock = r.clock;
			r.queue.enqueue(item(1, "schau mal hier\n```\nx = 1\n```\nund das war es"));
			await settle(r.clock, 40);

			expect(r.requests).to.have.length(1);
			expect(r.requests[0].lines).to.have.length(2);

			const done = r.updates.find(([id, u]) => id === 1 && u.status === "done");

			expect(done?.[1].text).to.equal(
				"[en] schau mal hier\n```\nx = 1\n```\n[en] und das war es"
			);
		});

		it("reports the engine's failure instead of losing the message", async () => {
			const r = rig(() => new Error("boom"));
			clock = r.clock;
			r.queue.enqueue(item(1, MULTILINE));
			await settle(r.clock, 40);

			expect(r.updates.map(([, u]) => u.status)).to.deep.equal(["pending", "failed"]);
			expect(
				r.updates.find(([, u]) => u.status === "failed")?.[1] as {error: string}
			).to.deep.include({error: "boom"});
		});

		it("a cancelled channel drops it rather than failing it", async () => {
			const r = rig(numbered);
			clock = r.clock;
			r.deps.translate = (_req, _signal) =>
				(async function* () {
					await new Promise<void>(() => {});
					yield {id: 0, text: "never", done: true};
				})();
			r.queue.enqueue(item(1, MULTILINE));
			await settle(r.clock, 5);
			r.queue.cancelChannel(1);
			await settle(r.clock, 40);

			expect(r.updates.map(([, u]) => u.status)).to.deep.equal(["pending", "dropped"]);
		});
	});

	it("drops an item that fell more than DROP_AFTER_LINES messages behind", async () => {
		const r = rig();
		clock = r.clock;
		r.queue.pauseForTest();
		r.queue.enqueue(item(1, "alt und vergessen", {arrivalsAtEnqueue: 0}));
		r.arrivals.set(1, DROP_AFTER_LINES + 1);
		await settle(r.clock, 3);
		r.queue.resumeForTest();
		await settle(r.clock);

		expect(r.requests.length).to.equal(0);
		expect(r.updates).to.deep.equal([[1, {status: "dropped"}]]);
	});

	it("a stale item is pruned on the next pump even while its own engine stays paused", async () => {
		const r = rig(() => new Error("boom"));
		clock = r.clock;

		for (let i = 1; i <= PAUSE_AFTER_FAILURES; i++) {
			r.queue.enqueue(item(i, `zeile ${i} hier`, {single: true}));
		}

		await settle(r.clock);
		expect(r.queue.paused("llm")).to.equal(true);

		r.queue.enqueue(item(100, "alt und vergessen"));
		r.arrivals.set(1, DROP_AFTER_LINES + 1);

		r.setEngine(() => "seq2seq");
		r.queue.enqueue(item(200, "andere sprache", {chanId: 2}));
		await settle(r.clock);

		expect(r.updates.filter(([id]) => id === 100)).to.deep.equal([[100, {status: "dropped"}]]);
		expect(r.queue.paused("llm")).to.equal(true);
	});

	it("a failure is reported and three in a row pause the engine", async () => {
		const r = rig(() => new Error("boom"));
		clock = r.clock;

		for (let i = 1; i <= PAUSE_AFTER_FAILURES + 1; i++) {
			r.queue.enqueue(item(i, `zeile ${i} hier`, {single: true}));
		}

		await settle(r.clock);

		expect(r.updates.filter(([, u]) => u.status === "failed").length).to.equal(
			PAUSE_AFTER_FAILURES
		);
		expect(r.updates.filter(([, u]) => u.status === "failed")[0][1].error).to.equal("boom");
		expect(r.paused).to.deep.equal([["llm", "boom"]]);
		expect(r.queue.paused("llm")).to.equal(true);
		expect(r.queue.size()).to.equal(1);

		r.queue.resume("llm");
		await settle(r.clock);
		expect(r.requests.length).to.equal(PAUSE_AFTER_FAILURES + 1);
	});

	it("a retry resumes the engine its failures paused", async () => {
		let failing = true;
		const r = rig((req) => (failing ? new Error("boom") : [`[en] ${req.text}`]));
		clock = r.clock;

		for (let i = 1; i <= PAUSE_AFTER_FAILURES; i++) {
			r.queue.enqueue(item(i, `zeile ${i} hier`, {single: true}));
		}

		await settle(r.clock);
		expect(r.queue.paused("llm")).to.equal(true);

		// The chip's retry, with nobody having resumed the engine: the item
		// would otherwise stay pending behind the pause for ever.
		failing = false;
		r.queue.retry(item(1, "zeile 1 hier"));
		await settle(r.clock);

		expect(r.queue.paused("llm")).to.equal(false);
		expect(r.updates.filter(([id, u]) => id === 1 && u.status === "done")).to.have.length(1);
	});

	// An answer equal to what went in is the *answer's* failure, not the
	// engine's: the engine completed, it just did not translate. Three of
	// them must not pause it the way three real failures would, since the
	// next line may well be one it can do.
	it("fails a line the engine handed back, and never pauses for it", async () => {
		const r = rig((req) => {
			const text = req.lines ? req.lines.join("\n") : req.text;

			return [text.includes("echo") ? text : `[en] ${text}`];
		});

		clock = r.clock;

		for (let i = 1; i <= PAUSE_AFTER_FAILURES; i++) {
			r.queue.enqueue(item(i, `das ist echo zeile ${i} hier`, {single: true}));
		}

		await settle(r.clock);

		const failed = r.updates.filter(([, u]) => u.status === "failed");

		expect(failed).to.deep.equal([
			[1, {status: "failed", error: UNCHANGED}],
			[2, {status: "failed", error: UNCHANGED}],
			[3, {status: "failed", error: UNCHANGED}],
		]);
		// Each line had its bare retry before it failed: two answers apiece,
		// six judged failures, and still no pause.
		expect(r.requests).to.have.length(2 * PAUSE_AFTER_FAILURES);
		expect(r.requests.filter((req) => req.from === null)).to.have.length(PAUSE_AFTER_FAILURES);
		expect(r.paused).to.deep.equal([]);
		expect(r.queue.paused("llm")).to.equal(false);

		// The engine is still the route for the next line, and it runs.
		r.queue.enqueue(item(4, "eine ganz normale zeile hier", {single: true}));
		await settle(r.clock);

		const done = r.updates.filter(([, u]) => u.status === "done");

		expect(done.map(([id]) => id)).to.deep.equal([4]);
		expect(done[0][1].text).to.equal("[en] eine ganz normale zeile hier");
	});

	it("fails an answer that talks about the request, without pausing the engine", async () => {
		const r = rig((req) => [
			`okay, let's see. The user wants the translation of "${
				req.lines ? req.lines[0] : req.text
			}" into English.`,
		]);
		clock = r.clock;
		r.queue.enqueue(item(1, "das ist eine zeile hier", {single: true}));
		await settle(r.clock);

		expect(r.updates.filter(([, u]) => u.status === "failed")).to.deep.equal([
			[1, {status: "failed", error: NARRATION}],
		]);
		expect(r.requests.map((req) => req.from)).to.deep.equal(["de", null]);
		expect(r.paused).to.deep.equal([]);
		expect(r.queue.paused("llm")).to.equal(false);
	});

	it("fails a question answered instead of translated, without pausing the engine", async () => {
		const r = rig((req) => [
			(req.lines ? req.lines[0] : req.text).includes("?")
				? "It starts at nine."
				: `[en] ${req.text}`,
		]);
		clock = r.clock;

		for (let id = 1; id <= PAUSE_AFTER_FAILURES; id++) {
			r.queue.enqueue(item(id, "wann beginnt das Treffen morgen?", {single: true}));
		}

		await settle(r.clock);

		expect(r.updates.filter(([, u]) => u.status === "failed")).to.deep.equal([
			[1, {status: "failed", error: ANSWERED}],
			[2, {status: "failed", error: ANSWERED}],
			[3, {status: "failed", error: ANSWERED}],
		]);
		expect(r.requests).to.have.length(2 * PAUSE_AFTER_FAILURES);
		expect(r.paused).to.deep.equal([]);
		expect(r.queue.paused("llm")).to.equal(false);

		// A translated question keeps its mark and is a translation.
		r.queue.enqueue(item(4, "das Treffen beginnt morgen um neun", {single: true}));
		await settle(r.clock);

		expect(r.updates.filter(([, u]) => u.status === "done").map(([id]) => id)).to.deep.equal([
			4,
		]);
	});

	it("does not judge a question translated into a target that drops the mark", async () => {
		const r = rig(() => ["明日の会議は何時に始まりますか"]);
		clock = r.clock;
		r.queue.enqueue(item(1, "wann beginnt das Treffen morgen?", {single: true, to: "ja"}));
		await settle(r.clock);

		expect(r.updates.filter(([, u]) => u.status === "done").map(([id]) => id)).to.deep.equal([
			1,
		]);
	});

	it("fails an answer stuck repeating itself, without pausing the engine", async () => {
		const r = rig(() => ["Höfðu ekki ekki ekki ekki ekki ekki ekki ekki"]);
		clock = r.clock;

		for (let id = 1; id <= PAUSE_AFTER_FAILURES; id++) {
			r.queue.enqueue(item(id, "hast du das nicht gesehen", {single: true}));
		}

		await settle(r.clock);

		expect(r.updates.filter(([, u]) => u.status === "failed")).to.deep.equal([
			[1, {status: "failed", error: REPETITION}],
			[2, {status: "failed", error: REPETITION}],
			[3, {status: "failed", error: REPETITION}],
		]);
		// A loop is retried once, bare, like the composer retries it: two
		// answers per line, and still no pause.
		expect(r.requests).to.have.length(PAUSE_AFTER_FAILURES * 2);
		expect(r.requests.filter((req) => req.from === null)).to.have.length(PAUSE_AFTER_FAILURES);
		expect(r.paused).to.deep.equal([]);
		expect(r.queue.paused("llm")).to.equal(false);
	});

	it("fails an answer with nothing in it a language could be", async () => {
		const r = rig(() => ["⟹"]);
		clock = r.clock;
		r.queue.enqueue(item(1, "das ist eine zeile hier"));
		await settle(r.clock);

		expect(r.updates.filter(([, u]) => u.status === "failed")).to.deep.equal([
			[1, {status: "failed", error: EMPTY_TRANSLATION}],
		]);
		expect(r.requests).to.have.length(1);
		expect(r.paused).to.deep.equal([]);
	});

	// Measured on the web build's weights, the shipped prompts hand back 5
	// (Qwen3-1.7B) and 8 (Qwen3-4B) of 45 casual English lines, and the
	// composer's bare shape translated all of 4B's and 2 of 1.7B's: the
	// reading queue gives a line judged untranslated the same one retry.
	it("retries a line judged untranslated once, bare, and reports the translation", async () => {
		const seen = new Set<string>();
		const r = rig((req) => {
			const text = req.lines ? req.lines.join("\n") : req.text;

			if (!seen.has(text)) {
				seen.add(text);
				return [text];
			}

			return [`[en] ${text}`];
		});
		clock = r.clock;

		const hints: (string | null)[] = [];
		const route = r.deps.route.bind(r.deps);

		r.deps.route = (from, to, hint) => {
			hints.push(hint);
			return route(from, to, hint);
		};

		r.queue.enqueue(
			item(1, "das ist eine zeile hier", {
				context: {
					...emptyContext(),
					recent: [{nick: "anna", text: "hallo"}],
					replyTo: {nick: "anna", text: "hallo"},
					topic: "Thema",
					names: ["anna"],
					terms: [["Zug", "train"]],
					formality: "formal",
					variant: "en-GB",
				},
			})
		);
		await settle(r.clock);

		expect(r.requests).to.have.length(2);
		expect(r.requests[1].from).to.equal(null);
		expect(r.requests[1].lines).to.equal(undefined);
		expect(r.requests[1].text).to.equal("das ist eine zeile hier");
		expect(r.requests[1].context).to.deep.equal({
			...emptyContext(),
			formality: "formal",
			variant: "en-GB",
			sourceHint: "de",
		});
		expect(hints).to.deep.equal([null, "de"]);
		expect(r.updates.filter(([, u]) => u.status === "failed")).to.deep.equal([]);
		expect(r.updates.filter(([, u]) => u.status === "done")).to.deep.equal([
			[1, {status: "done", text: "[en] das ist eine zeile hier", engine: "llm"}],
		]);

		// An unknown source keeps the detector's guess as the hint.
		r.queue.enqueue(
			item(2, "une autre ligne ici", {
				from: null,
				context: {...emptyContext(), sourceHint: "fr"},
			})
		);
		await settle(r.clock);

		expect(r.requests).to.have.length(4);
		expect(r.requests[3].context.sourceHint).to.equal("fr");
		expect(r.updates.filter(([, u]) => u.status === "failed")).to.deep.equal([]);
	});

	it("retries a batch line judged unchanged alone", async () => {
		const r = rig((req) =>
			req.lines
				? [
						req.lines
							.map(
								(line, i) =>
									`${i + 1}. ${line.includes("echo") ? line : `[en] ${line}`}`
							)
							.join("\n") + "\nEND",
				  ]
				: [`[en] ${req.text}`]
		);
		clock = r.clock;
		r.queue.pauseForTest();
		r.queue.enqueue(item(1, "das ist echo eins hier"));
		r.queue.enqueue(item(2, "das ist zwei hier"));
		r.queue.enqueue(item(3, "das ist drei hier"));
		await settle(r.clock, 3);
		r.queue.resumeForTest();
		await settle(r.clock);

		expect(r.requests).to.have.length(2);
		expect(r.requests[0].lines).to.have.length(3);
		expect(r.requests[1].lines).to.equal(undefined);
		expect(r.requests[1].text).to.equal("das ist echo eins hier");
		expect(r.requests[1].from).to.equal(null);
		expect(r.updates.filter(([, u]) => u.status === "failed")).to.deep.equal([]);
		expect(r.updates.filter(([, u]) => u.status === "done").map(([id]) => id)).to.have.members([
			1, 2, 3,
		]);
	});

	it("sends no bare retry for a line dropped before it runs", async () => {
		const r = rig((req) => {
			// The answer is about to be judged: hold the queue so the retry
			// waits, the way a busy engine would make it.
			r.queue.hold();
			return [req.text];
		});
		clock = r.clock;
		r.queue.enqueue(item(1, "das ist eine zeile hier"));
		await settle(r.clock);

		expect(r.queue.size()).to.equal(1);

		r.queue.cancelChannel(1);
		r.queue.release();
		await settle(r.clock);

		expect(r.requests).to.have.length(1);
		expect(r.updates.filter(([, u]) => u.status === "failed")).to.deep.equal([]);
		expect(r.updates[r.updates.length - 1]).to.deep.equal([1, {status: "dropped"}]);
	});

	it("a user's retry of a line that failed bare gets its own bare retry", async () => {
		const r = rig((req) => [req.text]);
		clock = r.clock;
		const first = item(1, "das ist eine zeile hier");

		r.queue.enqueue(first);
		await settle(r.clock);
		r.queue.retry(first);
		await settle(r.clock);

		expect(r.requests.map((req) => req.from)).to.deep.equal(["de", null, "de", null]);
		expect(r.updates.filter(([, u]) => u.status === "failed")).to.deep.equal([
			[1, {status: "failed", error: UNCHANGED}],
			[1, {status: "failed", error: UNCHANGED}],
		]);
		expect(r.paused).to.deep.equal([]);
	});

	// Both sides of the comparison are restored, so whichever marker form
	// the route chose (spans.ts `renderMarkers`) cancels out: the LLM's own
	// marks and a seq2seq placeholder are both recognised as the line in.
	it("recognises an echo whichever marker form the route chose", async () => {
		const r = rig((req) => [req.text]);
		clock = r.clock;
		r.queue.enqueue(item(1, "das ist *wichtig* hier"));
		await settle(r.clock);

		expect(r.requests[0].text).to.equal("das ist *wichtig* hier");
		expect(r.requests[0].markers).to.equal("literal");

		r.setEngine(() => "seq2seq");
		r.queue.enqueue(item(2, "siehe https://x.test bitte hier"));
		await settle(r.clock);

		// Item 1's bare retry went out in between, so the seq2seq request is
		// found by what it carries.
		expect(r.requests.map((req) => req.text)).to.include(`siehe ${placeholder(1)} bitte hier`);
		expect(r.updates.filter(([, u]) => u.status === "failed")).to.deep.equal([
			[1, {status: "failed", error: UNCHANGED}],
			[2, {status: "failed", error: UNCHANGED}],
		]);
	});

	it("fails each echoed line of a batch, and an echoed multi-line message", async () => {
		const r = rig((req) =>
			req.lines
				? [req.lines.map((line, i) => `${i + 1}. ${line}`).join("\n") + "\nEND"]
				: [req.text]
		);

		clock = r.clock;
		r.queue.pauseForTest();
		r.queue.enqueue(item(1, "eins zwei drei hier"));
		r.queue.enqueue(item(2, "vier fünf sechs hier"));
		await settle(r.clock, 3);
		r.queue.resumeForTest();
		await settle(r.clock);

		expect(r.requests[0].lines).to.have.length(2);
		expect(r.updates.filter(([, u]) => u.status === "failed")).to.deep.equal([
			[1, {status: "failed", error: UNCHANGED}],
			[2, {status: "failed", error: UNCHANGED}],
		]);

		r.queue.enqueue(item(3, "erste Zeile hier\nzweite Zeile hier"));
		await settle(r.clock, 40);

		expect(r.updates.filter(([id, u]) => id === 3 && u.status === "failed")).to.deep.equal([
			[3, {status: "failed", error: UNCHANGED}],
		]);
		expect(r.paused).to.deep.equal([]);
	});

	it("a route that rejects fails the item instead of losing it", async () => {
		const r = rig();
		clock = r.clock;
		r.deps.route = () => Promise.reject(new Error("router exploded"));
		r.queue.enqueue(item(1, "eins zwei drei"));
		await settle(r.clock);

		expect(r.updates).to.deep.equal([[1, {status: "failed", error: "router exploded"}]]);
	});

	it("an item with an unknown source routes and translates with from: null", async () => {
		const r = rig();
		clock = r.clock;
		const routedWith: [string | null, string | null][] = [];
		// eslint-disable-next-line @typescript-eslint/unbound-method
		const originalRoute = r.deps.route;

		r.deps.route = (from, to, hint) => {
			routedWith.push([from, hint]);
			return originalRoute(from, to, hint);
		};

		r.queue.enqueue(
			item(1, "bonjour", {from: null, context: {...emptyContext(), sourceHint: "fr"}})
		);
		await settle(r.clock);

		// The hint goes to the router, which may send a seq2seq request with it.
		expect(routedWith).to.deep.equal([[null, "fr"]]);
		expect(r.requests[0].from).to.equal(null);
		expect(r.updates.filter(([, u]) => u.status === "done").length).to.equal(1);
	});

	it("appends missing spans only to the final text, not a streaming chunk", async () => {
		const r = rig(() => ["step one no url", "step two no url"]);
		clock = r.clock;
		r.queue.enqueue(item(1, "siehe https://x.test bitte"));
		await settle(r.clock);

		const pending = r.updates.filter(([id, u]) => id === 1 && u.status === "pending");
		const done = r.updates.find(([id, u]) => id === 1 && u.status === "done");

		expect(pending[1][1].text).to.equal("step one no url");
		expect(pending[2][1].text).to.equal("step two no url");
		expect(done?.[1].text).to.equal("step two no url https://x.test");
	});

	it("cancelChannel drops queued items and the in-flight one of that channel", async () => {
		let release: (() => void) | null = null;
		const r = rig();
		clock = r.clock;
		let calls = 0;
		r.deps.translate = (_req, _signal) =>
			(async function* () {
				if (calls++ === 0) {
					await new Promise<void>((resolve) => {
						release = resolve;
					});
				}

				yield {id: 0, text: "late", done: true};
			})();
		r.queue.enqueue(item(1, "eins zwei drei", {single: true}));
		r.queue.enqueue(item(2, "vier fünf sechs", {chanId: 2, single: true}));
		await settle(r.clock, 3);
		r.queue.cancelChannel(1);
		release?.();
		await settle(r.clock);

		expect(r.updates.filter(([id]) => id === 1).map(([, u]) => u.status)).to.deep.equal([
			"pending",
			"dropped",
		]);
		expect(r.updates.filter(([id]) => id === 2).map(([, u]) => u.status)).to.include("done");
	});

	it("cancelChannel calls the iterator's return, so a cancel reaches an engine that never yields", async () => {
		const r = rig();
		clock = r.clock;
		let returned = false;

		r.deps.translate = (_req, _signal) => ({
			[Symbol.asyncIterator]: () => ({
				next: () => new Promise<IteratorResult<TranslateChunk>>(() => {}),
				return(value?: unknown) {
					returned = true;
					return Promise.resolve({done: true as const, value});
				},
			}),
		});
		r.queue.enqueue(item(1, "eins zwei drei", {single: true}));
		await settle(r.clock, 3);
		r.queue.cancelChannel(1);
		await settle(r.clock);

		expect(returned).to.equal(true);
		expect(r.updates.filter(([id]) => id === 1).map(([, u]) => u.status)).to.deep.equal([
			"pending",
			"dropped",
		]);
	});

	it("a request that never yields fails as timed out after REQUEST_TIMEOUT_MS", async () => {
		const r = rig();
		clock = r.clock;
		r.deps.translate = (_req, _signal) =>
			(async function* () {
				await new Promise<void>(() => {});
				yield {id: 0, text: "never", done: true};
			})();
		r.queue.enqueue(item(1, "eins zwei drei", {single: true}));
		await settle(r.clock, 3);
		await clock.tickAsync(REQUEST_TIMEOUT_MS);
		await settle(r.clock);

		expect(r.updates.filter(([id]) => id === 1).map(([, u]) => u.status)).to.deep.equal([
			"pending",
			"failed",
		]);
		expect(
			r.updates.find(([id, u]) => id === 1 && u.status === "failed")?.[1] as {error: string}
		).to.deep.include({error: "timed out"});
	});

	it("the deadline waits while a model downloads and fires once the download stalls", async () => {
		const r = rig();
		clock = r.clock;
		let ticks = 0;

		r.deps.loadTicks = () => ticks;
		r.deps.translate = (_req, _signal) =>
			(async function* () {
				await new Promise<void>(() => {});
				yield {id: 0, text: "never", done: true};
			})();
		r.queue.enqueue(item(1, "eins zwei drei", {single: true}));
		await settle(r.clock, 3);

		// Three deadlines' worth of download progress: never timed out.
		for (let i = 0; i < 3; i++) {
			ticks += 5;
			await clock.tickAsync(REQUEST_TIMEOUT_MS);
		}

		expect(r.updates.filter(([id]) => id === 1).map(([, u]) => u.status)).to.deep.equal([
			"pending",
		]);

		// The download stalls: one more deadline and the line fails.
		await clock.tickAsync(REQUEST_TIMEOUT_MS);
		await settle(r.clock);

		expect(r.updates.filter(([id]) => id === 1).map(([, u]) => u.status)).to.deep.equal([
			"pending",
			"failed",
		]);
	});

	it("cancelChannel aborts the signal the queue handed to deps.translate", async () => {
		const r = rig();
		clock = r.clock;
		let sawSignal: AbortSignal | null = null;

		r.deps.translate = (_req, signal) => {
			sawSignal = signal;
			return (async function* () {
				await new Promise<void>(() => {});
				yield {id: 0, text: "never", done: true};
			})();
		};

		r.queue.enqueue(item(1, "eins zwei drei", {single: true}));
		await settle(r.clock, 3);

		expect(sawSignal?.aborted).to.equal(false);
		r.queue.cancelChannel(1);
		await settle(r.clock);

		expect(sawSignal?.aborted).to.equal(true);
	});

	it("cancelAll drops an item still mid-route", async () => {
		const r = rig();
		clock = r.clock;
		let resolveRoute: ((engine: "llm" | "seq2seq" | null) => void) | null = null;

		r.deps.route = () =>
			new Promise((resolve) => {
				resolveRoute = resolve;
			});
		r.queue.enqueue(item(1, "eins zwei drei"));
		r.queue.cancelAll();
		resolveRoute?.("llm");
		await settle(r.clock);

		expect(r.updates).to.deep.equal([[1, {status: "dropped"}]]);
		expect(r.requests.length).to.equal(0);
	});

	it("route-after-cancel: cancelling before the route resolves drops the item", async () => {
		const r = rig();
		clock = r.clock;
		let resolveRoute: ((engine: "llm" | "seq2seq" | null) => void) | null = null;

		r.deps.route = () =>
			new Promise((resolve) => {
				resolveRoute = resolve;
			});
		r.queue.enqueue(item(1, "eins zwei drei"));
		r.queue.cancelChannel(1);
		resolveRoute?.("llm");
		await settle(r.clock);

		expect(r.updates).to.deep.equal([[1, {status: "dropped"}]]);
		expect(r.requests.length).to.equal(0);
	});

	it("retry re-enqueues an item at the front", async () => {
		let fail = true;
		const r = rig((req) => (fail ? new Error("once") : [`[en] ${req.text}`]));
		clock = r.clock;
		const first = item(1, "eins zwei drei", {single: true});
		r.queue.enqueue(first);
		await settle(r.clock);
		fail = false;
		r.queue.pauseForTest();
		r.queue.enqueue(item(2, "vier fünf sechs", {single: true}));
		r.queue.retry(first);
		await settle(r.clock, 3);
		r.queue.resumeForTest();
		await settle(r.clock);

		expect(r.requests.map((q) => q.text)).to.deep.equal([
			"eins zwei drei",
			"eins zwei drei",
			"vier fünf sechs",
		]);
	});

	it("an item with no route fails at once", async () => {
		const r = rig();
		clock = r.clock;
		r.setEngine(() => null);
		r.queue.enqueue(item(1, "eins zwei drei"));
		await settle(r.clock);

		expect(r.updates).to.deep.equal([
			[1, {status: "failed", error: "no translation engine can take this request"}],
		]);
	});

	// A worker torn down under a running request (the pagehide teardown, or a
	// cancel that reached the client) says nothing about the engine: the line
	// is put back at the front of its engine's queue, still pending, and no
	// failure is counted -- three background/return cycles on a phone used to
	// pause the engine for the rest of the session.
	it("a torn-down worker is not a failure: the line waits, still pending", async () => {
		let disposed = true;
		const r = rig((req) => (disposed ? new Error(WORKER_DISPOSED) : [`[en] ${req.text}`]));
		clock = r.clock;
		r.queue.enqueue(item(1, "eins zwei drei", {single: true}));
		await settle(r.clock);

		expect(r.updates.map(([, u]) => u.status)).to.deep.equal(["pending"]);
		expect(r.requests.length).to.equal(1);
		expect(r.paused).to.deep.equal([]);

		// It waits rather than spinning, then tries again.
		await r.clock.tickAsync(REQUEUE_WAIT_MS);
		await settle(r.clock);
		expect(r.requests.length).to.equal(2);

		disposed = false;
		await r.clock.tickAsync(REQUEUE_WAIT_MS);
		await settle(r.clock);

		expect(r.updates[r.updates.length - 1]).to.deep.equal([
			1,
			{status: "done", text: "[en] eins zwei drei", engine: "llm"},
		]);
	});

	it("an abort the queue did not ask for is not a failure either", async () => {
		let abort = true;
		const r = rig((req) => (abort ? new Error(ABORTED) : [`[en] ${req.text}`]));
		clock = r.clock;
		r.queue.enqueue(item(1, "eins zwei drei", {single: true}));
		await settle(r.clock);

		expect(r.updates.map(([, u]) => u.status)).to.deep.equal(["pending"]);
		expect(r.paused).to.deep.equal([]);

		abort = false;
		await r.clock.tickAsync(REQUEUE_WAIT_MS);
		await settle(r.clock);

		expect(r.updates[r.updates.length - 1][1].status).to.equal("done");
	});

	// The queue's own abort usually wins the race against the request and
	// leaves through the `aborted` branch, but it does not have to: an engine
	// that rejects with ABORTED in the same turn the cancel arrives lands in
	// the catch instead, and a cancelled line is not the engine's failure.
	// runMultiline() has said so since it was written; run() had not.
	it("an abort that lands as a rejection is dropped, not failed", async () => {
		const r = rig();
		clock = r.clock;
		// The cancel and the rejection in one turn, hand-rolled rather than a
		// generator so that the rejection is queued before the abort is: this
		// is the ordering that reaches the catch with `aborted` already set.
		r.deps.translate = () =>
			({
				[Symbol.asyncIterator]: () => ({
					next() {
						r.queue.cancelChannel(1);
						return Promise.reject(new Error(ABORTED));
					},
				}),
			} as AsyncIterable<TranslateChunk>);

		r.queue.enqueue(item(1, "eins zwei drei", {single: true}));
		await settle(r.clock);

		expect(r.updates.map(([, u]) => u.status)).to.deep.equal(["pending", "dropped"]);
		expect(r.paused).to.deep.equal([]);
		expect(r.queue.paused("llm")).to.equal(false);
	});

	// The route is fixed when a line is queued and resolved again when it
	// runs (service.ts): a batch made for the GPU model that now routes to a
	// seq2seq engine (the model switched off, or failing to load) is
	// refused. Each line goes again on its own, in order, with the new
	// engine's marker form -- never failed, and never a pause of the GPU
	// lane with the refusal on its banner.
	it("a batch refused by an engine that does not batch goes again line by line", async () => {
		const r = rig((req) => (req.lines ? new Error(BATCH_REFUSED) : [`[en] ${req.text}`]));
		clock = r.clock;
		r.queue.pauseForTest();

		for (let i = 1; i <= 3; i++) {
			r.queue.enqueue(item(i, `zeile *${i}* hier`));
		}

		await settle(r.clock, 3);

		// Batched for the LLM; the GPU model goes before the batch runs.
		r.setEngine(() => "seq2seq");
		r.queue.resumeForTest();
		await settle(r.clock);

		expect(r.requests[0].lines).to.have.length(3);
		const singles = r.requests.slice(1);

		expect(singles.map((q) => q.lines)).to.deep.equal([undefined, undefined, undefined]);
		expect(singles.map((q) => q.markers)).to.deep.equal([
			"placeholder",
			"placeholder",
			"placeholder",
		]);
		expect(r.updates.filter(([, u]) => u.status === "failed")).to.deep.equal([]);
		expect(r.updates.filter(([, u]) => u.status === "done")).to.deep.equal([
			[1, {status: "done", text: "[en] zeile *1* hier", engine: "seq2seq"}],
			[2, {status: "done", text: "[en] zeile *2* hier", engine: "seq2seq"}],
			[3, {status: "done", text: "[en] zeile *3* hier", engine: "seq2seq"}],
		]);
		expect(r.paused).to.deep.equal([]);
	});

	it("a requeued batch goes back in the order it was sent in", async () => {
		let disposed = true;
		const r = rig((req) =>
			disposed
				? new Error(WORKER_DISPOSED)
				: [
						(req.lines ?? [req.text])
							.map((line, i) => `${i + 1}. [en] ${line}`)
							.join("\n") + "\nEND",
				  ]
		);
		clock = r.clock;

		r.queue.pauseForTest();

		for (let i = 1; i <= 3; i++) {
			r.queue.enqueue(item(i, `zeile ${i} hier`));
		}

		await settle(r.clock);
		r.queue.resumeForTest();
		await settle(r.clock);
		expect(r.requests.length).to.equal(1);
		expect(r.requests[0].lines).to.have.length(3);

		disposed = false;
		await r.clock.tickAsync(REQUEUE_WAIT_MS);
		await settle(r.clock);

		expect(r.requests.length).to.equal(2);
		// Each item was pushed with its own more-negative sequence number, so
		// the batch came back reversed and the reader read line 3 first.
		expect(r.requests[1].lines).to.deep.equal(r.requests[0].lines);
	});

	it("cancelAll clears the requeue wait and the pause timer it left behind", async () => {
		const r = rig(() => new Error(WORKER_DISPOSED));
		clock = r.clock;
		r.queue.enqueue(item(1, "eins zwei drei", {single: true}));
		await settle(r.clock);

		expect(r.requests.length).to.equal(1);

		r.queue.cancelAll();
		await settle(r.clock);

		// The engine is free again straight away: the wait was cancelled with
		// everything else, rather than left running to pump a queue that was
		// emptied under it.
		r.deps.translate = (req) =>
			(async function* (): AsyncIterable<TranslateChunk> {
				await Promise.resolve();
				yield {id: 0, text: `[en] ${req.text}`, done: true};
			})();
		r.queue.enqueue(item(2, "vier fuenf sechs", {single: true}));
		await settle(r.clock);

		expect(r.updates[r.updates.length - 1]).to.deep.equal([
			2,
			{status: "done", text: "[en] vier fuenf sechs", engine: "llm"},
		]);
	});

	it("cancelAll lifts a pause rather than clearing the timer that would lift it", async () => {
		let fail = true;
		const r = rig((req) => (fail ? new Error("boom") : [`[en] ${req.text}`]));
		clock = r.clock;

		for (let i = 1; i <= PAUSE_AFTER_FAILURES; i++) {
			r.queue.enqueue(item(i, `zeile ${i} hier`, {single: true}));
		}

		await settle(r.clock);
		expect(r.queue.paused("llm")).to.equal(true);

		r.queue.cancelAll();
		await settle(r.clock);

		// Everything the pause was about is gone, so the pause goes with it —
		// disarming its resume timer and leaving the engine paused would have
		// parked it for the rest of the session. It goes through resume(), so
		// the banner comes down with it: the one caller is reader.ts on a
		// network's `quit`, and a "translation paused" banner for a network
		// that is no longer there is worse than none.
		expect(r.queue.paused("llm")).to.equal(false);
		expect(r.resumed).to.deep.equal(["llm"]);

		fail = false;
		r.queue.enqueue(item(9, "vier fuenf sechs", {single: true}));
		await settle(r.clock);

		expect(r.updates[r.updates.length - 1][1].status).to.equal("done");
	});

	it("a paused engine resumes on its own after a minute, and pauses again if it must", async () => {
		let fail = true;
		const r = rig((req) => (fail ? new Error("boom") : [`[en] ${req.text}`]));
		clock = r.clock;

		for (let i = 1; i <= PAUSE_AFTER_FAILURES; i++) {
			r.queue.enqueue(item(i, `zeile ${i} hier`, {single: true}));
		}

		await settle(r.clock);
		expect(r.queue.paused("llm")).to.equal(true);
		expect(r.paused.length).to.equal(1);
		expect(r.resumed).to.deep.equal([]);

		// A line queued while the engine is paused waits for the resume.
		r.queue.enqueue(item(10, "nach der pause", {single: true}));
		await settle(r.clock);
		expect(r.requests.length).to.equal(PAUSE_AFTER_FAILURES);

		fail = false;
		await r.clock.tickAsync(PAUSE_RESUME_MS);
		await settle(r.clock);

		expect(r.resumed).to.deep.equal(["llm"]);
		expect(r.queue.paused("llm")).to.equal(false);
		expect(r.requests.length).to.equal(PAUSE_AFTER_FAILURES + 1);
		expect(r.updates[r.updates.length - 1][1].status).to.equal("done");

		// The failure counter went back to zero with the resume, so it takes a
		// fresh run of failures to pause it again -- and that pause waits too.
		fail = true;

		for (let i = 20; i < 20 + PAUSE_AFTER_FAILURES; i++) {
			r.queue.enqueue(item(i, `wieder ${i} hier`, {single: true}));
		}

		await settle(r.clock);
		expect(r.paused.length).to.equal(2);

		fail = false;
		r.queue.enqueue(item(30, "und danach", {single: true}));
		await r.clock.tickAsync(PAUSE_RESUME_MS);
		await settle(r.clock);

		expect(r.resumed).to.deep.equal(["llm", "llm"]);
		expect(r.updates[r.updates.length - 1]).to.deep.equal([
			30,
			{status: "done", text: "[en] und danach", engine: "llm"},
		]);
	});

	// resume() is the one door back in: the timer and a user's retry both go
	// through it, so the banner clears either way -- and a retry takes the
	// pending timer with it, or it would clear the banner again a minute later.
	it("a user's retry resumes the engine and disarms the waiting timer", async () => {
		let fail = true;
		const r = rig((req) => (fail ? new Error("boom") : [`[en] ${req.text}`]));
		clock = r.clock;

		for (let i = 1; i <= PAUSE_AFTER_FAILURES; i++) {
			r.queue.enqueue(item(i, `zeile ${i} hier`, {single: true}));
		}

		await settle(r.clock);
		expect(r.queue.paused("llm")).to.equal(true);

		fail = false;
		r.queue.resume("llm");
		await settle(r.clock);

		expect(r.resumed).to.deep.equal(["llm"]);

		await r.clock.tickAsync(PAUSE_RESUME_MS);
		await settle(r.clock);

		expect(r.resumed).to.deep.equal(["llm"]);
	});

	// A batch is one request for several people's lines: the head's reply
	// target used to stand for all of them, so line 3's answer was written as
	// if it replied to whoever line 1 did.
	it("a batch carries each line's own reply target", async () => {
		const r = rig((req) => [
			(req.lines ?? []).map((line, i) => `${i + 1}. [en] ${line}`).join("\n") + "\nEND",
		]);
		clock = r.clock;
		r.queue.pauseForTest();
		r.queue.enqueue(
			item(1, "erste zeile hier", {
				context: {...emptyContext(), replyTo: {nick: "ada", text: "anyone tried it?"}},
			})
		);
		r.queue.enqueue(item(2, "zweite zeile hier"));
		r.queue.enqueue(
			item(3, "dritte zeile hier", {
				context: {...emptyContext(), replyTo: {nick: "bob", text: "did it build?"}},
			})
		);
		await settle(r.clock, 3);
		r.queue.resumeForTest();
		await settle(r.clock);

		expect(r.requests.length).to.equal(1);
		expect(r.requests[0].lines).to.have.length(3);
		expect(r.requests[0].lineContexts).to.deep.equal([
			{replyTo: {nick: "ada", text: "anyone tried it?"}},
			{},
			{replyTo: {nick: "bob", text: "did it build?"}},
		]);
	});

	it("a batch of lines that reply to nothing carries no per-line context", async () => {
		const r = rig((req) => [
			(req.lines ?? []).map((line, i) => `${i + 1}. [en] ${line}`).join("\n") + "\nEND",
		]);
		clock = r.clock;
		r.queue.pauseForTest();
		r.queue.enqueue(item(1, "erste zeile hier"));
		r.queue.enqueue(item(2, "zweite zeile hier"));
		await settle(r.clock, 3);
		r.queue.resumeForTest();
		await settle(r.clock);

		expect(r.requests[0].lineContexts).to.equal(undefined);
	});

	it("hold() keeps new runs from starting and release() runs them", async () => {
		const r = rig();
		clock = r.clock;

		r.queue.hold();
		r.queue.enqueue(item(1, "eins"));
		r.queue.enqueue(item(2, "zwei"));
		await r.clock.tickAsync(10);
		expect(r.requests).to.have.length(0);

		r.queue.release();
		await r.clock.tickAsync(10);
		expect(r.requests.length).to.be.greaterThan(0);
	});
});
