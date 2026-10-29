import {expect} from "chai";
import {
	DEFAULT_LLM_ID,
	DEFAULT_NLLB_ID,
	LLM_CHOICES,
	LLM_MIN_BUFFER_BYTES,
	llmFits,
	QWEN3_1_7B_ID,
	QWEN3_4B_ID,
	buildCatalog,
	defaultLlmForAdapter,
	cacheStates,
	candidateOf,
	catalogModels,
	llmChoice,
	llmName,
	refFor,
	selectLlm,
	type CacheApi,
} from "../../client/js/translate/models";

describe("translate/models", () => {
	it("builds the default catalog", () => {
		const catalog = buildCatalog();

		expect(catalog.llm).to.include({engine: "llm", family: "llm", id: DEFAULT_LLM_ID});
		expect(catalog.llm.copies.gpu?.sizeBytes).to.be.greaterThan(0);
		expect(catalog.nllb).to.include({engine: "seq2seq", family: "nllb", id: DEFAULT_NLLB_ID});
		expect(catalog.opus["de-en"]).to.deep.include({
			engine: "seq2seq",
			family: "opus",
			id: "Xenova/opus-mt-de-en",
			pair: ["de", "en"],
		});
		// The label is data, not copy: helpers/modelLabel.ts renders it.
		expect(catalog.opus["de-en"].label).to.deep.equal({kind: "opus", from: "de", to: "en"});
		expect(catalog.modelBase).to.equal(undefined);
	});

	it("applies config.json overrides", () => {
		const catalog = buildCatalog({
			modelBase: "https://models.example.test/",
			llm: {
				model: "gemma-3-1b-it-q4f16_1-MLC",
				lib: "https://models.example.test/gemma.wasm",
			},
			cpu: {nllb: "mirror/nllb-small", opus: {"fi-en": "mirror/opus-fi-en"}},
		});

		expect(catalog.modelBase).to.equal("https://models.example.test");
		expect(catalog.llm.id).to.equal("gemma-3-1b-it-q4f16_1-MLC");
		expect(catalog.llmLib).to.equal("https://models.example.test/gemma.wasm");
		expect(catalog.nllb.id).to.equal("mirror/nllb-small");
		expect(catalog.opus["fi-en"].id).to.equal("mirror/opus-fi-en");
		expect(catalog.opus["fi-en"].pair).to.deep.equal(["fi", "en"]);
		expect(catalog.opus["de-en"].id).to.equal("Xenova/opus-mt-de-en");
	});

	it("lists each model's copies by device", () => {
		const catalog = buildCatalog({seq2seqGpu: true});
		const [small, large] = catalog.llmChoices;

		expect(small.copies.gpu?.largestBufferBytes).to.equal(155_582_464);
		expect(small.copies.cpu).to.deep.equal({
			sizeBytes: 1_107_409_472,
			source: "unsloth/Qwen3-1.7B-GGUF",
			file: "Qwen3-1.7B-Q4_K_M.gguf",
		});
		expect(large.copies.cpu).to.equal(undefined);
		expect(catalog.nllb.copies.gpu).to.include({
			dtype: "q4f16",
			largestBufferBytes: 524_709_888,
		});
		expect(catalog.nllb.copies.cpu).to.include({dtype: "q8", sizeBytes: 912_000_000});
		expect(catalog.opus["de-en"].copies.cpu).to.include({dtype: "q8", sizeBytes: 113_000_000});
		expect(catalog.opus["de-en"].copies.gpu).to.include({
			dtype: "fp16",
			largestBufferBytes: 59_495_424,
		});
	});

	it("gives OPUS-MT and NLLB-200 no GPU copy unless asked", () => {
		// This build has no WebGPU backend for them (webpack.config.ts's
		// onnxruntime-web alias): a GPU copy would download and fail to start.
		const catalog = buildCatalog();

		expect(Object.keys(catalog.nllb.copies)).to.deep.equal(["cpu"]);

		for (const ref of Object.values(catalog.opus)) {
			expect(Object.keys(ref.copies), ref.id).to.deep.equal(["cpu"]);
		}

		// The language models keep theirs.
		expect(catalog.llmChoices.every((ref) => ref.copies.gpu)).to.equal(true);
		// A deploy's config cannot turn it on: BrandingTranslation has no such
		// field and index.ts passes it as false.
		expect(Object.keys(buildCatalog({seq2seqGpu: false}).nllb.copies)).to.deep.equal(["cpu"]);
		expect(buildCatalog({seq2seqGpu: true}).nllb.copies.gpu?.sizeBytes).to.equal(1_260_000_000);
	});

	it("gives a deploy's own language model a GPU copy alone, and its seq2seq ids the shipped ones' copies", () => {
		const options = {
			llm: {model: "gemma-3-1b-it-q4f16_1-MLC"},
			cpu: {nllb: "mirror/nllb-small", opus: {"fi-en": "mirror/opus-fi-en"}},
		};
		const catalog = buildCatalog(options);

		expect(Object.keys(catalog.llm.copies)).to.deep.equal(["gpu"]);
		expect(catalog.nllb.copies.cpu?.source).to.equal("mirror/nllb-small");
		expect(catalog.opus["fi-en"].copies.cpu?.source).to.equal("mirror/opus-fi-en");
		expect(catalog.nllb.copies.gpu).to.equal(undefined);
		expect(catalog.opus["fi-en"].copies.gpu).to.equal(undefined);

		// With the GPU copies on, both from the deploy's repos.
		const withGpu = buildCatalog({...options, seq2seqGpu: true});

		expect(withGpu.nllb.copies.gpu?.source).to.equal("mirror/nllb-small");
		expect(withGpu.opus["fi-en"].copies.gpu?.source).to.equal("mirror/opus-fi-en");
	});

	it("resolves a candidate to its model", () => {
		const catalog = buildCatalog();

		expect(refFor(catalog, "llm")).to.equal(catalog.llm);
		expect(refFor(catalog, "nllb")).to.equal(catalog.nllb);
		expect(refFor(catalog, "opus:de-en")).to.equal(catalog.opus["de-en"]);
		expect(refFor(catalog, "opus:xx-yy")).to.equal(null);
	});

	it("lists every model once, the GPU choices first", () => {
		const models = catalogModels(buildCatalog());

		expect(models[0].id).to.equal(DEFAULT_LLM_ID);
		expect(models[1].id).to.equal(QWEN3_4B_ID);
		expect(models[2].id).to.equal(DEFAULT_NLLB_ID);
		expect(new Set(models.map((m) => m.id)).size).to.equal(models.length);
	});

	it("knows both GPU models, 1.7B selected by default", () => {
		const catalog = buildCatalog();

		expect(DEFAULT_LLM_ID).to.equal(QWEN3_1_7B_ID);
		expect(catalog.llmChoices.map((ref) => ref.id)).to.deep.equal([QWEN3_1_7B_ID, QWEN3_4B_ID]);
		expect(catalog.llmChoices.map((ref) => ref.id)).to.deep.equal(LLM_CHOICES.map((r) => r.id));
		expect(catalog.llmDefault).to.equal(QWEN3_1_7B_ID);
		expect(catalog.llm.id).to.equal(QWEN3_1_7B_ID);

		const [small, large] = catalog.llmChoices;

		expect(small).to.include({engine: "llm", family: "llm"});
		expect(small.copies.gpu).to.deep.equal({
			sizeBytes: 984_000_000,
			source: QWEN3_1_7B_ID,
			largestBufferBytes: 155_582_464,
		});
		expect(large).to.include({engine: "llm", family: "llm"});
		expect(large.copies.gpu).to.deep.equal({
			sizeBytes: 2_280_000_000,
			source: QWEN3_4B_ID,
			largestBufferBytes: 194_478_080,
		});
		expect(llmName(small)).to.equal("Qwen3 1.7B");
		expect(llmName(large)).to.equal("Qwen3 4B");
		expect(small.label).to.deep.equal({kind: "llm", name: "Qwen3 1.7B"});
		expect(small.lib).to.equal(undefined);
	});

	it("defaults from the device's memory when the probe reports it", () => {
		// Chrome clamps maxStorageBufferBindingSize to ~2 GiB on most
		// desktop GPUs, so the buffer rule alone never reaches the 4B there:
		// where `navigator.deviceMemory` answers, that is the better probe.
		const buffer = 2 * 1024 * 1024 * 1024;

		expect(defaultLlmForAdapter({maxBufferBytes: buffer, deviceMemoryGiB: 8})).to.equal(
			QWEN3_4B_ID
		);
		expect(defaultLlmForAdapter({maxBufferBytes: buffer, deviceMemoryGiB: 6})).to.equal(
			QWEN3_4B_ID
		);
		expect(defaultLlmForAdapter({maxBufferBytes: buffer, deviceMemoryGiB: 4})).to.equal(
			QWEN3_1_7B_ID
		);
		// A phone-class report, whatever the adapter claims to address.
		expect(
			defaultLlmForAdapter({maxBufferBytes: 8 * 1024 * 1024 * 1024, deviceMemoryGiB: 2})
		).to.equal(QWEN3_1_7B_ID);
	});

	it("defaults to the 4B only on a computer with the memory, and only what the GPU can bind", () => {
		const MiB = 1024 * 1024;
		const mem = (maxBufferBytes: number, deviceMemoryGiB: number | null, mobile = false) => ({
			maxBufferBytes,
			deviceMemoryGiB,
			mobile,
		});

		// A desktop Chrome adapter (binding clamped near 2 GiB) with 8 GiB.
		expect(defaultLlmForAdapter(mem(2147483644, 8))).to.equal(QWEN3_4B_ID);
		// Not memory enough, or no `deviceMemory` at all (Safari, Firefox):
		// the binding limit is per buffer and says nothing about the total.
		expect(defaultLlmForAdapter(mem(2147483644, 4))).to.equal(QWEN3_1_7B_ID);
		expect(defaultLlmForAdapter(mem(4096 * MiB, null))).to.equal(QWEN3_1_7B_ID);
		// A phone reporting 8 GiB (Chrome's cap) never gets the 4B by default.
		expect(defaultLlmForAdapter(mem(2147483644, 8, true))).to.equal(QWEN3_1_7B_ID);
		// A GPU that binds the 1.7B's embedding but not the 4B's.
		expect(defaultLlmForAdapter(mem(160 * MiB, 16))).to.equal(QWEN3_1_7B_ID);
		// A computer under the test switch's 128 MiB: the 1.7B's small-buffer build.
		expect(defaultLlmForAdapter(mem(128 * MiB, 16))).to.equal(QWEN3_1_7B_ID);
		// Nothing fits, or no probe at all: the shipped default.
		expect(defaultLlmForAdapter(mem(64 * MiB, 16))).to.equal(QWEN3_1_7B_ID);
		expect(defaultLlmForAdapter(null)).to.equal(QWEN3_1_7B_ID);
	});

	it("a model fits when the GPU binds its largest tensor, or its small-buffer build's", () => {
		const MiB = 1024 * 1024;
		const [small, large] = LLM_CHOICES;

		// The tier's floor is the 1.7B's small-buffer build: half its table.
		expect(LLM_MIN_BUFFER_BYTES).to.equal(77_791_232);
		expect(llmFits(small, 155_582_464)).to.equal(true);
		expect(llmFits(small, 128 * MiB)).to.equal(true);
		expect(llmFits(small, 77_791_232)).to.equal(true);
		expect(llmFits(small, 77_791_231)).to.equal(false);
		// The 4B has no small-buffer build.
		expect(large.smallBuffer).to.equal(undefined);
		expect(llmFits(large, 180 * MiB)).to.equal(false);
		expect(llmFits(large, 256 * MiB)).to.equal(true);
		// Only a GPU model has a binding to fit.
		expect(llmFits(buildCatalog().nllb, 0)).to.equal(true);
	});

	it("a choice the GPU cannot bind runs the default; a CPU-only device keeps it", () => {
		const MiB = 1024 * 1024;
		const shipped = buildCatalog();

		expect(
			llmChoice(shipped, QWEN3_4B_ID, {maxBufferBytes: 160 * MiB, deviceMemoryGiB: 16}).id
		).to.equal(QWEN3_1_7B_ID);
		expect(
			llmChoice(shipped, QWEN3_4B_ID, {maxBufferBytes: 256 * MiB, deviceMemoryGiB: 4}).id
		).to.equal(QWEN3_4B_ID);
		// On a cpu-tier device the choice only picks the route table.
		expect(
			llmChoice(shipped, QWEN3_4B_ID, {maxBufferBytes: 0, deviceMemoryGiB: 4, tier: "cpu"}).id
		).to.equal(QWEN3_4B_ID);
	});

	it("an unset choice resolves at read time: the deploy's model, else the adapter's pick", () => {
		const shipped = buildCatalog();
		const gpu = {maxBufferBytes: 4 * 1024 * 1024 * 1024, deviceMemoryGiB: 16};
		const small = {maxBufferBytes: 2 * 1024 * 1024 * 1024, deviceMemoryGiB: 4};

		// Nothing stored and no deploy model: the device decides, and the
		// pick is never written back to the settings (translate/index.ts).
		expect(llmChoice(shipped, "", gpu).id).to.equal(QWEN3_4B_ID);
		expect(llmChoice(shipped, null, small).id).to.equal(QWEN3_1_7B_ID);
		// The capability is not probed yet: the catalog default serves until
		// it lands, and the same call answers anew once it has.
		expect(llmChoice(shipped, "", null).id).to.equal(QWEN3_1_7B_ID);
		expect(llmChoice(shipped, "").id).to.equal(QWEN3_1_7B_ID);
		// A device that found no GPU names no GPU model: the selected model
		// also picks the route table, whose non-LLM entries differ between
		// the two, so a cpu-tier device stays on the catalog default.
		expect(llmChoice(shipped, "", {...gpu, tier: "cpu"}).id).to.equal(QWEN3_1_7B_ID);
		expect(llmChoice(shipped, "", {...gpu, tier: "gpu"}).id).to.equal(QWEN3_4B_ID);
		// A choice the user made outranks the device.
		expect(llmChoice(shipped, QWEN3_1_7B_ID, gpu).id).to.equal(QWEN3_1_7B_ID);
		// So does the deploy's own model — including a deploy that picks the
		// shipped 1.7B on purpose.
		const deploy = buildCatalog({llm: {model: QWEN3_1_7B_ID}});

		expect(llmChoice(deploy, "", gpu).id).to.equal(QWEN3_1_7B_ID);
		expect(selectLlm(shipped, "", gpu).llm.id).to.equal(QWEN3_4B_ID);
	});

	it("the GPU choices carry their graphics-memory requirement", () => {
		const byId = new Map(LLM_CHOICES.map((ref) => [ref.id, ref]));

		expect(byId.get(QWEN3_4B_ID)?.vramBytes).to.be.greaterThan(
			byId.get(QWEN3_1_7B_ID)?.vramBytes ?? 0
		);
		// The 4B's check is the one the default decision makes: above 1 GiB
		// but below a 4 GiB adapter, or the default would never flip.
		expect(byId.get(QWEN3_4B_ID)?.vramBytes).to.be.greaterThan(1024 * 1024 * 1024);
		expect(byId.get(QWEN3_4B_ID)?.vramBytes).to.be.lessThan(4 * 1024 * 1024 * 1024);
	});

	it("selects the chosen GPU model; an id that is no choice selects the default", () => {
		expect(buildCatalog({}, QWEN3_4B_ID).llm.id).to.equal(QWEN3_4B_ID);
		expect(buildCatalog({}, "gone-model-q4f16_1-MLC").llm.id).to.equal(QWEN3_1_7B_ID);
		expect(buildCatalog({}, null).llm.id).to.equal(QWEN3_1_7B_ID);

		const catalog = buildCatalog();
		const large = selectLlm(catalog, QWEN3_4B_ID);

		expect(large.llm.id).to.equal(QWEN3_4B_ID);
		expect(large.llmChoices).to.equal(catalog.llmChoices);
		expect(catalogModels(large).map((m) => m.id)).to.deep.equal(
			catalogModels(catalog).map((m) => m.id)
		);
		expect(selectLlm(catalog, QWEN3_1_7B_ID)).to.equal(catalog);
		expect(llmChoice(large, "nope").id).to.equal(QWEN3_1_7B_ID);
		expect(refFor(large, "llm")?.id).to.equal(QWEN3_4B_ID);
	});

	it("a deploy's own model becomes the default and is added to the choices, with its lib", () => {
		const catalog = buildCatalog({
			llm: {model: "gemma-3-1b-it-q4f16_1-MLC", lib: "https://m.test/gemma.wasm"},
		});

		expect(catalog.llmChoices.map((ref) => ref.id)).to.deep.equal([
			QWEN3_1_7B_ID,
			QWEN3_4B_ID,
			"gemma-3-1b-it-q4f16_1-MLC",
		]);
		expect(catalog.llmDefault).to.equal("gemma-3-1b-it-q4f16_1-MLC");
		expect(catalog.llm.id).to.equal("gemma-3-1b-it-q4f16_1-MLC");
		expect(catalog.llm.lib).to.equal("https://m.test/gemma.wasm");
		// The library is the deploy model's alone.
		expect(catalog.llmChoices.slice(0, 2).every((ref) => ref.lib === undefined)).to.equal(true);
		expect(buildCatalog({llm: {model: "gemma-3-1b-it-q4f16_1-MLC"}}, "stale").llm.id).to.equal(
			"gemma-3-1b-it-q4f16_1-MLC"
		);
		expect(
			buildCatalog({llm: {model: "gemma-3-1b-it-q4f16_1-MLC"}}, QWEN3_4B_ID).llm.id
		).to.equal(QWEN3_4B_ID);
	});

	it("a deploy naming a shipped model makes it the default without a duplicate row", () => {
		const catalog = buildCatalog({llm: {model: QWEN3_4B_ID, lib: "https://m.test/4b.wasm"}});

		expect(catalog.llmChoices.map((ref) => ref.id)).to.deep.equal([QWEN3_1_7B_ID, QWEN3_4B_ID]);
		expect(catalog.llm.id).to.equal(QWEN3_4B_ID);
		expect(catalog.llm.lib).to.equal("https://m.test/4b.wasm");
		expect(catalog.llmChoices[0].lib).to.equal(undefined);
	});

	it("names the candidate a model answers for", () => {
		const catalog = buildCatalog();

		expect(candidateOf(catalog.llm)).to.equal("llm");
		expect(candidateOf(catalog.nllb)).to.equal("nllb");
		expect(candidateOf(catalog.opus["de-en"])).to.equal("opus:de-en");
	});

	it("one model the cache cannot answer for does not empty the list", async () => {
		const api: CacheApi = {
			has(ref) {
				return ref.id === DEFAULT_LLM_ID
					? Promise.reject(new Error(`unknown WebLLM model ${ref.id}`))
					: Promise.resolve(true);
			},
			delete() {
				return Promise.resolve();
			},
		};
		const states = await cacheStates(buildCatalog(), api);
		const copyCount = catalogModels(buildCatalog()).reduce(
			(n, ref) => n + Object.keys(ref.copies).length,
			0
		);

		// One entry per copy.
		expect(states.length).to.equal(copyCount);
		expect(states.find((s) => s.ref.id === DEFAULT_LLM_ID)?.cached).to.equal(false);
		expect(states.filter((s) => s.ref.id !== DEFAULT_LLM_ID).every((s) => s.cached)).to.equal(
			true
		);
	});

	it("asks the cache api about every model", async () => {
		const asked: string[] = [];
		const api: CacheApi = {
			has(ref, device) {
				asked.push(`${ref.id}@${device}`);
				return Promise.resolve(ref.id === DEFAULT_NLLB_ID && device === "cpu");
			},
			delete() {
				return Promise.resolve();
			},
		};
		const states = await cacheStates(buildCatalog({seq2seqGpu: true}), api);

		expect(asked.length).to.equal(states.length);
		// Each copy asked for by its own device, the GPU copy first.
		expect(asked.filter((a) => a.startsWith(`${DEFAULT_NLLB_ID}@`))).to.deep.equal([
			`${DEFAULT_NLLB_ID}@gpu`,
			`${DEFAULT_NLLB_ID}@cpu`,
		]);
		expect(
			states.filter((s) => s.ref.id === DEFAULT_NLLB_ID).map((s) => [s.device, s.cached])
		).to.deep.equal([
			["gpu", false],
			["cpu", true],
		]);
		expect(states.find((s) => s.ref.id === DEFAULT_LLM_ID)?.cached).to.equal(false);

		// The shipped catalog has no GPU copy of NLLB-200 to ask about.
		asked.length = 0;
		await cacheStates(buildCatalog(), api);
		expect(asked.filter((a) => a.startsWith(`${DEFAULT_NLLB_ID}@`))).to.deep.equal([
			`${DEFAULT_NLLB_ID}@cpu`,
		]);
	});
});
