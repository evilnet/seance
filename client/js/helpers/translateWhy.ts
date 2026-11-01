// Why a translation action or a model is unavailable, in words. The rule is
// Vue-free and reports codes (translate/models.ts `modelBlock`,
// translate/router.ts `explainRoute` and `translationBlock`); the phrase
// lives here, each reason a whole sentence of its own, so a caller shows it
// beside a lead sentence ("Correcting a message needs the language model.")
// rather than splicing one into the other.

import {activeLocale, t, tCount} from "../i18n/core";
import friendlysize from "./friendlysize";
import type {Device, ModelRef} from "../translate/engine";
import {DEFAULT_LLM_ID, LLM_CHOICES, QWEN3_1_7B_ID, listedSize, llmName} from "../translate/models";
import type {Isolation} from "../translate/threads";
import {languageName} from "../translate/languages";
import type {RouteBlock} from "../translate/router";

/**
 * A model's name as Settings lists it (helpers/modelLabel.ts), from its
 * label alone and without the store: the download question and the reason
 * a declined download gives are built where the store is not loaded
 * (translate/index.ts, the error text under mocha). The pair is named in
 * the interface's language, which is the reading language.
 */
export function modelDisplayName(ref: Pick<ModelRef, "label">): string {
	switch (ref.label.kind) {
		case "opus":
			return t("translate.model.opus", {
				from: languageName(ref.label.from, activeLocale()),
				to: languageName(ref.label.to, activeLocale()),
			});
		case "nllb":
			return t("translate.model.nllb");
		default:
			return t("translate.model.llm", {name: ref.label.name});
	}
}

/**
 * "Needs downloading <model> (<size>)", with the way to do it; `device`
 * names the copy it is about (a whole sentence per device, never a device
 * word spliced in), absent for a reason that does not know it.
 */
export function needsDownloadText(
	ref: Pick<ModelRef, "label"> & {sizeBytes: number},
	device?: Device
): string {
	const vars = {model: modelDisplayName(ref), size: friendlysize(ref.sizeBytes)};

	switch (device) {
		case "gpu":
			return t("translate.why.downloadGpu", vars);
		case "cpu":
			return t("translate.why.downloadCpu", vars);
		default:
			return t("translate.why.needsDownload", vars);
	}
}

/** The shipped language model's product name, for a caller that has no store. */
function defaultLlmName(): string {
	const ref = LLM_CHOICES.find((choice) => choice.id === DEFAULT_LLM_ID) ?? LLM_CHOICES[0];

	return llmName(ref);
}

/** The Qwen3 1.7B product name: the model a CPU request is told to choose. */
function cpuLlmName(): string {
	const ref = LLM_CHOICES.find((choice) => choice.id === QWEN3_1_7B_ID) ?? LLM_CHOICES[0];

	return llmName(ref);
}

/**
 * The CPU threads line in Settings' device line (reader.ts
 * `cpuThreadsLine`): how many threads the language model takes, or that a
 * reload brings them; nothing where the page can never be isolated.
 */
export function threadsText(isolation: Isolation, count: number): string {
	switch (isolation) {
		case "isolated":
			return tCount("translate.threads.using", count);
		case "reload":
			return tCount("translate.threads.reload", count);
		default:
			return "";
	}
}

/**
 * `llm` is the language model's product name where the caller knows the
 * model in use (reader.ts `liveLlmName`); without it the shipped default's.
 */
export function translateWhyText(block: RouteBlock, llm: string = defaultLlmName()): string {
	switch (block.kind) {
		case "disabled":
			return t("translate.settings.disabled");
		case "probing":
			return t("translate.why.probing");

		case "device":
			switch (block.reason) {
				case "INSECURE_ORIGIN":
					return t("translate.why.insecureOrigin");
				case "NO_ADAPTER":
					return t("translate.why.noAdapter");
				case "NO_F16":
					return t("translate.why.noF16");
				case "GPU_LIMITS":
					return t("translate.why.gpuLimits");
				case "NO_WASM_SIMD":
					return t("translate.why.noWasmSimd");
				case "NO_MEMORY64":
					return t("translate.why.noMemory64");
				case "PROBE_FAILED":
					return t("translate.why.probeFailed");
				default:
					return t("translate.why.noWebgpu");
			}

		case "buffer":
			return t("translate.model.needsBuffer", {
				needed: friendlysize(block.needed),
				limit: friendlysize(block.limit),
			});

		// No size: the GPU model select's own hint, above it, says how much
		// graphics memory the larger model needs.
		case "memory":
			return t("translate.why.phoneMemory");

		case "off":
			switch (block.engine) {
				case "llm":
					return t("translate.why.llmOff", {model: llm});
				case "opus":
					return t("translate.why.cpuOff");
				case "nllb":
					return t("translate.why.nllbOff");
				case "llmOrNllb":
					return t("translate.why.llmOrNllbOff", {model: llm});
				default:
					return t("translate.why.allOff");
			}

		// The model has no copy for the pinned device. On the CPU that is the
		// 4B, and the way out is the 1.7B, which has one; on the GPU it is
		// OPUS-MT and NLLB-200, which this build runs on the CPU alone
		// (models.ts CatalogOptions `seq2seqGpu`).
		case "noCopy":
			return block.device === "cpu"
				? t("translate.why.noCpuCopy", {model: llm, choice: cpuLlmName()})
				: t("translate.why.noGpuCopy");

		case "down":
			return t("translate.why.down");
		case "download":
			return needsDownloadText(
				{
					label: block.ref.label,
					sizeBytes: block.ref.copies[block.device]?.sizeBytes ?? listedSize(block.ref),
				},
				block.device
			);
		default:
			// "source" never reaches the UI (its questions pass a null source
			// as one the detector will name) and "unserved" is a pair no model
			// covers: both are "nothing here translates this pair".
			return t("translate.why.unserved");
	}
}
