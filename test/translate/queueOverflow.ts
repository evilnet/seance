// A request too long for the GPU model's context window (engine.ts
// `CONTEXT_OVERFLOW`): the reading queue retries each line bare and alone,
// fails one that overflowed bare, and never counts it toward a pause.

import {expect} from "chai";
import sinon from "ts-sinon";
import {
	CONTEXT_OVERFLOW,
	emptyContext,
	type TranslateChunk,
	type TranslateRequest,
} from "../../client/js/translate/engine";
import {
	PAUSE_AFTER_FAILURES,
	TranslateQueue,
	type QueueDeps,
	type QueueItem,
	type QueueUpdate,
} from "../../client/js/translate/queue";
import {protect} from "../../client/js/translate/spans";
import {TranslateError} from "../../client/js/translate/client";

type Request = Omit<TranslateRequest, "id" | "model">;

function rig(answer: (req: Request) => string | Error) {
	const clock = sinon.useFakeTimers();
	const updates: [number, QueueUpdate][] = [];
	const requests: Request[] = [];
	const paused: string[] = [];
	const deps: QueueDeps = {
		route: () => Promise.resolve({engine: "llm" as const, device: "gpu" as const}),
		translate(req) {
			requests.push(req);

			return (async function* (): AsyncIterable<TranslateChunk> {
				await Promise.resolve();

				const out = answer(req);

				if (out instanceof Error) {
					throw out;
				}

				yield {id: 0, text: out, done: true};
			})();
		},
		priority: () => 0,
		arrivals: () => 0,
		onUpdate: (id, update) => updates.push([id, update]),
		onPause: (engine) => paused.push(engine),
	};

	return {queue: new TranslateQueue(deps), clock, updates, requests, paused};
}

function item(id: number, text: string): QueueItem {
	const p = protect(text);
	const context = emptyContext();

	context.recent = [{nick: "alice", text: "an earlier line"}];
	context.topic = "the topic";

	return {
		id,
		chanId: 1,
		text: p.text,
		spans: p.spans,
		meta: p.meta,
		from: "de",
		to: "en",
		context,
		arrivalsAtEnqueue: 0,
		single: false,
	};
}

const overflow = () => new TranslateError(CONTEXT_OVERFLOW, "request");

async function settle(clock: sinon.SinonFakeTimers) {
	for (let i = 0; i < 30; i++) {
		await clock.tickAsync(1);
	}
}

function last(updates: [number, QueueUpdate][], id: number): QueueUpdate | undefined {
	return updates.filter(([u]) => u === id).at(-1)?.[1];
}

describe("translate/queue: a request too long for the context window", () => {
	let clock: sinon.SinonFakeTimers | null = null;

	afterEach(() => {
		clock?.restore();
		clock = null;
	});

	it("retries the line bare and alone, and shows what that gives", async () => {
		const r = rig((req) => (req.context.recent.length > 0 ? overflow() : `[en] ${req.text}`));
		clock = r.clock;

		r.queue.enqueue(item(1, "hallo welt"));
		await settle(r.clock);

		expect(r.requests).to.have.length(2);
		expect(r.requests[1].context.recent).to.deep.equal([]);
		expect(r.requests[1].context.topic).to.equal(undefined);
		expect(last(r.updates, 1)).to.deep.equal({
			status: "done",
			text: "[en] hallo welt",
			engine: "llm",
		});
	});

	it("fails a line that overflows bare too, and never pauses the engine for it", async () => {
		const r = rig(() => overflow());
		clock = r.clock;

		for (let id = 1; id <= PAUSE_AFTER_FAILURES + 2; id++) {
			r.queue.enqueue(item(id, `zeile ${id}`));
		}

		await settle(r.clock);

		for (let id = 1; id <= PAUSE_AFTER_FAILURES + 2; id++) {
			expect(last(r.updates, id), `line ${id}`).to.deep.equal({
				status: "failed",
				error: CONTEXT_OVERFLOW,
			});
		}

		// One bare try a line after the first (alone or batched); the
		// engine never paused.
		const bare = r.requests.filter((req) => req.context.recent.length === 0);

		expect(bare).to.have.length(PAUSE_AFTER_FAILURES + 2);
		expect(bare.every((req) => !req.lines)).to.equal(true);
		expect(r.paused).to.deep.equal([]);
		expect(r.queue.paused("llm")).to.equal(false);
	});

	it("takes a batch that overflowed apart: every line bare and alone, in order", async () => {
		const r = rig((req) => (req.lines ? overflow() : `[en] ${req.text}`));
		clock = r.clock;

		r.queue.hold();
		r.queue.enqueue(item(1, "eins"));
		r.queue.enqueue(item(2, "zwei"));
		r.queue.enqueue(item(3, "drei"));
		await settle(r.clock);
		r.queue.release();
		await settle(r.clock);

		expect(r.requests[0].lines).to.deep.equal(["eins", "zwei", "drei"]);

		const singles = r.requests.slice(1);

		expect(singles.map((req) => req.text)).to.deep.equal(["eins", "zwei", "drei"]);
		expect(singles.every((req) => !req.lines && req.context.recent.length === 0)).to.equal(
			true
		);

		for (const id of [1, 2, 3]) {
			expect(last(r.updates, id)).to.deep.include({status: "done"});
		}

		expect(r.paused).to.deep.equal([]);
	});

	it("retries a multi-line message bare when one of its lines overflowed", async () => {
		const r = rig((req) =>
			req.context.recent.length > 0
				? overflow()
				: req.lines
				? req.lines.map((l, i) => `${i + 1}. [en] ${l}`).join("\n")
				: `[en] ${req.text}`
		);
		clock = r.clock;

		r.queue.enqueue(item(1, "erste zeile\nzweite zeile"));
		await settle(r.clock);

		expect(last(r.updates, 1)).to.deep.equal({
			status: "done",
			text: "[en] erste zeile\n[en] zweite zeile",
			engine: "llm",
		});
		expect(r.paused).to.deep.equal([]);
	});
});
