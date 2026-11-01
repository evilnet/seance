// The worker's "is it downloaded" / "delete it" for the GPU models, over
// WebLLM's own two cache helpers (handed in by webllm.real.ts, so mocha tests
// this with stand-ins). Which build is the model on this device is the one
// rule models.ts `smallBufferBuildFor` gives, so a phone's "Downloaded" is its
// small-buffer build's and a desktop's the model's own.

import {ModelRef, SmallBufferBuild} from "../engine";
import {CacheApi, GpuBudget, ModelCatalog, smallBufferBuildFor} from "../models";
import {ModelRecord, appConfigFor, smallBufferConfig} from "./webllm";
import {SeedDeps, dropSplitManifest, hasManifest} from "./splitManifest";

/** An app config as WebLLM's helpers take it: the base config with one record. */
export type AppConfigLike = {model_list: ModelRecord[]} & Record<string, unknown>;

export interface WebLlmCacheDeps {
	/** WebLLM's `hasModelInCache`. */
	has(modelId: string, appConfig: AppConfigLike): Promise<boolean>;
	/** WebLLM's `deleteModelAllInfoInCache`: the shards, tokenizer, library and config — not the manifest. */
	deleteAll(modelId: string, appConfig: AppConfigLike): Promise<void>;
	/** What every config carries besides its record (WebLLM's prebuilt config, its cache backend). */
	baseConfig: Record<string, unknown>;
	prebuilt: ModelRecord[];
	appRoot: string;
	seed: Pick<SeedDeps, "openCache">;
	getCatalog(): ModelCatalog | null;
	getGpu(): GpuBudget | null;
}

export function webllmCacheApi(deps: WebLlmCacheDeps): CacheApi {
	const record = (ref: ModelRef, build: SmallBufferBuild | null) =>
		build
			? smallBufferConfig(ref, build, deps.prebuilt, deps.appRoot)
			: appConfigFor(ref, deps.prebuilt, {
					modelBase: deps.getCatalog()?.modelBase,
					lib: ref.lib,
			  });

	const config = (ref: ModelRef, build: SmallBufferBuild | null): AppConfigLike => ({
		...deps.baseConfig,
		model_list: record(ref, build).model_list,
	});

	const buildHere = (ref: ModelRef) => smallBufferBuildFor(ref, deps.getGpu()?.maxBufferBytes);

	return {
		// `async` so that `config()` throwing for a model the library does not
		// know (appConfigFor) rejects rather than throwing at the caller:
		// cacheStates() isolates a rejection to this one row.
		async has(ref) {
			const build = buildHere(ref);

			return await deps.has(build?.id ?? ref.id, config(ref, build));
		},
		// Every build of the model goes, not only this device's: a desktop that
		// downloaded the small-buffer build under the test switch has nothing
		// else to delete it with once the switch is cleared. A build other
		// than this device's is deleted only when its manifest is in the
		// cache, because WebLLM's delete fetches a missing manifest from the
		// network (and caches it under the build's key) before it deletes
		// anything. The small-buffer build's manifest is seeded before
		// WebLLM fetches anything of it, so without one there is nothing of
		// it to delete; with one, ours or the stock one, the shards it lists
		// are the same files. WebLLM's delete leaves every manifest in place:
		// the small-buffer build's is removed here, so a later load seeds it
		// afresh.
		async delete(ref) {
			const here = buildHere(ref);
			const small = ref.engine === "llm" ? ref.smallBuffer ?? null : null;
			const own = config(ref, null);

			if (here === null || (await hasManifest(own.model_list[0].model, deps.seed))) {
				await deps.deleteAll(ref.id, own);
			}

			if (small && (await hasManifest(small.model, deps.seed))) {
				await deps.deleteAll(small.id, config(ref, small));
				await dropSplitManifest({model: small.model}, deps.seed);
			}
		},
	};
}
