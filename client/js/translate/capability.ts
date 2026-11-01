// The device probe (spec § capability.ts): what the router may pick from.
// `gpu` needs a WebGPU adapter with 16-bit float shaders, WebLLM's shader
// limits (`WEBLLM_MIN_*`) and a storage
// binding as large as the smallest GPU model's largest tensor
// (models.ts `LLM_MIN_BUFFER_BYTES`; which models fit is `llmFits`); `cpu` needs
// WebAssembly SIMD for ONNX Runtime; `none` hides the feature. The reasons
// are what Settings shows in place of a missing model row. `browserEnv()`
// is the only place that reads `navigator`; tests pass their own env.

import {LLM_MIN_BUFFER_BYTES} from "./models";
import {readGpuTestLimit} from "./gpuTestLimit";

export type Tier = "gpu" | "cpu" | "none";

/**
 * Why the GPU tier (or translation itself) is out of reach, as a code:
 * this module is Vue-free and never imports the i18n runtime, so Settings
 * renders each code through its own `translate.capability.reason.*` key.
 */
export type CapabilityReason =
	| "NO_WEBGPU"
	| "INSECURE_ORIGIN"
	| "NO_ADAPTER"
	| "NO_F16"
	/** Below WebLLM's own shader floors (`WEBLLM_MIN_*`): it refuses the adapter outright. */
	| "GPU_LIMITS"
	| "SMALL_BUFFER"
	| "NO_WASM_SIMD"
	/**
	 * No WebAssembly Memory64: the language model's CPU library (wllama's
	 * standard build, engines/cpuLlm.real.ts) is a Memory64 module and
	 * cannot instantiate (desktop Safari). The seq2seq models do not need it.
	 */
	| "NO_MEMORY64"
	/** The probe itself threw: nothing could be measured (service.ts). */
	| "PROBE_FAILED";

export interface Capability {
	tier: Tier;
	reasons: CapabilityReason[];
	f16: boolean;
	maxBufferBytes: number;
	deviceMemoryGiB: number | null;
	storageQuotaBytes: number | null;
	/**
	 * A phone or tablet (`isMobile`): the page's memory is a phone's, so the
	 * GPU model loads with a smaller context window, the large GPU model
	 * cannot run (models.ts `modelBlock`) and one engine is in memory at a
	 * time (service.ts).
	 */
	mobile: boolean;
	/**
	 * An iPhone or iPad (`isAppleMobile`; absent = false): WebKit ends a page
	 * past ~1.8 GB, which the language model's CPU copy cannot stay under
	 * (models.ts `APPLE_PAGE_BUDGET_BYTES`).
	 */
	appleMobile?: boolean;
	/**
	 * The test switch's cap (gpuTestLimit.ts), when set: `maxBufferBytes` is
	 * already held to it, and the worker holds WebLLM's device to it too.
	 */
	bufferCapBytes?: number | null;
}

export interface AdapterLike {
	features: {has(name: string): boolean};
	limits: {
		maxBufferSize: number;
		maxStorageBufferBindingSize: number;
		/** Absent (an adapter that does not say) passes; see `WEBLLM_MIN_*`. */
		maxStorageBuffersPerShaderStage?: number;
		maxComputeWorkgroupStorageSize?: number;
	};
}

export interface ProbeEnv {
	gpu: {requestAdapter(): Promise<AdapterLike | null>} | null;
	deviceMemory: number | null;
	storage: {estimate(): Promise<{quota?: number}>} | null;
	wasmSimd: boolean;
	/** WebAssembly Memory64 (`hasMemory64`): what the CPU language model's library needs. */
	memory64: boolean;
	/**
	 * Whether the page is a secure context (`window.isSecureContext`), when
	 * that is known. A plain-HTTP origin away from localhost is the usual
	 * reason `navigator.gpu` is missing entirely, and the one a reader can
	 * do something about — the probe names it instead of a bare "no
	 * WebGPU". Undefined where the question makes no sense (tests).
	 */
	secureContext?: boolean;
	/** A phone or tablet (`browserEnv`); absent means a computer. */
	mobile?: boolean;
	/** An iPhone or iPad (`browserEnv`); absent means neither. */
	appleMobile?: boolean;
	/** The test switch (gpuTestLimit.ts): bind no more than this; absent or null, no cap. */
	bufferCapBytes?: number | null;
}

// A model binds each weight tensor whole, so the floor is the smallest GPU
// model's largest tensor, not WebLLM's 1 GiB: the worker asks WebLLM's
// device for whatever the adapter offers (engines/gpuLimits.ts). The 1.7B's
// small-buffer build needs 74 MiB (models.ts), under WebGPU's 128 MiB
// default, so every adapter with shader-f16 and WebLLM's floors is on it.
export const GPU_MIN_BUFFER_BYTES = LLM_MIN_BUFFER_BYTES;

// WebLLM's own floors (`detectGPUDevice`, @mlc-ai/web-llm 0.2.85): an
// adapter below either is refused before a device is even asked for, so a
// GPU model could never load there, whatever its buffers. WebGPU's defaults
// are 8 and 16 KiB; desktop adapters report at least these.
export const WEBLLM_MIN_STORAGE_BUFFERS = 10;
export const WEBLLM_MIN_WORKGROUP_STORAGE = 32768;

/** A minimal module using a v128 op; validating it proves SIMD support. */
export const WASM_SIMD_PROBE = new Uint8Array([
	0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253,
	15, 253, 98, 11,
]);

