// The model catalog (spec § router.ts, § Settings): which models exist, from
// the shipped defaults plus the deploy's `config.json` `translation` block,
// and the cache API the worker answers "is it downloaded" / "delete it"
// with. A router candidate names a catalog entry, never a URL.

import {Device, DeviceChoice, DeviceCopy, EngineName, ModelRef, SmallBufferBuild} from "./engine";
import type {Capability, CapabilityReason, Tier} from "./capability";

/** What the route table lists: the LLM, NLLB, or an OPUS-MT pair. */
export type Candidate = "llm" | "nllb" | `opus:${string}`;

/** The shape `BrandingTranslation` (branding.ts) is assignable to. */
export interface CatalogOptions {
	modelBase?: string;
	llm?: {model?: string; lib?: string};
	cpu?: {nllb?: string; opus?: Record<string, string>};
	/**
	 * Give OPUS-MT and NLLB-200 their GPU copies. Off in the shipped app,
	 * and never read from a deploy's `config.json`: this build has no WebGPU
	 * backend for them (webpack.config.ts aliases `onnxruntime-web/webgpu`
	 * to the wasm bundle, which registers only the CPU), so a GPU copy would
	 * download its weights and then fail to start (translation-devices.md
	 * § Not in this build). Tests turn it on to keep the GPU logic covered.
	 */
	seq2seqGpu?: boolean;
}

export interface ModelCatalog {
	/** The selected GPU model: what a route's `llm` candidate runs. */
	llm: ModelRef;
	/**
	 * Every GPU model the user can choose: the shipped ones, then the
	 * deploy's own model when it is neither. Settings lists them all, so
	 * either can be downloaded or deleted whichever is selected.
	 */
	llmChoices: ModelRef[];
	/**
	 * The catalog's own fallback GPU model: the deploy's model, else the
	 * shipped 1.7B. What an unresolvable selection lands on when the device
	 * has not been probed (`llmChoice`).
	 */
	llmDefault: string;
	/**
	 * The deploy's `translation.llm.model`, when it named one. A deploy's
	 * model is a decision, so it outranks the device pick for a user who
	 * never chose (`llmChoice`); the shipped default is not.
	 */
	llmDeploy?: string;
	/**
	 * The deploy's `translation.llm.lib`, as given. The engines read it off
	 * the model's own ref (`ModelRef.lib`), which only the deploy's model
	 * (or the default it mirrors) carries.
	 */
	llmLib?: string;
	nllb: ModelRef;
	/** Keyed "from-to". */
	opus: Record<string, ModelRef>;
	/** Mirror base URL without a trailing slash; undefined = Hugging Face. */
	modelBase?: string;
}

export const QWEN3_1_7B_ID = "Qwen3-1.7B-q4f16_1-MLC";
export const QWEN3_4B_ID = "Qwen3-4B-q4f16_1-MLC";
export const DEFAULT_LLM_ID = QWEN3_1_7B_ID;
export const DEFAULT_NLLB_ID = "Xenova/nllb-200-distilled-600M";
export const DEFAULT_OPUS_PAIRS: Record<string, string> = {
	"de-en": "Xenova/opus-mt-de-en",
	"en-de": "Xenova/opus-mt-en-de",
	"fr-en": "Xenova/opus-mt-fr-en",
	"en-fr": "Xenova/opus-mt-en-fr",
	"es-en": "Xenova/opus-mt-es-en",
	"en-es": "Xenova/opus-mt-en-es",
	"it-en": "Xenova/opus-mt-it-en",
	"en-it": "Xenova/opus-mt-en-it",
	"nl-en": "Xenova/opus-mt-nl-en",
	"en-nl": "Xenova/opus-mt-en-nl",
	"ru-en": "Xenova/opus-mt-ru-en",
	"en-ru": "Xenova/opus-mt-en-ru",
};

// The downloads as Hugging Face lists them (2026-10-27): the MLC repo's
// files for the 1.7B; NLLB's and an OPUS pair's q8 encoder, merged decoder
// and tokenizer (a pair varies by a few MB).
const LLM_SIZE_BYTES = 984_000_000;
const NLLB_SIZE_BYTES = 912_000_000;
const OPUS_SIZE_BYTES = 113_000_000;
// The GPU copies (spec translation-devices.md): NLLB's q4f16 encoder and
// merged decoder; an OPUS pair's fp16 pair of files.
const NLLB_GPU_SIZE_BYTES = 1_260_000_000; // 584 + 612 MiB and the tokenizer
const OPUS_GPU_SIZE_BYTES = 210_000_000;
const NLLB_GPU_LARGEST_BYTES = 524_709_888;

/**
 * An OPUS-MT pair's largest GPU binding: its shared embedding in fp16 (en-de
 * measured, 59,495,424 bytes). Every pair takes this constant; the real
 * figure varies a little with the pair's vocabulary, so it is approximate.
 */
export const OPUS_GPU_LARGEST_BYTES = 59_495_424;

