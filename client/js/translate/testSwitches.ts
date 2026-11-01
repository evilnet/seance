// The GPU test switches as URL parameters, for a phone where nobody can
// type into the console: `?gpuPrefillChunk=N` (gpuPrefillChunk.ts) and
// `?gpuTestLimitMiB=N` (gpuTestLimit.ts) store N under their
// `thelounge.state.*` keys, `0` or an empty value removes the key, and a
// value that is neither changes nothing. boot.ts applies them first thing,
// before translation probes the device, and puts the address it returns in
// the address bar -- every other parameter and the hash kept -- so the
// switch is not applied again on a reload and the link handling never sees
// it. Vue-free; tests pass their own storage.

import {GPU_PREFILL_CHUNK_KEY, parseGpuPrefillChunk} from "./gpuPrefillChunk";
import {GPU_TEST_LIMIT_KEY, parseGpuTestLimit} from "./gpuTestLimit";

interface UrlSwitch {
	param: string;
	key: string;
	/** A value worth storing (the stored text is the value trimmed). */
	valid(value: string): boolean;
}

const SWITCHES: readonly UrlSwitch[] = [
	{
		param: "gpuPrefillChunk",
		key: GPU_PREFILL_CHUNK_KEY,
		valid: (value) => typeof parseGpuPrefillChunk(value) === "number",
	},
	{
		param: "gpuTestLimitMiB",
		key: GPU_TEST_LIMIT_KEY,
		valid: (value) => parseGpuTestLimit(value) !== null,
	},
];

/**
 * Applies the switches `href` carries to `storage` and returns `href`
 * without them, or null when it carries neither. A storage that throws (a
 * private window) stores nothing; the parameters still go.
 */
export function takeTestSwitches(
	href: string,
	storage: Pick<Storage, "setItem" | "removeItem"> | null
): string | null {
	const url = new URL(href);
	let found = false;

	for (const {param, key, valid} of SWITCHES) {
		if (!url.searchParams.has(param)) {
			continue;
		}

		found = true;

		const value = (url.searchParams.get(param) ?? "").trim();

		url.searchParams.delete(param);

		try {
			if (value === "" || value === "0") {
				storage?.removeItem(key);
			} else if (valid(value)) {
				storage?.setItem(key, value);
			}
		} catch {
			// No storage here: the switch cannot be kept.
		}
	}

	if (!found) {
		return null;
	}

	return url.href;
}
