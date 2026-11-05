// The test switch for the GPU model's prefill chunk (docs/resources/
// translation.md § Phones and small GPUs): `localStorage[
// "thelounge.state.gpuPrefillChunk"]`, a number of tokens, is how many
// tokens of a prompt WebLLM sends to the GPU at a time (models.ts
// `prefillChunkFor`), on a phone and on a computer alike; `0` is the model
// library's own chunk. A `thelounge.state.*` key: never carried by the
// settings backup. Read once per page, with the device probe; a reload
// applies a change. Vue-free; tests pass their own storage.

export const GPU_PREFILL_CHUNK_KEY = "thelounge.state.gpuPrefillChunk";

/**
 * The switch's tokens; null for `0` (the library's own chunk); undefined
 * when the value is absent or not a whole number of tokens (no switch).
 */
export function parseGpuPrefillChunk(raw: string | null | undefined): number | null | undefined {
	if (typeof raw !== "string" || !/^\s*\d+\s*$/.test(raw)) {
		return undefined;
	}

	const tokens = Number(raw.trim());

	return tokens === 0 ? null : tokens;
}

/** The switch as stored (`parseGpuPrefillChunk`); a storage that throws (a private window) is no switch. */
export function readGpuPrefillChunk(
	storage?: Pick<Storage, "getItem"> | null
): number | null | undefined {
	try {
		const store = storage === undefined ? globalThis.localStorage : storage;

		return parseGpuPrefillChunk(store?.getItem(GPU_PREFILL_CHUNK_KEY));
	} catch {
		return undefined;
	}
}