/**
 * The 1.7B's CPU copy: the Q4_K_M GGUF wllama runs (the spike,
 * tools/translate-eval/results/2026-10-29-cpu-llm.md).
 */
export const CPU_LLM_COPY: DeviceCopy = {
	sizeBytes: 1_107_409_472,
	source: "unsloth/Qwen3-1.7B-GGUF",
	file: "Qwen3-1.7B-Q4_K_M.gguf",
};

/**
 * The commit of `CPU_LLM_COPY.source` its file is fetched at (the repo's
 * head on 2026-10-29, `x-repo-commit` of the file, 1,107,409,472 bytes).
 * Pinned, as `QWEN3_1_7B_PINNED_MODEL` is: the file's cache key is its URL
 * (engines/cpuLlm.ts `cpuLlmUrl`), so a moving `main` would never change
 * what is cached under it.
 */
export const CPU_LLM_REVISION = "d7f544eead698dbd1f15126ef60b45a1e1933222";

/**
 * The context window the language model loads with on the CPU, in tokens
 * (tools/translate-eval/results/2026-10-29-cpu-llm.md § The 15 s rule): it
 * holds the 700-token context budget, the prompt and a 160-token answer.
 * The prompt costs what it costs on the CPU whatever the window — the
 * system prompt alone is past the spec's 15 s on the sandbox's core — so a
 * smaller window would only cut context, not time.
 */
export const CPU_CONTEXT_WINDOW = 1024;

function opusRef(pairKey: string, id: string, gpu: boolean): ModelRef {
	const [from, to] = pairKey.split("-");

	return {
		engine: "seq2seq",
		family: "opus",
		id,
		label: {kind: "opus", from, to},
		copies: {
			cpu: {sizeBytes: OPUS_SIZE_BYTES, source: id, dtype: "q8"},
			...(gpu && {
				gpu: {
					sizeBytes: OPUS_GPU_SIZE_BYTES,
					source: id,
					dtype: "fp16",
					largestBufferBytes: OPUS_GPU_LARGEST_BYTES,
				},
			}),
		},
		pair: [from, to],
	};
}

/** The small-buffer build of the 1.7B: its own WebLLM id (engine.ts `SmallBufferBuild`). */
export const QWEN3_1_7B_SPLIT_ID = "Qwen3-1.7B-q4f16_1-MLC-split";

/**
 * The 1.7B's published directory at the commit its split was cut from (the
 * manifest there is byte-identical to `main` on 2026-10-28). Pinned, so the
 * byte ranges the rewrite names can never move, and so the build's cache
 * keys are never the model's own `resolve/main/` ones.
 */
export const QWEN3_1_7B_PINNED_MODEL =
	"https://huggingface.co/mlc-ai/Qwen3-1.7B-q4f16_1-MLC/resolve/80b3abcec6c3b3f5355dc0cc99cc4fb578f192bc/";

/**
 * The split library the app ships (client/models/, copied to public/models/
 * by webpack; built by tools/translate-split/). The file name carries the
 * first eight hex digits of its SHA-256: WebLLM caches a library by URL, so
 * a rebuilt library must have a new one. Relative to the app's root, which
 * the worker resolves against its own location (a deploy may live under a
 * subpath).
 */
export const QWEN3_1_7B_SPLIT_LIB = "models/qwen3-1.7b-q4f16_1-split-c4939e7d.wasm";

/** Qwen3's vocabulary, and the row its table is split at: two halves of 75968 rows. */
const QWEN3_VOCAB_ROWS = 151_936;
const QWEN3_SPLIT_ROW = 75_968;

/**
 * The GPU models Settings offers, both WebLLM prebuilt ids. `sizeBytes` is
 * the download; `vramBytes` is the graphics memory the model needs at
 * runtime (WebLLM's `vram_required_MB`, about 2.0 GB for 1.7B and 3.4 GB
 * for 4B); `largestBufferBytes` is the model's largest weight tensor, its
 * vocabulary embedding (`model.embed_tokens.q_weight`, 151936 rows of u32:
 * 256 per row for 1.7B, 320 for 4B, from each model's
 * tensor-cache.json: 155,582,464 and 194,478,080 bytes) — the single
 * binding the device must allow. The KV cache's pages and the work buffers
 * are smaller by estimate, not by measurement.
 *
 * The 1.7B also has a small-buffer build (`smallBuffer`): the table split
 * in two halves of 75968 rows, whose larger tensor is 75968 × 1024 bytes,
 * so it loads where a storage binding stops at WebGPU's 128 MiB floor. The
 * same weights, so the same download and the same graphics memory. The 4B
 * has none: its library was never built (its table is 186 MiB, two halves
 * of 93 MiB would fit too, but nothing has measured it on a phone).
 */
