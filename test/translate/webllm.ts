import {expect} from "chai";
import {noteDeviceLoss, takeDeviceLoss} from "../../client/js/translate/engines/gpuLimits";
import {
	EngineError,
	emptyContext,
	parseGpuLost,
	type ModelRef,
	type TranslateRequest,
} from "../../client/js/translate/engine";
import {
	WebLlmEngine,
	appConfigFor,
	maxTokensFor,
	type ChatRequest,
	type MlcLike,
	type ModelRecord,
	type WebLlmDeps,
} from "../../client/js/translate/engines/webllm";
import {
	QWEN3_1_7B_ID,
	QWEN3_1_7B_PINNED_MODEL,
	QWEN3_1_7B_SPLIT_ID,
	QWEN3_1_7B_SPLIT_LIB,
	QWEN3_4B_ID,
	buildCatalog,
} from "../../client/js/translate/models";
import {EXAMPLES} from "../../client/js/translate/prompt";
import {promptProfileFor} from "../../client/js/translate/prompts";

const catalog = buildCatalog();
const prebuilt: ModelRecord[] = [
	{
		model_id: catalog.llm.id,
		model: `https://huggingface.co/mlc-ai/${catalog.llm.id}/resolve/main/`,
		model_lib: "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/qwen3.wasm",
		vram_required_MB: 2036.66,
		low_resource_required: true,
		overrides: {context_window_size: 4096},
	},
];

function fakeMlc(pieces: string[]) {
	const calls = {
		reload: [] as string[],
		unload: 0,
		interrupt: 0,
		create: [] as ChatRequest[],
		/**
		 * Set when the generator reaches the end of its `for` loop — where
		 * WebLLM's own generator releases its per-model lock. An early
		 * `return()` from the consumer never gets there, so a stranded lock
		 * shows up here as `false`. This fake keeps streaming through an
		 * interrupt, as WebLLM does until its next decode step.
		 */
		ranToEnd: false,
	};
	const mlc: MlcLike = {
		reload(modelId) {
			calls.reload.push(modelId);

			return Promise.resolve();
		},
		unload() {
			calls.unload++;

			return Promise.resolve();
		},
		interruptGenerate() {
			calls.interrupt++;
		},
		chat: {
			completions: {
				async create(req) {
					calls.create.push(req);
					await Promise.resolve();

					return (async function* () {
						await Promise.resolve();

						for (const piece of pieces) {
							await Promise.resolve();
							yield {choices: [{delta: {content: piece}}]};
						}

						calls.ranToEnd = true;
					})();
				},
			},
		},
	};

	return {mlc, calls};
}

function deps(pieces: string[]) {
	const fake = fakeMlc(pieces);
	const created: {appConfig: {model_list: ModelRecord[]}; progress: number[]}[] = [];
	const d: WebLlmDeps = {
		prebuilt,
		create(appConfig, onProgress) {
			const entry = {appConfig, progress: [] as number[]};
			created.push(entry);
			onProgress({progress: 0.5, text: "half"});
			onProgress({progress: 1, text: "done"});
			return fake.mlc;
		},
	};

	return {deps: d, created, calls: fake.calls};
}

/**
 * WebLLM's per-model lock, modelled as a deferred `create()`: a request sits
 * in `create()` until the test grants it the lock, exactly as a generation
 * waits for the one before it. `interruptGenerate()` is engine-global, as
 * WebLLM's is — it ends whichever generation is streaming, whoever called it.
 */
function lockedMlc(pieces: string[]) {
	const calls = {reload: [] as string[], unload: 0, interrupt: 0, create: [] as ChatRequest[]};
	const locks: (() => void)[] = [];
	let interrupted = false;
	const mlc: MlcLike = {
		reload(modelId) {
			calls.reload.push(modelId);

			return Promise.resolve();
		},
		unload() {
			calls.unload++;

			return Promise.resolve();
		},
		interruptGenerate() {
			calls.interrupt++;
			interrupted = true;
		},
		chat: {
			completions: {
				async create(req) {
					calls.create.push(req);
					await new Promise<void>((resolve) => locks.push(resolve));
					// WebLLM clears the flag as a generation starts.
					interrupted = false;

					return (async function* () {
						await Promise.resolve();

						for (const piece of pieces) {
							if (interrupted) {
								return;
							}

							yield {choices: [{delta: {content: piece}}]};
						}
					})();
				},
			},
		},
	};

	return {mlc, calls, locks};
}

function lockedDeps(pieces: string[]) {
	const fake = lockedMlc(pieces);
	const d: WebLlmDeps = {prebuilt, create: () => fake.mlc};

	return {
		deps: d,
		calls: fake.calls,
		/** Hand the lock to the n-th `create()` call; any other keeps waiting. */
		grant: (n: number) => fake.locks[n](),
	};
}

/** Drain the microtask queue (these harnesses use no timers). */
async function settle() {
	for (let i = 0; i < 10; i++) {
		await Promise.resolve();
	}
}

function request(overrides: Partial<TranslateRequest> = {}): TranslateRequest {
	return {
		id: 1,
		model: catalog.llm.id,
		text: "Ich schick dir gleich das Log.",
		from: "de",
		to: "en",
		purpose: "read",
		context: emptyContext(),
		...overrides,
	};
}

