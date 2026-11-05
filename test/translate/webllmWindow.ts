// The GPU model's context window (engines/webllm.ts, budget.ts): a phone's
// reload asks for MOBILE_CONTEXT_WINDOW, a computer's is the one it always
// was; every request is fitted to the window before it is sent; and
// WebLLM's own overflow error is the request's failure, never the model's.

import {expect} from "chai";
import {
	BATCH_REFUSED,
	CONTEXT_OVERFLOW,
	EngineError,
	emptyContext,
	type TranslateRequest,
} from "../../client/js/translate/engine";
import {
	WebLlmEngine,
	isContextOverflow,
	type ChatRequest,
	type MlcLike,
	type ModelRecord,
	type ReloadOptions,
} from "../../client/js/translate/engines/webllm";
import {
	DEFAULT_CONTEXT_WINDOW,
	MOBILE_CONTEXT_WINDOW,
	buildCatalog,
	type GpuBudget,
} from "../../client/js/translate/models";

const catalog = buildCatalog();
const MiB = 1024 * 1024;
const prebuilt: ModelRecord[] = [
	{
		model_id: catalog.llm.id,
		model: `https://huggingface.co/mlc-ai/${catalog.llm.id}/resolve/main/`,
		model_lib: "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/qwen3.wasm",
		overrides: {context_window_size: 4096},
	},
];

/** WebLLM's own error, as 0.2.85 builds it (lib/index.js `ContextWindowSizeExceededError`). */
function overflowError(): Error {
	const error = new Error(
		"Prompt tokens exceed context window size: number of prompt tokens: 2100; context window size: 2048\nConsider shortening the prompt, or increase `context_window_size`, or using sliding window via `sliding_window_size`."
	);

	error.name = "ContextWindowSizeExceededError";
	return error;
}

function rig(gpu: GpuBudget | null, fail: () => Error | null = () => null) {
	const calls = {
		reload: [] as [string, ReloadOptions | undefined, number][],
		create: [] as ChatRequest[],
		unload: 0,
	};
	const mlc: MlcLike = {
		reload(modelId, ...rest: [ReloadOptions?]) {
			calls.reload.push([modelId, rest[0], rest.length]);
			return Promise.resolve();
		},
		unload() {
			calls.unload++;
			return Promise.resolve();
		},
		interruptGenerate() {},
		chat: {
			completions: {
				async create(req) {
					calls.create.push(req);
					await Promise.resolve();

					const error = fail();

					if (error) {
						throw error;
					}

					return (async function* () {
						await Promise.resolve();
						yield {choices: [{delta: {content: "<think>\n\n</think>\n\nhallo"}}]};
					})();
				},
			},
		},
	};
	const engine = new WebLlmEngine({prebuilt, create: () => mlc}, (code) => code);

	engine.configure(catalog, gpu ?? undefined);

	return {engine, calls};
}

function request(overrides: Partial<TranslateRequest> = {}): TranslateRequest {
	const context = emptyContext();

	// Japanese, which the bound counts at 0.8 a character: ten lines that
	// the profile's own trim keeps whole and a phone's window cannot hold.
	const japanese = "今日はとても良い天気ですね".repeat(9);

	context.recent = Array.from({length: 10}, (_, i) => ({
		nick: `nick${i}`,
		text: `earlier line ${i} ${japanese}`,
		translated: `${japanese}`,
	}));

	return {
		id: 1,
		model: catalog.llm.id,
		text: "hello",
		from: "en",
		to: "de",
		purpose: "read",
		context,
		...overrides,
	};
}

async function run(engine: WebLlmEngine, req: TranslateRequest): Promise<string> {
	let last = "";

	for await (const chunk of engine.translate(req, new AbortController().signal)) {
		last = chunk.text;
	}

	return last;
}

const phone: GpuBudget = {maxBufferBytes: 2048 * MiB, capBytes: null, mobile: true};
const computer: GpuBudget = {maxBufferBytes: 2048 * MiB, capBytes: null};

