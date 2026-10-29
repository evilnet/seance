// The only import of @wllama/wllama (llama.cpp in WebAssembly), the CPU
// library the spike chose (tools/translate-eval/results/2026-10-29-cpu-llm.md).
// Loaded by worker-entry.ts, never by a test or the page.
//
// Threads: the library's one wasm (js/wllama.wasm, copied next to this
// worker by the build) runs llama.cpp single-threaded or on pthreads, chosen
// at load: more than one `n_threads` and a SharedArrayBuffer (a
// cross-origin-isolated worker: the service worker's headers, threads.ts)
// start the thread pool. Not isolated, it is one thread, as measured
// (tools/translate-eval/results/2026-10-29-cpu-llm.md § Threads).
//
// The model file is kept in the library's own cache (OPFS, keyed by its
// URL), so the 1.1 GB file is downloaded once; the cache API asks that same
// cache.
//
// Never the library's "compat" build: it comes from a CDN (jsdelivr), and a
// deploy keeps its readers off third-party hosts other than the model's own
// (or its mirror). Where the browser lacks what the standard build needs
// (JSPI and Memory64: Safari, Firefox today), the load fails and says so.

import {CacheManager, LogLevel, ModelManager, Wllama} from "@wllama/wllama/esm/index.js";
import {CacheApi} from "../models";
import {cpuThreads} from "../threads";
import {CpuLlmBackend, cpuLlmCacheApi, cpuLlmUrl} from "./cpuLlm";

/** The library's wasm, beside this worker (webpack.config.ts copies it). */
const WASM_URL = new URL("wllama.wasm", self.location.href).href;

/** The library's own chatter stays out of the console; its warnings and errors do not. */
const logger = {...console, debug() {}, log() {}};

/**
 * The threads a load asks for: one where the worker is not cross-origin
 * isolated (no SharedArrayBuffer, no thread pool), else `cpuThreads`.
 */
function threadsHere(mobile: boolean): number {
	return self.crossOriginIsolated ? cpuThreads(navigator.hardwareConcurrency, mobile) : 1;
}

/**
 * wllama behind `CpuLlmBackend`: a fresh instance per load (the library
 * refuses a second model on one), `exit()` on unload. `getModelBase` is the
 * deploy's mirror as the worker was last configured with it, `isMobile`
 * whether the page's probe said phone or tablet (`GpuBudget.mobile`), read
 * at each load: the budget arrives after the worker starts.
 */
export function wllamaBackend(
	getModelBase: () => string | undefined,
	isMobile: () => boolean
): CpuLlmBackend {
	let instance: Wllama | null = null;

	const unload = async () => {
		const held = instance;

		instance = null;
		await held?.exit();
	};

	return {
		async load(copy, window, onProgress) {
			await unload();

			// Built here, not at import: the constructor checks the wasm
			// runtime, and a worker whose CPU library cannot run must still
			// serve the GPU.
			const wllama = new Wllama({default: WASM_URL}, {logger});

			wllama.setCompat(null);
			instance = wllama;

			try {
				await wllama.loadModelFromUrl(cpuLlmUrl(copy, getModelBase()), {
					n_ctx: window,
					n_threads: threadsHere(isMobile()),
					n_gpu_layers: 0,
					log_level: LogLevel.WARN,
					progressCallback({loaded, total}) {
						if (total > 0) {
							onProgress(Math.min(loaded / total, 1));
						}
					},
				});
			} catch (e) {
				if (instance === wllama) {
					instance = null;
				}

				await wllama.exit().catch(() => {});
				throw e;
			}

			onProgress(1);
		},
		async *generate(prompt, opts, signal) {
			if (!instance) {
				throw new Error("no model loaded on the CPU");
			}

			// The context is never reset between requests: llama.cpp keeps
			// the KV cache of the prompt's common prefix (the system prompt).
			const stream = await instance.createCompletion({
				prompt,
				stream: true,
				max_tokens: opts.maxTokens,
				temperature: opts.temperature,
				stop: opts.stop,
				abortSignal: signal,
			});

			for await (const chunk of stream) {
				const text = chunk.choices[0]?.text ?? "";

				if (text !== "") {
					yield text;
				}
			}
		},
		unload,
	};
}

/** `has` / `delete` for the language model's CPU copy, in the library's own cache. */
export function cpuLlmCache(getModelBase: () => string | undefined): CacheApi {
	let manager: ModelManager | null = null;
	// The default storage (OPFS) is the one `Wllama` downloads into.
	const models = () => (manager ??= new ModelManager({cacheManager: new CacheManager(), logger}));

	return cpuLlmCacheApi(
		{
			has: async (url) => (await models().getModels()).some((model) => model.url === url),
			delete: (url) => models().cacheManager.delete(url),
		},
		getModelBase
	);
}
