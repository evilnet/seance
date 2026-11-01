import {expect} from "chai";
import {before, describe, it} from "mocha";
import enCatalog from "../../client/locales/en.json";
import {setCatalog} from "../../client/js/i18n/core";
import {threadsText, translateWhyText} from "../../client/js/helpers/translateWhy";
import {translateErrorText} from "../../client/js/helpers/translateErrors";
import type {RouteBlock} from "../../client/js/translate/router";
import {buildCatalog, listedSize, type DeviceReason} from "../../client/js/translate/models";
import {TRANSLATION_UNAVAILABLE} from "../../client/js/translate/service";
import {needsDownloadError} from "../../client/js/translate/consent";
import friendlysize from "../../client/js/helpers/friendlysize";
import {ABORTED, TIMED_OUT} from "../../client/js/translate/outgoing";
import {CONTEXT_OVERFLOW, gpuLost, parseGpuLost} from "../../client/js/translate/engine";

// The rule reports codes (models.ts modelBlock, router.ts explainRoute and
// translationBlock); these two helpers turn them into the sentences every
// surface shows. availability.ts pins the codes, this pins the mapping: a
// code that falls to the wrong sentence (a new device reason read as "no
// WebGPU", both engines off read as the GPU's alone) ships with a green
// suite otherwise.
const en = enCatalog as Record<string, string>;

describe("translateWhyText", () => {
	before(() => {
		setCatalog("en", enCatalog, undefined);
	});

	const cases: Array<[RouteBlock, string]> = [
		[{kind: "disabled"}, "translate.settings.disabled"],
		[{kind: "probing"}, "translate.why.probing"],
		[{kind: "off", engine: "opus"}, "translate.why.cpuOff"],
		[{kind: "off", engine: "all"}, "translate.why.allOff"],
		[{kind: "down"}, "translate.why.down"],
		[{kind: "unserved"}, "translate.why.unserved"],
		[{kind: "off", engine: "nllb"}, "translate.why.nllbOff"],
		[{kind: "source"}, "translate.why.unserved"],
	];

	it("names the language model in its switch's reason, and the pair-serving ones as they are", () => {
		expect(translateWhyText({kind: "off", engine: "llm"})).to.equal(
			"Qwen3 1.7B is switched off in Settings → Translation."
		);
		expect(translateWhyText({kind: "off", engine: "llm"}, "Qwen3 4B")).to.equal(
			"Qwen3 4B is switched off in Settings → Translation."
		);
		expect(translateWhyText({kind: "off", engine: "opus"})).to.equal(
			"OPUS-MT is switched off in Settings → Translation."
		);
		expect(translateWhyText({kind: "off", engine: "all"})).to.equal(
			"The language model and OPUS-MT are both switched off in Settings → Translation."
		);
		expect(translateWhyText({kind: "off", engine: "llmOrNllb"}, "Qwen3 4B")).to.equal(
			"This needs Qwen3 4B or NLLB-200, and both are switched off in Settings → Translation."
		);
	});

	it("says a model without a CPU copy cannot run on the CPU, and which one to choose", () => {
		expect(translateWhyText({kind: "noCopy", device: "cpu"}, "Qwen3 4B")).to.equal(
			"Qwen3 4B can't run on the CPU. Choose Qwen3 1.7B to run it there."
		);
	});

	it("says a model without a GPU copy cannot run on the GPU in this version", () => {
		// OPUS-MT and NLLB-200 in this build (models.ts CatalogOptions `seq2seqGpu`).
		expect(translateWhyText({kind: "noCopy", device: "gpu"})).to.equal(
			"This model can't run on the GPU in this version of the app."
		);
	});

	it("says which device a declined download was for, with that copy's size", () => {
		const llm = buildCatalog().llm;
		const opus = buildCatalog().opus["de-en"];
		const gpu = translateWhyText({kind: "download", ref: llm, device: "gpu"});
		const cpu = translateWhyText({kind: "download", ref: llm, device: "cpu"});

		expect(gpu).to.match(
			/^Needs Qwen3 1\.7B \(all languages\) for the GPU, a [\d.]+ \w+ download/
		);
		expect(cpu).to.match(
			/^Needs Qwen3 1\.7B \(all languages\) for the CPU, a [\d.]+ \w+ download/
		);
		expect(gpu).to.not.equal(cpu);
		expect(translateWhyText({kind: "download", ref: opus, device: "gpu"})).to.include(
			"OPUS-MT German → English for the GPU"
		);
	});

	for (const [block, key] of cases) {
		it(`says ${key} for ${JSON.stringify(block)}`, () => {
			expect(translateWhyText(block)).to.equal(en[key]);
		});
	}

	it("has a sentence of its own for every device reason", () => {
		const reasons: Record<DeviceReason, string> = {
			NO_WEBGPU: "translate.why.noWebgpu",
			INSECURE_ORIGIN: "translate.why.insecureOrigin",
			NO_ADAPTER: "translate.why.noAdapter",
			NO_F16: "translate.why.noF16",
			GPU_LIMITS: "translate.why.gpuLimits",
			NO_WASM_SIMD: "translate.why.noWasmSimd",
			PROBE_FAILED: "translate.why.probeFailed",
			NO_MEMORY64: "translate.why.noMemory64",
		};

		for (const [reason, key] of Object.entries(reasons)) {
			expect(
				translateWhyText({kind: "device", reason: reason as DeviceReason}),
				reason
			).to.equal(en[key]);
		}

		// Eight reasons, eight sentences: none falls to another's.
		expect(new Set(Object.values(reasons).map((key) => en[key])).size).to.equal(8);

		// Each says which device it is about.
		expect(en["translate.why.noMemory64"]).to.include("on the CPU");
		expect(en["translate.why.noWebgpu"]).to.include("on the GPU");
	});

	it("says a phone cannot hold a model", () => {
		expect(translateWhyText({kind: "memory", needed: 3_400_000_000})).to.equal(
			en["translate.why.phoneMemory"]
		);
	});

	it("names both sizes of a buffer that is too small", () => {
		const text = translateWhyText({
			kind: "buffer",
			needed: 148.4 * 1024 * 1024,
			limit: 128 * 1024 * 1024,
		});

		expect(text).to.equal("Needs a GPU buffer of 148.4 MiB; this device binds at most 128 MiB");
	});
});

