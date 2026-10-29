// The only import of @mlc-ai/web-llm. Loaded by worker-entry.ts, never by
// a test. WebLLM keeps its weights in Cache Storage under its own keys and
// offers the two helpers the cache API needs.

import {
	type AppConfig,
	type ChatOptions,
	MLCEngine,
	deleteModelAllInfoInCache,
	hasModelInCache,
	prebuiltAppConfig,
} from "@mlc-ai/web-llm";
import {CacheApi, GpuBudget, ModelCatalog} from "../models";
import {MlcLike, ModelRecord, ReloadOptions, WebLlmDeps} from "./webllm";
import {webllmCacheApi} from "./webllmCache";
import {installBufferLimits} from "./gpuLimits";
import {SeedDeps, seedSplitManifest} from "./splitManifest";

// Before any reload: WebLLM's device asks for what the adapter can give
// (gpuLimits.ts). A worker without WebGPU has no GPUAdapter at all.
installBufferLimits(
	(globalThis as {GPUAdapter?: {prototype: Parameters<typeof installBufferLimits>[0]}}).GPUAdapter
		?.prototype
);

const prebuilt = prebuiltAppConfig.model_list as ModelRecord[];

// The engine reaches MLCEngine through `MlcLike` behind a cast (its chat API
// is overloaded past what the interface spells out), so the reload options
// are held to the library here: `reload(id, {context_window_size})` (a
// phone's window, webllm.ts) is WebLLM's own `reload(modelId, chatOpts)`,
// whose options override the record's `overrides` at load.
const reloadOptionsFit: ReloadOptions extends ChatOptions ? true : never = true;

void reloadOptionsFit;

/**
 * The app's root: this worker is js/translate-worker.js under it, wherever
 * the deploy serves it from (https://host/seance/develop/ on Pages).
 */
const appRoot = new URL("..", self.location.href).href;

/**
 * The Cache API backend, said outright rather than left to WebLLM's
 * default: the small-buffer build's manifest is seeded into Cache Storage
 * (splitManifest.ts), and a backend that never reads it there (OPFS, the
 * cross-origin extension) would load the stock manifest into the split
 * library.
 */
const CACHE_BACKEND = {cacheBackend: "cache" as const};

const seedDeps: SeedDeps = {
	fetch: (url) => fetch(url),
	openCache: (name) => caches.open(name),
	response: (body) => new Response(body, {headers: {"Content-Type": "application/json"}}),
};

export const realWebLlmDeps: WebLlmDeps = {
	prebuilt,
	appRoot,
	seedSplit: (build) => seedSplitManifest({model: build.model, split: build.split}, seedDeps),
	create(appConfig, onProgress) {
		return new MLCEngine({
			appConfig: {...prebuiltAppConfig, ...CACHE_BACKEND, model_list: appConfig.model_list},
			initProgressCallback: (report) =>
				onProgress({progress: report.progress, text: report.text}),
			logLevel: "WARN",
		}) as unknown as MlcLike;
	},
};

/** `has` / `delete` for the LLM (webllmCache.ts), over WebLLM's own two helpers. */
export function webllmCache(
	getCatalog: () => ModelCatalog | null,
	getGpu: () => GpuBudget | null
): CacheApi {
	return webllmCacheApi({
		has: (id, config) => hasModelInCache(id, config as unknown as AppConfig),
		deleteAll: (id, config) => deleteModelAllInfoInCache(id, config as unknown as AppConfig),
		baseConfig: {...prebuiltAppConfig, ...CACHE_BACKEND},
		prebuilt,
		appRoot,
		seed: seedDeps,
		getCatalog,
		getGpu,
	});
}
