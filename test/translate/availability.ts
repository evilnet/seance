// The one rule for "can this run here, and if not why": models.ts
// `modelBlock` per model, router.ts `explainRoute` per pair and
// `translationBlock` for translation as a whole. Settings, the composer's
// dialog, the panel and the toolbar disable exactly what the router would
// refuse, so the explanation is tested against the router itself.

import {expect} from "chai";
import type {Capability} from "../../client/js/translate/capability";
import {
	APPLE_PAGE_BUDGET_BYTES,
	CPU_LLM_PEAK_BYTES,
	nativeDevice,
	LLM_CHOICES,
	LLM_MIN_BUFFER_BYTES,
	QWEN3_1_7B_ID,
	QWEN3_4B_ID,
	buildCatalog,
	modelBlock,
	selectLlm,
	type DeviceChoices,
	type EngineSwitches,
} from "../../client/js/translate/models";
import {routesFor} from "../../client/js/translate/routes.default";
import {
	explainRoute,
	resolveRoute,
	routeInput,
	translationBlock,
	type RouteTable,
} from "../../client/js/translate/router";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

function cap(overrides: Partial<Capability>): Capability {
	return {
		tier: "gpu",
		reasons: [],
		f16: true,
		maxBufferBytes: 2 * GiB,
		deviceMemoryGiB: 8,
		storageQuotaBytes: null,
		mobile: false,
		...overrides,
	};
}

/** The five devices the browser scenario stubs, and three more the probe can report. */
const DEVICES: Record<string, Capability> = {
	noWebgpu: cap({tier: "cpu", reasons: ["NO_WEBGPU"], f16: false, maxBufferBytes: 0}),
	noF16: cap({tier: "cpu", reasons: ["NO_F16"], f16: false}),
	// A phone: WebGPU's 128 MiB floor, which the 1.7B's small-buffer build fits.
	binds128: cap({maxBufferBytes: 128 * MiB}),
	// Below even the small-buffer build (no WebGPU device is: its floor is
	// 128 MiB), so the tier is cpu and every GPU row says what it needs.
	binds64: cap({tier: "cpu", reasons: ["SMALL_BUFFER"], maxBufferBytes: 64 * MiB}),
	binds160: cap({maxBufferBytes: 160 * MiB}),
	desktop: cap({}),
	noSimd: cap({
		tier: "none",
		reasons: ["NO_WEBGPU", "NO_WASM_SIMD"],
		f16: false,
		maxBufferBytes: 0,
	}),
	probeFailed: cap({tier: "none", reasons: ["PROBE_FAILED"], f16: false, maxBufferBytes: 0}),
};

const on: EngineSwitches = {llm: true, opus: true, nllb: true};
const AUTO: DeviceChoices = {llm: "auto", opus: "auto", nllb: "auto"};

const small = LLM_CHOICES.find((ref) => ref.id === QWEN3_1_7B_ID)!;
const large = LLM_CHOICES.find((ref) => ref.id === QWEN3_4B_ID)!;
const base = buildCatalog();
const nllb = base.nllb;

// The pair rows the shipped table has in kind: a pair both engines serve,
// one only the LLM does (a language NLLB measured badly in), and one where
// an OPUS pair shares the LLM's class.
const table: RouteTable = {
	"*": {"*": ["llm", "nllb"]},
	en: {"*": ["llm", "nllb"], de: [["llm", "opus:de-en"], "nllb"]},
	fil: {"*": ["llm"]},
};