const name = (code: string) => code;

describe("translate/engines/webllm", () => {
	it("appConfigFor takes the prebuilt record as it is", () => {
		expect(appConfigFor(catalog.llm, prebuilt, {})).to.deep.equal({model_list: [prebuilt[0]]});
	});

	it("appConfigFor points a mirrored model at the mirror, library included", () => {
		const mirrored = appConfigFor(catalog.llm, prebuilt, {modelBase: "https://m.test/models"});

		expect(mirrored.model_list[0].model).to.equal(`https://m.test/models/${catalog.llm.id}/`);
		// A mirror is a mirror: the GPU library comes from it too, by its
		// file name, not from raw.githubusercontent.com.
		expect(mirrored.model_list[0].model_lib).to.equal("https://m.test/models/qwen3.wasm");

		// A trailing slash on the mirror is not a double slash in the result.
		expect(
			appConfigFor(catalog.llm, prebuilt, {modelBase: "https://m.test/models/"}).model_list[0]
				.model_lib
		).to.equal("https://m.test/models/qwen3.wasm");

		const own = appConfigFor(catalog.llm, prebuilt, {
			modelBase: "https://m.test/models",
			lib: "https://m.test/libs/qwen3.wasm",
		});

		expect(own.model_list[0].model_lib).to.equal("https://m.test/libs/qwen3.wasm");
	});

	it("appConfigFor keeps the prebuilt record's own fields when mirroring", () => {
		const mirrored = appConfigFor(catalog.llm, prebuilt, {modelBase: "https://m.test/models"});

		expect(mirrored.model_list[0].vram_required_MB).to.equal(prebuilt[0].vram_required_MB);
		expect(mirrored.model_list[0].low_resource_required).to.equal(true);
		expect(mirrored.model_list[0].overrides).to.deep.equal({context_window_size: 4096});
	});

	it("appConfigFor refuses an unknown model without a library", () => {
		const ref = {...catalog.llm, id: "not-prebuilt"};

		expect(() => appConfigFor(ref, prebuilt, {})).to.throw(
			"unknown WebLLM model not-prebuilt: set translation.llm.lib"
		);
		expect(
			appConfigFor(ref, prebuilt, {lib: "https://m.test/x.wasm"}).model_list[0]
		).to.deep.equal({
			model_id: "not-prebuilt",
			model: "https://huggingface.co/mlc-ai/not-prebuilt/resolve/main/",
			model_lib: "https://m.test/x.wasm",
		});
	});

	it("load creates the engine with the app config, reloads the model and reports progress", async () => {
		const d = deps([]);
		const engine = new WebLlmEngine(d.deps, name);
		const progress: number[] = [];

		engine.configure(catalog);
		await engine.load(catalog.llm, "gpu", (p) => progress.push(p.fraction));

		expect(d.created[0].appConfig.model_list[0].model_id).to.equal(catalog.llm.id);
		expect(d.calls.reload).to.deep.equal([catalog.llm.id]);
		expect(progress).to.deep.equal([0.5, 1]);
		expect(engine.status()).to.equal("ready");
		expect(engine.loadedModels()).to.deep.equal([catalog.llm.id]);
		expect(engine.isLoaded(catalog.llm.id)).to.equal(true);
	});

	describe("the small-buffer build", () => {
		const MiB = 1024 * 1024;
		const APP = "https://example.github.io/seance/develop/";

		function splitDeps(seed: (build: unknown) => Promise<unknown> = () => Promise.resolve()) {
			const d = deps(["Good morning."]);
			const order: string[] = [];
			const seeded: unknown[] = [];

			d.deps.appRoot = APP;

			d.deps.seedSplit = (build) => {
				order.push("seed");
				seeded.push(build);

				return seed(build);
			};

			const create = d.deps.create.bind(d.deps);

			d.deps.create = (appConfig, onProgress) => {
				order.push("create");

				return create(appConfig, onProgress);
			};

			return {...d, order, seeded};
		}

		it("on a GPU that binds 128 MiB: seeds its manifest, then reloads the build", async () => {
			const d = splitDeps();
			const engine = new WebLlmEngine(d.deps, name);

			engine.configure(catalog, {maxBufferBytes: 128 * MiB, capBytes: null});
			await engine.load(catalog.llm, "gpu", () => {});

			expect(d.order).to.deep.equal(["seed", "create"]);
			expect(d.seeded).to.deep.equal([catalog.llm.smallBuffer]);
			expect(d.created[0].appConfig.model_list).to.deep.equal([
				{
					...prebuilt[0],
					model_id: QWEN3_1_7B_SPLIT_ID,
					model: QWEN3_1_7B_PINNED_MODEL,
					model_lib: APP + QWEN3_1_7B_SPLIT_LIB,
				},
			]);
			expect(d.calls.reload).to.deep.equal([QWEN3_1_7B_SPLIT_ID]);
			// Everything above the engine keeps the model's own id.
			expect(engine.loadedModels()).to.deep.equal([catalog.llm.id]);
			expect(engine.isLoaded(catalog.llm.id)).to.equal(true);

			const chunks: string[] = [];

			for await (const chunk of engine.translate(request(), new AbortController().signal)) {
				chunks.push(chunk.text);
			}

			expect(chunks.at(-1)).to.equal("Good morning.");
		});

		it("on a desktop, and before the probe, loads the model itself and seeds nothing", async () => {
			for (const gpu of [{maxBufferBytes: 2048 * MiB, capBytes: null}, undefined]) {
				const d = splitDeps();
				const engine = new WebLlmEngine(d.deps, name);

				engine.configure(catalog, gpu);
				await engine.load(catalog.llm, "gpu", () => {});

				expect(d.seeded).to.deep.equal([]);
				expect(d.calls.reload).to.deep.equal([catalog.llm.id]);
			}
		});

		it("does not load when its manifest cannot be seeded, and says why", async () => {
			const d = splitDeps(() =>
				Promise.reject(
					new Error(
						"model.embed_tokens.q_weight is [151936, 320], the library expects [151936, 256]"
					)
				)
			);
			const engine = new WebLlmEngine(d.deps, name);
			let error: unknown = null;

			engine.configure(catalog, {maxBufferBytes: 128 * MiB, capBytes: null});
			await engine.load(catalog.llm, "gpu", () => {}).catch((e: unknown) => (error = e));

			expect((error as Error).message).to.contain("the library expects [151936, 256]");
			expect(d.created).to.have.length(0);
			expect(engine.status()).to.equal("failed");
			expect(engine.loadedModels()).to.deep.equal([]);
		});

		it("refuses to load without a way to seed or an app root", async () => {
			const noSeed = deps([]);

			noSeed.deps.appRoot = APP;

			const engine = new WebLlmEngine(noSeed.deps, name);

			engine.configure(catalog, {maxBufferBytes: 128 * MiB, capBytes: null});
			let error: unknown = null;

			await engine.load(catalog.llm, "gpu", () => {}).catch((e: unknown) => (error = e));
			expect((error as Error).message).to.contain("needs its manifest seeded");
			expect(noSeed.created).to.have.length(0);
		});
	});

	it("a cleanup decodes greedily: one token's narrow lead decides a correction", async () => {
		const d = deps(["you're going to love this\n"]);
		const engine = new WebLlmEngine(d.deps, name);
		engine.configure(catalog);
		await engine.load(catalog.llm, "gpu", () => {});
		const polish = request({
			text: "your going to love this",
			from: "en",
			to: "en",
			purpose: "polish",
		});

		for await (const chunk of engine.translate(polish, new AbortController().signal)) {
			void chunk;
		}

		expect(d.calls.create[0].temperature).to.equal(0);
	});

	it("translate streams cumulative text, then the trimmed result, with the spec's decoding settings", async () => {
		const d = deps(["I'll", " send", " you the log", " shortly.\n"]);
		const engine = new WebLlmEngine(d.deps, name);
		engine.configure(catalog);
		await engine.load(catalog.llm, "gpu", () => {});
		const seen: {text: string; done: boolean}[] = [];

		for await (const chunk of engine.translate(request(), new AbortController().signal)) {
			seen.push({text: chunk.text, done: chunk.done});
		}

		expect(seen).to.deep.equal([
			{text: "I'll", done: false},
			{text: "I'll send", done: false},
			{text: "I'll send you the log", done: false},
			// The trailing newline ends no longer ends the request: the
			// generation is consumed whole and the answer picked out of it.
			{text: "I'll send you the log shortly.", done: false},
			{text: "I'll send you the log shortly.", done: true},
		]);
		expect(d.calls.interrupt).to.equal(0);
		const created = d.calls.create[0];

		expect(created.stream).to.equal(true);
		// A translation keeps its low temperature; a cleanup is greedy (below).
		expect(created.temperature).to.equal(0.1);
		expect(created.stop).to.deep.equal([]);
		expect(created.extra_body).to.deep.equal({enable_thinking: false});
		expect(created.max_tokens).to.equal(maxTokensFor(request()));
		expect(created.messages[0].role).to.equal("system");
		expect(created.messages[1].content).to.equal(
			"Translate into en: Ich schick dir gleich das Log."
		);
		expect(created.messages[1].content).to.include("Ich schick dir gleich das Log.");
	});

	it("a batched request stops at the sentinel and strips it", async () => {
		const d = deps(["1. one\n2. two\nEND"]);
		const engine = new WebLlmEngine(d.deps, name);
		engine.configure(catalog);
		await engine.load(catalog.llm, "gpu", () => {});
		const chunks: string[] = [];

		for await (const chunk of engine.translate(
			request({lines: ["eins", "zwei"]}),
			new AbortController().signal
		)) {
			chunks.push(chunk.text);
		}

		expect(chunks[chunks.length - 1]).to.equal("1. one\n2. two");
		expect(d.calls.create[0].stop).to.deep.equal(["\nEND"]);
	});

	it("the empty thinking block WebLLM prepends never reaches the caller", async () => {
		const d = deps(["<think>", "\n\n</think>", "\n\n", "Hallo", " Welt"]);
		const engine = new WebLlmEngine(d.deps, name);
		engine.configure(catalog);
		await engine.load(catalog.llm, "gpu", () => {});
		const seen: {text: string; done: boolean}[] = [];

		for await (const chunk of engine.translate(request(), new AbortController().signal)) {
			seen.push({text: chunk.text, done: chunk.done});
		}

		// Nothing at all while the block is open; an empty translation-so-far
		// once it closes, which is all the block leaves behind.
		expect(seen).to.deep.equal([
			{text: "", done: false},
			{text: "", done: false},
			{text: "Hallo", done: false},
			{text: "Hallo Welt", done: false},
			{text: "Hallo Welt", done: true},
		]);
		expect(seen.some((chunk) => chunk.text.includes("<think>"))).to.equal(false);
	});

	it("a single-line reply that wraps is joined, not cut at the first newline", async () => {
		const d = deps(["<think>\n\n</think>\n\n", "Hallo", "\nWelt", " mehr"]);
		const engine = new WebLlmEngine(d.deps, name);
		engine.configure(catalog);
		await engine.load(catalog.llm, "gpu", () => {});
		const seen: {text: string; done: boolean}[] = [];

		for await (const chunk of engine.translate(request(), new AbortController().signal)) {
			seen.push({text: chunk.text, done: chunk.done});
		}

		expect(seen).to.deep.equal([
			{text: "", done: false},
			{text: "Hallo", done: false},
			{text: "Hallo Welt", done: false},
			{text: "Hallo Welt mehr", done: false},
			{text: "Hallo Welt mehr", done: true},
		]);
		// Nothing is interrupted any more: the generation ends by itself.
		expect(d.calls.interrupt).to.equal(0);
		// The generation reached the point where WebLLM releases its lock.
		expect(d.calls.ranToEnd).to.equal(true);
		// A completed generation is not a failure.
		expect(engine.generationFailures).to.equal(0);
	});

	it("a blank line ends the translation: the note after it is dropped", async () => {
		const d = deps(["A\nB", "\n\nNote: ", "B is an idiom here."]);
		const engine = new WebLlmEngine(d.deps, name);
		engine.configure(catalog);
		await engine.load(catalog.llm, "gpu", () => {});
		const seen: {text: string; done: boolean}[] = [];

		for await (const chunk of engine.translate(request(), new AbortController().signal)) {
			seen.push({text: chunk.text, done: chunk.done});
		}

		expect(seen[seen.length - 1]).to.deep.equal({text: "A B", done: true});
		// and nothing past the blank line is ever shown on the way there
		expect(seen.every((chunk) => !chunk.text.includes("Note"))).to.equal(true);
	});

	it("the echoed line is dropped and what follows it is joined", async () => {
		const d = deps([
			"Ich schick dir gleich das Log.",
			"\n",
			"I'll send you the log shortly.",
			"\nand more",
		]);
		const engine = new WebLlmEngine(d.deps, name);
		engine.configure(catalog);
		await engine.load(catalog.llm, "gpu", () => {});
		const seen: {text: string; done: boolean}[] = [];

		for await (const chunk of engine.translate(request(), new AbortController().signal)) {
			seen.push({text: chunk.text, done: chunk.done});
		}

		expect(seen).to.deep.equal([
			// while it is the line being generated, nobody can tell it is an echo
			{text: "Ich schick dir gleich das Log.", done: false},
			// the newline makes it a whole line, and it stops being shown
			{text: "", done: false},
			{text: "I'll send you the log shortly.", done: false},
			{text: "I'll send you the log shortly. and more", done: false},
			{text: "I'll send you the log shortly. and more", done: true},
		]);
		expect(d.calls.interrupt).to.equal(0);
		expect(engine.generationFailures).to.equal(0);
	});

	it("a bare fence line is not the translation either", async () => {
		const d = deps(['"""\n', "Hallo Welt", "\n"]);
		const engine = new WebLlmEngine(d.deps, name);
		engine.configure(catalog);
		await engine.load(catalog.llm, "gpu", () => {});
		const seen: {text: string; done: boolean}[] = [];

		for await (const chunk of engine.translate(request(), new AbortController().signal)) {
			seen.push({text: chunk.text, done: chunk.done});
		}

		expect(seen).to.deep.equal([
			{text: "", done: false},
			{text: "Hallo Welt", done: false},
			{text: "Hallo Welt", done: false},
			{text: "Hallo Welt", done: true},
		]);
		expect(d.calls.interrupt).to.equal(0);
	});

	it("a reply that is nothing but the echo is yielded rather than nothing at all", async () => {
		const d = deps(["Ich schick dir", " gleich das Log."]);
		const engine = new WebLlmEngine(d.deps, name);
		engine.configure(catalog);
		await engine.load(catalog.llm, "gpu", () => {});
		const seen: {text: string; done: boolean}[] = [];

		for await (const chunk of engine.translate(request(), new AbortController().signal)) {
			seen.push({text: chunk.text, done: chunk.done});
		}

		expect(seen[seen.length - 1]).to.deep.equal({
			text: "Ich schick dir gleich das Log.",
			done: true,
		});
		expect(d.calls.interrupt).to.equal(0);
	});

	it("a reply that opens with a newline is not cut to nothing", async () => {
		const d = deps(["\n", "Hallo", "\nWelt"]);
		const engine = new WebLlmEngine(d.deps, name);
		engine.configure(catalog);
		await engine.load(catalog.llm, "gpu", () => {});
		const seen: {text: string; done: boolean}[] = [];

		for await (const chunk of engine.translate(request(), new AbortController().signal)) {
			seen.push({text: chunk.text, done: chunk.done});
		}

		expect(seen).to.deep.equal([
			{text: "", done: false},
			{text: "Hallo", done: false},
			{text: "Hallo Welt", done: false},
			{text: "Hallo Welt", done: true},
		]);
	});

	it("a single-line reply is unquoted and unlabelled", async () => {
		const d = deps(['Translation: "Hallo Welt"']);
		const engine = new WebLlmEngine(d.deps, name);
		engine.configure(catalog);
		await engine.load(catalog.llm, "gpu", () => {});
		const seen: {text: string; done: boolean}[] = [];

		for await (const chunk of engine.translate(request(), new AbortController().signal)) {
			seen.push({text: chunk.text, done: chunk.done});
		}

		expect(seen[seen.length - 1]).to.deep.equal({text: "Hallo Welt", done: true});
	});

	it("a batched request keeps its newlines and stops at the sentinel, thinking block aside", async () => {
		const d = deps(["<think>\n\n</think>\n\n", "1. Hallo\n", "2. Welt\nEND"]);
		const engine = new WebLlmEngine(d.deps, name);
		engine.configure(catalog);
		await engine.load(catalog.llm, "gpu", () => {});
		const chunks: string[] = [];

		for await (const chunk of engine.translate(
			request({lines: ["eins", "zwei"]}),
			new AbortController().signal
		)) {
			chunks.push(chunk.text);
		}

		expect(chunks[chunks.length - 1]).to.equal("1. Hallo\n2. Welt");
		expect(d.calls.create[0].stop).to.deep.equal(["\nEND"]);
		expect(d.calls.interrupt).to.equal(0);
	});

	it("a canned example answer is skipped like an echo", async () => {
		const d = deps([`${EXAMPLES.de}\n`, "I'll send you the log shortly."]);
		const engine = new WebLlmEngine(d.deps, name);
		engine.configure(catalog);
		await engine.load(catalog.llm, "gpu", () => {});
		const seen: {text: string; done: boolean}[] = [];

		for await (const chunk of engine.translate(request(), new AbortController().signal)) {
			seen.push({text: chunk.text, done: chunk.done});
		}

		expect(seen[seen.length - 1]).to.deep.equal({
			text: "I'll send you the log shortly.",
			done: true,
		});
		expect(seen.every((chunk) => !chunk.text.includes(EXAMPLES.de))).to.equal(true);
	});

	it("the target's own greeting translates a short question", async () => {
		// Measured on the web build's 4B weights: the guard failed this line.
		const d = deps([EXAMPLES.es]);
		const engine = new WebLlmEngine(d.deps, name);
		engine.configure(catalog);
		await engine.load(catalog.llm, "gpu", () => {});
		const req = request({text: "hey, how's it going?", from: "en", to: "es"});
		let last = "";

		for await (const chunk of engine.translate(req, new AbortController().signal)) {
			last = chunk.text;
		}

		expect(last).to.equal(EXAMPLES.es);
	});

	it("another language's greeting for a short question still fails", async () => {
		const d = deps([EXAMPLES.de]);
		const engine = new WebLlmEngine(d.deps, name);
		engine.configure(catalog);
		await engine.load(catalog.llm, "gpu", () => {});
		const req = request({text: "hey, how's it going?", from: "en", to: "es"});
		let error: Error | null = null;

		try {
			for await (const _c of engine.translate(req, new AbortController().signal)) {
				// consume
			}
		} catch (e) {
			error = e as Error;
		}

		expect(error?.message).to.equal("the model answered with the example");
	});

	it("a reply that is nothing but the canned answer fails the request, not the model", async () => {
		const d = deps([`${EXAMPLES.de.toUpperCase()} `]);
		const engine = new WebLlmEngine(d.deps, name);
		engine.configure(catalog);
		await engine.load(catalog.llm, "gpu", () => {});
		let error: Error | null = null;

		try {
			for await (const _c of engine.translate(request(), new AbortController().signal)) {
				// consume
			}
		} catch (e) {
			error = e as Error;
		}

		expect(error).to.be.instanceOf(EngineError);
		expect(error?.message).to.equal("the model answered with the example");
		expect((error as EngineError).cause).to.equal("request");
		// The device is fine: the model stays loaded and nothing is counted
		// against it, so the queue's retry has an engine to retry on.
		expect(engine.isLoaded(catalog.llm.id)).to.equal(true);
		expect(engine.status()).to.equal("ready");
		expect(engine.generationFailures).to.equal(0);
		expect(d.calls.unload).to.equal(0);
	});

	it("a source that is itself the canned answer is an echo, not a refusal", async () => {
		// The line to translate *is* "Hallo, wie geht es dir?" (already in
		// the target): the echo rule runs first, so the reply comes back.
		const d = deps(["Hallo, wie geht es dir?"]);
		const engine = new WebLlmEngine(d.deps, name);
		engine.configure(catalog);
		await engine.load(catalog.llm, "gpu", () => {});
		const seen: string[] = [];

		for await (const chunk of engine.translate(
			request({text: "Hallo, wie geht es dir?", from: null, to: "de"}),
			new AbortController().signal
		)) {
			seen.push(chunk.text);
		}

		expect(seen[seen.length - 1]).to.equal("Hallo, wie geht es dir?");
	});

	it("maxTokensFor is 3 × input tokens + 48 + the thinking block, capped at 512", () => {
		expect(maxTokensFor(request({text: "abcd"}))).to.equal(3 * 1 + 48 + 16);
		expect(maxTokensFor(request({text: "x".repeat(4000)}))).to.equal(512);
		expect(maxTokensFor(request({lines: ["abcd", "efgh"]}))).to.equal(3 * 3 + 48 + 16);
	});

	it("an abort interrupts generation", async () => {
		const d = deps(["a", "b", "c"]);
		const engine = new WebLlmEngine(d.deps, name);
		engine.configure(catalog);
		await engine.load(catalog.llm, "gpu", () => {});
		const controller = new AbortController();

		for await (const _chunk of engine.translate(request(), controller.signal)) {
			controller.abort();
			break;
		}

		expect(d.calls.interrupt).to.equal(1);
	});

	it("an abort mid-stream drains the stream instead of returning early", async () => {
		const d = deps(["a", "b", "c", "d"]);
		const engine = new WebLlmEngine(d.deps, name);

		engine.configure(catalog);
		await engine.load(catalog.llm, "gpu", () => {});

		const controller = new AbortController();
		const seen: string[] = [];

		for await (const chunk of engine.translate(request(), controller.signal)) {
			seen.push(chunk.text);

			if (seen.length === 2) {
				controller.abort();
			}
		}

		// Nothing after the abort: not the remaining pieces, not the done chunk.
		expect(seen).to.deep.equal(["a", "ab"]);
		expect(d.calls.interrupt).to.be.at.least(1);
		// The generation reached the point where WebLLM would release its lock.
		expect(d.calls.ranToEnd).to.equal(true);
	});

	it("an abort before the first chunk still drains and interrupts once the generation runs", async () => {
		const d = deps(["a", "b"]);
		const engine = new WebLlmEngine(d.deps, name);

		engine.configure(catalog);
		await engine.load(catalog.llm, "gpu", () => {});

		const controller = new AbortController();
		const stream = engine.translate(request(), controller.signal)[Symbol.asyncIterator]();
		const first = stream.next();

		// Before a single chunk — before `create()` has even resolved, so the
		// interrupt the listener would send has nothing to aim at yet.
		controller.abort();
		expect(d.calls.interrupt).to.equal(0);

		expect((await first).done).to.equal(true);
		expect(d.calls.interrupt).to.be.at.least(1);
		expect(d.calls.ranToEnd).to.equal(true);
	});

	it("an abort while waiting for the lock leaves the running generation alone", async () => {
		const d = lockedDeps(["a", "b"]);
		const engine = new WebLlmEngine(d.deps, name);

		engine.configure(catalog);
		await engine.load(catalog.llm, "gpu", () => {});

		const waiting = new AbortController();
		const running = engine
			.translate(request({id: 1}), new AbortController().signal)
			[Symbol.asyncIterator]();
		const queued = engine.translate(request({id: 2}), waiting.signal)[Symbol.asyncIterator]();
		const first = running.next();

		// The queued request asks for the lock and never gets it: that is the
		// case under test, so do not grant it here (test (c) below is the
		// request that does get it after its abort).
		void queued.next();
		await settle();
		expect(d.calls.create).to.have.length(2);
		d.grant(0);
		expect((await first).value.text).to.equal("a");

		waiting.abort();
		await settle();
		expect(d.calls.interrupt).to.equal(0);

		const rest: {text: string; done: boolean}[] = [];

		for (let step = await running.next(); !step.done; step = await running.next()) {
			rest.push({text: step.value.text, done: step.value.done});
		}

		expect(rest).to.deep.equal([
			{text: "ab", done: false},
			{text: "ab", done: true},
		]);
		expect(d.calls.interrupt).to.equal(0);
	});

	it("an abort of the generation that is running interrupts it once", async () => {
		const d = lockedDeps(["a", "b"]);
		const engine = new WebLlmEngine(d.deps, name);

		engine.configure(catalog);
		await engine.load(catalog.llm, "gpu", () => {});

		const controller = new AbortController();
		const stream = engine.translate(request(), controller.signal)[Symbol.asyncIterator]();
		const first = stream.next();

		await settle();
		d.grant(0);
		expect((await first).value.text).to.equal("a");

		controller.abort();
		expect(d.calls.interrupt).to.equal(1);
		expect((await stream.next()).done).to.equal(true);
	});

	it("a request aborted before the lock arrives ends the generation handed to it", async () => {
		const d = lockedDeps(["a", "b"]);
		const engine = new WebLlmEngine(d.deps, name);

		engine.configure(catalog);
		await engine.load(catalog.llm, "gpu", () => {});

		const controller = new AbortController();
		const stream = engine.translate(request(), controller.signal)[Symbol.asyncIterator]();
		const first = stream.next();

		await settle();
		controller.abort();
		expect(d.calls.interrupt).to.equal(0);

		d.grant(0);
		expect((await first).done).to.equal(true);
		expect(d.calls.interrupt).to.equal(1);
	});

	it("translating with a model that is not loaded throws; unload resets", async () => {
		const d = deps([]);
		const engine = new WebLlmEngine(d.deps, name);
		engine.configure(catalog);
		let message = "";

		try {
			for await (const _c of engine.translate(request(), new AbortController().signal)) {
				// consume
			}
		} catch (e) {
			message = (e as Error).message;
		}

		expect(message).to.equal(`model not loaded: ${catalog.llm.id}`);
		await engine.load(catalog.llm, "gpu", () => {});
		await engine.unload();
		expect(d.calls.unload).to.equal(1);
		expect(engine.status()).to.equal("cold");
		expect(engine.loadedModels()).to.deep.equal([]);
	});

	it("two concurrent loads of the same model share one engine", async () => {
		const d = deps([]);
		const engine = new WebLlmEngine(d.deps, name);

		engine.configure(catalog);
		await Promise.all([
			engine.load(catalog.llm, "gpu", () => {}),
			engine.load(catalog.llm, "gpu", () => {}),
		]);

		expect(d.created.length).to.equal(1);
		expect(d.calls.reload).to.deep.equal([catalog.llm.id]);
		expect(d.calls.unload).to.equal(0);
		expect(engine.status()).to.equal("ready");
		expect(engine.loadedModels()).to.deep.equal([catalog.llm.id]);
	});

	it("a failed load leaves the engine failed and empty", async () => {
		const d = deps([]);

		d.deps.create = () => {
			throw new Error("no adapter");
		};

		const engine = new WebLlmEngine(d.deps, name);
		engine.configure(catalog);
		let message = "";

		try {
			await engine.load(catalog.llm, "gpu", () => {});
		} catch (e) {
			message = (e as Error).message;
		}

		expect(message).to.equal("no adapter");
		expect(engine.status()).to.equal("failed");
		expect(engine.loadedModels()).to.deep.equal([]);
	});

	it("a load whose reload throws releases the engine it created", async () => {
		const d = deps([]);
		const engine = new WebLlmEngine(d.deps, name);
		engine.configure(catalog);
		const original = d.deps.create.bind(d.deps);

		d.deps.create = (appConfig, onProgress) => {
			const mlc = original(appConfig, onProgress);

			mlc.reload = () => {
				throw new Error("out of memory");
			};

			return mlc;
		};

		let message = "";

		try {
			await engine.load(catalog.llm, "gpu", () => {});
		} catch (e) {
			message = (e as Error).message;
		}

		expect(message).to.equal("out of memory");
		expect(d.calls.unload).to.equal(1);
		expect(engine.status()).to.equal("failed");
		expect(engine.loadedModels()).to.deep.equal([]);
	});
	it("a generation failure tears the engine down so the next request reloads", async () => {
		const d = deps([]);
		const engine = new WebLlmEngine(d.deps, name);
		engine.configure(catalog);
		await engine.load(catalog.llm, "gpu", () => {});
		const original = d.calls;
		const mlc = d.deps.create({model_list: []}, () => {});
		mlc.chat.completions.create = () => Promise.reject(new Error("Device lost"));
		d.deps.create = () => mlc;
		await engine.unload();
		await engine.load(catalog.llm, "gpu", () => {});
		let error: Error | null = null;

		try {
			for await (const _c of engine.translate(request(), new AbortController().signal)) {
				// consume
			}
		} catch (e) {
			error = e as Error;
		}

		expect(error).to.be.instanceOf(EngineError);
		expect((error as EngineError).cause).to.equal("request");
		expect(engine.isLoaded(catalog.llm.id)).to.equal(false);
		expect(engine.status()).to.equal("failed");
		expect(original.unload).to.be.greaterThan(0);
	});

	it("a generation failure on a lost GPU says why the GPU stopped", async () => {
		const d = deps([]);
		const engine = new WebLlmEngine({...d.deps, takeDeviceLoss}, name);
		engine.configure(catalog);
		const mlc = d.deps.create({model_list: []}, () => {});
		const mapAsync =
			"Failed to execute 'mapAsync' on 'GPUBuffer': Buffer was unmapped before mapping was resolved.";

		mlc.chat.completions.create = () => {
			// WebKit settles the device's `lost` a moment after the call fails.
			setTimeout(
				() => noteDeviceLoss({reason: "unknown", message: "GPU process terminated"}),
				5
			);
			return Promise.reject(new Error(mapAsync));
		};

		d.deps.create = () => mlc;
		takeDeviceLoss();
		await engine.load(catalog.llm, "gpu", () => {});
		let error: Error | null = null;

		try {
			for await (const _c of engine.translate(request(), new AbortController().signal)) {
				// consume
			}
		} catch (e) {
			error = e as Error;
		}

		expect(error).to.be.instanceOf(EngineError);
		expect(parseGpuLost(error!.message)).to.deep.equal({
			reason: "GPU process terminated",
			detail: mapAsync,
		});
		expect(takeDeviceLoss(), "the loss is spent").to.equal(null);
	});

	it("a GPU failure without the loss dependency does not read the GPU's loss", async () => {
		const d = deps([]);
		const engine = new WebLlmEngine(d.deps, name);
		engine.configure(catalog);
		const mlc = d.deps.create({model_list: []}, () => {});
		mlc.chat.completions.create = () => Promise.reject(new Error("boom"));
		d.deps.create = () => mlc;
		takeDeviceLoss();
		noteDeviceLoss({reason: "unknown", message: "GPU process terminated"});
		await engine.load(catalog.llm, "gpu", () => {});
		let error: Error | null = null;

		try {
			for await (const _c of engine.translate(request(), new AbortController().signal)) {
				// consume
			}
		} catch (e) {
			error = e as Error;
		}

		expect(error?.message).to.equal("boom");
		expect(takeDeviceLoss(), "left for whoever owns it").to.deep.equal({
			reason: "unknown",
			message: "GPU process terminated",
		});
	});

	it("a contextWindow option is the window every reload asks for", async () => {
		const reloads: (number | undefined)[] = [];
		const d = deps([]);
		const mlc = d.deps.create({model_list: []}, () => {});
		const reload = mlc.reload.bind(mlc);

		mlc.reload = (id, opts) => {
			reloads.push(opts?.context_window_size);
			return reload(id, opts);
		};

		d.deps.create = () => mlc;
		const engine = new WebLlmEngine(d.deps, name, {contextWindow: 1024});

		// Even on a phone, whose GPU window would be 2048.
		engine.configure(catalog, {
			maxBufferBytes: 1024 * 1024 * 1024,
			capBytes: null,
			mobile: true,
		});
		await engine.load(catalog.llm, "gpu", () => {});

		expect(reloads).to.deep.equal([1024]);
		expect(engine.contextWindow).to.equal(1024);
	});

	it("the second generation failure in a row is a load-class failure", async () => {
		const d = deps([]);
		const engine = new WebLlmEngine(d.deps, name);
		engine.configure(catalog);
		const mlc = d.deps.create({model_list: []}, () => {});
		mlc.chat.completions.create = () => Promise.reject(new Error("Device lost"));
		d.deps.create = () => mlc;
		const causes: string[] = [];

		for (let i = 0; i < 2; i++) {
			await engine.load(catalog.llm, "gpu", () => {});

			try {
				for await (const _c of engine.translate(request(), new AbortController().signal)) {
					// consume
				}
			} catch (e) {
				causes.push((e as EngineError).cause);
			}
		}

		expect(causes).to.deep.equal(["request", "load"]);
	});

	it("a different model gets its own reload grace", async () => {
		const d = deps([]);
		const engine = new WebLlmEngine(d.deps, name);
		engine.configure(catalog);
		const mlc = d.deps.create({model_list: []}, () => {});
		mlc.chat.completions.create = () => Promise.reject(new Error("Device lost"));
		d.deps.create = () => mlc;
		// A deploy's own model carries its library on its ref (models.ts).
		const other = {
			...catalog.llm,
			id: "other-model-q4f16_1-MLC",
			lib: "https://m.test/lib.wasm",
		};
		const causes: string[] = [];

		for (const ref of [catalog.llm, other]) {
			await engine.load(ref, "gpu", () => {});

			try {
				for await (const _c of engine.translate(
					request({model: ref.id}),
					new AbortController().signal
				)) {
					// consume
				}
			} catch (e) {
				causes.push((e as EngineError).cause);
			}
		}

		expect(causes).to.deep.equal(["request", "request"]);
	});

	it("a completed generation resets the failure count", async () => {
		const d = deps(["ok"]);
		const engine = new WebLlmEngine(d.deps, name);
		engine.configure(catalog);
		await engine.load(catalog.llm, "gpu", () => {});

		for await (const _c of engine.translate(request(), new AbortController().signal)) {
			// consume
		}

		expect(engine.generationFailures).to.equal(0);
	});

	it("asks with the prompt profile of the model it loaded", async () => {
		const d = deps(["ok"]);
		const asked: string[] = [];

		d.deps.prebuilt = [
			...prebuilt,
			{
				model_id: QWEN3_4B_ID,
				model: `https://huggingface.co/mlc-ai/${QWEN3_4B_ID}/resolve/main/`,
				model_lib: "https://m.test/qwen3-4b.wasm",
			},
		];

		d.deps.promptProfileFor = (modelId) => {
			asked.push(modelId);

			return {
				...promptProfileFor(modelId),
				buildMessages: () => [{role: "system", content: `profile of ${modelId}`}],
				maxTokensFor: () => 77,
			};
		};

		const engine = new WebLlmEngine(d.deps, name);
		const large = catalog.llmChoices.find((ref) => ref.id === QWEN3_4B_ID);

		engine.configure(catalog);
		await engine.load(large as ModelRef, "gpu", () => {});

		for await (const _c of engine.translate(
			request({model: QWEN3_4B_ID}),
			new AbortController().signal
		)) {
			// consume
		}

		expect(asked).to.deep.equal([QWEN3_4B_ID]);
		expect(d.calls.create[0].messages).to.deep.equal([
			{role: "system", content: `profile of ${QWEN3_4B_ID}`},
		]);
		expect(d.calls.create[0].max_tokens).to.equal(77);
	});

	it("without an injected lookup the loaded model's own profile builds the messages", async () => {
		const d = deps(["ok"]);
		const engine = new WebLlmEngine(d.deps, name);

		engine.configure(catalog);
		await engine.load(catalog.llm, "gpu", () => {});

		for await (const _c of engine.translate(request(), new AbortController().signal)) {
			// consume
		}

		expect(d.calls.create[0].messages).to.deep.equal(
			promptProfileFor(QWEN3_1_7B_ID).buildMessages(request(), name)
		);
	});
});
