// The 1.7B's small-buffer build (docs/resources/translation.md § Phones and
// small GPUs): which build a device loads (models.ts `smallBufferBuildFor`),
// what the catalog offers it with, the library the app ships, and the test
// switch that makes a desktop GPU bind what a phone does.

import {expect} from "chai";
import {createHash} from "node:crypto";
import {readFileSync, readdirSync} from "node:fs";
import {resolve} from "node:path";
import {isBackupKey} from "../../client/js/helpers/settingsBackup";
import type {ModelRef} from "../../client/js/translate/engine";
import {manifestUrl} from "../../client/js/translate/engines/splitManifest";
import {appConfigFor, smallBufferConfig} from "../../client/js/translate/engines/webllm";
import {
	GPU_TEST_LIMIT_FLOOR_MIB,
	GPU_TEST_LIMIT_KEY,
	parseGpuTestLimit,
	readGpuTestLimit,
} from "../../client/js/translate/gpuTestLimit";
import {
	LLM_CHOICES,
	QWEN3_1_7B_ID,
	QWEN3_1_7B_PINNED_MODEL,
	QWEN3_1_7B_SPLIT_ID,
	QWEN3_1_7B_SPLIT_LIB,
	QWEN3_4B_ID,
	buildCatalog,
	buildIdFor,
	minBufferNeed,
	smallBufferBuildFor,
} from "../../client/js/translate/models";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const small = LLM_CHOICES.find((ref) => ref.id === QWEN3_1_7B_ID)!;
const large = LLM_CHOICES.find((ref) => ref.id === QWEN3_4B_ID)!;

