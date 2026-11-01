// The small-buffer build of a GPU model (docs/resources/translation.md
// § Phones and small GPUs, tools/translate-split/): a phone's WebGPU binds at
// most 128 MiB per storage buffer, and each weight tensor is one binding, so
// Qwen3's quantized vocabulary table (148 MiB in the 1.7B) cannot load there.
// Our own build of the model library splits the table by rows into two
// parameters, `model.embed_tokens.part0.*` and `part1.*`; the published
// weights are untouched, because each half is a byte range of the same
// published shard record. What the library is handed is a rewritten tensor
// manifest that names those two ranges, and WebLLM is made to use it by
// putting it into its own Cache Storage scope under the URL it will ask for
// (`seedSplitManifest`): WebLLM matches the cache before it fetches.
//
// Vue-free and DOM-free; the Cache API and `fetch` are passed in, so mocha
// tests it with stand-ins. engines/webllm.real.ts hands in the real ones.

/** One tensor of a shard (tvmjs `tensor-cache.json`). */
export interface TensorRecord {
	name: string;
	shape: number[];
	dtype: string;
	format: string;
	nbytes: number;
	byteOffset: number;
	[key: string]: unknown;
}

/** One shard file and the tensors that are byte ranges of it. */
export interface TensorShard {
	dataPath: string;
	format: string;
	nbytes: number;
	records: TensorRecord[];
	[key: string]: unknown;
}

export interface TensorManifest {
	metadata?: Record<string, unknown>;
	records: TensorShard[];
	[key: string]: unknown;
}

/**
 * What the split library was compiled for: the vocabulary's rows, the row
 * the table is split at, and each of the two tensors' columns and type as
 * the published manifest lists them. A published manifest that says
 * otherwise is not the model the library was built from, and is refused.
 */
export interface EmbeddingSplit {
	rows: number;
	at: number;
	weight: {cols: number; dtype: string};
	scale: {cols: number; dtype: string};
}

/** The two tensors the split replaces, and the leaf names they keep. */
const EMBED_PREFIX = "model.embed_tokens.";
const LEAVES = ["q_weight", "q_scale"] as const;

/**
 * Written into the rewritten manifest's `metadata` (tvmjs merges that object
 * and reads nothing of it by this name): a seeded manifest carrying the
 * wrong mark, or none, is not ours and is rewritten.
 */
export const SPLIT_MARK = "SeanceEmbeddingSplit";
/** Bumped when the rewrite itself changes, so an older seed is replaced. */
export const SPLIT_VERSION = 1;

export class SplitManifestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SplitManifestError";
	}
}

function expected(split: EmbeddingSplit, leaf: typeof LEAVES[number]) {
	return leaf === "q_weight" ? split.weight : split.scale;
}

/** The mark a manifest rewritten for `split` carries. */
export function splitMark(split: EmbeddingSplit): string {
	return `v${SPLIT_VERSION}:${split.rows}@${split.at}`;
}

/**
 * The published manifest with the vocabulary table's two tensors replaced
 * by their two row ranges each: `part0` rows [0, at), `part1` rows
 * [at, rows), at the same shard and dataPath, each half's byte range cut
 * from the original record's. A row's bytes on disk are the record's
 * `nbytes` over its rows — not the shape times the type's width: a
 * "f32-to-bf16" record of float32 values stores two bytes per value.
 * Everything else is kept as it is, so the paths stay relative to the
 * manifest's own URL. Throws a SplitManifestError saying why when the
 * manifest is not the one the library was built from.
 */
export function splitManifest(manifest: TensorManifest, split: EmbeddingSplit): TensorManifest {
	if (!manifest || !Array.isArray(manifest.records)) {
		throw new SplitManifestError("the tensor manifest has no records");
	}

	if (!(split.at > 0 && split.at < split.rows)) {
		throw new SplitManifestError(`cannot split ${split.rows} rows at ${split.at}`);
	}

	const seen = new Map<string, number>();

	const shards = manifest.records.map((shard): TensorShard => {
		const records: TensorRecord[] = [];

		for (const record of shard.records ?? []) {
			const leaf = LEAVES.find((name) => record.name === EMBED_PREFIX + name);

			if (record.name.startsWith(`${EMBED_PREFIX}part`)) {
				throw new SplitManifestError(`the manifest is already split (${record.name})`);
			}

			if (!leaf) {
				records.push(record);
				continue;
			}

			seen.set(leaf, (seen.get(leaf) ?? 0) + 1);

			const want = expected(split, leaf);
			const [rows, cols] = record.shape ?? [];

			if (record.shape?.length !== 2 || rows !== split.rows || cols !== want.cols) {
				throw new SplitManifestError(
					`${record.name} is [${(record.shape ?? []).join(", ")}], the library expects [${
						split.rows
					}, ${want.cols}]`
				);
			}

			if (record.dtype !== want.dtype) {
				throw new SplitManifestError(
					`${record.name} is ${record.dtype}, the library expects ${want.dtype}`
				);
			}

			if (!(record.nbytes > 0) || record.nbytes % rows !== 0) {
				throw new SplitManifestError(
					`${record.name}: ${record.nbytes} bytes are not whole rows of ${rows}`
				);
			}

			const rowBytes = record.nbytes / rows;
			const ranges: [number, number][] = [
				[0, split.at],
				[split.at, rows],
			];

			ranges.forEach(([lo, hi], part) => {
				records.push({
					...record,
					name: `${EMBED_PREFIX}part${part}.${leaf}`,
					shape: [hi - lo, cols],
					nbytes: (hi - lo) * rowBytes,
					byteOffset: record.byteOffset + lo * rowBytes,
				});
			});
		}

		return {...shard, records};
	});

	for (const leaf of LEAVES) {
		const count = seen.get(leaf) ?? 0;

		if (count !== 1) {
			throw new SplitManifestError(
				count === 0
					? `the manifest has no ${EMBED_PREFIX}${leaf}`
					: `the manifest lists ${EMBED_PREFIX}${leaf} ${count} times`
			);
		}
	}

	return {
		...manifest,
		metadata: {...(manifest.metadata ?? {}), [SPLIT_MARK]: splitMark(split)},
		records: shards,
	};
}