describe("translate/engines/webllm: the context window", () => {
	it("reloads with MOBILE_CONTEXT_WINDOW on a phone", async () => {
		const r = rig(phone);

		await r.engine.load(catalog.llm, "gpu", () => {});
		expect(r.calls.reload).to.deep.equal([
			[catalog.llm.id, {context_window_size: MOBILE_CONTEXT_WINDOW}, 1],
		]);
		expect(r.engine.contextWindow).to.equal(MOBILE_CONTEXT_WINDOW);
	});

	it("reloads as it always did on a computer, or before the probe: the record's window", async () => {
		for (const gpu of [computer, null]) {
			const r = rig(gpu);

			await r.engine.load(catalog.llm, "gpu", () => {});
			// No second argument at all: WebLLM's own record decides.
			expect(r.calls.reload).to.deep.equal([[catalog.llm.id, undefined, 0]]);
			expect(r.engine.contextWindow).to.equal(DEFAULT_CONTEXT_WINDOW);
		}
	});

	it("sends a request trimmed to the phone's window, and the same request whole on a computer", async () => {
		const small = rig(phone);
		const large = rig(computer);

		await small.engine.load(catalog.llm, "gpu", () => {});
		await large.engine.load(catalog.llm, "gpu", () => {});

		expect(await run(small.engine, request())).to.equal("hallo");
		expect(await run(large.engine, request())).to.equal("hallo");

		const userOf = (calls: typeof small.calls) => calls.create[0].messages[1].content;

		// The phone's prompt lost its oldest earlier lines, the newest kept.
		expect(userOf(small.calls)).not.to.include("earlier line 0 ");
		expect(userOf(small.calls)).to.include("earlier line 9 ");
		expect(userOf(large.calls)).to.include("earlier line 3 ");
		expect(userOf(small.calls).length).to.be.below(userOf(large.calls).length);
	});

	it("refuses a batch that does not fit even bare, so its lines go one at a time", async () => {
		const r = rig(phone);

		await r.engine.load(catalog.llm, "gpu", () => {});

		const lines = Array.from({length: 6}, (_, i) => `line ${i} ${"word ".repeat(300)}`);
		const error = await run(r.engine, request({text: "", lines})).catch((e: unknown) => e);

		expect(error).to.be.instanceOf(EngineError);
		expect((error as EngineError).message).to.equal(BATCH_REFUSED);
		expect((error as EngineError).cause).to.equal("request");
		// Nothing was sent, and the model stays loaded.
		expect(r.calls.create).to.have.length(0);
		expect(r.engine.isLoaded(catalog.llm.id)).to.equal(true);
	});

	it("says a single line too long for the window is too long, as the request's failure", async () => {
		const r = rig(phone);

		await r.engine.load(catalog.llm, "gpu", () => {});

		const error = await run(r.engine, request({text: "word ".repeat(3000)})).catch(
			(e: unknown) => e
		);

		expect((error as EngineError).message).to.equal(CONTEXT_OVERFLOW);
		expect((error as EngineError).cause).to.equal("request");
		expect(r.calls.create).to.have.length(0);
	});

	it("keeps the model loaded and counts nothing when WebLLM itself says the prompt is too long", async () => {
		let failing = true;
		const r = rig(phone, () => (failing ? overflowError() : null));

		await r.engine.load(catalog.llm, "gpu", () => {});

		// Twice in a row: a lost device would be "load" the second time.
		for (let i = 0; i < 2; i++) {
			const error = await run(r.engine, request()).catch((e: unknown) => e);

			expect((error as EngineError).message).to.equal(CONTEXT_OVERFLOW);
			expect((error as EngineError).cause).to.equal("request");
		}

		expect(r.engine.generationFailures).to.equal(0);
		expect(r.engine.isLoaded(catalog.llm.id)).to.equal(true);
		expect(r.calls.unload).to.equal(0);
		expect(r.calls.reload).to.have.length(1);

		failing = false;
		expect(await run(r.engine, request())).to.equal("hallo");
	});

	it("still treats any other generation failure as a device that may be gone", async () => {
		const r = rig(phone, () => new Error("GPU device lost"));

		await r.engine.load(catalog.llm, "gpu", () => {});

		const error = await run(r.engine, request()).catch((e: unknown) => e);

		expect((error as EngineError).message).to.equal("GPU device lost");
		expect(r.engine.isLoaded(catalog.llm.id)).to.equal(false);
	});

	it("knows WebLLM's overflow by its name or by its message", () => {
		expect(isContextOverflow(overflowError())).to.equal(true);

		const renamed = overflowError();

		renamed.name = "Error";
		expect(isContextOverflow(renamed)).to.equal(true);
		expect(isContextOverflow(new Error("out of memory"))).to.equal(false);
		expect(isContextOverflow("Prompt tokens exceed context window size")).to.equal(false);
	});
});