export const LLM_CHOICES: readonly ModelRef[] = [
	{
		engine: "llm",
		family: "llm",
		id: QWEN3_1_7B_ID,
		label: {kind: "llm", name: "Qwen3 1.7B"},
		copies: {
			gpu: {
				sizeBytes: LLM_SIZE_BYTES,
				source: QWEN3_1_7B_ID,
				largestBufferBytes: 155_582_464,
			},
			cpu: CPU_LLM_COPY,
		},
		vramBytes: 2_000_000_000,
		smallBuffer: {
			id: QWEN3_1_7B_SPLIT_ID,
			model: QWEN3_1_7B_PINNED_MODEL,
			lib: QWEN3_1_7B_SPLIT_LIB,
			split: {
				rows: QWEN3_VOCAB_ROWS,
				at: QWEN3_SPLIT_ROW,
				weight: {cols: 256, dtype: "uint32"},
				scale: {cols: 64, dtype: "float16"},
			},
			largestBufferBytes: 77_791_232,
		},
	},
	{
		engine: "llm",
		family: "llm",
		id: QWEN3_4B_ID,
		label: {kind: "llm", name: "Qwen3 4B"},
		copies: {
			gpu: {
				sizeBytes: 2_280_000_000,
				source: QWEN3_4B_ID,
				largestBufferBytes: 194_478_080,
			},
		},
		vramBytes: 3_400_000_000,
	},
];

/**
 * What the worker is told about the device (protocol.ts `configure`): the
 * probe's largest storage binding, which decides the build
 * (`smallBufferBuildFor`), and the test cap (translate/gpuTestLimit.ts),
 * which WebLLM's device request is held to (engines/gpuLimits.ts). Null
 * where nothing is known: the model's own build loads, uncapped.
 */
export interface GpuBudget {
	maxBufferBytes: number | null;
	capBytes: number | null;
	/**
	 * A phone or tablet (capability.ts `Capability.mobile`): the GPU model
	 * loads with `MOBILE_CONTEXT_WINDOW` (`contextWindowFor`). Absent on a
	 * computer, so the message a computer's worker is told is unchanged.
	 */
	mobile?: boolean;
}

/**
 * The context window a GPU model loads with on a phone or tablet, in tokens.
 * WebLLM sizes the KV cache for the whole window at load and WebKit counts
 * GPU memory against the page's own process (about 2.1 GB on an iPhone,
 * past which the page is killed), so the window is memory: measured on a
 * SwiftShader bench (the f32 build; the shipped f16 KV is half), the 1.7B
 * at load was 1,278 MiB at 1024, 1,502 at 2048 and 1,950 at 4096 — about
 * 1,050 / 1,160 / 1,390 MiB in f16. 2048 holds the worst single request
 * the reader builds (10 full-length context lines with their translations,
 * a 250-byte topic, 20 names, 20 terms, a full line and its 394-token reply:
 * at most 1,952 tokens, docs/resources/translation.md § Phones and small
 * GPUs); anything larger is trimmed to fit (budget.ts). 1024 saves another
 * ~110 MiB and cannot hold a full line with its context; the library's
 * prefill chunk is 1k.
 */
export const MOBILE_CONTEXT_WINDOW = 2048;

/**
 * The window a model loads with when nothing says otherwise: the Qwen3
 * records' own (`overrides.context_window_size` in WebLLM's prebuilt list).
 */
export const DEFAULT_CONTEXT_WINDOW = 4096;

/**
 * The context window to ask WebLLM for on this device: `MOBILE_CONTEXT_WINDOW`
 * on a phone or tablet, null elsewhere — the model's own record decides
 * (4096 for both Qwen3 models), and the reload is the one it always was.
 */
export function contextWindowFor(gpu: GpuBudget | null | undefined): number | null {
	return gpu?.mobile ? MOBILE_CONTEXT_WINDOW : null;
}

/**
 * The most graphics memory a GPU model may need and still run on a phone or
 * tablet. WebKit attributes GPU memory to the page's process and kills it
 * past about 2.1 GB, and the page itself, the weights' load buffers and the
 * other engine all live there too. The 1.7B (WebLLM's 2.0 GB figure is its
 * 4096-token window in f32; about 1.2 GiB at `MOBILE_CONTEXT_WINDOW` in f16)
 * is under it; the 4B, whose weights alone are 2.2 GB, never is.
 */
export const MOBILE_LLM_MAX_VRAM_BYTES = 2_500_000_000;

/** A GPU model too large for a phone's page (`MOBILE_LLM_MAX_VRAM_BYTES`); unknown sizes pass. */
export function tooLargeForPhone(ref: ModelRef): boolean {
	return ref.engine === "llm" && (ref.vramBytes ?? 0) > MOBILE_LLM_MAX_VRAM_BYTES;
}

/**
 * Which build of `ref` loads on a device whose largest storage binding is
 * `maxBufferBytes`: null for the model itself — it fits, it has no
 * small-buffer build, or the limit is unknown — and its small-buffer build
 * when only that fits. The one rule the engine's load, the worker's cache
 * answers (Downloaded / Delete) and Settings read, so a phone's Download
 * downloads the build it will run and a desktop's the model itself. A
 * device that can bind neither gets the model itself, which then fails as
 * `modelBlock` already said it would.
 */