describe("translate availability", () => {
	describe("modelBlock", () => {
		it("is probing until the probe answers, and disabled on a deploy that switched it off", () => {
			expect(modelBlock(small, "gpu", null, on)).to.deep.equal({kind: "probing"});
			expect(modelBlock(nllb, "cpu", DEVICES.desktop, on, false)).to.deep.equal({
				kind: "disabled",
			});
		});

		it("lets every model run on a desktop GPU with both switches on", () => {
			for (const ref of [small, large, nllb, base.opus["de-en"]]) {
				expect(modelBlock(ref, nativeDevice(ref), DEVICES.desktop, on), ref.id).to.equal(
					null
				);
			}
		});

		it("names the device code for a GPU model, never the buffer when f16 is missing", () => {
			expect(modelBlock(small, "gpu", DEVICES.noWebgpu, on)).to.deep.equal({
				kind: "device",
				reason: "NO_WEBGPU",
			});
			expect(modelBlock(large, "gpu", DEVICES.noF16, on)).to.deep.equal({
				kind: "device",
				reason: "NO_F16",
			});
			expect(
				modelBlock(small, "gpu", cap({tier: "cpu", reasons: ["INSECURE_ORIGIN"]}), on)
			).to.deep.equal({kind: "device", reason: "INSECURE_ORIGIN"});
			expect(modelBlock(small, "gpu", DEVICES.probeFailed, on)).to.deep.equal({
				kind: "device",
				reason: "PROBE_FAILED",
			});
		});

		it("a GPU copy of OPUS-MT needs WebAssembly SIMD", () => {
			const opus = base.opus["de-en"];

			expect(modelBlock(opus, "gpu", cap({reasons: ["NO_WASM_SIMD"]}), on)).to.deep.equal({
				kind: "device",
				reason: "NO_WASM_SIMD",
			});
		});

		it("gives each GPU model its own buffer numbers, on a cpu-tier device too", () => {
			// 64 MiB: the tier is cpu (SMALL_BUFFER), and both rows still say
			// what they need: the 1.7B its small-buffer build's need.
			expect(modelBlock(small, "gpu", DEVICES.binds64, on)).to.deep.equal({
				kind: "buffer",
				needed: small.smallBuffer!.largestBufferBytes,
				limit: 64 * MiB,
			});
			expect(modelBlock(large, "gpu", DEVICES.binds64, on)).to.deep.equal({
				kind: "buffer",
				needed: large.copies.gpu!.largestBufferBytes,
				limit: 64 * MiB,
			});
			// 128 MiB, a phone: the 1.7B runs as its small-buffer build; the
			// 4B has none and says what it needs.
			expect(modelBlock(small, "gpu", DEVICES.binds128, on)).to.equal(null);
			expect(modelBlock(large, "gpu", DEVICES.binds128, on)).to.deep.equal({
				kind: "buffer",
				needed: large.copies.gpu!.largestBufferBytes,
				limit: 128 * MiB,
			});
			// 160 MiB: the 1.7B fits, the 4B does not.
			expect(modelBlock(small, "gpu", DEVICES.binds160, on)).to.equal(null);
			expect(modelBlock(large, "gpu", DEVICES.binds160, on)).to.deep.equal({
				kind: "buffer",
				needed: large.copies.gpu!.largestBufferBytes,
				limit: 160 * MiB,
			});
		});

		it("holds a deploy model of unknown size to the gpu tier's floor", () => {
			const deploy = buildCatalog({llm: {model: "Custom-q4f16_1-MLC"}}).llm;

			expect(modelBlock(deploy, "gpu", DEVICES.binds160, on)).to.equal(null);
			expect(modelBlock(deploy, "gpu", DEVICES.binds64, on)).to.deep.equal({
				kind: "buffer",
				needed: LLM_MIN_BUFFER_BYTES,
				limit: 64 * MiB,
			});
		});

		it("says switched off only for a model the device could run", () => {
			const off = {llm: false, opus: false, nllb: true};

			expect(modelBlock(small, "gpu", DEVICES.desktop, off)).to.deep.equal({
				kind: "off",
				engine: "llm",
			});
			expect(modelBlock(base.opus["de-en"], "cpu", DEVICES.desktop, off)).to.deep.equal({
				kind: "off",
				engine: "opus",
			});
			// Turning the switch on would change nothing: the device is the reason.
			expect(modelBlock(small, "gpu", DEVICES.noWebgpu, off).kind).to.equal("device");
			expect(modelBlock(large, "gpu", DEVICES.binds160, off).kind).to.equal("buffer");
			expect(modelBlock(nllb, "cpu", DEVICES.noSimd, off)).to.deep.equal({
				kind: "device",
				reason: "NO_WASM_SIMD",
			});
		});

		describe("per device", () => {
			const opus = base.opus["de-en"];
			const all = {llm: true, opus: true, nllb: true};
			// The seq2seq GPU copies are off in the shipped catalog (models.ts
			// CatalogOptions `seq2seqGpu`); their rules are tested with them on.
			const withGpu = buildCatalog({seq2seqGpu: true});
			const gpuOpus = withGpu.opus["de-en"];
			const gpuNllb = withGpu.nllb;

			it("the language model on the CPU needs Memory64", () => {
				const noMemory64 = cap({reasons: ["NO_MEMORY64"]});

				expect(modelBlock(small, "cpu", noMemory64, all)).to.deep.equal({
					kind: "device",
					reason: "NO_MEMORY64",
				});
				// The seq2seq models do not, on either device; nor does the GPU.
				expect(modelBlock(opus, "cpu", noMemory64, all)).to.equal(null);
				expect(modelBlock(nllb, "cpu", noMemory64, all)).to.equal(null);
				expect(modelBlock(gpuOpus, "gpu", noMemory64, all)).to.equal(null);
				expect(modelBlock(small, "gpu", noMemory64, all)).to.equal(null);
				// No SIMD is still said first.
				expect(
					modelBlock(small, "cpu", cap({reasons: ["NO_WASM_SIMD", "NO_MEMORY64"]}), all)
				).to.deep.equal({kind: "device", reason: "NO_WASM_SIMD"});
			});

			it("gives the 4B no CPU copy on any device", () => {
				for (const device of Object.values(DEVICES)) {
					if (
						device.reasons.includes("NO_WASM_SIMD") ||
						device.reasons.includes("PROBE_FAILED")
					) {
						continue;
					}

					expect(modelBlock(large, "cpu", device, all)).to.deep.equal({
						kind: "noCopy",
						device: "cpu",
					});
				}
			});

			it("runs the 1.7B on the CPU with no WebGPU", () => {
				expect(modelBlock(small, "cpu", DEVICES.noWebgpu, all)).to.equal(null);
				expect(
					modelBlock(small, "cpu", DEVICES.noWebgpu, {...all, llm: false})
				).to.deep.equal({
					kind: "off",
					engine: "llm",
				});
			});

			it("keeps the 1.7B's CPU copy off an iPhone or iPad", () => {
				const apple = cap({appleMobile: true, mobile: true});

				expect(modelBlock(small, "cpu", apple, all)).to.deep.equal({
					kind: "memory",
					needed: CPU_LLM_PEAK_BYTES,
				});
				expect(CPU_LLM_PEAK_BYTES).to.be.above(APPLE_PAGE_BUDGET_BYTES);
				expect(modelBlock(small, "cpu", cap({mobile: true}), all)).to.equal(null);
				expect(modelBlock(opus, "cpu", apple, all)).to.equal(null);
			});

			it("holds NLLB's GPU copy to the binding, an f16 device and the probe's codes", () => {
				expect(modelBlock(gpuNllb, "gpu", DEVICES.binds128, all)).to.deep.equal({
					kind: "buffer",
					needed: 524_709_888,
					limit: 134_217_728,
				});
				expect(
					modelBlock(gpuNllb, "gpu", cap({f16: false, maxBufferBytes: GiB}), all)
				).to.deep.equal({
					kind: "device",
					reason: "NO_F16",
				});
				expect(modelBlock(gpuNllb, "gpu", DEVICES.noWebgpu, all)).to.deep.equal({
					kind: "device",
					reason: "NO_WEBGPU",
				});
				// WebLLM's shader floors are the language model's rule alone.
				expect(
					modelBlock(
						gpuNllb,
						"gpu",
						cap({reasons: ["GPU_LIMITS"], tier: "cpu", maxBufferBytes: GiB}),
						all
					)
				).to.equal(null);
			});

			it("runs OPUS-MT on a GPU with f16 and a 1 GiB binding", () => {
				expect(modelBlock(gpuOpus, "gpu", cap({maxBufferBytes: GiB}), all)).to.equal(null);
			});

			it("has no GPU copy of OPUS-MT or NLLB-200 in the shipped catalog", () => {
				// A 1 GiB desktop with f16 that would run either copy (above).
				const desktop = cap({maxBufferBytes: GiB});

				for (const ref of [opus, nllb]) {
					expect(ref.copies.gpu, ref.id).to.equal(undefined);
					expect(modelBlock(ref, "gpu", desktop, all), ref.id).to.deep.equal({
						kind: "noCopy",
						device: "gpu",
					});
					expect(modelBlock(ref, "cpu", desktop, all), ref.id).to.equal(null);
				}
			});

			it("gates each of OPUS-MT and NLLB by its own switch", () => {
				expect(
					modelBlock(opus, "cpu", DEVICES.desktop, {...all, opus: false})
				).to.deep.equal({
					kind: "off",
					engine: "opus",
				});
				expect(
					modelBlock(nllb, "cpu", DEVICES.desktop, {llm: true, opus: false, nllb: true})
				).to.equal(null);
				expect(
					modelBlock(nllb, "cpu", DEVICES.desktop, {llm: true, opus: true, nllb: false})
				).to.deep.equal({kind: "off", engine: "nllb"});
			});
		});

		it("blocks the CPU models without WebAssembly SIMD even on a gpu-tier device", () => {
			const gpuNoSimd = cap({reasons: ["NO_WASM_SIMD"]});

			expect(modelBlock(nllb, "cpu", gpuNoSimd, on)).to.deep.equal({
				kind: "device",
				reason: "NO_WASM_SIMD",
			});
			expect(modelBlock(small, "gpu", gpuNoSimd, on)).to.equal(null);
		});
	});

	describe("explainRoute", () => {
		const catalogFor = (capability: Capability) => selectLlm(base, null, capability);
		const ask = (
			capability: Capability,
			switches: EngineSwitches,
			from: string | null,
			to: string,
			sourceLater = false
		) =>
			explainRoute(
				table,
				catalogFor(capability),
				routeInput(capability, switches, AUTO, {from, to, sourceLater})
			);

		it("agrees with resolveRoute everywhere, and gives a reason exactly when there is no route", () => {
			const switchSets: EngineSwitches[] = [
				{llm: true, opus: true, nllb: true},
				{llm: true, opus: false, nllb: true},
				{llm: false, opus: true, nllb: true},
				{llm: false, opus: false, nllb: true},
				// NLLB-200 off (the default): the OPUS pairs and the LLM only.
				{llm: true, opus: true, nllb: false},
				{llm: false, opus: true, nllb: false},
				{llm: true, opus: false, nllb: false},
			];
			const pairs: [string | null, string][] = [
				["de", "en"],
				["fr", "en"],
				["en", "en"],
				["en", "fil"],
				// No OPUS-MT pair: the GPU model or NLLB-200.
				["en", "ja"],
				[null, "en"],
				[null, "fil"],
			];

			// Auto, and every model pinned to each device.
			const deviceSets: DeviceChoices[] = [
				AUTO,
				{llm: "gpu", opus: "gpu", nllb: "gpu"},
				{llm: "cpu", opus: "cpu", nllb: "cpu"},
			];

			for (const [name, capability] of Object.entries(DEVICES)) {
				for (const devices of deviceSets) {
					for (const switches of switchSets) {
						for (const [from, to] of pairs) {
							for (const sourceLater of [false, true]) {
								const input = routeInput(capability, switches, devices, {
									from,
									to,
									sourceLater,
								});
								const catalog = selectLlm(base, null, capability, devices.llm);
								const verdict = explainRoute(table, catalog, input);
								const label = `${name} ${JSON.stringify(devices)} ${JSON.stringify(
									switches
								)} ${from}->${to} ${sourceLater}`;

								expect(verdict.route, label).to.deep.equal(
									resolveRoute(table, catalog, input)
								);

								// A pair that routes means translation is there at all.
								if (verdict.route) {
									expect(
										translationBlock(catalog, capability, switches, devices),
										label
									).to.equal(null);
								}

								expect(verdict.why === null, label).to.equal(
									verdict.route !== null
								);
								expect(verdict.polish, label).to.equal(from === to);

								// A switch named as the reason is a real fix: turned on,
								// the pair routes or a different reason takes over.
								if (verdict.why?.kind === "off" && verdict.why.engine !== "all") {
									const engine = verdict.why.engine;
									// "llmOrNllb" names two ways in: each must be one.
									const fixes =
										engine === "llm"
											? [{...switches, llm: true}]
											: engine === "nllb"
											? [{...switches, nllb: true}]
											: engine === "llmOrNllb"
											? [
													{...switches, llm: true},
													{...switches, nllb: true},
											  ]
											: [{...switches, opus: true}];

									for (const fixed of fixes) {
										const after = explainRoute(
											table,
											catalog,
											routeInput(capability, fixed, devices, {
												from,
												to,
												sourceLater,
											})
										);

										// Or another reason takes over.
										expect(
											after.route !== null ||
												after.why?.kind !== "off" ||
												after.why.engine !== engine,
											`${label} fixed by ${JSON.stringify(fixed)}`
										).to.equal(true);
									}
								}
							}
						}
					}
				}
			}
		});

		it("explains the cleanup pass by the GPU model's own block", () => {
			const binds64 = ask(DEVICES.binds64, on, "en", "en");

			expect(binds64.route).to.equal(null);
			expect(binds64.polish).to.equal(true);
			expect(binds64.why).to.deep.equal({
				kind: "buffer",
				needed: small.smallBuffer!.largestBufferBytes,
				limit: 64 * MiB,
			});
			// A phone's 128 MiB runs the 1.7B's small-buffer build: on offer.
			expect(ask(DEVICES.binds128, on, "en", "en").route?.ref.id).to.equal(QWEN3_1_7B_ID);
			expect(ask(DEVICES.noF16, on, "en", "en").why).to.deep.equal({
				kind: "device",
				reason: "NO_F16",
			});
			expect(ask(DEVICES.noWebgpu, on, "en", "en").why).to.deep.equal({
				kind: "device",
				reason: "NO_WEBGPU",
			});
			expect(
				ask(DEVICES.desktop, {llm: false, opus: true, nllb: true}, "en", "en").why
			).to.deep.equal({
				kind: "off",
				engine: "llm",
			});
			// 160 MiB runs the 1.7B: the cleanup pass is on offer.
			expect(ask(DEVICES.binds160, on, "en", "en").route?.ref.id).to.equal(QWEN3_1_7B_ID);
		});

		it("names the switch the user can turn on over a device the GPU model cannot use", () => {
			// CPU-only device, OPUS-MT and NLLB-200 off: the LLM cannot run
			// here anyway, so the fix is OPUS-MT's switch (the pair's own).
			expect(
				ask(DEVICES.noWebgpu, {llm: true, opus: false, nllb: false}, "de", "en").why
			).to.deep.equal({
				kind: "off",
				engine: "opus",
			});
		});

		it("names both switches when either would serve the pair", () => {
			expect(
				ask(DEVICES.desktop, {llm: false, opus: false, nllb: false}, "de", "en").why
			).to.deep.equal({
				kind: "off",
				engine: "all",
			});
			// NLLB-200 has its own switch: on, it serves the pair alone.
			expect(
				ask(DEVICES.desktop, {llm: false, opus: false, nllb: true}, "de", "en").route
					?.candidate
			).to.equal("nllb");
			// Only the LLM serves Filipino: its switch alone is named.
			expect(
				ask(DEVICES.desktop, {llm: false, opus: false, nllb: true}, "en", "fil").why
			).to.deep.equal({
				kind: "off",
				engine: "llm",
			});
		});

		it("explains an LLM-only pair on a device without the GPU model by the device", () => {
			expect(ask(DEVICES.binds64, on, "en", "fil").why).to.deep.equal({
				kind: "buffer",
				needed: small.smallBuffer!.largestBufferBytes,
				limit: 64 * MiB,
			});
			expect(ask(DEVICES.desktop, on, "en", "fil").route?.candidate).to.equal("llm");
		});

		it("counts the CPU models for a line the detector will place, and only then", () => {
			expect(ask(DEVICES.noWebgpu, on, null, "en", true).route?.candidate).to.equal("nllb");
			// A request with no source at all: only the LLM takes one, and it is
			// the device that keeps it out, so that is what is said.
			expect(ask(DEVICES.noWebgpu, on, null, "en", false).why).to.deep.equal({
				kind: "device",
				reason: "NO_WEBGPU",
			});
			expect(
				ask(DEVICES.noWebgpu, {llm: false, opus: true, nllb: true}, null, "en", false).why
			).to.deep.equal({kind: "device", reason: "NO_WEBGPU"});
		});

		describe("NLLB-200 switched off (the default; its licence is non-commercial)", () => {
			const noNllb: EngineSwitches = {llm: true, opus: true, nllb: false};
			// The shipped table: the OPUS pairs ahead of NLLB everywhere.
			const shipped = routesFor(QWEN3_1_7B_ID);
			const askShipped = (capability: Capability, from: string | null, to: string) =>
				explainRoute(
					shipped,
					catalogFor(capability),
					routeInput(capability, noNllb, AUTO, {from, to})
				);

			it("blocks the NLLB row as switched off, and only that one", () => {
				expect(modelBlock(nllb, "cpu", DEVICES.desktop, noNllb)).to.deep.equal({
					kind: "off",
					engine: "nllb",
				});
				expect(modelBlock(base.opus["de-en"], "cpu", DEVICES.desktop, noNllb)).to.equal(
					null
				);
				expect(modelBlock(small, "gpu", DEVICES.desktop, noNllb)).to.equal(null);
			});

			it("gives a pair only NLLB serves here the NLLB reason", () => {
				// No WebGPU, English to Filipino: no OPUS pair, the LLM cannot run.
				expect(askShipped(DEVICES.noWebgpu, "en", "fil").why).to.deep.equal({
					kind: "off",
					engine: "nllb",
				});
				// And it is a real fix: switched on, NLLB takes it.
				expect(
					explainRoute(
						shipped,
						catalogFor(DEVICES.noWebgpu),
						routeInput(DEVICES.noWebgpu, {...noNllb, nllb: true}, AUTO, {
							from: "en",
							to: "fil",
						})
					).route?.candidate
				).to.equal("nllb");
			});

			it("sends an NLLB-first pair to the GPU model where it runs", () => {
				// Serbian is NLLB-first for 1.7B (routes.default.ts).
				expect(askShipped(DEVICES.desktop, "en", "sr").route?.candidate).to.equal("llm");
			});

			it("still translates the OPUS-MT pairs on a device without WebGPU", () => {
				for (const pair of Object.keys(base.opus)) {
					const [from, to] = pair.split("-");

					expect(askShipped(DEVICES.noWebgpu, from, to).route?.candidate, pair).to.equal(
						`opus:${pair}`
					);
				}
			});

			it("never makes translation as a whole unavailable", () => {
				expect(translationBlock(base, DEVICES.noWebgpu, noNllb, AUTO)).to.equal(null);
				expect(translationBlock(base, DEVICES.desktop, noNllb, AUTO)).to.equal(null);
			});
		});

		it("explains a device that runs nothing by the CPU models' code", () => {
			expect(ask(DEVICES.noSimd, on, "de", "en").why).to.deep.equal({
				kind: "device",
				reason: "NO_WASM_SIMD",
			});
			expect(ask(DEVICES.probeFailed, on, "de", "en").why).to.deep.equal({
				kind: "device",
				reason: "PROBE_FAILED",
			});
		});

		it("skips the CPU copies on a gpu-tier device without WebAssembly SIMD", () => {
			const gpuNoSimd = cap({reasons: ["NO_WASM_SIMD"]});
			const nllbOnly: RouteTable = {"*": {"*": ["nllb"]}};
			const pinnedCpu = explainRoute(
				nllbOnly,
				base,
				routeInput(gpuNoSimd, on, {...AUTO, nllb: "cpu"}, {from: "de", to: "en"})
			);

			expect(pinnedCpu.route).to.equal(null);
			expect(pinnedCpu.why).to.deep.equal({kind: "device", reason: "NO_WASM_SIMD"});
			// Its GPU copy runs inside onnxruntime-web's SIMD build, so Auto has nothing either.
			const auto = explainRoute(
				nllbOnly,
				base,
				routeInput(gpuNoSimd, on, AUTO, {from: "de", to: "en"})
			);

			expect(auto.route).to.equal(null);
		});

		it("reports a candidate down for the session once nothing else serves", () => {
			const verdict = explainRoute(
				table,
				base,
				routeInput(
					DEVICES.desktop,
					on,
					AUTO,
					{from: "en", to: "fil"},
					new Set(["llm@gpu" as const])
				)
			);

			expect(verdict.why).to.deep.equal({kind: "down"});
		});

		it("reads the tier off the probe and carries the probe; an unknown probe routes nothing", () => {
			const input = routeInput(DEVICES.noSimd, on, AUTO, {from: "de", to: "en"});

			expect(input.tier).to.equal("none");
			expect(input.capability).to.equal(DEVICES.noSimd);
			expect(routeInput(null, on, AUTO, {from: "de", to: "en"}).tier).to.equal("none");
		});
	});

	describe("translationBlock", () => {
		const block = (capability: Capability | null, switches: EngineSwitches, enabled = true) =>
			translationBlock(
				selectLlm(base, null, capability),
				capability,
				switches,
				AUTO,
				enabled
			);

		it("is null while either engine runs", () => {
			expect(block(DEVICES.desktop, on)).to.equal(null);
			expect(block(DEVICES.desktop, {llm: false, opus: true, nllb: true})).to.equal(null);
			expect(block(DEVICES.desktop, {llm: true, opus: false, nllb: true})).to.equal(null);
			expect(block(DEVICES.noWebgpu, {llm: true, opus: true, nllb: true})).to.equal(null);
		});

		it("says both switches are off as one reason", () => {
			expect(block(DEVICES.desktop, {llm: false, opus: false, nllb: false})).to.deep.equal({
				kind: "off",
				engine: "all",
			});
		});

		it("counts NLLB-200 as a way in while it is switched on", () => {
			// It needs no other switch: on, translation is there.
			expect(block(DEVICES.desktop, {llm: false, opus: false, nllb: true})).to.equal(null);
			expect(block(DEVICES.noWebgpu, {llm: true, opus: false, nllb: true})).to.equal(null);
			expect(block(DEVICES.binds64, {llm: false, opus: false, nllb: true})).to.equal(null);
		});

		it("names the switch that would fix it on a device without the GPU model", () => {
			expect(block(DEVICES.noWebgpu, {llm: true, opus: false, nllb: false})).to.deep.equal({
				kind: "off",
				engine: "opus",
			});
			expect(block(DEVICES.binds64, {llm: false, opus: false, nllb: false})).to.deep.equal({
				kind: "off",
				engine: "opus",
			});
			// A phone runs the 1.7B's small-buffer build: either switch would serve.
			expect(block(DEVICES.binds128, {llm: false, opus: false, nllb: false})).to.deep.equal({
				kind: "off",
				engine: "all",
			});
		});

		it("names the device when nothing could run however the switches stand", () => {
			expect(block(DEVICES.noSimd, on)).to.deep.equal({
				kind: "device",
				reason: "NO_WASM_SIMD",
			});
			expect(block(null, on)).to.deep.equal({kind: "probing"});
			expect(block(DEVICES.desktop, on, false)).to.deep.equal({kind: "disabled"});
		});
	});
});
