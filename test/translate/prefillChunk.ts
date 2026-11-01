// The GPU model's prefill chunk (models.ts `prefillChunkFor`,
// engines/webllm.ts): a phone's GPU takes a prompt 64 tokens at a time, a
// computer's in the library's own chunks, and the test switch
// (`thelounge.state.gpuPrefillChunk`, gpuPrefillChunk.ts) overrides both;
// the URL switches (testSwitches.ts) store it and leave the address bar.

import {expect} from "chai";
import {
	WebLlmEngine,
	type MlcLike,
	type ModelRecord,
} from "../../client/js/translate/engines/webllm";
import {
	MOBILE_PREFILL_CHUNK,
	buildCatalog,
	prefillChunkFor,
	smallBufferBuildFor,
	type GpuBudget,
} from "../../client/js/translate/models";
import {
	GPU_PREFILL_CHUNK_KEY,
	parseGpuPrefillChunk,
	readGpuPrefillChunk,
} from "../../client/js/translate/gpuPrefillChunk";
import {GPU_TEST_LIMIT_KEY} from "../../client/js/translate/gpuTestLimit";
import {takeTestSwitches} from "../../client/js/translate/testSwitches";

const catalog = buildCatalog();
const MiB = 1024 * 1024;
const COMPUTER: GpuBudget = {maxBufferBytes: 1024 * MiB, capBytes: null};
const PHONE: GpuBudget = {maxBufferBytes: 1024 * MiB, capBytes: null, mobile: true};
const SMALL_PHONE: GpuBudget = {maxBufferBytes: 128 * MiB, capBytes: null, mobile: true};
const prebuilt: ModelRecord[] = [
	{
		model_id: catalog.llm.id,
		model: `https://huggingface.co/mlc-ai/${catalog.llm.id}/resolve/main/`,
		model_lib: "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/qwen3.wasm",
		overrides: {context_window_size: 4096},
	},
];

/** A storage for the switches: what was stored and removed. */
function memoryStorage(initial: Record<string, string> = {}) {
	const items = new Map(Object.entries(initial));

	return {
		items,
		getItem: (key: string) => items.get(key) ?? null,
		setItem: (key: string, value: string) => void items.set(key, value),
		removeItem: (key: string) => void items.delete(key),
	};
}