export function smallBufferBuildFor(
	ref: ModelRef,
	maxBufferBytes: number | null | undefined
): SmallBufferBuild | null {
	const build = ref.engine === "llm" ? ref.smallBuffer : undefined;

	if (!build || typeof maxBufferBytes !== "number" || !(maxBufferBytes > 0)) {
		return null;
	}

	if ((ref.copies.gpu?.largestBufferBytes ?? 0) <= maxBufferBytes) {
		return null;
	}

	return build.largestBufferBytes <= maxBufferBytes ? build : null;
}

/** The WebLLM id that loads for `ref` on this device: its own, or its small-buffer build's. */
export function buildIdFor(ref: ModelRef, maxBufferBytes: number | null | undefined): string {
	return smallBufferBuildFor(ref, maxBufferBytes)?.id ?? ref.id;
}

/**
 * The smallest binding any build of `ref` needs: its small-buffer build's
 * when it has one. Undefined for a model of unknown size (a deploy's own).
 */
export function minBufferNeed(ref: ModelRef): number | undefined {
	const own = ref.copies.gpu?.largestBufferBytes;
	const small = ref.smallBuffer?.largestBufferBytes;

	if (own === undefined) {
		return small;
	}

	return small === undefined ? own : Math.min(own, small);
}

/**
 * The smallest binding any GPU model needs, by its smallest build: the gpu
 * tier's floor (capability.ts). The 1.7B's small-buffer build: 74 MiB.
 */
export const LLM_MIN_BUFFER_BYTES = Math.min(
	...LLM_CHOICES.map((ref) => minBufferNeed(ref) ?? Infinity)
);

/**
 * Whether `ref` can load on a device whose largest storage binding is
 * `maxBufferBytes` (the probe's `min(maxBufferSize,
 * maxStorageBufferBindingSize)`, and the test cap; the worker asks WebLLM's
 * device for that much, engines/gpuLimits.ts): the model itself fits, or
 * its small-buffer build does. Anything but a GPU model fits.
 */
export function llmFits(ref: ModelRef, maxBufferBytes: number): boolean {
	return ref.engine !== "llm" || (minBufferNeed(ref) ?? 0) <= maxBufferBytes;
}

/** The language model's CPU copy's measured peak page memory (tools/translate-eval/results/2026-10-29-cpu-llm.md). */
export const CPU_LLM_PEAK_BYTES = 2_921_910_272;

/** What WebKit lets an iPhone or iPad page use before it ends it. */
export const APPLE_PAGE_BUDGET_BYTES = 1_800_000_000;

/**
 * The device codes that keep a model from running: everything the probe can
 * report but SMALL_BUFFER, which is per model and becomes a `buffer` block
 * with that model's own numbers.
 */
export type DeviceReason = Exclude<CapabilityReason, "SMALL_BUFFER">;

/**
 * Why a model cannot run here, in the order a user can do something about
 * it last: the deploy switched translation off, the probe has not answered
 * yet, the device cannot (a capability code), the GPU binds too little for
 * this model (with both numbers), or the user switched its engine off in
 * Settings. A model the device cannot run is never reported as switched off:
 * turning the setting on would change nothing.
 */
export type ModelBlock =
	| {kind: "disabled"}
	| {kind: "probing"}
	| {kind: "device"; reason: DeviceReason}
	| {kind: "buffer"; needed: number; limit: number}
	/**
	 * A GPU model a phone or tablet cannot hold (`tooLargeForPhone`):
	 * `needed` is its graphics memory (`ModelRef.vramBytes`).
	 */
	| {kind: "memory"; needed: number}
	/** The model has no copy for the device asked about (the 4B on the CPU). */
	| {kind: "noCopy"; device: Device}
	/**
	 * `all`: both engine switches (router.ts `translationBlock`; never one
	 * model's). `nllb`: NLLB-200 alone, which is off until the user opts in
	 * (its licence is non-commercial, CC-BY-NC-4.0).
	 */
	// "llmOrNllb": the pair has the GPU model or NLLB-200, and both are off.
	| {kind: "off"; engine: "llm" | "opus" | "nllb" | "llmOrNllb" | "all"};

/**
 * The user's engine switches (`translateLlm`, `translateCpu`,
 * `translateNllb`; service.ts `ServiceSettings`). `nllb` is NLLB-200's own
 * opt-in; the OPUS-MT pairs run with `opus` alone.
 */
export interface EngineSwitches {
	llm: boolean;
	/** OPUS-MT's switch (the setting `translateCpu`, kept under its old name). */
	opus: boolean;
	nllb: boolean;
}

/** The GPU codes, most fundamental first: the first one the probe lists is the one named. */
const GPU_REASONS: readonly DeviceReason[] = [
	"PROBE_FAILED",
	"INSECURE_ORIGIN",
	"NO_WEBGPU",
	"NO_ADAPTER",
	"NO_F16",
	"GPU_LIMITS",
];

/**
 * What keeps `ref` from running on this device, or null when it can. The
 * one rule Settings' model rows, the router's explanations (router.ts
 * `explainRoute`) and the disabled translation actions all read. `capability`
 * is the probe (store `translationCapability`), null while it runs; `enabled`
 * is the deploy's `translation.enabled`.
 */
