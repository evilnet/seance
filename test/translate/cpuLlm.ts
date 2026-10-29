import {expect} from "chai";
import {
	CpuLlmBackend,
	chatMlPrompt,
	cpuLlmCacheApi,
	cpuLlmUrl,
	createCpuMlc,
} from "../../client/js/translate/engines/cpuLlm";
import {WebLlmEngine, type WebLlmDeps} from "../../client/js/translate/engines/webllm";
import {noteDeviceLoss, takeDeviceLoss} from "../../client/js/translate/engines/gpuLimits";
import {
	CONTEXT_OVERFLOW,
	EngineError,
	emptyContext,
	parseGpuLost,
	type DeviceCopy,
	type TranslateRequest,
} from "../../client/js/translate/engine";
import {
	CPU_CONTEXT_WINDOW,
	CPU_LLM_COPY,
	CPU_LLM_REVISION,
	DEFAULT_CONTEXT_WINDOW,
	QWEN3_1_7B_ID,
	QWEN3_4B_ID,
	buildCatalog,
} from "../../client/js/translate/models";
import {requestTokens} from "../../client/js/translate/budget";
import {QWEN3_1_7B_PROMPT} from "../../client/js/translate/prompts/qwen3-1.7b";

const MiB = 1024 * 1024;
const catalog = buildCatalog();
const name = (code: string) => code;

/** The 1.7B's CPU copy, as the worker resolves it from the catalog; null for anything else. */
const copyFor = (id: string): DeviceCopy | null =>
	catalog.llmChoices.find((ref) => ref.id === id)?.copies.cpu ?? null;

interface FakeBackend extends CpuLlmBackend {
	loads: {copy: DeviceCopy; window: number}[];
	prompts: string[];
	opts: {temperature: number; maxTokens: number; stop: string[]}[];
	/** Pieces the generator yielded, and whether it saw its signal abort. */
	yielded: number;
	sawAbort: boolean;
	unloads: number;
}

function fakeBackend(pieces: string[], options: {fail?: Error; gate?: Promise<void>} = {}) {
	const backend: FakeBackend = {
		loads: [],
		prompts: [],
		opts: [],
		yielded: 0,
		sawAbort: false,
		unloads: 0,
		load(copy, window, onProgress) {
			backend.loads.push({copy, window});
			onProgress(0.5);
			onProgress(1);
			return Promise.resolve();
		},
		async *generate(prompt, opts, signal) {
			backend.prompts.push(prompt);
			backend.opts.push(opts);

			if (options.fail) {
				throw options.fail;
			}

			for (const piece of pieces) {
				if (options.gate && backend.yielded === 1) {
					await options.gate;
				}

				await Promise.resolve();

				if (signal.aborted) {
					backend.sawAbort = true;
					return;
				}

				backend.yielded++;
				yield piece;
			}
		},
		unload() {
			backend.unloads++;
			return Promise.resolve();
		},
	};

	return backend;
}

function cpuDeps(backend: CpuLlmBackend): WebLlmDeps {
	return {
		prebuilt: [],
		create: (_appConfig, onProgress) => createCpuMlc(backend, copyFor, onProgress),
	};
}

function cpuEngine(backend: CpuLlmBackend) {
	const engine = new WebLlmEngine(cpuDeps(backend), name, {
		contextWindow: CPU_CONTEXT_WINDOW,
		device: "cpu",
	});

	engine.configure(catalog);
	return engine;
}

function request(overrides: Partial<TranslateRequest> = {}): TranslateRequest {
	return {
		id: 1,
		model: QWEN3_1_7B_ID,
		text: "Ich schick dir gleich das Log.",
		from: "de",
		to: "en",
		purpose: "read",
		context: emptyContext(),
		...overrides,
	};
}

async function collect(engine: WebLlmEngine, req: TranslateRequest, signal?: AbortSignal) {
	const chunks: {text: string; done: boolean}[] = [];

	for await (const chunk of engine.translate(req, signal ?? new AbortController().signal)) {
		chunks.push(chunk);
	}

	return chunks;
}

