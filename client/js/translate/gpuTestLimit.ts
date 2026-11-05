// The test switch for small GPUs (docs/resources/translation.md § Phones and
// small GPUs): `localStorage["thelounge.state.gpuTestLimitMiB"]`, a number of
// MiB, makes this browser behave as if its GPU could bind no more than that
// in one storage buffer — the device probe reports min(real, cap)
// (capability.ts) and the worker holds WebLLM's device request to it
// (engines/gpuLimits.ts) — so the small-buffer build a phone runs can be
// tried on a desktop GPU first. A `thelounge.state.*` key: never carried by
// the settings backup. Read once per page, with the probe; a reload applies
// a change. Vue-free; tests pass their own storage.

export const GPU_TEST_LIMIT_KEY = "thelounge.state.gpuTestLimitMiB";

/**
 * WebGPU's default storage binding: a device is never given less, so a cap
 * below it would report a limit the device does not enforce. A smaller
 * value is read as this.
 */
export const GPU_TEST_LIMIT_FLOOR_MIB = 128;

const MiB = 1024 * 1024;

/** The cap in bytes, or null when the value is absent or not a positive number of MiB. */
export function parseGpuTestLimit(raw: string | null | undefined): number | null {
	if (typeof raw !== "string" || raw.trim() === "") {
		return null;
	}

	const mib = Number(raw.trim());

	if (!Number.isFinite(mib) || mib <= 0) {
		return null;
	}

	return Math.max(GPU_TEST_LIMIT_FLOOR_MIB, Math.floor(mib)) * MiB;
}

/** The switch as stored, or null; a storage that throws (a private window) is no switch. */
export function readGpuTestLimit(storage?: Pick<Storage, "getItem"> | null): number | null {
	try {
		const store = storage === undefined ? globalThis.localStorage : storage;

		return parseGpuTestLimit(store?.getItem(GPU_TEST_LIMIT_KEY));
	} catch {
		return null;
	}
}