export function modelBlock(
	ref: ModelRef,
	device: Device,
	capability: Capability | null,
	switches: EngineSwitches,
	enabled = true
): ModelBlock | null {
	if (!enabled) {
		return {kind: "disabled"};
	}

	if (!capability) {
		return {kind: "probing"};
	}

	return device === "gpu"
		? gpuBlock(ref, capability, switches)
		: cpuBlock(ref, capability, switches);
}

/** The user's switch for `ref`: its block when off, else null. */
function switchBlock(ref: ModelRef, switches: EngineSwitches): ModelBlock | null {
	if (ref.family === "llm") {
		return switches.llm ? null : {kind: "off", engine: "llm"};
	}

	if (ref.family === "nllb") {
		return switches.nllb ? null : {kind: "off", engine: "nllb"};
	}

	return switches.opus ? null : {kind: "off", engine: "opus"};
}

function gpuBlock(
	ref: ModelRef,
	capability: Capability,
	switches: EngineSwitches
): ModelBlock | null {
	if (ref.engine === "llm") {
		const reason = GPU_REASONS.find((code) => capability.reasons.includes(code));

		if (reason) {
			return {kind: "device", reason};
		}

		if (!ref.copies.gpu) {
			return {kind: "noCopy", device: "gpu"};
		}

		// The gpu tier's floor is the smallest shipped model's need, so a
		// deploy model of unknown size on a device below it is held to that.
		// A model with a small-buffer build needs what that build needs.
		const needed = minBufferNeed(ref) ?? (capability.tier === "gpu" ? 0 : LLM_MIN_BUFFER_BYTES);

		if (capability.tier !== "gpu" || needed > capability.maxBufferBytes) {
			return {kind: "buffer", needed, limit: capability.maxBufferBytes};
		}

		// Whatever the GPU binds, a phone's page cannot hold the 4B: the
		// switch would change nothing, so this comes before it.
		if (capability.mobile && tooLargeForPhone(ref)) {
			return {kind: "memory", needed: ref.vramBytes ?? 0};
		}

		return switchBlock(ref, switches);
	}

	// OPUS-MT and NLLB-200 on the GPU: any WebGPU device with f16 whose
	// largest binding holds the copy's biggest tensor; WebLLM's shader
	// floors (GPU_LIMITS) and the language model's buffer rule do not apply.
	for (const code of ["PROBE_FAILED", "INSECURE_ORIGIN", "NO_WEBGPU", "NO_ADAPTER"] as const) {
		if (capability.reasons.includes(code)) {
			return {kind: "device", reason: code};
		}
	}

	// onnxruntime-web's WebGPU execution provider runs inside its SIMD wasm build.
	if (capability.reasons.includes("NO_WASM_SIMD")) {
		return {kind: "device", reason: "NO_WASM_SIMD"};
	}

	if (!capability.f16) {
		return {kind: "device", reason: "NO_F16"};
	}

	const copy = ref.copies.gpu;

	if (!copy) {
		return {kind: "noCopy", device: "gpu"};
	}

	if (
		copy.largestBufferBytes !== undefined &&
		copy.largestBufferBytes > capability.maxBufferBytes
	) {
		return {kind: "buffer", needed: copy.largestBufferBytes, limit: capability.maxBufferBytes};
	}

	return switchBlock(ref, switches);
}

function cpuBlock(
	ref: ModelRef,
	capability: Capability,
	switches: EngineSwitches
): ModelBlock | null {
	if (capability.reasons.includes("PROBE_FAILED")) {
		return {kind: "device", reason: "PROBE_FAILED"};
	}

	if (capability.tier === "none" || capability.reasons.includes("NO_WASM_SIMD")) {
		return {kind: "device", reason: "NO_WASM_SIMD"};
	}

	// The language model's CPU library is a Memory64 module (wllama's
	// standard build); OPUS-MT and NLLB-200 run on ONNX Runtime's 32-bit one.
	if (ref.family === "llm" && capability.reasons.includes("NO_MEMORY64")) {
		return {kind: "device", reason: "NO_MEMORY64"};
	}

	if (!ref.copies.cpu) {
		return {kind: "noCopy", device: "cpu"};
	}

	// WebKit ends a page past its budget: the language model's CPU copy
	// peaks above it, so an iPhone or iPad cannot run it however it is set.
	if (
		capability.appleMobile &&
		ref.family === "llm" &&
		CPU_LLM_PEAK_BYTES > APPLE_PAGE_BUDGET_BYTES
	) {
		return {kind: "memory", needed: CPU_LLM_PEAK_BYTES};
	}

	return switchBlock(ref, switches);
}

/**
 * The device `ref`'s slot ran on before models ran on either (the language
 * model on the GPU, OPUS-MT and NLLB-200 on the CPU): the copy the download
 * question asks about with its plain title (index.ts), the other device's
 * naming its device.
 */
export function nativeDevice(ref: ModelRef): Device {
	return ref.engine === "llm" ? "gpu" : "cpu";
}

