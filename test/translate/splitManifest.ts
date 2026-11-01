import {expect} from "chai";
import {
	type CacheLike,
	type EmbeddingSplit,
	type SeedDeps,
	type TensorManifest,
	SPLIT_MARK,
	SplitManifestError,
	WEBLLM_MODEL_CACHE,
	dropSplitManifest,
	hasManifest,
	isSplitManifest,
	largestRecordBytes,
	manifestUrl,
	seedSplitManifest,
	splitManifest,
	splitMark,
} from "../../client/js/translate/engines/splitManifest";
import {
	LLM_CHOICES,
	QWEN3_1_7B_ID,
	QWEN3_1_7B_PINNED_MODEL,
} from "../../client/js/translate/models";

const ROWS = 151_936;
const AT = 75_968;

/** The 1.7B q4f16_1 build: what tools/translate-split/ compiled its library for. */
const Q4F16: EmbeddingSplit = {
	rows: ROWS,
	at: AT,
	weight: {cols: 256, dtype: "uint32"},
	scale: {cols: 64, dtype: "float16"},
};

/** The q4f32_1 bench build: a float32 scale stored as bf16, two bytes a value. */
const Q4F32: EmbeddingSplit = {...Q4F16, scale: {cols: 64, dtype: "float32"}};

/**
 * The published 1.7B q4f16_1 manifest's first shards, as Hugging Face serves
 * it at the pinned revision (every record "f32-to-bf16", which for uint32 and
 * float16 stores the values as they are): the table alone in shard 0, its
 * scale first in shard 1, then the first layer's tensors.
 */
function published(): TensorManifest {
	return {
		metadata: {ParamSize: 339, ParamBytes: 968001536, BitsPerParam: 4.5},
		records: [
			{
				dataPath: "params_shard_0.bin",
				format: "raw-shard",
				nbytes: 155_582_464,
				md5sum: "529aed61a274c19024f5c9431c844191",
				records: [
					{
						name: "model.embed_tokens.q_weight",
						shape: [ROWS, 256],
						dtype: "uint32",
						format: "f32-to-bf16",
						nbytes: 155_582_464,
						byteOffset: 0,
					},
				],
			},
			{
				dataPath: "params_shard_1.bin",
				format: "raw-shard",
				nbytes: 19_447_808 + 4096,
				records: [
					{
						name: "model.embed_tokens.q_scale",
						shape: [ROWS, 64],
						dtype: "float16",
						format: "f32-to-bf16",
						nbytes: 19_447_808,
						byteOffset: 0,
					},
					{
						name: "model.layers.0.input_layernorm.weight",
						shape: [2048],
						dtype: "float16",
						format: "f32-to-bf16",
						nbytes: 4096,
						byteOffset: 19_447_808,
					},
				],
			},
		],
	};
}

function names(manifest: TensorManifest): string[] {
	return manifest.records.flatMap((shard) => shard.records.map((record) => record.name));
}

function find(manifest: TensorManifest, name: string) {
	for (const shard of manifest.records) {
		for (const record of shard.records) {
			if (record.name === name) {
				return {shard: shard.dataPath, ...record};
			}
		}
	}

	return undefined;
}