/** Whether `manifest` is our rewrite for `split` (its mark and both halves of both tensors). */
export function isSplitManifest(manifest: unknown, split: EmbeddingSplit): boolean {
	const candidate = manifest as TensorManifest | null;

	if (!candidate || !Array.isArray(candidate.records)) {
		return false;
	}

	if (candidate.metadata?.[SPLIT_MARK] !== splitMark(split)) {
		return false;
	}

	const names = new Map<string, number[]>();

	for (const shard of candidate.records) {
		for (const record of shard.records ?? []) {
			names.set(record.name, record.shape);
		}
	}

	return LEAVES.every((leaf) => {
		const cols = expected(split, leaf).cols;
		const part0 = names.get(`${EMBED_PREFIX}part0.${leaf}`);
		const part1 = names.get(`${EMBED_PREFIX}part1.${leaf}`);

		return (
			!names.has(EMBED_PREFIX + leaf) &&
			part0?.[0] === split.at &&
			part0?.[1] === cols &&
			part1?.[0] === split.rows - split.at &&
			part1?.[1] === cols
		);
	});
}

/** The largest single tensor the manifest names, in bytes: one GPU binding each. */
export function largestRecordBytes(manifest: TensorManifest): number {
	let largest = 0;

	for (const shard of manifest.records) {
		for (const record of shard.records ?? []) {
			largest = Math.max(largest, record.nbytes);
		}
	}

	return largest;
}

/**
 * The URL WebLLM fetches a model's tensor manifest from, the way it builds
 * it (@mlc-ai/web-llm 0.2.85 `cleanModelUrl`, then `new URL("tensor-cache.json",
 * …)`): a trailing slash added, and `resolve/main/` when the URL names no
 * revision. The seeded manifest must sit under exactly this key.
 */
export function manifestUrl(modelUrl: string): string {
	let url = modelUrl.endsWith("/") ? modelUrl : `${modelUrl}/`;

	if (!/.+\/resolve\/.+\//.test(url)) {
		url += "resolve/main/";
	}

	return new URL("tensor-cache.json", new URL(url).href).href;
}

/** The Cache Storage scope WebLLM keeps a model's manifest, tokenizer and shards in. */
export const WEBLLM_MODEL_CACHE = "webllm/model";

/** The slice of the Cache API the seeding needs. */
export interface CacheLike {
	match(request: string): Promise<{json(): Promise<unknown>} | undefined>;
	put(request: string, response: Response): Promise<void>;
	delete(request: string): Promise<boolean>;
}

export interface SeedDeps {
	fetch(url: string): Promise<{ok: boolean; status: number; json(): Promise<unknown>}>;
	openCache(name: string): Promise<CacheLike>;
	/** Builds what is stored; the real Response, a stand-in under mocha. */
	response(body: string): Response;
}

/** Where the split build's manifest comes from and goes to. */
export interface SplitSource {
	/** The published model directory the split was cut from, revision pinned. */
	model: string;
	split: EmbeddingSplit;
}

/**
 * Put the rewritten manifest where WebLLM will look for it, unless what is
 * there already is our rewrite for this split: `"kept"` then, `"seeded"`
 * when it was written. Anything else under that key — nothing, the
 * unsplit manifest WebLLM's own delete fetched into it, a seed of another
 * version — is replaced. The original is fetched from the same pinned URL
 * with a plain `fetch`, never through WebLLM's cache, so the stock manifest
 * never lands under the key. A manifest that is not the model the library
 * was built from rejects with a SplitManifestError, and nothing is stored.
 */
export async function seedSplitManifest(
	source: SplitSource,
	deps: SeedDeps
): Promise<"seeded" | "kept"> {
	const url = manifestUrl(source.model);
	const cache = await deps.openCache(WEBLLM_MODEL_CACHE);
	const present = await cache.match(url);

	if (present) {
		let body: unknown = null;

		try {
			body = await present.json();
		} catch {
			// Not JSON: not ours either, and replaced below.
		}

		if (isSplitManifest(body, source.split)) {
			return "kept";
		}
	}

	const response = await deps.fetch(url);

	if (!response.ok) {
		throw new Error(`the tensor manifest could not be fetched (HTTP ${response.status})`);
	}

	const rewritten = splitManifest((await response.json()) as TensorManifest, source.split);

	await cache.put(url, deps.response(JSON.stringify(rewritten)));

	return "seeded";
}

/** Remove the seeded manifest (WebLLM's own delete leaves every manifest in place). */
export async function dropSplitManifest(
	source: Pick<SplitSource, "model">,
	deps: Pick<SeedDeps, "openCache">
): Promise<void> {
	const cache = await deps.openCache(WEBLLM_MODEL_CACHE);

	await cache.delete(manifestUrl(source.model));
}

/** Whether a manifest sits under the model's key at all (a download started, or a seed). */
export async function hasManifest(
	model: string,
	deps: Pick<SeedDeps, "openCache">
): Promise<boolean> {
	const cache = await deps.openCache(WEBLLM_MODEL_CACHE);

	return (await cache.match(manifestUrl(model))) !== undefined;
}
