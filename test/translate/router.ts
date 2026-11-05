import {expect} from "chai";
import type {Capability, Tier} from "../../client/js/translate/capability";
import type {Device, ModelRef} from "../../client/js/translate/engine";
import {
	QWEN3_1_7B_ID,
	QWEN3_4B_ID,
	buildCatalog,
	type Candidate,
	selectLlm,
	type DeviceChoices,
	type EngineSwitches,
} from "../../client/js/translate/models";
import {
	candidatesFor,
	classesOf,
	explainRoute,
	mergeRoutes,
	resolveRoute,
	type RouteInput,
	type RouteTable,
} from "../../client/js/translate/router";
import {
	DEFAULT_ROUTES,
	LIMITED_LANGUAGES,
	NLLB_FIRST,
	NLLB_TIED,
	isLimitedLanguage,
	routesFor,
} from "../../client/js/translate/routes.default";
import {nllbCode} from "../../client/js/translate/languages";

// OPUS-MT and NLLB-200 with their GPU copies (off in the shipped catalog,
// models.ts CatalogOptions `seq2seqGpu`), so the per-device logic is covered.
const catalog = buildCatalog({seq2seqGpu: true});
const table: RouteTable = {
	"*": {"*": ["llm", "nllb"], sw: ["nllb", "llm"]},
	en: {
		"*": ["llm", "nllb"],
		// The LLM and the OPUS pair are one class, NLLB the next.
		de: [["llm", "opus:de-en"], "nllb"],
		// A strict order: NLLB, then the LLM.
		sw: ["nllb", "llm"],
	},
};

const AUTO: DeviceChoices = {llm: "auto", opus: "auto", nllb: "auto"};

/**
 * The probe a bare tier stands for: a computer whose GPU runs everything
 * (f16, Chrome's ~2 GiB binding), a device without WebGPU, or one without
 * WebAssembly SIMD either.
 */
function capabilityFor(tier: Tier): Capability {
	return {
		tier,
		reasons:
			tier === "gpu" ? [] : tier === "cpu" ? ["NO_WEBGPU"] : ["NO_WEBGPU", "NO_WASM_SIMD"],
		f16: tier === "gpu",
		maxBufferBytes: tier === "gpu" ? 2 * 1024 * 1024 * 1024 : 0,
		deviceMemoryGiB: 8,
		storageQuotaBytes: null,
		mobile: false,
	};
}

type Overrides = Omit<Partial<RouteInput>, "switches" | "devices"> & {
	switches?: Partial<EngineSwitches>;
	devices?: Partial<DeviceChoices>;
};

function input(overrides: Overrides = {}): RouteInput {
	const {switches, devices, ...rest} = overrides;
	const tier = overrides.tier ?? "gpu";

	return {
		from: "de",
		hint: null,
		to: "en",
		tier,
		switches: {llm: true, opus: true, nllb: true, ...switches},
		devices: {...AUTO, ...devices},
		down: new Set(),
		capability: capabilityFor(tier),
		...rest,
	};
}

/** Both copies of a candidate marked down. */
const downBoth = (candidate: Candidate) =>
	new Set([`${candidate}@gpu`, `${candidate}@cpu`] as const);

const isCached = (id: string, device?: Device) => (ref: ModelRef, on: Device) =>
	ref.id === id && (device === undefined || on === device);

