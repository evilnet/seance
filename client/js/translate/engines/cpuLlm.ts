// The language model on the CPU (spec docs/projects/translation-devices.md
// § Engines and the worker): the same `WebLlmEngine` the GPU runs — its
// prompt profiles, think-block handling, `fitToWindow` and guards — over an
// `MlcLike` made here from a CPU library's backend instead of WebLLM's
// MLCEngine. The library is the spike's winner, wllama (llama.cpp in
// WebAssembly; tools/translate-eval/results/2026-10-29-cpu-llm.md), wired in
// cpuLlm.real.ts, the only file that imports it. Vue-free and library-free,
// so mocha drives it with a scripted backend.
//
// The backend completes raw text, so the chat is rendered here as Qwen3's
// ChatML with the empty think block `enable_thinking: false` renders
// (`chatMlPrompt`): the model answers after it, never inside one. The system
// prompt stays first and the backend's context is never reset between
// requests: llama.cpp reuses the KV cache of the common prefix, which on the
// spike's core brought the first token about three times sooner.
//
// Generations take turns, as WebLLM's do behind its per-model lock: the
// engine's abort handling relies on it (only the request that owns the
// generation may interrupt it), and one CPU thread gains nothing from two.

import {DeviceCopy, EngineError, ModelRef} from "../engine";
import {CPU_CONTEXT_WINDOW, CPU_LLM_COPY, CPU_LLM_REVISION, CacheApi} from "../models";
import {ChatMessage} from "../prompt";
import {ChatDelta, ChatRequest, MlcLike, ReloadOptions} from "./webllm";

/** What the CPU library does for the engine; cpuLlm.real.ts is the wllama one. */
export interface CpuLlmBackend {
	/** Fetch (or read from the library's cache) and load `copy` with a `window`-token context. */
	load(copy: DeviceCopy, window: number, onProgress: (fraction: number) => void): Promise<void>;
	/** The completion of `prompt`, piece by piece; ends (or throws) once `signal` aborts. */
	generate(
		prompt: string,
		opts: {temperature: number; maxTokens: number; stop: string[]},
		signal: AbortSignal
	): AsyncIterable<string>;
	unload(): Promise<void>;
}

/** Qwen3's end of turn: every generation stops at it, whatever the caller's stops. */
export const IM_END = "<|im_end|>";

/**
 * `messages` as Qwen3's chat template renders them with `add_generation_prompt`
 * and `enable_thinking: false`: one `<|im_start|>role\n…<|im_end|>\n` block
 * each, then the assistant's turn opened on an empty think block.
 */
export function chatMlPrompt(messages: ChatMessage[]): string {
	const turns = messages.map((m) => `<|im_start|>${m.role}\n${m.content}${IM_END}\n`);

	return `${turns.join("")}<|im_start|>assistant\n<think>\n\n</think>\n\n`;
}

const HF = "https://huggingface.co/";

/**
 * Where `copy`'s file is fetched from: Hugging Face at the pinned commit
 * (`CPU_LLM_REVISION` for the shipped copy), or a deploy's mirror laid out
 * as transformers.js reads one (`{modelBase}/{repo}/{file}`,
 * seq2seq.real.ts `configureTransformers`). The URL is also the file's key
 * in the library's cache, so the cache API asks with this same URL. The
 * file name stays last: wllama refuses a URL that does not end in `.gguf`.
 */
export function cpuLlmUrl(copy: DeviceCopy, modelBase?: string): string {
	if (!copy.file) {
		throw new Error(`${copy.source} names no file to fetch`);
	}

	const base = modelBase?.replace(/\/+$/, "");

	if (base) {
		return `${base}/${copy.source}/${copy.file}`;
	}

	const revision = copy.source === CPU_LLM_COPY.source ? CPU_LLM_REVISION : "main";

	return `${HF}${copy.source}/resolve/${revision}/${copy.file}`;
}

/**
 * An `MlcLike` over `backend`: `reload` loads the model's CPU copy
 * (`copyFor`, from the catalog) with the window asked for, else
 * `CPU_CONTEXT_WINDOW`; a model with no CPU copy (the 4B, a deploy's own
 * model) fails as a load. `onProgress` gets WebLLM's report shape.
 */
export function createCpuMlc(
	backend: CpuLlmBackend,
	copyFor: (modelId: string) => DeviceCopy | null,
	onProgress: (report: {progress: number; text: string}) => void
): MlcLike {
	/** The backend holds (or was asked to load) a model: unload has work to do. */
	let held = false;
	let loaded = false;
	/** Settles when the generation ahead of the next one has finished. */
	let turn: Promise<void> = Promise.resolve();
	/** The running generation's own controller, which `interruptGenerate` aborts. */
	let current: AbortController | null = null;

	const unload = async () => {
		current?.abort();
		loaded = false;

		if (held) {
			held = false;
			await backend.unload();
		}
	};

	const create = async (request: ChatRequest): Promise<AsyncIterable<ChatDelta>> => {
		const prompt = chatMlPrompt(request.messages);
		const stop = [...(request.stop ?? []).filter((s) => s !== IM_END), IM_END];
		const ahead = turn;

		let release: () => void = () => {};

		turn = new Promise<void>((resolve) => {
			release = resolve;
		});
		await ahead;

		if (!loaded) {
			release();
			throw new Error("no model loaded on the CPU");
		}

		const controller = new AbortController();

		current = controller;

		const pieces = backend.generate(
			prompt,
			{temperature: request.temperature, maxTokens: request.max_tokens, stop},
			controller.signal
		);

		return (async function* () {
			try {
				for await (const piece of pieces) {
					yield {choices: [{delta: {content: piece}}]};
				}
			} catch (e) {
				// An interrupted generation ends; it has nothing to report.
				if (!controller.signal.aborted) {
					throw e;
				}
			} finally {
				if (current === controller) {
					current = null;
				}

				release();
			}
		})();
	};

	return {
		async reload(modelId: string, chatOpts?: ReloadOptions) {
			const copy = copyFor(modelId);

			if (!copy) {
				throw new EngineError(`${modelId} has no CPU copy`, "load");
			}

			await unload();
			held = true;
			await backend.load(copy, chatOpts?.context_window_size ?? CPU_CONTEXT_WINDOW, (f) =>
				onProgress({progress: f, text: ""})
			);
			loaded = true;
		},
		unload,
		interruptGenerate() {
			current?.abort();
		},
		chat: {completions: {create}},
	};
}

/** The slice of the library's model cache the cache API needs, by the file's URL. */
export interface CpuLlmStore {
	has(url: string): Promise<boolean>;
	delete(url: string): Promise<void>;
}

/**
 * "Is it downloaded" / "delete it" for a language model's CPU copy: its
 * file's URL (`cpuLlmUrl`, the deploy's mirror as it is now) in the
 * library's own cache. A model with no CPU copy has nothing downloaded.
 */
export function cpuLlmCacheApi(
	store: CpuLlmStore,
	getModelBase: () => string | undefined
): CacheApi {
	const urlOf = (ref: ModelRef): string | null => {
		const copy = ref.copies.cpu;

		return copy?.file ? cpuLlmUrl(copy, getModelBase()) : null;
	};

	return {
		async has(ref) {
			const url = urlOf(ref);

			return url ? await store.has(url) : false;
		},
		async delete(ref) {
			const url = urlOf(ref);

			if (url) {
				await store.delete(url);
			}
		},
	};
}