describe("translate small-buffer build", () => {
	describe("smallBufferBuildFor", () => {
		it("is the model itself wherever it fits, and on a device not measured", () => {
			expect(smallBufferBuildFor(small, 2 * GiB)).to.equal(null);
			expect(smallBufferBuildFor(small, 512 * MiB)).to.equal(null);
			// Its own embedding exactly: still the model itself.
			expect(smallBufferBuildFor(small, 155_582_464)).to.equal(null);
			expect(smallBufferBuildFor(small, null)).to.equal(null);
			expect(smallBufferBuildFor(small, undefined)).to.equal(null);
			expect(smallBufferBuildFor(small, 0)).to.equal(null);
			expect(buildIdFor(small, 2 * GiB)).to.equal(QWEN3_1_7B_ID);
		});

		it("is the small-buffer build where only it fits: a phone's 128 MiB", () => {
			const build = smallBufferBuildFor(small, 128 * MiB);

			expect(build?.id).to.equal(QWEN3_1_7B_SPLIT_ID);
			expect(build?.largestBufferBytes).to.equal(77_791_232);
			expect(smallBufferBuildFor(small, 155_582_463)?.id).to.equal(QWEN3_1_7B_SPLIT_ID);
			expect(buildIdFor(small, 128 * MiB)).to.equal(QWEN3_1_7B_SPLIT_ID);
		});

		it("is the model itself where neither fits, and for a model without one", () => {
			expect(smallBufferBuildFor(small, 64 * MiB)).to.equal(null);
			expect(smallBufferBuildFor(large, 128 * MiB)).to.equal(null);
			expect(buildIdFor(large, 128 * MiB)).to.equal(QWEN3_4B_ID);
			expect(smallBufferBuildFor(buildCatalog().nllb, 128 * MiB)).to.equal(null);
		});

		it("needs the build's own buffer: half the table, 75968 rows of 1024 bytes", () => {
			expect(small.smallBuffer?.largestBufferBytes).to.equal(75_968 * 1024);
			expect(minBufferNeed(small)).to.equal(77_791_232);
			expect(minBufferNeed(large)).to.equal(194_478_080);
			expect(minBufferNeed({...small, copies: {}, smallBuffer: undefined})).to.be.undefined;
		});
	});

	describe("the catalog", () => {
		it("offers one 1.7B: the same download and memory figures, its build inside", () => {
			const catalog = buildCatalog();
			const listed = catalog.llmChoices.filter((ref) => ref.id.startsWith("Qwen3-1.7B"));

			expect(listed.map((ref) => ref.id)).to.deep.equal([QWEN3_1_7B_ID]);
			expect(listed[0].smallBuffer).to.deep.equal({
				id: QWEN3_1_7B_SPLIT_ID,
				model: QWEN3_1_7B_PINNED_MODEL,
				lib: QWEN3_1_7B_SPLIT_LIB,
				split: {
					rows: 151_936,
					at: 75_968,
					weight: {cols: 256, dtype: "uint32"},
					scale: {cols: 64, dtype: "float16"},
				},
				largestBufferBytes: 77_791_232,
			});
			expect(catalog.llmChoices.find((ref) => ref.id === QWEN3_4B_ID)?.smallBuffer).to.equal(
				undefined
			);
		});

		it("has no small-buffer build on a mirrored deploy, or one naming its own library", () => {
			const mirrored = buildCatalog({modelBase: "https://example.org/models"});

			expect(mirrored.llmChoices.every((ref) => !ref.smallBuffer)).to.equal(true);

			const ownLib = buildCatalog({
				llm: {model: QWEN3_1_7B_ID, lib: "https://example.org/qwen3.wasm"},
			});

			expect(ownLib.llm.smallBuffer).to.equal(undefined);
			// The shipped table stays untouched.
			expect(small.smallBuffer?.id).to.equal(QWEN3_1_7B_SPLIT_ID);
		});

		it("pins the build to a revision, so its manifest key is never the model's own", () => {
			const build = small.smallBuffer!;
			const prebuilt = [
				{
					model_id: QWEN3_1_7B_ID,
					model: `https://huggingface.co/mlc-ai/${QWEN3_1_7B_ID}`,
					model_lib:
						"https://raw.githubusercontent.com/x/Qwen3-1.7B-q4f16_1_cs1k-webgpu.wasm",
					vram_required_MB: 2036.66,
					overrides: {context_window_size: 4096},
				},
			];
			const own = appConfigFor(small, prebuilt, {}).model_list[0].model;
			const mirrored = appConfigFor(small, prebuilt, {modelBase: "https://example.org/m"})
				.model_list[0].model;

			expect(build.model).to.match(/\/resolve\/[0-9a-f]{40}\/$/);
			expect(manifestUrl(build.model)).to.not.equal(manifestUrl(own));
			expect(manifestUrl(build.model)).to.not.equal(manifestUrl(mirrored));
		});
	});

	describe("smallBufferConfig", () => {
		const prebuilt = [
			{
				model_id: QWEN3_1_7B_ID,
				model: `https://huggingface.co/mlc-ai/${QWEN3_1_7B_ID}`,
				model_lib:
					"https://raw.githubusercontent.com/x/Qwen3-1.7B-q4f16_1_cs1k-webgpu.wasm",
				vram_required_MB: 2036.66,
				low_resource_required: true,
				overrides: {context_window_size: 4096},
			},
		];

		it("is the model's record under the build's id, weights and library", () => {
			const config = smallBufferConfig(
				small,
				small.smallBuffer!,
				prebuilt,
				"https://example.github.io/seance/develop/"
			);

			expect(config.model_list).to.deep.equal([
				{
					model_id: QWEN3_1_7B_SPLIT_ID,
					model: QWEN3_1_7B_PINNED_MODEL,
					model_lib: `https://example.github.io/seance/develop/${QWEN3_1_7B_SPLIT_LIB}`,
					vram_required_MB: 2036.66,
					low_resource_required: true,
					overrides: {context_window_size: 4096},
				},
			]);
		});

		it("resolves the library under a subpath deploy, never at the origin's root", () => {
			// The worker is js/translate-worker.js under the app root.
			const root = new URL(
				"..",
				"https://example.github.io/seance/pr42/js/translate-worker.js?v=1"
			).href;

			expect(root).to.equal("https://example.github.io/seance/pr42/");
			expect(
				smallBufferConfig(small, small.smallBuffer!, prebuilt, root).model_list[0].model_lib
			).to.equal(`https://example.github.io/seance/pr42/${QWEN3_1_7B_SPLIT_LIB}`);
		});

		it("refuses a model WebLLM has no record for", () => {
			const stranger: ModelRef = {...small, id: "Other-MLC"};

			expect(() =>
				smallBufferConfig(stranger, small.smallBuffer!, prebuilt, "https://x/")
			).to.throw(/unknown WebLLM model Other-MLC/);
		});
	});

	describe("the shipped library", () => {
		it("is in client/models/ under the name the catalog gives, its hash in the name", () => {
			const dir = resolve(__dirname, "../../client/models");
			const file = QWEN3_1_7B_SPLIT_LIB.replace(/^models\//, "");
			const bytes = readFileSync(resolve(dir, file));
			const sha = createHash("sha256").update(bytes).digest("hex");
			const named = /-([0-9a-f]{8})\.wasm$/.exec(file)?.[1];

			expect(readdirSync(dir).filter((name) => name.endsWith(".wasm"))).to.deep.equal([file]);
			expect(named, "the name carries a hash").to.be.a("string");
			expect(sha.slice(0, 8)).to.equal(named);
			// A WebAssembly module, not a text file normalised by git.
			expect([...bytes.subarray(0, 4)]).to.deep.equal([0, 97, 115, 109]);
		});
	});

	describe("the test switch", () => {
		it("reads MiB, at least WebGPU's 128 MiB binding, and nothing else", () => {
			expect(parseGpuTestLimit("128")).to.equal(128 * MiB);
			expect(parseGpuTestLimit(" 256 ")).to.equal(256 * MiB);
			expect(parseGpuTestLimit("200.7")).to.equal(200 * MiB);
			expect(parseGpuTestLimit("64")).to.equal(GPU_TEST_LIMIT_FLOOR_MIB * MiB);
			expect(parseGpuTestLimit(null)).to.equal(null);
			expect(parseGpuTestLimit("")).to.equal(null);
			expect(parseGpuTestLimit("0")).to.equal(null);
			expect(parseGpuTestLimit("-5")).to.equal(null);
			expect(parseGpuTestLimit("lots")).to.equal(null);
		});

		it("is a thelounge.state key, which the settings backup never carries", () => {
			expect(GPU_TEST_LIMIT_KEY).to.equal("thelounge.state.gpuTestLimitMiB");
			expect(isBackupKey(GPU_TEST_LIMIT_KEY)).to.equal(false);
			expect(
				readGpuTestLimit({getItem: (key) => (key === GPU_TEST_LIMIT_KEY ? "128" : null)})
			).to.equal(128 * MiB);
			expect(readGpuTestLimit(null)).to.equal(null);
			expect(
				readGpuTestLimit({
					getItem() {
						throw new Error("SecurityError");
					},
				})
			).to.equal(null);
		});
	});
});