const ALL_ON: EngineSwitches = {llm: true, opus: true, nllb: true};

/**
 * The devices to try `ref` on, best first (spec translation-devices.md
 * § Auto). A pinned choice is that device alone. Auto, a placeholder until
 * measured on real GPUs: the language model on the GPU alone (the CPU runs
 * it only when the user pins it there); NLLB-200 on the GPU, then the CPU,
 * where its GPU copy fits, else the CPU alone; OPUS-MT on the CPU, then the
 * GPU, on a phone (its GPU memory is kept for the language model), the GPU
 * first on a computer; a device the model has no copy for is left out.
 * What the walk does with each device -- blocked, down, a declined
 * download -- is the router's (router.ts `explainRoute`).
 */
export function deviceOrder(
	ref: ModelRef,
	choice: DeviceChoice,
	capability: Capability | null
): Device[] {
	if (choice !== "auto") {
		return [choice];
	}

	if (ref.family === "llm") {
		return ["gpu"];
	}

	if (ref.family === "nllb") {
		return modelBlock(ref, "gpu", capability, ALL_ON) === null ? ["gpu", "cpu"] : ["cpu"];
	}

	// Auto tries only the devices the model has a copy for: a catalog without
	// OPUS-MT's GPU copies (CatalogOptions `seq2seqGpu`) runs it on the CPU,
	// and its reasons are the CPU's, never the missing copy's.
	const order: Device[] = capability?.mobile ? ["cpu", "gpu"] : ["gpu", "cpu"];
	const copied = order.filter((device) => ref.copies[device] !== undefined);

	return copied.length ? copied : order;
}

/** What the default GPU model is decided from (capability.ts `Capability`). */
export interface AdapterMemory {
	maxBufferBytes: number;
	deviceMemoryGiB: number | null;
	/** A phone or tablet (capability.ts `browserEnv`): never the 4B by default. */
	mobile?: boolean;
	/**
	 * The probe's verdict, when it is known. Only a `gpu` device gets a GPU
	 * default: on a cpu-tier device the selected model still picks the route
	 * table (`service.ts` `buildTable`), whose non-LLM entries differ between
	 * the two models, so a device that can run neither must stay on the
	 * catalog's own default.
	 */
	tier?: Tier;
}

/**
 * Whether `ref` can run on the device `memory` describes: its smallest
 * build binds (`llmFits`) and, on a phone or tablet, it is not too large
 * for the page (`tooLargeForPhone`) — the GPU half of `modelBlock`, for the
 * callers that hold an `AdapterMemory` rather than a whole capability.
 */
export function llmRunsOn(
	ref: ModelRef,
	memory: Pick<AdapterMemory, "maxBufferBytes" | "mobile">
): boolean {
	return llmFits(ref, memory.maxBufferBytes) && !(memory.mobile && tooLargeForPhone(ref));
}

/** The device memory a 4B model asks for, in GiB. */
export const LARGE_LLM_MIN_MEMORY_GIB = 6;

/**
 * The default GPU model for this device: the most capable choice it can hold.
 * Only a model whose largest buffer the device can bind is a candidate
 * (`llmFits`). The 4B needs `navigator.deviceMemory` (`deviceMemoryGiB`) of
 * LARGE_LLM_MIN_MEMORY_GIB and a computer: Chrome reports 8 GiB on many
 * phones, where its 3.4 GB is most of the memory, and a browser without
 * `deviceMemory` (Safari, Firefox) says nothing about it — the adapter's
 * binding limit is per buffer, not the total. Falls back to the first choice
 * when nothing fits (the gpu tier's floor makes that the smallest model's
 * own need). It answers for a gpu-tier device; gating on the tier is the
 * caller's (`llmChoice`).
 */
export function defaultLlmForAdapter(memory: AdapterMemory | null | undefined): string {
	const fitting = LLM_CHOICES.filter((ref) =>
		llmRunsOn(ref, {maxBufferBytes: memory?.maxBufferBytes ?? 0, mobile: memory?.mobile})
	);
	const large = fitting.find((ref) => ref.id === QWEN3_4B_ID);
	const wantsLarge =
		!!memory &&
		!memory.mobile &&
		typeof memory.deviceMemoryGiB === "number" &&
		memory.deviceMemoryGiB >= LARGE_LLM_MIN_MEMORY_GIB;

	return (wantsLarge && large ? large : fitting[0] ?? LLM_CHOICES[0]).id;
}

/** A GPU model's own product name, for the model select. */
export function llmName(ref: ModelRef): string {
	return ref.label.kind === "llm" ? ref.label.name : ref.id;
}

/** A deploy's own GPU model, neither of the shipped choices. */
function deployLlmRef(id: string, lib: string | undefined): ModelRef {
	const ref: ModelRef = {
		engine: "llm",
		family: "llm",
		id,
		label: {kind: "llm", name: id.replace(/-q4f16_1-MLC$/, "").replace(/-/g, " ")},
		copies: {gpu: {sizeBytes: LLM_SIZE_BYTES, source: id}},
	};

	if (lib) {
		ref.lib = lib;
	}

	return ref;
}