describe("translate/engines/splitManifest", () => {
	describe("splitManifest", () => {
		it("cuts the table and its scale into two row ranges of the same shard record", () => {
			const out = splitManifest(published(), Q4F16);

			expect(names(out)).to.deep.equal([
				"model.embed_tokens.part0.q_weight",
				"model.embed_tokens.part1.q_weight",
				"model.embed_tokens.part0.q_scale",
				"model.embed_tokens.part1.q_scale",
				"model.layers.0.input_layernorm.weight",
			]);
			expect(find(out, "model.embed_tokens.part0.q_weight")).to.deep.include({
				shard: "params_shard_0.bin",
				shape: [AT, 256],
				dtype: "uint32",
				format: "f32-to-bf16",
				nbytes: AT * 1024,
				byteOffset: 0,
			});
			expect(find(out, "model.embed_tokens.part1.q_weight")).to.deep.include({
				shard: "params_shard_0.bin",
				shape: [ROWS - AT, 256],
				nbytes: (ROWS - AT) * 1024,
				byteOffset: AT * 1024,
			});
			expect(find(out, "model.embed_tokens.part0.q_scale")).to.deep.include({
				shard: "params_shard_1.bin",
				shape: [AT, 64],
				dtype: "float16",
				nbytes: AT * 128,
				byteOffset: 0,
			});
			expect(find(out, "model.embed_tokens.part1.q_scale")).to.deep.include({
				shard: "params_shard_1.bin",
				shape: [ROWS - AT, 64],
				nbytes: (ROWS - AT) * 128,
				byteOffset: AT * 128,
			});
		});

		it("leaves every other record, the shards and their relative paths as they are", () => {
			const before = published();
			const out = splitManifest(before, Q4F16);

			expect(find(out, "model.layers.0.input_layernorm.weight")).to.deep.equal({
				shard: "params_shard_1.bin",
				...before.records[1].records[1],
			});
			expect(out.records.map((shard) => shard.dataPath)).to.deep.equal([
				"params_shard_0.bin",
				"params_shard_1.bin",
			]);
			expect(out.records[0]).to.include({
				format: "raw-shard",
				nbytes: 155_582_464,
				md5sum: "529aed61a274c19024f5c9431c844191",
			});
			// The input is not touched.
			expect(names(before)).to.include("model.embed_tokens.q_weight");
		});

		it("halves the largest record: 74.2 MiB, under a phone's 128 MiB", () => {
			expect(largestRecordBytes(published())).to.equal(155_582_464);
			expect(largestRecordBytes(splitManifest(published(), Q4F16))).to.equal(77_791_232);
			expect(77_791_232).to.equal(LLM_CHOICES[0].smallBuffer!.largestBufferBytes);
		});

		it("reads a row's bytes off the record: a f32-to-bf16 float32 value is two bytes", () => {
			const manifest = published();
			const scale = manifest.records[1].records[0];

			scale.dtype = "float32";
			// Stored as bf16: two bytes a value, not four.
			scale.nbytes = ROWS * 64 * 2;
			manifest.records[1].records[1].byteOffset = scale.nbytes;

			const out = splitManifest(manifest, Q4F32);

			expect(find(out, "model.embed_tokens.part0.q_scale")).to.deep.include({
				dtype: "float32",
				format: "f32-to-bf16",
				nbytes: AT * 128,
				byteOffset: 0,
			});
			expect(find(out, "model.embed_tokens.part1.q_scale")).to.deep.include({
				nbytes: (ROWS - AT) * 128,
				byteOffset: AT * 128,
			});
		});

		it("adds a byte offset the record already had to both halves", () => {
			const manifest = published();

			manifest.records[0].records[0].byteOffset = 4096;

			const out = splitManifest(manifest, Q4F16);

			expect(find(out, "model.embed_tokens.part0.q_weight")?.byteOffset).to.equal(4096);
			expect(find(out, "model.embed_tokens.part1.q_weight")?.byteOffset).to.equal(
				4096 + AT * 1024
			);
		});

		it("marks the rewrite in the metadata and keeps the rest of it", () => {
			const out = splitManifest(published(), Q4F16);

			expect(out.metadata).to.deep.include({ParamSize: 339, ParamBytes: 968001536});
			expect(out.metadata?.[SPLIT_MARK]).to.equal(splitMark(Q4F16));
			expect(splitMark(Q4F16)).to.equal("v1:151936@75968");
		});

		it("refuses a table whose shape is not the one the library was built for", () => {
			const wider = published();

			// The 4B's table: 320 columns.
			wider.records[0].records[0].shape = [ROWS, 320];
			wider.records[0].records[0].nbytes = ROWS * 1280;

			expect(() => splitManifest(wider, Q4F16)).to.throw(
				SplitManifestError,
				"model.embed_tokens.q_weight is [151936, 320], the library expects [151936, 256]"
			);

			const longer = published();

			longer.records[1].records[0].shape = [ROWS + 1, 64];
			expect(() => splitManifest(longer, Q4F16)).to.throw(
				SplitManifestError,
				/\[151937, 64\]/
			);
		});

		it("refuses another type, a missing or doubled tensor, and bytes that are not whole rows", () => {
			const typed = published();

			typed.records[1].records[0].dtype = "float32";
			expect(() => splitManifest(typed, Q4F16)).to.throw(
				SplitManifestError,
				"model.embed_tokens.q_scale is float32, the library expects float16"
			);

			const missing = published();

			missing.records[1].records.shift();
			expect(() => splitManifest(missing, Q4F16)).to.throw(
				SplitManifestError,
				"the manifest has no model.embed_tokens.q_scale"
			);

			const doubled = published();

			doubled.records[1].records.push({...doubled.records[0].records[0]});
			expect(() => splitManifest(doubled, Q4F16)).to.throw(
				SplitManifestError,
				"lists model.embed_tokens.q_weight 2 times"
			);

			const ragged = published();

			ragged.records[0].records[0].nbytes += 1;
			expect(() => splitManifest(ragged, Q4F16)).to.throw(
				SplitManifestError,
				/are not whole rows/
			);
		});

		it("refuses a manifest that is already split, and a split row outside the table", () => {
			const once = splitManifest(published(), Q4F16);

			expect(() => splitManifest(once, Q4F16)).to.throw(SplitManifestError, /already split/);
			expect(() => splitManifest(published(), {...Q4F16, at: 0})).to.throw(
				SplitManifestError
			);
			expect(() => splitManifest(published(), {...Q4F16, at: ROWS})).to.throw(
				SplitManifestError
			);
			expect(() => splitManifest({} as TensorManifest, Q4F16)).to.throw(
				SplitManifestError,
				"no records"
			);
		});
	});

	describe("isSplitManifest", () => {
		it("knows its own rewrite, and nothing else", () => {
			const out = splitManifest(published(), Q4F16);

			expect(isSplitManifest(out, Q4F16)).to.equal(true);
			expect(isSplitManifest(published(), Q4F16)).to.equal(false);
			expect(isSplitManifest(out, {...Q4F16, at: AT + 1})).to.equal(false);
			expect(isSplitManifest(null, Q4F16)).to.equal(false);
			expect(isSplitManifest("{}", Q4F16)).to.equal(false);

			// The mark alone is not enough: both halves of both tensors.
			const marked = {...published(), metadata: {[SPLIT_MARK]: splitMark(Q4F16)}};

			expect(isSplitManifest(marked, Q4F16)).to.equal(false);
		});
	});

	describe("manifestUrl", () => {
		it("is the key WebLLM fetches the manifest under", () => {
			// A pinned revision is kept as it is.
			expect(manifestUrl(QWEN3_1_7B_PINNED_MODEL)).to.equal(
				"https://huggingface.co/mlc-ai/Qwen3-1.7B-q4f16_1-MLC/resolve/80b3abcec6c3b3f5355dc0cc99cc4fb578f192bc/tensor-cache.json"
			);
			// A bare repository, as the prebuilt records name it: resolve/main.
			expect(manifestUrl(`https://huggingface.co/mlc-ai/${QWEN3_1_7B_ID}`)).to.equal(
				`https://huggingface.co/mlc-ai/${QWEN3_1_7B_ID}/resolve/main/tensor-cache.json`
			);
			// A mirror's directory.
			expect(manifestUrl("https://example.org/models/x/")).to.equal(
				"https://example.org/models/x/resolve/main/tensor-cache.json"
			);
		});
	});

	describe("seedSplitManifest", () => {
		const source = {model: QWEN3_1_7B_PINNED_MODEL, split: Q4F16};
		const key = manifestUrl(QWEN3_1_7B_PINNED_MODEL);

		/** Cache Storage with one scope, by request URL; bodies kept as text. */
		function stand(body: () => unknown = published, status = 200) {
			const opened: string[] = [];
			const fetched: string[] = [];
			const store = new Map<string, string>();
			const cache: CacheLike = {
				match: (url) =>
					Promise.resolve(
						store.has(url)
							? {
									json: () =>
										new Promise<unknown>((resolve) =>
											resolve(JSON.parse(store.get(url)!))
										),
							  }
							: undefined
					),
				put(url, response) {
					store.set(url, (response as unknown as {body: string}).body);

					return Promise.resolve();
				},
				delete: (url) => Promise.resolve(store.delete(url)),
			};
			const deps: SeedDeps = {
				fetch(url) {
					fetched.push(url);

					return Promise.resolve({
						ok: status === 200,
						status,
						json: () => Promise.resolve(body()),
					});
				},
				openCache(name) {
					opened.push(name);

					return Promise.resolve(cache);
				},
				response: (text) => ({body: text} as unknown as Response),
			};

			return {deps, store, fetched, opened};
		}

		it("fetches the pinned manifest, rewrites it and puts it under WebLLM's key", async () => {
			const {deps, store, fetched, opened} = stand();

			expect(await seedSplitManifest(source, deps)).to.equal("seeded");
			expect(fetched).to.deep.equal([key]);
			expect(opened).to.deep.equal([WEBLLM_MODEL_CACHE]);
			expect([...store.keys()]).to.deep.equal([key]);
			expect(isSplitManifest(JSON.parse(store.get(key)!), Q4F16)).to.equal(true);
		});

		it("keeps a seed already there, fetching nothing", async () => {
			const {deps, store, fetched} = stand();

			await seedSplitManifest(source, deps);
			const before = store.get(key);

			expect(await seedSplitManifest(source, deps)).to.equal("kept");
			expect(fetched).to.have.length(1);
			expect(store.get(key)).to.equal(before);
		});

		it("replaces the stock manifest WebLLM's own delete left under the key", async () => {
			const {deps, store, fetched} = stand();

			store.set(key, JSON.stringify(published()));

			expect(await seedSplitManifest(source, deps)).to.equal("seeded");
			expect(fetched).to.have.length(1);
			expect(isSplitManifest(JSON.parse(store.get(key)!), Q4F16)).to.equal(true);
		});

		it("replaces a seed of another split, and an entry that is not JSON", async () => {
			const other = stand();

			other.store.set(key, JSON.stringify(splitManifest(published(), {...Q4F16, at: 1000})));
			expect(await seedSplitManifest(source, other.deps)).to.equal("seeded");

			const broken = stand();

			broken.store.set(key, "<html>");
			expect(await seedSplitManifest(source, broken.deps)).to.equal("seeded");
			expect(isSplitManifest(JSON.parse(broken.store.get(key)!), Q4F16)).to.equal(true);
		});

		it("stores nothing for a manifest the library was not built from, and says why", async () => {
			const {deps, store} = stand(() => {
				const wrong = published();

				wrong.records[0].records[0].shape = [ROWS, 320];
				wrong.records[0].records[0].nbytes = ROWS * 1280;

				return wrong;
			});

			let error: unknown = null;

			await seedSplitManifest(source, deps).catch((e: unknown) => (error = e));
			expect(error).to.be.instanceOf(SplitManifestError);
			expect((error as Error).message).to.contain("the library expects [151936, 256]");
			expect(store.size).to.equal(0);
		});

		it("fails on an HTTP error, storing nothing", async () => {
			const {deps, store} = stand(published, 404);
			let error: unknown = null;

			await seedSplitManifest(source, deps).catch((e: unknown) => (error = e));
			expect((error as Error).message).to.contain("HTTP 404");
			expect(store.size).to.equal(0);
		});

		it("drops the seed, and tells whether a manifest is there", async () => {
			const {deps, store} = stand();

			expect(await hasManifest(source.model, deps)).to.equal(false);
			await seedSplitManifest(source, deps);
			expect(await hasManifest(source.model, deps)).to.equal(true);
			await dropSplitManifest(source, deps);
			expect(store.size).to.equal(0);
			expect(await hasManifest(source.model, deps)).to.equal(false);
		});
	});
});