describe("translate: the GPU's prefill chunk", () => {
	describe("prefillChunkFor", () => {
		it("is 64 tokens on a phone and the library's own on a computer", () => {
			expect(MOBILE_PREFILL_CHUNK).to.equal(64);
			expect(prefillChunkFor(PHONE)).to.equal(64);
			expect(prefillChunkFor(COMPUTER)).to.equal(null);
			expect(prefillChunkFor(null)).to.equal(null);
			expect(prefillChunkFor(undefined)).to.equal(null);
		});

		it("follows the test switch on both, and its 0 is the library's own", () => {
			expect(prefillChunkFor({...COMPUTER, prefillChunk: 32})).to.equal(32);
			expect(prefillChunkFor({...PHONE, prefillChunk: 32})).to.equal(32);
			expect(prefillChunkFor({...PHONE, prefillChunk: null})).to.equal(null);
		});
	});

	describe("the stored switch", () => {
		it("is a positive integer, 0 for the library's own, else absent", () => {
			expect(parseGpuPrefillChunk("32")).to.equal(32);
			expect(parseGpuPrefillChunk(" 128 ")).to.equal(128);
			expect(parseGpuPrefillChunk("0")).to.equal(null);

			for (const junk of [null, undefined, "", " ", "-4", "3.5", "abc", "1e3x"]) {
				expect(parseGpuPrefillChunk(junk), String(junk)).to.equal(undefined);
			}
		});

		it("is read from thelounge.state.gpuPrefillChunk, and a storage that throws is no switch", () => {
			expect(GPU_PREFILL_CHUNK_KEY).to.equal("thelounge.state.gpuPrefillChunk");
			expect(readGpuPrefillChunk(memoryStorage({[GPU_PREFILL_CHUNK_KEY]: "48"}))).to.equal(
				48
			);
			expect(readGpuPrefillChunk(memoryStorage())).to.equal(undefined);
			expect(
				readGpuPrefillChunk({
					getItem() {
						throw new Error("private window");
					},
				})
			).to.equal(undefined);
		});
	});

	describe("WebLlmEngine", () => {
		function rig(gpu: GpuBudget | null, options: {device?: "gpu" | "cpu"} = {}) {
			const set: [string, number][] = [];
			let answer = true;
			const mlc: MlcLike = {
				reload: () => Promise.resolve(),
				unload: () => Promise.resolve(),
				interruptGenerate() {},
				chat: {completions: {create: () => Promise.reject(new Error("not here"))}},
			};
			const engine = new WebLlmEngine(
				{
					prebuilt,
					appRoot: "https://app.test/",
					create: () => mlc,
					seedSplit: () => Promise.resolve(),
					setPrefillChunk(engineMlc, modelId, tokens) {
						expect(engineMlc).to.equal(mlc);
						set.push([modelId, tokens]);
						return answer;
					},
				},
				(code) => code,
				options.device === "cpu" ? {device: "cpu", contextWindow: 1024} : {}
			);

			engine.configure(catalog, gpu ?? undefined);

			return {
				engine,
				set,
				refuse() {
					answer = false;
				},
			};
		}

		it("sets 64 after a phone's GPU reload, with the id it reloaded", async () => {
			const r = rig(PHONE);

			await r.engine.load(catalog.llm, "gpu", () => {});
			expect(r.set).to.deep.equal([[catalog.llm.id, 64]]);
		});

		it("names the small-buffer build's id when that is what loaded", async () => {
			const build = smallBufferBuildFor(catalog.llm, SMALL_PHONE.maxBufferBytes);

			expect(build, "the 1.7B has a small-buffer build").to.not.equal(null);

			const r = rig(SMALL_PHONE);

			await r.engine.load(catalog.llm, "gpu", () => {});
			expect(r.set).to.deep.equal([[build!.id, 64]]);
		});

		it("never on a computer, unless the switch says so", async () => {
			const computer = rig(COMPUTER);

			await computer.engine.load(catalog.llm, "gpu", () => {});
			expect(computer.set).to.deep.equal([]);

			const switched = rig({...COMPUTER, prefillChunk: 32});

			await switched.engine.load(catalog.llm, "gpu", () => {});
			expect(switched.set).to.deep.equal([[catalog.llm.id, 32]]);
		});

		it("never on the CPU instance", async () => {
			const r = rig(PHONE, {device: "cpu"});

			await r.engine.load(catalog.llm, "cpu", () => {});
			expect(r.set).to.deep.equal([]);
		});

		it("a library that refuses (false) does not fail the load", async () => {
			const r = rig(PHONE);

			r.refuse();
			await r.engine.load(catalog.llm, "gpu", () => {});
			expect(r.set).to.have.length(1);
			expect(r.engine.isLoaded(catalog.llm.id)).to.equal(true);
		});
	});

	describe("the URL switches", () => {
		it("stores ?gpuPrefillChunk and ?gpuTestLimitMiB and leaves every other parameter and the hash", () => {
			const storage = memoryStorage();
			const clean = takeTestSwitches(
				"https://app.test/seance/?gpuPrefillChunk=64&nick=alice&gpuTestLimitMiB=128&join=%23a#/settings/translation",
				storage
			);

			expect(storage.items.get(GPU_PREFILL_CHUNK_KEY)).to.equal("64");
			expect(storage.items.get(GPU_TEST_LIMIT_KEY)).to.equal("128");
			expect(clean).to.equal(
				"https://app.test/seance/?nick=alice&join=%23a#/settings/translation"
			);
		});

		it("0 or empty removes the stored value; with nothing else the query goes", () => {
			const storage = memoryStorage({
				[GPU_PREFILL_CHUNK_KEY]: "32",
				[GPU_TEST_LIMIT_KEY]: "128",
			});

			expect(
				takeTestSwitches("https://app.test/?gpuPrefillChunk=0&gpuTestLimitMiB=", storage)
			).to.equal("https://app.test/");
			expect(storage.items.size).to.equal(0);
		});

		it("ignores junk (nothing stored, nothing removed) but still takes it out of the address bar", () => {
			const storage = memoryStorage({[GPU_PREFILL_CHUNK_KEY]: "32"});

			expect(
				takeTestSwitches(
					"https://app.test/?gpuPrefillChunk=lots&gpuTestLimitMiB=-1#x",
					storage
				)
			).to.equal("https://app.test/#x");
			expect(storage.items.get(GPU_PREFILL_CHUNK_KEY)).to.equal("32");
			expect(storage.items.has(GPU_TEST_LIMIT_KEY)).to.equal(false);
		});

		it("is null when the URL has neither switch", () => {
			const storage = memoryStorage();

			expect(takeTestSwitches("https://app.test/?nick=alice#/", storage)).to.equal(null);
			expect(storage.items.size).to.equal(0);
		});
	});
});