describe("translate/router", () => {
	it("reads a bare candidate as a class of one and a list as one class", () => {
		expect(classesOf(["llm", "nllb"])).to.deep.equal([["llm"], ["nllb"]]);
		expect(classesOf([["llm", "opus:de-en"], "nllb", []])).to.deep.equal([
			["llm", "opus:de-en"],
			["nllb"],
		]);
	});

	it("looks up the exact pair, the target's wildcard, the source's row, then the global one", () => {
		expect(candidatesFor(table, "de", "en")).to.deep.equal([["llm", "opus:de-en"], ["nllb"]]);
		expect(candidatesFor(table, "fr", "en")).to.deep.equal([["llm"], ["nllb"]]);
		expect(candidatesFor(table, "en", "de")).to.deep.equal([["llm"], ["nllb"]]);
		// No row for the target: the wildcard target's row for the source.
		expect(candidatesFor(table, "sw", "pt")).to.deep.equal([["nllb"], ["llm"]]);
		expect(candidatesFor({}, "en", "de")).to.deep.equal([]);
	});

	it("routes a same-language request to the LLM alone", () => {
		// The composer's cleanup pass: English corrected in English.
		expect(resolveRoute(table, catalog, input({from: "en", to: "en"}))?.candidate).to.equal(
			"llm"
		);
		expect(resolveRoute(table, catalog, input({from: "en", to: "en", tier: "cpu"}))).to.equal(
			null
		);
		expect(
			resolveRoute(table, catalog, input({from: "en", to: "en", switches: {llm: false}}))
		).to.equal(null);
		expect(
			resolveRoute(table, catalog, input({from: "en", to: "en", down: new Set(["llm@gpu"])}))
		).to.equal(null);
		// The hint counts as the source here too.
		expect(
			resolveRoute(table, catalog, input({from: null, hint: "en", to: "en"}))?.candidate
		).to.equal("llm");
	});

	it("takes the first class with a candidate the device, the settings and the session allow", () => {
		expect(resolveRoute(table, catalog, input())?.candidate).to.equal("llm");
		expect(resolveRoute(table, catalog, input({tier: "cpu"}))?.candidate).to.equal(
			"opus:de-en"
		);
		expect(resolveRoute(table, catalog, input({switches: {llm: false}}))?.candidate).to.equal(
			"opus:de-en"
		);
		expect(
			resolveRoute(table, catalog, input({tier: "cpu", down: new Set(["opus:de-en@cpu"])}))
				?.candidate
		).to.equal("nllb");
		// NLLB-200 has its own switch: OPUS-MT's off leaves it serving.
		expect(
			resolveRoute(table, catalog, input({tier: "cpu", switches: {opus: false}}))?.candidate
		).to.equal("nllb");
		expect(
			resolveRoute(table, catalog, input({tier: "cpu", switches: {opus: false, nllb: false}}))
		).to.equal(null);
		expect(resolveRoute(table, catalog, input({tier: "none"}))).to.equal(null);
	});

	it("skips the seq2seq candidates when neither a source nor a hint is known", () => {
		expect(resolveRoute(table, catalog, input({from: null, tier: "cpu"}))).to.equal(null);
		expect(resolveRoute(table, catalog, input({from: null}))?.candidate).to.equal("llm");
	});

	it("takes the source hint for the table row and for a seq2seq candidate's source", () => {
		// A draft left to the model, the detector's weak verdict Swahili: the
		// Swahili row, whose best class is NLLB.
		expect(resolveRoute(table, catalog, input({from: null, hint: "sw"}))?.candidate).to.equal(
			"nllb"
		);
		// On a CPU-only device the hint is what lets the OPUS pair run at all.
		expect(
			resolveRoute(table, catalog, input({from: null, hint: "de", tier: "cpu"}))?.candidate
		).to.equal("opus:de-en");
		// A named source wins over the hint.
		expect(
			resolveRoute(table, catalog, input({from: "de", hint: "sw", tier: "cpu"}))?.candidate
		).to.equal("opus:de-en");
	});

	it("prefers a downloaded candidate inside its class", () => {
		// llm is first in the class and allowed, but the OPUS pair of the same
		// class is downloaded: taking llm would wait for a download for no
		// better a translation.
		expect(
			resolveRoute(table, catalog, input({cached: isCached(catalog.opus["de-en"].id)}))
				?.candidate
		).to.equal("opus:de-en");

		// Nothing cached, or nothing to ask: the class's order stands.
		expect(resolveRoute(table, catalog, input({cached: () => false}))?.candidate).to.equal(
			"llm"
		);
		expect(resolveRoute(table, catalog, input())?.candidate).to.equal("llm");
	});

	it("never skips a better class for a downloaded model in a worse one", () => {
		// Swahili: NLLB strictly first. A downloaded LLM does not take it.
		expect(
			resolveRoute(table, catalog, input({from: "sw", cached: isCached(catalog.llm.id)}))
				?.candidate
		).to.equal("nllb");
		// de→en: NLLB is a worse class than the LLM, downloaded or not.
		expect(
			resolveRoute(table, catalog, input({cached: isCached(catalog.nllb.id)}))?.candidate
		).to.equal("llm");
		// The better class unusable (NLLB-200 switched off): the next class.
		expect(
			resolveRoute(
				table,
				catalog,
				input({from: "sw", switches: {nllb: false}, cached: isCached(catalog.llm.id)})
			)?.candidate
		).to.equal("llm");
	});

	it("never picks a candidate that is down or disallowed, cached or not", () => {
		const cachedOpus = isCached(catalog.opus["de-en"].id);

		expect(
			resolveRoute(table, catalog, input({cached: cachedOpus, down: downBoth("opus:de-en")}))
				?.candidate
		).to.equal("llm");
		// A downloaded LLM on a device that cannot run it stays unrouted.
		expect(
			resolveRoute(table, catalog, input({tier: "cpu", cached: isCached(catalog.llm.id)}))
				?.candidate
		).to.equal("opus:de-en");
		// A down best class falls to the next one.
		expect(
			resolveRoute(table, catalog, input({from: "sw", down: downBoth("nllb")}))?.candidate
		).to.equal("llm");
	});

	it("passes over a candidate whose download is refused, naming its model", () => {
		const refuseAll = () => true;
		// Nothing may be downloaded and nothing is: no route, the best class's model named.
		const none = explainRoute(table, catalog, input({refuse: refuseAll}));

		expect(none.route).to.equal(null);
		expect(none.why).to.deep.equal({kind: "download", ref: catalog.llm, device: "gpu"});
		// What is on the device still runs.
		expect(
			resolveRoute(
				table,
				catalog,
				input({
					cached: isCached(catalog.nllb.id),
					refuse: (ref) => ref.id !== catalog.nllb.id,
				})
			)?.candidate
		).to.equal("nllb");
		// A switch the user turned off outranks it as the reason.
		expect(
			explainRoute(
				table,
				catalog,
				input({switches: {llm: false, opus: false}, refuse: refuseAll})
			).why
		).to.deep.equal({kind: "off", engine: "all"});
	});

	it("names both ways in when the GPU model and NLLB-200 are both off", () => {
		// English -> Japanese has no OPUS-MT pair: the GPU model or NLLB-200.
		const enJa = {from: "en", to: "ja"};

		expect(
			explainRoute(table, catalog, input({...enJa, switches: {llm: false, nllb: false}})).why
		).to.deep.equal({kind: "off", engine: "llmOrNllb"});
		// Either switch alone is a way in.
		expect(
			resolveRoute(table, catalog, input({...enJa, switches: {llm: false}}))?.candidate
		).to.equal("nllb");
		expect(
			resolveRoute(table, catalog, input({...enJa, switches: {nllb: false}}))?.candidate
		).to.equal("llm");
		// OPUS-MT's switch serves no part of this pair, so it is not named.
		expect(
			explainRoute(
				table,
				catalog,
				input({...enJa, switches: {llm: false, nllb: false, opus: false}})
			).why
		).to.deep.equal({kind: "off", engine: "llmOrNllb"});
		// A pair OPUS-MT serves never needs either.
		expect(
			resolveRoute(
				table,
				catalog,
				input({from: "de", to: "en", switches: {llm: false, nllb: false}})
			)?.candidate
		).to.match(/^opus:/);
	});

	it("passes over NLLB-200 until it is switched on", () => {
		expect(
			resolveRoute(table, catalog, input({from: "sw", switches: {nllb: false}}))?.candidate
		).to.equal("llm");
		expect(
			explainRoute(table, catalog, input({from: "sw", tier: "cpu", switches: {nllb: false}}))
				.why
		).to.deep.equal({kind: "off", engine: "nllb"});
		// The OPUS pair needs no NLLB.
		expect(
			resolveRoute(table, catalog, input({tier: "cpu", switches: {nllb: false}}))?.candidate
		).to.equal("opus:de-en");
	});

	it("skips a candidate the catalog has no model for", () => {
		const t: RouteTable = {en: {de: ["opus:xx-yy", "nllb"]}};

		expect(resolveRoute(t, catalog, input({tier: "cpu"}))?.candidate).to.equal("nllb");
	});

	it("returns the model with the candidate", () => {
		expect(resolveRoute(table, catalog, input({tier: "cpu"}))?.ref).to.equal(
			catalog.opus["de-en"]
		);
	});

	it("merges an override per entry, keeping the rest of the base", () => {
		const merged = mergeRoutes(table, {en: {de: ["nllb"]}, pt: {"*": [["nllb", "llm"]]}});

		expect(merged.en.de).to.deep.equal(["nllb"]);
		expect(merged.en.sw).to.deep.equal(["nllb", "llm"]);
		expect(merged.pt["*"]).to.deep.equal([["nllb", "llm"]]);
		expect(merged["*"]["*"]).to.deep.equal(["llm", "nllb"]);
		expect(table.en.de).to.deep.equal([["llm", "opus:de-en"], "nllb"]);
	});

	it("a deploy's flat override is a strict order, one candidate per class", () => {
		// The shape config.json overrides have always had.
		const merged = mergeRoutes(table, {de: {"*": ["llm", "nllb"]}});

		expect(candidatesFor(merged, "en", "de")).to.deep.equal([["llm"], ["nllb"]]);
		expect(
			resolveRoute(
				merged,
				catalog,
				input({from: "en", to: "de", cached: isCached(catalog.nllb.id)})
			)?.candidate
		).to.equal("llm");
	});

	describe("the default table", () => {
		it("puts NLLB first where it measured ahead, in both directions", () => {
			// Arabic measured NLLB ahead too, but stays LLM-first for the
			// channel context the LLM reads (routes.default.ts): it routes like
			// any language the table has no opinion about.
			for (const pair of [
				["ar", "en"],
				["en", "ar"],
			] as const) {
				expect(
					candidatesFor(DEFAULT_ROUTES, pair[0], pair[1]),
					pair.join("→")
				).to.deep.equal(
					candidatesFor(
						DEFAULT_ROUTES,
						pair[0] === "ar" ? "pt" : "en",
						pair[1] === "ar" ? "pt" : "en"
					)
				);
			}

			// Placed from the web build's own weights (2026-09-13-web-weights.md).
			for (const code of ["tl", "el", "fi", "hu", "hi", "sw"]) {
				expect(candidatesFor(DEFAULT_ROUTES, code, "en"), `${code}→en`).to.deep.equal([
					["nllb"],
					["llm"],
				]);
				expect(candidatesFor(DEFAULT_ROUTES, "en", code), `en→${code}`).to.deep.equal([
					["nllb"],
					["llm"],
				]);
			}

			// A target with no row of its own still sends a weak source to NLLB.
			expect(candidatesFor(DEFAULT_ROUTES, "tl", "pt")).to.deep.equal([["nllb"], ["llm"]]);
			// Either side weak is enough.
			expect(candidatesFor(DEFAULT_ROUTES, "el", "sk")).to.deep.equal([["nllb"], ["llm"]]);
		});

		it("puts the LLM and NLLB in one class where they tied", () => {
			for (const code of ["sk", "ms", "gl", "th", "cs", "nb", "bg", "id"]) {
				expect(candidatesFor(DEFAULT_ROUTES, code, "en"), `${code}→en`).to.deep.equal([
					["llm", "nllb"],
				]);
				expect(candidatesFor(DEFAULT_ROUTES, "fr", code), `fr→${code}`).to.deep.equal([
					["llm", "nllb"],
				]);
			}
		});

		it("gives the OPUS-MT pairs the class they measured into", () => {
			expect(candidatesFor(DEFAULT_ROUTES, "de", "en")).to.deep.equal([
				["llm", "opus:de-en"],
				["nllb"],
			]);
			expect(candidatesFor(DEFAULT_ROUTES, "en", "ru")).to.deep.equal([
				["llm", "opus:en-ru"],
				["nllb"],
			]);
			// French tied with OPUS-MT on the web weights (Qwen +3).
			expect(candidatesFor(DEFAULT_ROUTES, "en", "fr")).to.deep.equal([
				["llm", "opus:en-fr"],
				["nllb"],
			]);
			expect(candidatesFor(DEFAULT_ROUTES, "en", "es")).to.deep.equal([
				["llm"],
				["opus:en-es"],
				["nllb"],
			]);
		});

		it("keeps the LLM first everywhere else", () => {
			expect(candidatesFor(DEFAULT_ROUTES, "ja", "fr")).to.deep.equal([["llm"], ["nllb"]]);
			expect(candidatesFor(DEFAULT_ROUTES, "en", "pt")).to.deep.equal([["llm"], ["nllb"]]);
			expect(candidatesFor(DEFAULT_ROUTES, "de", "fr")).to.deep.equal([["llm"], ["nllb"]]);

			// Qwen ahead of NLLB by more than the tie band on the web weights.
			for (const code of ["pl", "ca", "ga"]) {
				expect(candidatesFor(DEFAULT_ROUTES, "en", code), `en→${code}`).to.deep.equal([
					["llm"],
					["nllb"],
				]);
			}
		});

		it("Filipino with Qwen downloaded and NLLB not goes to NLLB", () => {
			expect(
				resolveRoute(
					DEFAULT_ROUTES,
					catalog,
					input({from: null, hint: "tl", to: "en", cached: isCached(catalog.llm.id)})
				)?.candidate
			).to.equal("nllb");
			expect(
				resolveRoute(
					DEFAULT_ROUTES,
					catalog,
					input({from: "en", to: "tl", cached: isCached(catalog.llm.id)})
				)?.candidate
			).to.equal("nllb");
		});

		it("every placed language has an NLLB code, and the limited ones are marked", () => {
			for (const code of [...NLLB_FIRST, ...NLLB_TIED]) {
				expect(nllbCode(code), code).to.not.equal(null);
			}

			expect([...LIMITED_LANGUAGES].sort()).to.deep.equal(["bn", "hi", "hu", "ko", "sk"]);
			expect(isLimitedLanguage("hu")).to.equal(true);
			expect(isLimitedLanguage("fi")).to.equal(false);
			expect(isLimitedLanguage(null)).to.equal(false);
		});
	});

	describe("devices", () => {
		const shipped = routesFor(QWEN3_1_7B_ID);
		const opusOnly: RouteTable = {de: {en: ["opus:en-de"]}};
		const llmOnly: RouteTable = {ja: {en: ["llm"]}};
		const enDe = {from: "en", to: "de"};
		const enJa = {from: "en", to: "ja"};
		const refuseGpu = (_ref: ModelRef, device: Device) => device === "gpu";
		const opusCpuCached = isCached(catalog.opus["en-de"].id, "cpu");

		it("puts the route on the device its copy runs on", () => {
			expect(resolveRoute(table, catalog, input())?.device).to.equal("gpu");
			// A computer: OPUS-MT's GPU copy first under Auto.
			expect(resolveRoute(opusOnly, catalog, input(enDe))).to.deep.include({
				candidate: "opus:en-de",
				device: "gpu",
			});
			// No WebGPU: its CPU copy.
			expect(resolveRoute(opusOnly, catalog, input({...enDe, tier: "cpu"}))).to.deep.include({
				candidate: "opus:en-de",
				device: "cpu",
			});
		});

		it("a declined GPU download falls back to the CPU copy for OPUS-MT only", () => {
			// A downloaded copy does not outrank the better device: the GPU
			// copy is asked for first.
			expect(
				resolveRoute(
					shipped,
					catalog,
					input({...enDe, switches: {llm: false}, cached: opusCpuCached})
				)
			).to.deep.include({candidate: "opus:en-de", device: "gpu"});
			// "Not now" to the GPU copy: the CPU copy on the device serves.
			expect(
				resolveRoute(
					shipped,
					catalog,
					input({...enDe, cached: opusCpuCached, refuse: refuseGpu})
				)
			).to.deep.include({candidate: "opus:en-de", device: "cpu"});
			// The language model has the GPU alone under Auto: a downloaded
			// CPU copy is never fallen back to.
			const verdict = explainRoute(
				llmOnly,
				catalog,
				input({...enJa, cached: isCached(catalog.llm.id, "cpu"), refuse: refuseGpu})
			);

			expect(verdict.route).to.equal(null);
			expect(verdict.why).to.deep.include({kind: "download", device: "gpu"});
		});

		it("runs a language model pinned to the CPU on a device without WebGPU", () => {
			expect(
				resolveRoute(table, catalog, input({...enJa, tier: "cpu", devices: {llm: "cpu"}}))
			).to.deep.include({candidate: "llm", device: "cpu"});
			// Under Auto it stays blocked by the GPU's reason.
			expect(explainRoute(llmOnly, catalog, input({...enJa, tier: "cpu"})).why).to.deep.equal(
				{kind: "device", reason: "NO_WEBGPU"}
			);
		});

		it("walks past a copy marked down to the model's other copy", () => {
			expect(
				resolveRoute(
					shipped,
					catalog,
					input({...enDe, switches: {llm: false}, down: new Set(["opus:en-de@gpu"])})
				)
			).to.deep.include({candidate: "opus:en-de", device: "cpu"});
			// The language model's GPU copy down: no other copy under Auto.
			expect(
				explainRoute(llmOnly, catalog, input({...enJa, down: new Set(["llm@gpu"])})).why
			).to.deep.equal({kind: "down"});
		});

		it("blocks a chosen 4B pinned to the CPU as having no copy there", () => {
			const capability = capabilityFor("gpu");
			const chosen = selectLlm(catalog, QWEN3_4B_ID, capability, "cpu");

			expect(chosen.llm.id).to.equal(QWEN3_4B_ID);
			expect(
				explainRoute(llmOnly, chosen, input({...enJa, devices: {llm: "cpu"}})).why
			).to.deep.equal({kind: "noCopy", device: "cpu"});
		});

		it("routes the cleanup pass on the language model's device", () => {
			expect(
				resolveRoute(table, catalog, input({from: "en", to: "en", devices: {llm: "cpu"}}))
			).to.deep.include({candidate: "llm", device: "cpu"});
			expect(
				resolveRoute(
					table,
					catalog,
					input({from: "en", to: "en", tier: "cpu", devices: {llm: "cpu"}})
				)
			).to.deep.include({candidate: "llm", device: "cpu"});
			expect(resolveRoute(table, catalog, input({from: "en", to: "en"}))).to.deep.include({
				candidate: "llm",
				device: "gpu",
			});
		});

		describe("the reason", () => {
			// A computer whose GPU lacks f16: OPUS-MT's GPU copy cannot run.
			const noF16 = {
				...capabilityFor("cpu"),
				reasons: ["NO_F16" as const],
				f16: false,
				maxBufferBytes: 2 * 1024 * 1024 * 1024,
			};

			it("is a pinned device's own block, never the other device's", () => {
				const verdict = explainRoute(
					opusOnly,
					catalog,
					input({...enDe, tier: "cpu", capability: noF16, devices: {opus: "gpu"}})
				);

				expect(verdict.route).to.equal(null);
				expect(verdict.why).to.deep.equal({kind: "device", reason: "NO_F16"});
			});

			it("under Auto, the next device's switch over the first device's code", () => {
				expect(
					explainRoute(
						opusOnly,
						catalog,
						input({...enDe, tier: "cpu", capability: noF16, switches: {opus: false}})
					).why
				).to.deep.equal({kind: "off", engine: "opus"});
			});

			it("under Auto, the next device's declined download over the first device's code", () => {
				const why = explainRoute(
					opusOnly,
					catalog,
					input({...enDe, tier: "cpu", capability: noF16, refuse: () => true})
				).why;

				expect(why).to.deep.include({kind: "download", device: "cpu"});
			});

			it("under Auto, the first device's block when it is not a device code", () => {
				// A desktop: the GPU copy's download declined, the CPU copy down.
				expect(
					explainRoute(
						opusOnly,
						catalog,
						input({
							...enDe,
							refuse: refuseGpu,
							down: new Set(["opus:en-de@cpu"]),
						})
					).why
				).to.deep.include({kind: "download", device: "gpu"});
			});
		});
	});
});