/**
 * The GPU model `selected` names among the choices; an id that is none of
 * them (a stored setting a later deploy no longer offers, an empty one — an
 * unset setting is no choice) is resolved here, at read time, and never
 * written back: the deploy's own model, else what `memory` fits, else the
 * catalog default. `memory` is the device probe (store `translationCapability`),
 * null while it is still running — the catalog default serves until it lands
 * and this answers anew once it has.
 *
 * `llmDevice` is the language model's device setting (`translateLlmDevice`).
 * Pinned to the CPU, a choice stands as made — a chosen 4B, which has no
 * CPU copy, is the router's to block (`noCopy`), never quietly swapped —
 * and an unresolved one lands on a model that has a CPU copy (the 1.7B,
 * where the adapter would have picked the 4B).
 */
export function llmChoice(
	catalog: ModelCatalog,
	selected: string | null | undefined,
	memory?: AdapterMemory | null,
	llmDevice: DeviceChoice = "auto"
): ModelRef {
	const chosen = catalog.llmChoices.find((ref) => ref.id === selected);

	if (llmDevice === "cpu") {
		if (chosen) {
			return chosen;
		}

		const onCpu = (ref: ModelRef | undefined): ref is ModelRef => !!ref?.copies.cpu;
		const deployed = catalog.llmChoices.find((ref) => ref.id === catalog.llmDeploy);
		const fallback = llmChoice(catalog, selected, memory);

		return (
			[deployed, fallback].find(onCpu) ??
			catalog.llmChoices.find((ref) => ref.id === catalog.llmDefault && onCpu(ref)) ??
			catalog.llmChoices.find(onCpu) ??
			fallback
		);
	}

	// A probe that found no GPU names no GPU model (see AdapterMemory.tier).
	const device = memory && (memory.tier ?? "gpu") === "gpu" ? memory : null;

	// A choice this GPU cannot bind (llmFits), or a phone cannot hold
	// (tooLargeForPhone), runs the default instead, so a gpu tier always
	// means the model in use can load; Settings says why the chosen row
	// cannot be downloaded. The deploy's own model is held to the same rule.
	const runs = (ref: ModelRef | undefined): ref is ModelRef =>
		!!ref && (!device || llmRunsOn(ref, device));

	if (runs(chosen)) {
		return chosen;
	}

	const deployed = catalog.llmChoices.find((ref) => ref.id === catalog.llmDeploy);

	if (runs(deployed)) {
		return deployed;
	}

	const unset = device ? defaultLlmForAdapter(device) : undefined;
	const fallback =
		catalog.llmChoices.find((ref) => ref.id === unset) ??
		catalog.llmChoices.find((ref) => ref.id === catalog.llmDefault);

	return runs(fallback)
		? fallback
		: catalog.llmChoices.find((ref) => runs(ref)) ?? fallback ?? catalog.llm;
}

/** The catalog with `selected` (see `llmChoice`) as its GPU model. */
export function selectLlm(
	catalog: ModelCatalog,
	selected: string | null | undefined,
	memory?: AdapterMemory | null,
	llmDevice: DeviceChoice = "auto"
): ModelCatalog {
	const llm = llmChoice(catalog, selected, memory, llmDevice);

	return llm === catalog.llm ? catalog : {...catalog, llm};
}

export function buildCatalog(
	options: CatalogOptions = {},
	selectedLlm: string | null = null
): ModelCatalog {
	const llmId = options.llm?.model ?? DEFAULT_LLM_ID;
	const lib = options.llm?.lib;
	// A deploy's library belongs to the deploy's model (or to the shipped
	// default it mirrors), never to the other choice: a 4B load handed the
	// 1.7B wasm fails.
	//
	// The small-buffer build reads the published weights from Hugging Face
	// at a pinned commit through the app's own library: a deploy that
	// mirrors the weights (`modelBase`, which keeps its readers off
	// third-party hosts) or names its own library for the model has neither,
	// so there the model has no such build and a small GPU cannot run it.
	const llmChoices = LLM_CHOICES.map((ref): ModelRef => {
		const choice: ModelRef = ref.id === llmId && lib ? {...ref, lib} : {...ref};

		if (choice.smallBuffer && (options.modelBase || choice.lib)) {
			delete choice.smallBuffer;
		}

		return choice;
	});

	if (!llmChoices.some((ref) => ref.id === llmId)) {
		llmChoices.push(deployLlmRef(llmId, lib));
	}

	// A deploy's own NLLB/OPUS ids get the same copies as the shipped ones:
	// the same repo layout (q8 and q4f16/fp16 files side by side) is
	// assumed. The GPU copies only with `seq2seqGpu` (CatalogOptions).
	const seq2seqGpu = options.seq2seqGpu === true;
	const nllbId = options.cpu?.nllb ?? DEFAULT_NLLB_ID;
	const pairs = {...DEFAULT_OPUS_PAIRS, ...(options.cpu?.opus ?? {})};
	const opus: Record<string, ModelRef> = {};

	for (const [pairKey, id] of Object.entries(pairs)) {
		if (/^[a-z]{2,3}-[a-z]{2,3}$/.test(pairKey)) {
			opus[pairKey] = opusRef(pairKey, id, seq2seqGpu);
		}
	}

	const catalog: ModelCatalog = {
		llm: llmChoices.find((ref) => ref.id === llmId) as ModelRef,
		llmChoices,
		llmDefault: llmId,
		nllb: {
			engine: "seq2seq",
			family: "nllb",
			id: nllbId,
			label: {kind: "nllb"},
			copies: {
				cpu: {sizeBytes: NLLB_SIZE_BYTES, source: nllbId, dtype: "q8"},
				...(seq2seqGpu && {
					gpu: {
						sizeBytes: NLLB_GPU_SIZE_BYTES,
						source: nllbId,
						dtype: "q4f16",
						largestBufferBytes: NLLB_GPU_LARGEST_BYTES,
					},
				}),
			},
		},
		opus,
	};

	if (options.llm?.model) {
		catalog.llmDeploy = options.llm.model;
	}

	if (options.llm?.lib) {
		catalog.llmLib = options.llm.lib;
	}

	if (options.modelBase) {
		catalog.modelBase = options.modelBase.replace(/\/+$/, "");
	}

	return selectLlm(catalog, selectedLlm);
}

