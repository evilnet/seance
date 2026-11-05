import {expect} from "chai";
import {
	type CacheLike,
	WEBLLM_MODEL_CACHE,
	manifestUrl,
} from "../../client/js/translate/engines/splitManifest";
import type {ModelRecord} from "../../client/js/translate/engines/webllm";
import {type AppConfigLike, webllmCacheApi} from "../../client/js/translate/engines/webllmCache";
import {
	type GpuBudget,
	QWEN3_1_7B_ID,
	QWEN3_1_7B_PINNED_MODEL,
	QWEN3_1_7B_SPLIT_ID,
	QWEN3_1_7B_SPLIT_LIB,
	QWEN3_4B_ID,
	buildCatalog,
} from "../../client/js/translate/models";

const MiB = 1024 * 1024;
const APP = "https://example.github.io/seance/";
const catalog = buildCatalog();
const small = catalog.llmChoices.find((ref) => ref.id === QWEN3_1_7B_ID)!;
const large = catalog.llmChoices.find((ref) => ref.id === QWEN3_4B_ID)!;
const prebuilt: ModelRecord[] = [
	{
		model_id: QWEN3_1_7B_ID,
		model: `https://huggingface.co/mlc-ai/${QWEN3_1_7B_ID}`,
		model_lib: "https://raw.githubusercontent.com/x/Qwen3-1.7B-q4f16_1_cs1k-webgpu.wasm",
		vram_required_MB: 2036.66,
	},
	{
		model_id: QWEN3_4B_ID,
		model: `https://huggingface.co/mlc-ai/${QWEN3_4B_ID}`,
		model_lib: "https://raw.githubusercontent.com/x/Qwen3-4B-q4f16_1_cs1k-webgpu.wasm",
	},
];
const OWN_MANIFEST = manifestUrl(prebuilt[0].model);
const SPLIT_MANIFEST = manifestUrl(QWEN3_1_7B_PINNED_MODEL);

function stand(gpu: GpuBudget | null, present: string[] = []) {
	const store = new Set(present);
	const calls: {op: string; id: string; config: AppConfigLike}[] = [];
	const cache: CacheLike = {
		match: (url) =>
			Promise.resolve(store.has(url) ? {json: () => Promise.resolve({})} : undefined),
		put(url) {
			store.add(url);

			return Promise.resolve();
		},
		delete: (url) => Promise.resolve(store.delete(url)),
	};
	const opened: string[] = [];
	const api = webllmCacheApi({
		has(id, config) {
			calls.push({op: "has", id, config});

			return Promise.resolve(true);
		},
		deleteAll(id, config) {
			calls.push({op: "delete", id, config});

			return Promise.resolve();
		},
		baseConfig: {cacheBackend: "cache"},
		prebuilt,
		appRoot: APP,
		seed: {
			openCache(name) {
				opened.push(name);

				return Promise.resolve(cache);
			},
		},
		getCatalog: () => catalog,
		getGpu: () => gpu,
	});

	return {api, calls, store, opened};
}

const phone: GpuBudget = {maxBufferBytes: 128 * MiB, capBytes: null};
const desktop: GpuBudget = {maxBufferBytes: 2048 * MiB, capBytes: null};

describe("translate/engines/webllmCache", () => {
	it("asks a desktop about the model itself, a phone about its small-buffer build", async () => {
		const onDesktop = stand(desktop);

		await onDesktop.api.has(small, "gpu");
		expect(onDesktop.calls.map((c) => c.id)).to.deep.equal([QWEN3_1_7B_ID]);
		expect(onDesktop.calls[0].config).to.deep.equal({
			cacheBackend: "cache",
			model_list: [prebuilt[0]],
		});

		const onPhone = stand(phone);

		await onPhone.api.has(small, "gpu");
		expect(onPhone.calls.map((c) => c.id)).to.deep.equal([QWEN3_1_7B_SPLIT_ID]);
		expect(onPhone.calls[0].config.model_list[0]).to.deep.include({
			model_id: QWEN3_1_7B_SPLIT_ID,
			model: QWEN3_1_7B_PINNED_MODEL,
			model_lib: APP + QWEN3_1_7B_SPLIT_LIB,
		});
		expect(onPhone.calls[0].config.cacheBackend).to.equal("cache");
	});

	it("asks before the probe, and about a model without a build, as itself", async () => {
		const early = stand(null);

		await early.api.has(small, "gpu");
		await early.api.has(large, "gpu");
		expect(early.calls.map((c) => c.id)).to.deep.equal([QWEN3_1_7B_ID, QWEN3_4B_ID]);
	});

	it("deletes a phone's build and its seeded manifest, and no model it never fetched", async () => {
		const {api, calls, store, opened} = stand(phone, [SPLIT_MANIFEST]);

		await api.delete(small, "gpu");

		expect(calls.map((c) => `${c.op} ${c.id}`)).to.deep.equal([
			`delete ${QWEN3_1_7B_SPLIT_ID}`,
		]);
		expect(store.has(SPLIT_MANIFEST)).to.equal(false);
		expect(opened.every((name) => name === WEBLLM_MODEL_CACHE)).to.equal(true);
	});

	it("deletes a desktop's model, and a build the test switch left behind", async () => {
		const plain = stand(desktop);

		await plain.api.delete(small, "gpu");
		expect(plain.calls.map((c) => `${c.op} ${c.id}`)).to.deep.equal([
			`delete ${QWEN3_1_7B_ID}`,
		]);

		const leftover = stand(desktop, [OWN_MANIFEST, SPLIT_MANIFEST]);

		await leftover.api.delete(small, "gpu");
		expect(leftover.calls.map((c) => `${c.op} ${c.id}`)).to.deep.equal([
			`delete ${QWEN3_1_7B_ID}`,
			`delete ${QWEN3_1_7B_SPLIT_ID}`,
		]);
		expect(leftover.store.has(SPLIT_MANIFEST)).to.equal(false);
	});

	it("deletes a phone's model itself only when something of it is there", async () => {
		const both = stand(phone, [OWN_MANIFEST, SPLIT_MANIFEST]);

		await both.api.delete(small, "gpu");
		expect(both.calls.map((c) => c.id)).to.deep.equal([QWEN3_1_7B_ID, QWEN3_1_7B_SPLIT_ID]);

		// Nothing of either: nothing is asked of WebLLM, which would fetch a
		// manifest from the network to delete what it lists.
		const none = stand(phone);

		await none.api.delete(small, "gpu");
		expect(none.calls).to.deep.equal([]);
	});

	it("a model without a build is deleted as before", async () => {
		const {api, calls} = stand(phone);

		await api.delete(large);
		expect(calls.map((c) => `${c.op} ${c.id}`)).to.deep.equal([`delete ${QWEN3_4B_ID}`]);
	});
});