describe("translateErrorText", () => {
	before(() => {
		setCatalog("en", enCatalog, undefined);
	});

	it("says a request too long for the model's window is too long", () => {
		expect(translateErrorText(CONTEXT_OVERFLOW)).to.equal(en["translate.error.tooLong"]);
	});

	it("says the GPU stopped, with the browser's reason and the call that failed", () => {
		const mapAsync =
			"Failed to execute 'mapAsync' on 'GPUBuffer': Buffer was unmapped before mapping was resolved.";
		const code = gpuLost("GPU process\nterminated", mapAsync);
		expect(parseGpuLost(code)).to.deep.equal({
			reason: "GPU process terminated",
			detail: mapAsync,
		});
		expect(parseGpuLost(mapAsync)).to.equal(null);
		expect(translateErrorText(code)).to.equal(
			en["translate.error.gpuLost"]
				.replace("{reason}", "GPU process terminated")
				.replace("{detail}", mapAsync)
		);
	});

	it("says why nothing could take the request when the caller knows", () => {
		expect(
			translateErrorText(TRANSLATION_UNAVAILABLE, () => en["translate.why.cpuOff"])
		).to.equal(en["translate.why.cpuOff"]);
	});

	it("falls back to the generic sentence without an explanation", () => {
		expect(translateErrorText(TRANSLATION_UNAVAILABLE)).to.equal(
			en["translate.error.unavailable"]
		);
		// An explanation that has nothing to say does not blank the line.
		expect(translateErrorText(TRANSLATION_UNAVAILABLE, () => "")).to.equal(
			en["translate.error.unavailable"]
		);
	});

	it("keeps a load error's own detail, and an engine's text as it is", () => {
		expect(translateErrorText(`${TRANSLATION_UNAVAILABLE}: out of memory`)).to.equal(
			"no translation engine can take this request: out of memory"
		);
		expect(translateErrorText("WebGPU device lost")).to.equal("WebGPU device lost");
	});

	it("words a declined download with the model and its size, as the router's reason does", () => {
		const ref = buildCatalog().llm;
		const model = en["translate.model.llm"].replace("{name}", "Qwen3 1.7B");
		const size = friendlysize(listedSize(ref));
		const plain = en["translate.why.needsDownload"]
			.replace("{model}", model)
			.replace("{size}", size);
		const forGpu = en["translate.why.downloadGpu"]
			.replace("{model}", model)
			.replace("{size}", size);

		// A reason that does not know the copy's device says the plain sentence.
		expect(translateErrorText(needsDownloadError(ref))).to.equal(plain);
		expect(translateErrorText(needsDownloadError(ref, "gpu"))).to.equal(forGpu);
		expect(translateWhyText({kind: "download", ref, device: "gpu"})).to.equal(forGpu);
		expect(forGpu).to.include("Qwen3 1.7B").and.include("MiB");
	});

	it("names an OPUS-MT pair by its languages", () => {
		const ref = buildCatalog().opus["de-en"];

		expect(translateErrorText(needsDownloadError(ref))).to.include(
			en["translate.model.opus"].replace("{from}", "German").replace("{to}", "English")
		);
	});

	it("words the queue's own codes", () => {
		expect(translateErrorText(TIMED_OUT)).to.equal(en["translate.error.timedOut"]);
		expect(translateErrorText(ABORTED)).to.equal(en["translate.error.aborted"]);
	});
});

describe("threadsText", () => {
	before(() => {
		setCatalog("en", enCatalog, undefined);
	});

	it("says how many CPU threads are in use, or would be after a reload", () => {
		expect(threadsText("isolated", 4)).to.equal("Uses 4 CPU threads.");
		expect(threadsText("isolated", 1)).to.equal("Uses 1 CPU thread.");
		expect(threadsText("reload", 4)).to.equal("Reload the app to use 4 CPU threads.");
	});

	it("says nothing where the page can never be isolated", () => {
		expect(threadsText("unsupported", 4)).to.equal("");
	});
});
