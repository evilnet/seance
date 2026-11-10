import {expect} from "chai";
import type {Capability, Tier} from "../../client/js/translate/capability";
import type {Device, ModelRef} from "../../client/js/translate/engine";
import {
	QWEN3_1_7B_ID,
	QWEN3_4B_ID,
	buildCatalog,
	type DeviceChoices,
} from "../../client/js/translate/models";
import {
	normalizePreference,
	resolveRoute,
	withLlmAt,
	type RouteInput,
} from "../../client/js/translate/router";
import {
	DEFAULT_ROUTES,
	LLM_AHEAD,
	OPUS_TIED,
	QWEN3_4B,
	QWEN3_4B_OPUS_TIED,
	llmAheadOf,
} from "../../client/js/translate/routes.default";

// Settings → Advanced's "Prefer" (router.ts `EnginePreference`) and
// Automatic's one exception (`llmFirstIfCached`, routes.default.ts
// `llmAheadOf`), over the shipped table, where an OPUS-MT pair routes first.

const catalog = buildCatalog();
const AUTO: DeviceChoices = {llm: "auto", opus: "auto", nllb: "auto"};

function capabilityFor(tier: Tier): Capability {
	return {
		tier,
		reasons: tier === "gpu" ? [] : ["NO_WEBGPU"],
		f16: tier === "gpu",
		maxBufferBytes: tier === "gpu" ? 2 * 1024 * 1024 * 1024 : 0,
		deviceMemoryGiB: 8,
		storageQuotaBytes: null,
		mobile: false,
	};
}

function input(overrides: Partial<RouteInput> = {}): RouteInput {
	const tier = overrides.tier ?? "gpu";

	return {
		from: "es",
		hint: null,
		to: "en",
		tier,
		switches: {llm: true, opus: true, nllb: false},
		devices: AUTO,
		down: new Set(),
		capability: capabilityFor(tier),
		...overrides,
	};
}

const llmOnGpu = (ref: ModelRef, device: Device) => ref.id === catalog.llm.id && device === "gpu";
const route = (overrides: Partial<RouteInput>) =>
	resolveRoute(DEFAULT_ROUTES, catalog, input(overrides))?.candidate;

describe("translate: the engine preference", () => {
	it("takes the language model out of its class, first or last", () => {
		const classes = [["opus:es-en"], ["llm", "nllb"]];

		expect(withLlmAt(classes, "first")).to.deep.equal([["llm"], ["opus:es-en"], ["nllb"]]);
		expect(withLlmAt(classes, "last")).to.deep.equal([["opus:es-en"], ["nllb"], ["llm"]]);
		// A class left empty goes; an entry without the language model stays.
		expect(withLlmAt([["llm"], ["nllb"]], "last")).to.deep.equal([["nllb"], ["llm"]]);
		expect(withLlmAt([["nllb"]], "first")).to.deep.equal([["nllb"]]);
	});

	it("reads anything but llm and small as Automatic", () => {
		expect(normalizePreference("llm")).to.equal("llm");
		expect(normalizePreference("small")).to.equal("small");
		expect(normalizePreference("auto")).to.equal("auto");
		expect(normalizePreference("qwen")).to.equal("auto");
		expect(normalizePreference(undefined)).to.equal("auto");
	});

	it("Automatic: the pair first, as the table has it", () => {
		expect(route({})).to.equal("opus:es-en");
		expect(route({prefer: "auto"})).to.equal("opus:es-en");
	});

	it("Language model first: the language model ahead of the pair", () => {
		expect(route({prefer: "llm"})).to.equal("llm");
		expect(route({from: "de", prefer: "llm"})).to.equal("llm");
	});

	it("Language model first keeps the pair as the fallback", () => {
		// No GPU: the language model cannot run on Auto, the pair takes it.
		expect(route({prefer: "llm", tier: "cpu"})).to.equal("opus:es-en");
		// Switched off, or marked down for the session.
		expect(route({prefer: "llm", switches: {llm: false, opus: true, nllb: false}})).to.equal(
			"opus:es-en"
		);
		expect(route({prefer: "llm", down: new Set(["llm@gpu"])})).to.equal("opus:es-en");
	});

	it("Smaller models first: the language model behind every other class", () => {
		// English to Japanese has no pair: the language model leads the
		// table, and NLLB-200 (switched on) goes ahead of it here.
		const ja = {from: "en", to: "ja"};

		expect(route({...ja})).to.equal("llm");
		expect(
			route({...ja, prefer: "small", switches: {llm: true, opus: true, nllb: true}})
		).to.equal("nllb");
		// NLLB-200 off: the language model still serves, as the fallback.
		expect(route({...ja, prefer: "small"})).to.equal("llm");
	});

	it("Automatic: the language model first where it measured ahead, once downloaded", () => {
		const ahead = {llmFirstIfCached: true};

		// Not downloaded: the cheaper pair, as before.
		expect(route({...ahead, cached: () => false})).to.equal("opus:es-en");
		// Downloaded: the language model.
		expect(route({...ahead, cached: llmOnGpu})).to.equal("llm");
		// Downloaded, but only its CPU copy, which Auto does not route to.
		expect(
			route({
				...ahead,
				cached: (ref: ModelRef, device: Device) =>
					ref.id === catalog.llm.id && device === "cpu",
			})
		).to.equal("opus:es-en");
		// Downloaded but unable to run: the pair.
		expect(route({...ahead, cached: llmOnGpu, down: new Set(["llm@gpu"])})).to.equal(
			"opus:es-en"
		);
	});

	it("names the pairs the language model measured ahead in, per model", () => {
		expect(LLM_AHEAD).to.deep.equal(["es", "it"]);
		expect(QWEN3_4B.llmAhead).to.deep.equal(["fr", "es", "it"]);

		// A measured tie, or the pair ahead, is never in the list.
		for (const code of [...OPUS_TIED, ...QWEN3_4B_OPUS_TIED]) {
			if (code !== "fr") {
				expect(LLM_AHEAD).not.to.include(code);
				expect(QWEN3_4B.llmAhead).not.to.include(code);
			}
		}

		expect(llmAheadOf(QWEN3_1_7B_ID, "es", "en")).to.equal(true);
		expect(llmAheadOf(QWEN3_1_7B_ID, "en", "it")).to.equal(true);
		expect(llmAheadOf(QWEN3_1_7B_ID, "fr", "en")).to.equal(false);
		expect(llmAheadOf(QWEN3_4B_ID, "fr", "en")).to.equal(true);
		expect(llmAheadOf(QWEN3_1_7B_ID, "de", "en")).to.equal(false);
		// Only a shipped pair counts: es→de has no OPUS-MT model.
		expect(llmAheadOf(QWEN3_1_7B_ID, "es", "de")).to.equal(false);
		expect(llmAheadOf(QWEN3_1_7B_ID, null, "en")).to.equal(false);
		// A deploy's own model gets 1.7B's placements.
		expect(llmAheadOf("someone/else", "es", "en")).to.equal(true);
	});
});