describe("translate/engines/cpuLlm", () => {
	it("chatMlPrompt renders ChatML with the empty think block of enable_thinking: false", () => {
		const prompt = chatMlPrompt([
			{role: "system", content: "You translate."},
			{role: "user", content: "Hallo"},
		]);

		expect(prompt).to.equal(
			"<|im_start|>system\nYou translate.<|im_end|>\n" +
				"<|im_start|>user\nHallo<|im_end|>\n" +
				"<|im_start|>assistant\n<think>\n\n</think>\n\n"
		);
	});

	it("the model URL is pinned on Hugging Face and the file under a mirror", () => {
		expect(CPU_LLM_REVISION).to.equal("d7f544eead698dbd1f15126ef60b45a1e1933222");
		expect(cpuLlmUrl(CPU_LLM_COPY)).to.equal(
			"https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/d7f544eead698dbd1f15126ef60b45a1e1933222/Qwen3-1.7B-Q4_K_M.gguf"
		);
		// A mirror is the transformers.js layout: `{model}/` then the file.
		expect(cpuLlmUrl(CPU_LLM_COPY, "https://m.test/models/")).to.equal(
			"https://m.test/models/unsloth/Qwen3-1.7B-GGUF/Qwen3-1.7B-Q4_K_M.gguf"
		);
	});

	it("translates a request end to end with the 1.7B prompt profile", async () => {
		const backend = fakeBackend(["Ich send", "e dir gleich das Log."]);
		const engine = cpuEngine(backend);

		await engine.load(catalog.llm, "cpu", () => {});
		const chunks = await collect(engine, request({text: "I'll send you the log."}));

		expect(chunks[chunks.length - 1]).to.deep.include({
			text: "Ich sende dir gleich das Log.",
			done: true,
		});

		// The prompt is the profile's messages, as ChatML.
		const fitted = request({text: "I'll send you the log."});
		expect(backend.prompts).to.deep.equal([
			chatMlPrompt(QWEN3_1_7B_PROMPT.buildMessages(fitted, name)),
		]);
		// The engine's temperature and budget; a single line always stops at
		// the end of the turn.
		expect(backend.opts[0]).to.deep.equal({
			temperature: 0.1,
			maxTokens: QWEN3_1_7B_PROMPT.maxTokensFor(fitted),
			stop: ["<|im_end|>"],
		});
	});

	it("strips a think block the model writes anyway", async () => {
		const backend = fakeBackend(["<think>\n\n</think>\n\n", "Hallo Welt"]);
		const engine = cpuEngine(backend);

		await engine.load(catalog.llm, "cpu", () => {});
		const chunks = await collect(engine, request());

		expect(chunks[chunks.length - 1]).to.deep.include({text: "Hallo Welt", done: true});
	});

	it("a batch keeps its sentinel stop beside the end of the turn", async () => {
		const backend = fakeBackend(["1. a\n2. b\nEND"]);
		const engine = cpuEngine(backend);

		await engine.load(catalog.llm, "cpu", () => {});
		await collect(engine, request({lines: ["a", "b"], text: "a\nb"}));

		expect(backend.opts[0].stop).to.have.members(["\nEND", "<|im_end|>"]);
	});

	it("the backend is loaded with CPU_CONTEXT_WINDOW", async () => {
		const backend = fakeBackend([]);
		const engine = cpuEngine(backend);
		const progress: number[] = [];

		await engine.load(catalog.llm, "cpu", (p) => progress.push(p.fraction));

		expect(CPU_CONTEXT_WINDOW).to.equal(1024);
		expect(backend.loads).to.deep.equal([{copy: CPU_LLM_COPY, window: CPU_CONTEXT_WINDOW}]);
		expect(engine.contextWindow).to.equal(CPU_CONTEXT_WINDOW);
		expect(progress).to.deep.equal([0.5, 1]);
		expect(engine.isLoaded(QWEN3_1_7B_ID, "cpu")).to.equal(true);
		expect(engine.isLoaded(QWEN3_1_7B_ID, "gpu")).to.equal(false);
		expect(engine.isLoaded(QWEN3_1_7B_ID)).to.equal(true);
	});

	it("a small GPU never sends the CPU copy down the small-buffer build", async () => {
		const backend = fakeBackend([]);
		const engine = cpuEngine(backend);

		engine.configure(catalog, {maxBufferBytes: 128 * MiB, capBytes: null});
		await engine.load(catalog.llm, "cpu", () => {});

		expect(backend.loads.map((load) => load.copy)).to.deep.equal([CPU_LLM_COPY]);
		expect(engine.isLoaded(QWEN3_1_7B_ID, "cpu")).to.equal(true);
	});

	it("a model with no CPU copy fails to load, as a load failure", async () => {
		const backend = fakeBackend([]);
		const engine = cpuEngine(backend);
		const fourB = catalog.llmChoices.find((ref) => ref.id === QWEN3_4B_ID)!;
		const deployOwn = buildCatalog({llm: {model: "Own-Model-q4f16_1-MLC"}}).llm;

		for (const ref of [fourB, deployOwn]) {
			let error: unknown = null;

			try {
				await engine.load(ref, "cpu", () => {});
			} catch (e) {
				error = e;
			}

			expect(error, ref.id).to.be.instanceOf(EngineError);
			expect((error as EngineError).cause, ref.id).to.equal("load");
		}

		expect(backend.loads).to.deep.equal([]);
	});

	it("an over-long request fails with CONTEXT_OVERFLOW without calling generate", async () => {
		const backend = fakeBackend(["never"]);
		const engine = cpuEngine(backend);
		const long = request({text: Array.from({length: 300}, (_, i) => `word${i}`).join(" ")});
		const tokens = requestTokens(long, QWEN3_1_7B_PROMPT, name);

		// Too long for the CPU window, not for the GPU's: the CPU window is
		// the one the request is fitted to.
		expect(tokens).to.be.greaterThan(CPU_CONTEXT_WINDOW);
		expect(tokens).to.be.lessThan(DEFAULT_CONTEXT_WINDOW);

		await engine.load(catalog.llm, "cpu", () => {});
		let error: unknown = null;

		try {
			await collect(engine, long);
		} catch (e) {
			error = e;
		}

		expect(error).to.be.instanceOf(EngineError);
		expect((error as EngineError).message).to.equal(CONTEXT_OVERFLOW);
		expect(backend.prompts).to.deep.equal([]);
		expect(engine.isLoaded(QWEN3_1_7B_ID, "cpu"), "still loaded").to.equal(true);
	});

	it("aborting the signal stops the backend's iterator", async () => {
		let open: () => void = () => {};

		const gate = new Promise<void>((resolve) => {
			open = resolve;
		});
		const backend = fakeBackend(["a", "b", "c", "d", "e"], {gate});
		const engine = cpuEngine(backend);
		const controller = new AbortController();

		await engine.load(catalog.llm, "cpu", () => {});
		const run = collect(engine, request(), controller.signal);

		// The first piece is out; the backend waits at the gate.
		for (let i = 0; i < 20 && backend.yielded < 1; i++) {
			await Promise.resolve();
		}

		controller.abort();
		open();
		const chunks = await run;

		expect(backend.sawAbort).to.equal(true);
		expect(backend.yielded).to.equal(1);
		expect(chunks.some((chunk) => chunk.done)).to.equal(false);
	});

	it("a GPU loss recorded before a CPU failure is not reported", async () => {
		const backend = fakeBackend([], {fail: new Error("memory access out of bounds")});
		const engine = cpuEngine(backend);

		takeDeviceLoss();
		noteDeviceLoss({reason: "unknown", message: "GPU process terminated"});
		await engine.load(catalog.llm, "cpu", () => {});
		let error: unknown = null;

		try {
			await collect(engine, request());
		} catch (e) {
			error = e;
		}

		expect(error).to.be.instanceOf(EngineError);
		expect((error as EngineError).message).to.equal("memory access out of bounds");
		expect(parseGpuLost((error as EngineError).message)).to.equal(null);
		expect(takeDeviceLoss(), "the GPU's loss is still the GPU's").to.deep.equal({
			reason: "unknown",
			message: "GPU process terminated",
		});
		expect(backend.unloads, "the failed model is unloaded").to.equal(1);
	});

	it("generations take turns, and an interrupt ends only the running one", async () => {
		let open: () => void = () => {};

		const gate = new Promise<void>((resolve) => {
			open = resolve;
		});
		const backend = fakeBackend(["x", "y", "z"], {gate});
		const mlc = createCpuMlc(backend, copyFor, () => {});

		await mlc.reload(QWEN3_1_7B_ID, {context_window_size: CPU_CONTEXT_WINDOW});
		const ask = () =>
			mlc.chat.completions.create({
				messages: [{role: "user", content: "hi"}],
				stream: true,
				temperature: 0,
				max_tokens: 8,
			});
		const first = await ask();
		let secondStarted = false;
		const second = ask().then((stream) => {
			secondStarted = true;
			return stream;
		});

		const firstPieces: string[] = [];
		const drainFirst = (async () => {
			for await (const delta of first) {
				firstPieces.push(delta.choices[0].delta.content ?? "");
			}
		})();

		for (let i = 0; i < 20 && backend.yielded < 1; i++) {
			await Promise.resolve();
		}

		expect(secondStarted, "the second waits for the first").to.equal(false);
		mlc.interruptGenerate();
		open();
		await drainFirst;

		const secondPieces: string[] = [];

		for await (const delta of await second) {
			secondPieces.push(delta.choices[0].delta.content ?? "");
		}

		expect(firstPieces).to.deep.equal(["x"]);
		expect(secondPieces.join("")).to.equal("xyz");
	});

	it("the cache answers for the copy's URL through the library's cache", async () => {
		const stored = new Set<string>([cpuLlmUrl(CPU_LLM_COPY)]);
		const deleted: string[] = [];
		const api = cpuLlmCacheApi(
			{
				has: (url) => Promise.resolve(stored.has(url)),
				delete(url) {
					deleted.push(url);
					stored.delete(url);
					return Promise.resolve();
				},
			},
			() => undefined
		);

		expect(await api.has(catalog.llm, "cpu")).to.equal(true);
		await api.delete(catalog.llm, "cpu");
		expect(deleted).to.deep.equal([cpuLlmUrl(CPU_LLM_COPY)]);
		expect(await api.has(catalog.llm, "cpu")).to.equal(false);

		// No CPU copy: nothing downloaded, nothing to delete.
		const fourB = catalog.llmChoices.find((ref) => ref.id === QWEN3_4B_ID)!;
		expect(await api.has(fourB, "cpu")).to.equal(false);
		await api.delete(fourB, "cpu");
		expect(deleted).to.have.length(1);
	});
});
