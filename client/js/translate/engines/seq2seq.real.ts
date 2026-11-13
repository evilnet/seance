// The only import of @huggingface/transformers. Loaded by worker-entry.ts,
// never by a test. `configureTransformers` runs once per worker from the
// protocol's `configure` message: the mirror (or Hugging Face), the ORT
// wasm files the build copies to js/ort/, and the browser cache the
// library keeps under the "transformers-cache" Cache Storage name.

import {env, pipeline} from "@huggingface/transformers";
import {CacheApi} from "../models";
import type {Device, DeviceCopy} from "../engine";
import {PipelineLike, PipelineProgress, Seq2seqDeps, remoteFor} from "./seq2seq";
import {seq2seqCacheApi, UrlStore} from "./seq2seqCache";

const CACHE_NAME = "transformers-cache";

// The library's own Hugging Face host and path, as it ships them: what a
// load with no mirror and no host of its own goes back to.
const HUB = {remoteHost: env.remoteHost, remotePathTemplate: env.remotePathTemplate};
let mirror: string | undefined;
// The host is one setting for the whole library, read while `pipeline`
// fetches (and looks up the cache by URL); a model's files are all fetched
// before it resolves. So loads take turns, each with its own host.
let loading: Promise<unknown> = Promise.resolve();

export function configureTransformers(options: {modelBase?: string; ortBase: string}): void {
	env.allowLocalModels = false;
	env.useBrowserCache = true;
	mirror = options.modelBase;

	// `wasm` is declared readonly on the library's Env type (only its own
	// fields, like wasmPaths, are meant to be mutated) and, through the
	// Partial<Env> that TransformersEnvironment wraps it in, possibly
	// undefined to the type checker; at runtime the library always
	// populates it before this runs.
	env.backends.onnx.wasm!.wasmPaths = options.ortBase;
}

export const realSeq2seqDeps: Seq2seqDeps = {
	pipeline(copy, device, onProgress) {
		const turn = loading.then(() => load(copy, device, onProgress));

		loading = turn.catch(() => undefined);

		return turn;
	},
	threads: () => typeof SharedArrayBuffer !== "undefined",
};

async function load(
	copy: DeviceCopy,
	device: Device,
	onProgress: (p: PipelineProgress) => void
): Promise<PipelineLike> {
	const remote = remoteFor(copy, mirror) ?? HUB;

	env.remoteHost = remote.remoteHost;
	env.remotePathTemplate = remote.remotePathTemplate;

	const wasm = device === "cpu";
	const pipe = await pipeline("translation", copy.source, {
		dtype: copy.dtype as "q8",
		device: wasm ? "wasm" : "webgpu",
		// The q8 weights are QDQ graphs, and ONNX Runtime's *extended*
		// optimizer level (the library's default) runs a MatMulNBits
		// transform that rejects them outright: "Can't create a session.
		// ERROR_CODE: 1 … qdq_actions.cc:137
		// TransposeDQWeightsForMatMulNBits Missing required scale:
		// model.shared.weight_merged_0_scale for node:
		// model.shared.weight_transposed_DequantizeLinear" — so every CPU
		// model failed to load and the tier looked broken. `basic` stops
		// short of that transform and the same weights load and run.
		...(wasm ? {session_options: {graphOptimizationLevel: "basic"}} : {}),
		progress_callback(report: {
			status: string;
			file?: string;
			loaded?: number;
			total?: number;
		}) {
			if (report.status === "progress" && report.file && report.total) {
				onProgress({
					file: report.file,
					loaded: report.loaded ?? 0,
					total: report.total,
				});
			}
		},
	});

	return pipe as unknown as PipelineLike;
}

/** transformers.js's Cache Storage, as the URLs it holds. */
export function seq2seqStore(): UrlStore {
	return {
		async keys() {
			const cache = await caches.open(CACHE_NAME);

			return (await cache.keys()).map((request) => request.url);
		},
		async delete(url) {
			const cache = await caches.open(CACHE_NAME);

			await cache.delete(url);
		},
	};
}

/**
 * The library caches every file under a URL containing the repo id; a copy
 * is its dtype's weights among them (seq2seqCache.ts).
 */
export function seq2seqCache(store: UrlStore = seq2seqStore()): CacheApi {
	return seq2seqCacheApi(store);
}