export async function probe(env: ProbeEnv): Promise<Capability> {
	const reasons: CapabilityReason[] = [];
	let f16 = false;
	let maxBufferBytes = 0;
	let gpuOk = false;

	if (!env.gpu) {
		reasons.push(env.secureContext === false ? "INSECURE_ORIGIN" : "NO_WEBGPU");
	} else {
		let adapter: AdapterLike | null = null;

		try {
			adapter = await env.gpu.requestAdapter();
		} catch {
			adapter = null;
		}

		if (!adapter) {
			reasons.push("NO_ADAPTER");
		} else {
			f16 = adapter.features.has("shader-f16");
			maxBufferBytes = Math.min(
				adapter.limits.maxBufferSize,
				adapter.limits.maxStorageBufferBindingSize,
				env.bufferCapBytes ?? Infinity
			);

			if (!f16) {
				reasons.push("NO_F16");
			} else if (!meetsWebLlmFloors(adapter.limits)) {
				reasons.push("GPU_LIMITS");
			} else if (maxBufferBytes < GPU_MIN_BUFFER_BYTES) {
				reasons.push("SMALL_BUFFER");
			} else {
				gpuOk = true;
			}
		}
	}

	if (!env.wasmSimd) {
		reasons.push("NO_WASM_SIMD");
	}

	if (!env.memory64) {
		reasons.push("NO_MEMORY64");
	}

	let storageQuotaBytes: number | null = null;

	if (env.storage) {
		try {
			storageQuotaBytes = (await env.storage.estimate()).quota ?? null;
		} catch {
			storageQuotaBytes = null;
		}
	}

	const tier: Tier = gpuOk ? "gpu" : env.wasmSimd ? "cpu" : "none";

	return {
		tier,
		reasons,
		f16,
		maxBufferBytes,
		deviceMemoryGiB: env.deviceMemory,
		storageQuotaBytes,
		mobile: env.mobile === true,
		appleMobile: env.appleMobile === true,
		bufferCapBytes: env.bufferCapBytes ?? null,
	};
}

/** A limit the adapter does not report is taken as met: only a number below the floor fails. */
function meetsWebLlmFloors(limits: AdapterLike["limits"]): boolean {
	const below = (value: number | undefined, floor: number) =>
		typeof value === "number" && value < floor;

	return !(
		below(limits.maxStorageBuffersPerShaderStage, WEBLLM_MIN_STORAGE_BUFFERS) ||
		below(limits.maxComputeWorkgroupStorageSize, WEBLLM_MIN_WORKGROUP_STORAGE)
	);
}

export function browserEnv(): ProbeEnv {
	const nav = navigator as Navigator & {
		gpu?: {requestAdapter(): Promise<AdapterLike | null>};
		deviceMemory?: number;
		userAgentData?: {mobile?: boolean};
	};
	let wasmSimd = false;

	try {
		wasmSimd = WebAssembly.validate(WASM_SIMD_PROBE);
	} catch {
		wasmSimd = false;
	}

	return {
		gpu: nav.gpu ?? null,
		deviceMemory: typeof nav.deviceMemory === "number" ? nav.deviceMemory : null,
		storage: nav.storage && typeof nav.storage.estimate === "function" ? nav.storage : null,
		wasmSimd,
		memory64: hasMemory64(),
		secureContext: typeof window !== "undefined" ? window.isSecureContext : undefined,
		mobile: isMobile(nav),
		appleMobile: isAppleMobile(nav),
		bufferCapBytes: readGpuTestLimit(),
	};
}

/**
 * Whether a 64-bit WebAssembly memory can be made: an engine without
 * Memory64 throws on the `address` descriptor's BigInt `initial` (it reads
 * the field as a number), one with it returns a memory of one page.
 * `WebAssembly` missing, or a constructor that throws, is no.
 */
export function hasMemory64(
	wasm: {Memory?: unknown} | undefined = typeof WebAssembly !== "undefined"
		? WebAssembly
		: undefined
): boolean {
	const Memory = wasm?.Memory as (new (descriptor: unknown) => unknown) | undefined;

	if (typeof Memory !== "function") {
		return false;
	}

	try {
		return !!new Memory({address: "i64", initial: BigInt(1)});
	} catch {
		return false;
	}
}

/** The slice of `navigator` `isMobile` reads. */
export interface MobileNavigator {
	userAgent?: string;
	maxTouchPoints?: number;
	userAgentData?: {mobile?: boolean};
}

/**
 * A phone or tablet: Chromium says so outright (`userAgentData.mobile`); the
 * others by their user agent — iPhone, iPad, Android (a tablet's Chrome
 * says `mobile: false` and has no "Mobile" in its agent, but still
 * "Android"), and an iPad that asks for desktop sites (the default since
 * iPadOS 13), which reads as a Mac with a touch screen: no Mac has one, so
 * `maxTouchPoints > 1` there is an iPad. A device that runs out of page
 * memory long before a computer does (models.ts `modelBlock`, the context
 * window, one engine at a time in service.ts).
 */
export function isMobile(nav: MobileNavigator): boolean {
	if (typeof nav.userAgentData?.mobile === "boolean" && nav.userAgentData.mobile) {
		return true;
	}

	const ua = nav.userAgent ?? "";

	return (
		/Android|iPhone|iPad|iPod|Mobi/i.test(ua) ||
		(/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1)
	);
}

/** An iPhone or iPod, or an iPad (one that asks for desktop sites reads as a Mac with a touch screen). */
export function isAppleMobile(nav: MobileNavigator): boolean {
	const ua = nav.userAgent ?? "";

	return /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1);
}

let cached: Promise<Capability> | null = null;

/** The probe runs once per page; the result is kept in memory only. */
export function probeOnce(env?: ProbeEnv): Promise<Capability> {
	if (!cached) {
		cached = probe(env ?? browserEnv());
	}

	return cached;
}

/** Tests only. */
export function resetProbe(): void {
	cached = null;
}
