import {expect} from "chai";
import type {Capability} from "../../client/js/translate/capability";
import {
	buildCatalog,
	choiceFor,
	QWEN3_1_7B_ID,
	QWEN3_4B_ID,
	deviceOrder,
	llmChoice,
	normalizeDeviceChoice,
	type DeviceChoices,
} from "../../client/js/translate/models";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

function cap(overrides: Partial<Capability>): Capability {
	return {
		tier: "gpu",
		reasons: [],
		f16: true,
		maxBufferBytes: GiB,
		deviceMemoryGiB: 8,
		storageQuotaBytes: null,
		mobile: false,
		...overrides,
	};
}

/** A computer whose GPU binds 1 GiB with f16, and a phone at WebGPU's 128 MiB floor. */
const desktop = cap({});
const phone = cap({maxBufferBytes: 128 * MiB, mobile: true});

describe("translate/devices", () => {
	describe("normalizeDeviceChoice", () => {
		it("keeps the three values", () => {
			for (const value of ["auto", "gpu", "cpu"] as const) {
				expect(normalizeDeviceChoice(value)).to.equal(value);
			}
		});

		it("reads anything else as auto", () => {
			for (const value of ["npu", null, undefined, 1, "", {}]) {
				expect(normalizeDeviceChoice(value)).to.equal("auto");
			}
		});
	});

	describe("choiceFor", () => {
		it("maps a model's family to its own setting", () => {
			const choices: DeviceChoices = {llm: "gpu", opus: "cpu", nllb: "auto"};
			const catalog = buildCatalog();

			expect(choiceFor(catalog.llm, choices)).to.equal("gpu");
			expect(choiceFor(catalog.opus["de-en"], choices)).to.equal("cpu");
			expect(choiceFor(catalog.nllb, choices)).to.equal("auto");
		});
	});

	describe("deviceOrder", () => {
		// The GPU copies of OPUS-MT and NLLB-200 are off in the shipped
		// catalog (models.ts CatalogOptions `seq2seqGpu`); on here.
		const catalog = buildCatalog({seq2seqGpu: true});
		const opus = catalog.opus["en-de"];

		it("keeps the language model on the GPU under Auto, phone or computer", () => {
			expect(deviceOrder(catalog.llm, "auto", phone)).to.deep.equal(["gpu"]);
			expect(deviceOrder(catalog.llm, "auto", desktop)).to.deep.equal(["gpu"]);
		});

		it("tries NLLB-200's GPU copy first only where it fits", () => {
			expect(deviceOrder(catalog.nllb, "auto", desktop)).to.deep.equal(["gpu", "cpu"]);
			// Its 500 MiB embedding never binds on a 128 MiB phone.
			expect(deviceOrder(catalog.nllb, "auto", phone)).to.deep.equal(["cpu"]);
			// Nor without f16, nor before the probe has answered.
			expect(deviceOrder(catalog.nllb, "auto", cap({f16: false}))).to.deep.equal(["cpu"]);
			expect(deviceOrder(catalog.nllb, "auto", null)).to.deep.equal(["cpu"]);
		});

		it("puts OPUS-MT on the CPU first on a phone and on the GPU first on a computer", () => {
			expect(deviceOrder(opus, "auto", phone)).to.deep.equal(["cpu", "gpu"]);
			expect(deviceOrder(opus, "auto", desktop)).to.deep.equal(["gpu", "cpu"]);
		});

		it("leaves out a device the model has no copy for under Auto", () => {
			const shipped = buildCatalog();

			expect(deviceOrder(shipped.nllb, "auto", desktop)).to.deep.equal(["cpu"]);
			expect(deviceOrder(shipped.opus["en-de"], "auto", desktop)).to.deep.equal(["cpu"]);
			expect(deviceOrder(shipped.opus["en-de"], "auto", phone)).to.deep.equal(["cpu"]);
			// A pinned GPU is still that device alone: the router says why not.
			expect(deviceOrder(shipped.opus["en-de"], "gpu", desktop)).to.deep.equal(["gpu"]);
		});

		it("gives a pinned choice that device alone", () => {
			for (const ref of [catalog.llm, catalog.nllb, opus]) {
				expect(deviceOrder(ref, "cpu", desktop), ref.id).to.deep.equal(["cpu"]);
				expect(deviceOrder(ref, "gpu", phone), ref.id).to.deep.equal(["gpu"]);
			}
		});
	});

	describe("llmChoice and the language model's device", () => {
		const catalog = buildCatalog();
		// A computer that defaults to the 4B: 2 GiB binding, 8 GiB of memory.
		const big = cap({maxBufferBytes: 2 * GiB});

		it("resolves an unset choice to a model with a CPU copy when the CPU runs it", () => {
			expect(llmChoice(catalog, "", big).id).to.equal(QWEN3_4B_ID);
			expect(llmChoice(catalog, "", big, "auto").id).to.equal(QWEN3_4B_ID);
			expect(llmChoice(catalog, "", big, "gpu").id).to.equal(QWEN3_4B_ID);
			expect(llmChoice(catalog, "", big, "cpu").id).to.equal(QWEN3_1_7B_ID);
			// A stale id is no choice either; nor is a device with no GPU.
			expect(llmChoice(catalog, "gone", big, "cpu").id).to.equal(QWEN3_1_7B_ID);
			expect(
				llmChoice(catalog, null, cap({tier: "cpu", reasons: ["NO_WEBGPU"]}), "cpu").id
			).to.equal(QWEN3_1_7B_ID);
		});

		it("keeps a chosen 4B on the CPU, so the router can say it has no copy there", () => {
			expect(llmChoice(catalog, QWEN3_4B_ID, big, "cpu").id).to.equal(QWEN3_4B_ID);
			// Even where the GPU could not bind it (a phone).
			expect(llmChoice(catalog, QWEN3_4B_ID, phone, "cpu").id).to.equal(QWEN3_4B_ID);
		});
	});
});