/** Every model Settings lists: all the GPU choices, NLLB, then the OPUS-MT pairs. */
export function catalogModels(catalog: ModelCatalog): ModelRef[] {
	return [...catalog.llmChoices, catalog.nllb, ...Object.values(catalog.opus)];
}

export function refFor(catalog: ModelCatalog, candidate: Candidate): ModelRef | null {
	if (candidate === "llm") {
		return catalog.llm;
	}

	if (candidate === "nllb") {
		return catalog.nllb;
	}

	return catalog.opus[candidate.slice("opus:".length)] ?? null;
}

/** The other direction: which route candidate a model answers for. */
export function candidateOf(ref: ModelRef): Candidate {
	if (ref.family === "llm") {
		return "llm";
	}

	if (ref.family === "nllb") {
		return "nllb";
	}

	const [from, to] = ref.pair ?? ["", ""];

	return `opus:${from}-${to}`;
}

/**
 * Answered by the worker, where Cache Storage and the libraries' cache
 * helpers live: per copy, the model's copy for `device`. An engine's own
 * helper, which only ever holds one device's copies, may ignore it.
 */
export interface CacheApi {
	has(ref: ModelRef, device: Device): Promise<boolean>;
	delete(ref: ModelRef, device: Device): Promise<void>;
}

/** Whether one copy of a model is on the device: one entry per copy. */
export interface ModelCacheState {
	ref: ModelRef;
	device: Device;
	cached: boolean;
}

/** The devices `ref` has a copy for, the GPU copy first. */
export function copyDevices(ref: Pick<ModelRef, "copies">): Device[] {
	return (["gpu", "cpu"] as const).filter((device) => ref.copies[device] !== undefined);
}

// One entry per copy, in catalog order, a model's GPU copy before its CPU
// copy. One entry that cannot answer is that entry's problem — it counts as not
// downloaded and Settings still lists every other model (an LLM id the
// library does not know throws in `webllm.real.ts`'s `has`). A cache api
// that throws synchronously is the whole of Cache Storage being unusable,
// and that still rejects: Settings says so instead of offering every model
// as a fresh download.
export async function cacheStates(
	catalog: ModelCatalog,
	api: CacheApi
): Promise<ModelCacheState[]> {
	return Promise.all(
		catalogModels(catalog).flatMap((ref) =>
			copyDevices(ref).map(async (device) => ({
				ref,
				device,
				cached: await api.has(ref, device).catch(() => false),
			}))
		)
	);
}

/** A device setting as stored: anything but the three values reads as "auto". */
export function normalizeDeviceChoice(value: unknown): DeviceChoice {
	return value === "gpu" || value === "cpu" || value === "auto" ? value : "auto";
}

/** The user's three device settings, by the model each governs. */
export interface DeviceChoices {
	llm: DeviceChoice;
	opus: DeviceChoice;
	nllb: DeviceChoice;
}

/** The device setting that governs `ref`'s family. */
export function choiceFor(ref: ModelRef, choices: DeviceChoices): DeviceChoice {
	return choices[ref.family];
}

/**
 * The download size a plain listing shows for `ref`: the copy of the device
 * its engine slot runs on today (the language model's GPU copy, the CPU
 * copy of OPUS-MT and NLLB-200), else the other's; 0 when it lists none.
 * The language model select's sizes and a download question that names no
 * device read it; Settings' copy lines show each copy's own size.
 */
export function listedSize(ref: Pick<ModelRef, "engine" | "copies">): number {
	const {gpu, cpu} = ref.copies;

	return (ref.engine === "llm" ? gpu ?? cpu : cpu ?? gpu)?.sizeBytes ?? 0;
}
