// The routing matrix (docs/resources/translation.md § The ladder): the
// route every request should take, written down a second time as a small
// rule of its own (`ladder`), and the real router asked
// the same question over every combination that is modelled -- platform
// (the probes measured on real devices), deploy (the shipped build, and
// AfterNET's config as its builds carry it and with all its models), pair,
// engine switches, Run on, what is on the device and a GPU lost before.
// A mismatch names the case. The domain is finite, so this is a complete
// check over it, not a sample: nothing needs a solver.
//
// The rule is built from facts, not from the router's helpers: what each
// platform can run (the `llmGpu` / `llmCpu` columns, from the probes), the
// deploy's pairs, and the measurement's placement lists (routes.default.ts
// NLLB_FIRST and kin, which are data). The system translator comes ahead of
// all of it in the service, and has its own suite at the end, through the
// service and a fake bridge.

import {expect} from "chai";
import type {Capability} from "../../client/js/translate/capability";
import type {Device, ModelRef} from "../../client/js/translate/engine";
import {
	buildCatalog,
	type CatalogOptions,
	type DeviceChoice,
	type EngineSwitches,
	type ModelCatalog,
	QWEN3_1_7B_ID,
	QWEN3_4B_ID,
	selectLlm,
} from "../../client/js/translate/models";
import {
	explainRoute,
	mergeRoutes,
	routeInput,
	translationBlock,
	type RouteTable,
} from "../../client/js/translate/router";
import {placementFor, routesFor} from "../../client/js/translate/routes.default";
import {SUPPORTED_LANGUAGES} from "../../client/js/translate/languages";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

// ---- Platforms: what the probe answers, and what each can run ----

interface Platform {
	name: string;
	capability: Capability;
	/** The language model runs on its GPU (WebGPU, f16, WebLLM's limits, the binding). */
	llmGpu: boolean;
	/** Its CPU copy runs (Memory64, and not an iPhone or iPad page). */
	llmCpu: boolean;
	/** The GPU model the device gets when nothing is chosen. */
	model: string;
	/**
	 * Its GPU binds too little for the 1.7B itself and runs only the
	 * small-buffer build, which reads the published weights: a deploy that
	 * mirrors the models (`modelBase`) has no such build (models.ts).
	 */
	smallBufferOnly?: boolean;
}

const probe = (fields: Partial<Capability>): Capability => ({
	tier: "gpu",
	reasons: [],
	f16: true,
	maxBufferBytes: 2 * GiB,
	deviceMemoryGiB: 8,
	storageQuotaBytes: null,
	mobile: false,
	appleMobile: false,
	bufferCapBytes: null,
	...fields,
});

export const PLATFORMS: Platform[] = [
	{
		// Measured 2026-11-10: Chrome 157 on an Apple-silicon Mac.
		name: "Mac Chrome",
		capability: probe({maxBufferBytes: 4294967292, deviceMemoryGiB: 32}),
		llmGpu: true,
		llmCpu: true,
		model: QWEN3_4B_ID,
	},
	{
		// Measured 2026-11-10: Safari 27.2, no deviceMemory.
		name: "Mac Safari",
		capability: probe({maxBufferBytes: 2147483644, deviceMemoryGiB: null}),
		llmGpu: true,
		llmCpu: true,
		model: QWEN3_1_7B_ID,
	},
	{
		// Measured 2026-11-10: Firefox 158 has WebGPU, below WebLLM's limits.
		name: "Mac Firefox",
		capability: probe({tier: "cpu", reasons: ["GPU_LIMITS"], deviceMemoryGiB: null}),
		llmGpu: false,
		llmCpu: true,
		model: QWEN3_1_7B_ID,
	},
	{
		// Measured 2026-11-10 in the iPhone app (WKWebView).
		name: "iPhone app",
		capability: probe({
			maxBufferBytes: 1 * GiB,
			deviceMemoryGiB: null,
			mobile: true,
			appleMobile: true,
		}),
		llmGpu: true,
		llmCpu: false,
		model: QWEN3_1_7B_ID,
	},
	{
		name: "iPhone Safari, no WebGPU",
		capability: probe({
			tier: "cpu",
			reasons: ["NO_WEBGPU", "NO_MEMORY64"],
			f16: false,
			maxBufferBytes: 0,
			deviceMemoryGiB: null,
			mobile: true,
			appleMobile: true,
		}),
		llmGpu: false,
		llmCpu: false,
		model: QWEN3_1_7B_ID,
	},
	{
		// A tester's phone: Adreno, Chrome on Android.
		name: "Android Chrome",
		capability: probe({maxBufferBytes: 1 * GiB, deviceMemoryGiB: 8, mobile: true}),
		llmGpu: true,
		llmCpu: true,
		model: QWEN3_1_7B_ID,
	},
	{
		name: "Android, no WebGPU",
		capability: probe({
			tier: "cpu",
			reasons: ["NO_WEBGPU"],
			f16: false,
			maxBufferBytes: 0,
			deviceMemoryGiB: 4,
			mobile: true,
		}),
		llmGpu: false,
		llmCpu: true,
		model: QWEN3_1_7B_ID,
	},
	{
		// Chrome on Linux with an AMD GPU or X11 NVIDIA: WebGPU behind a flag.
		name: "Linux Chrome, no WebGPU",
		capability: probe({
			tier: "cpu",
			reasons: ["NO_WEBGPU"],
			f16: false,
			maxBufferBytes: 0,
			deviceMemoryGiB: 8,
		}),
		llmGpu: false,
		llmCpu: true,
		model: QWEN3_1_7B_ID,
	},
	{
		// Chrome 144+ on Linux with Intel Gen12+.
		name: "Linux Chrome, Intel",
		capability: probe({maxBufferBytes: 2 * GiB, deviceMemoryGiB: 8}),
		llmGpu: true,
		llmCpu: true,
		model: QWEN3_4B_ID,
	},
	{
		// WebGPU's floor: the 1.7B's small-buffer build only.
		name: "Desktop, 128 MiB binding",
		capability: probe({maxBufferBytes: 128 * MiB, deviceMemoryGiB: 8}),
		llmGpu: true,
		llmCpu: true,
		model: QWEN3_1_7B_ID,
		smallBufferOnly: true,
	},
	{
		name: "Windows Chrome",
		capability: probe({maxBufferBytes: 2 * GiB, deviceMemoryGiB: 16}),
		llmGpu: true,
		llmCpu: true,
		model: QWEN3_4B_ID,
	},
];

/** The probe with a GPU lost here before laid over it, as service.ts lays it. */
function lost(capability: Capability): Capability {
	return {
		...capability,
		tier: capability.tier === "gpu" ? "cpu" : capability.tier,
		reasons: [...capability.reasons, "GPU_LOST"],
	};
}

// ---- Deploys ----

interface Deploy {
	name: string;
	options: CatalogOptions;
	routes: RouteTable;
	/** Its own small models, as "from-to". */
	pairs: readonly string[];
	/**
	 * Its pairs are one class with the language model (`[[pair, "llm"],
	 * "nllb"]`), the AfterNET config's shape; else the pair stands alone
	 * ahead of it, as the shipped table has it.
	 */
	tiedWithLlm: boolean;
}

const OPUS = ["de", "fr", "es", "it", "nl", "ru"].flatMap((code) => [`en-${code}`, `${code}-en`]);
const TOKENS: Record<string, string> = {
	ar: ">>ara<<",
	ko: ">>kor<<",
	pl: ">>pol<<",
	pt: ">>por<<",
	sv: ">>swe<<",
	zh: ">>zho<<",
	es: ">>spa<<",
	fr: ">>fra<<",
	de: ">>deu<<",
	ru: ">>rus<<",
};

function afternet(name: string, directions: string[]): Deploy {
	const opus: Record<string, {model: string; token: string; name: string; sizeBytes: number}> =
		{};
	const routes: RouteTable = {};

	for (const pair of directions) {
		const [from, to] = pair.split("-");
		const code = from === "en" ? to : from;

		opus[pair] = {
			model: `seance-mt/marian-${code}`,
			token: to === "en" ? ">>eng<<" : TOKENS[code],
			name: "AfterNET MT",
			sizeBytes: 30_000_000,
		};
		(routes[to] ??= {})[from] = [[`opus:${pair}`, "llm"], "nllb"];
	}

	return {
		name,
		options: {modelBase: "https://models.example/models", cpu: {opus}},
		routes,
		pairs: directions,
		tiedWithLlm: true,
	};
}

const both = (codes: string[]) => codes.flatMap((code) => [`en-${code}`, `${code}-en`]);

export const DEPLOYS: Deploy[] = [
	{name: "shipped", options: {}, routes: {}, pairs: [], tiedWithLlm: false},
	// As AfterNET's builds carry it on 2026-11-10: English into Arabic only.
	afternet("AfterNET (builds)", ["en-ar", ...both(["ko", "pl", "pt", "sv", "zh"])]),
	// With every model the host has: all ten, both ways.
	afternet(
		"AfterNET (all models)",
		both(["ar", "ko", "pl", "pt", "sv", "zh", "es", "fr", "de", "ru"])
	),
];

// ---- The ladder ----

type Copy = "small" | "llm@gpu" | "llm@cpu" | "nllb@cpu";

interface Case {
	platform: Platform;
	deploy: Deploy;
	from: string | null;
	to: string;
	switches: EngineSwitches;
	llmDevice: DeviceChoice;
	cached: ReadonlySet<Copy>;
	gpuLost: boolean;
}

/**
 * The route the spec gives, as "small", "llm@gpu", "llm@cpu", "nllb@cpu",
 * or null for none. Steps (Apple aside, which comes first in the service):
 * a small CPU model for the pair; the language model on the GPU; NLLB-200
 * once switched on, ahead of the language model in the languages it
 * measured ahead in, tied with it in the ones it tied; and last, under
 * Auto where the GPU cannot run the language model, its CPU copy. Inside
 * one class a copy already on the device answers first. A pinned Run on
 * keeps the language model to that device. No pivot through English.
 */
export function ladder(c: Case): string | null {
	const {platform, deploy, from, to, switches, llmDevice, cached} = c;
	const mirrored = deploy.options.modelBase !== undefined;
	const gpuRuns = platform.llmGpu && !c.gpuLost && !(platform.smallBufferOnly && mirrored);
	// A GPU nothing runs on, or Run on pinned to the CPU: a model with a CPU copy.
	const model = gpuRuns && llmDevice !== "cpu" ? platform.model : QWEN3_1_7B_ID;
	const placement = placementFor(model);
	const polish = from !== null && from === to;

	// The language model in its class: the device it would take.
	const llmInClass = (): "llm@gpu" | "llm@cpu" | null => {
		if (!switches.llm) {
			return null;
		}

		if (llmDevice === "gpu") {
			return gpuRuns ? "llm@gpu" : null;
		}

		if (llmDevice === "cpu") {
			// A pinned CPU and no choice: a model with a CPU copy (models.ts llmChoice).
			return platform.llmCpu ? "llm@cpu" : null;
		}

		const cpuThere = platform.llmCpu && cached.has("llm@cpu");

		if (gpuRuns) {
			// On a phone the copy on the device answers before the GPU's download.
			return platform.capability.mobile && cpuThere && !cached.has("llm@gpu")
				? "llm@cpu"
				: "llm@gpu";
		}

		return cpuThere ? "llm@cpu" : null;
	};

	// Under Auto where the GPU cannot run it, the CPU copy: the last way in
	// for every request, the cleanup pass (the language model's alone) too.
	const lastResort =
		switches.llm && llmDevice === "auto" && !gpuRuns && platform.llmCpu ? "llm@cpu" : null;

	if (polish) {
		return llmInClass() ?? lastResort;
	}

	const pair = from ? `${from}-${to}` : null;
	const deployPair = pair !== null && deploy.pairs.includes(pair);
	const small = pair !== null && switches.opus && (deployPair || OPUS.includes(pair));
	const nllb = switches.nllb && from !== null ? "nllb@cpu" : null;
	const sides = [from, to];
	const nllbFirst = sides.some((code) => code && placement.nllbFirst.includes(code));
	const nllbTied = sides.some((code) => code && placement.nllbTied.includes(code));

	// The classes, best first, each the candidates' routes in order.
	const classes: (string | null)[][] = [];

	if (deployPair && deploy.tiedWithLlm) {
		classes.push([small ? "small" : null, llmInClass()], [nllb]);
	} else {
		if (small) {
			classes.push(["small"]);
		}

		if (nllbFirst) {
			classes.push([nllb], [llmInClass()]);
		} else if (nllbTied) {
			classes.push([llmInClass(), nllb]);
		} else {
			classes.push([llmInClass()], [nllb]);
		}
	}

	for (const group of classes) {
		const runnable = group.filter((route): route is string => route !== null);
		const there = runnable.find((route) => cached.has(route as Copy));

		if (there ?? runnable[0]) {
			return there ?? runnable[0];
		}
	}

	return lastResort;
}

// ---- The real router, asked as the service asks it ----

const catalogs = new Map<string, ModelCatalog>();

function catalogFor(deploy: Deploy, capability: Capability, llmDevice: DeviceChoice) {
	const key = `${deploy.name}|${JSON.stringify(capability)}|${llmDevice}`;
	let catalog = catalogs.get(key);

	if (!catalog) {
		catalog = selectLlm(buildCatalog(deploy.options), null, capability, llmDevice);
		catalogs.set(key, catalog);
	}

	return catalog;
}

const tables = new Map<string, RouteTable>();

function tableFor(deploy: Deploy, llmId: string): RouteTable {
	const key = `${deploy.name}|${llmId}`;
	let table = tables.get(key);

	if (!table) {
		table = mergeRoutes(routesFor(llmId), deploy.routes);
		tables.set(key, table);
	}

	return table;
}

function routed(c: Case): string | null {
	const capability = c.gpuLost ? lost(c.platform.capability) : c.platform.capability;
	const catalog = catalogFor(c.deploy, capability, c.llmDevice);
	const table = tableFor(c.deploy, catalog.llm.id);
	const cached = (ref: ModelRef, device: Device): boolean => {
		if (ref.family === "llm") {
			return c.cached.has(`llm@${device}` as Copy);
		}

		if (ref.family === "nllb") {
			return c.cached.has(`nllb@${device}` as Copy);
		}

		return c.cached.has("small");
	};
	const verdict = explainRoute(table, catalog, {
		...routeInput(
			capability,
			c.switches,
			{llm: c.llmDevice, opus: "auto", nllb: "auto"},
			{from: c.from, to: c.to}
		),
		cached,
	});
	const route = verdict.route;

	if (!route) {
		return null;
	}

	if (route.ref.family === "llm" || route.ref.family === "nllb") {
		return `${route.ref.family}@${route.device}`;
	}

	return route.device === "cpu" ? "small" : `small@${route.device}`;
}

function describeCase(c: Case): string {
	return [
		c.platform.name,
		c.deploy.name,
		`${c.from ?? "?"}>${c.to}`,
		`switches ${
			["llm", "opus", "nllb"]
				.filter((k) => c.switches[k as keyof EngineSwitches])
				.join("+") || "none"
		}`,
		`llm on ${c.llmDevice}`,
		`cached ${[...c.cached].join("+") || "none"}`,
		c.gpuLost ? "GPU lost before" : "GPU fine",
	].join(", ");
}

// ---- The enumeration ----

const SWITCHES: EngineSwitches[] = [true, false].flatMap((llm) =>
	[true, false].flatMap((opus) => [true, false].map((nllb) => ({llm, opus, nllb})))
);
const DEVICES: DeviceChoice[] = ["auto", "gpu", "cpu"];
const COPIES: Copy[] = ["small", "llm@gpu", "llm@cpu", "nllb@cpu"];
const CACHED: ReadonlySet<Copy>[] = Array.from(
	{length: 1 << COPIES.length},
	(_, mask) => new Set(COPIES.filter((copy, i) => mask & (1 << i)))
);

/**
 * One language of each kind the rule tells apart: English, the OPUS-MT
 * languages, AfterNET's in the builds and only in its full set, Arabic (one
 * way in the builds), the measurement's NLLB-first and tied languages (for
 * either model), and plain ones.
 */
const KINDS = ["en", "de", "it", "es", "ko", "pt", "ar", "ja", "sr", "fi", "sk", "th", "tl"];

function* pairs(languages: readonly string[]): Generator<[string | null, string]> {
	for (const to of languages) {
		yield [null, to];

		for (const from of languages) {
			yield [from, to];
		}
	}
}

describe("translate: the routing matrix", function () {
	this.timeout(600_000);

	it("routes every kind of pair as the ladder says, in every state", () => {
		const misses: string[] = [];
		let cases = 0;

		for (const platform of PLATFORMS) {
			for (const deploy of DEPLOYS) {
				for (const [from, to] of pairs(KINDS)) {
					for (const switches of SWITCHES) {
						for (const llmDevice of DEVICES) {
							for (const cached of CACHED) {
								for (const gpuLost of [false, true]) {
									const c: Case = {
										platform,
										deploy,
										from,
										to,
										switches,
										llmDevice,
										cached,
										gpuLost,
									};
									const want = ladder(c);
									const got = routed(c);

									cases++;

									if (want !== got && misses.length < 40) {
										misses.push(`${describeCase(c)}: want ${want}, got ${got}`);
									}
								}
							}
						}
					}
				}
			}
		}

		expect(misses, `${misses.length} of ${cases} cases differ`).to.deep.equal([]);
	});

	it("routes every pair of every language as the ladder says, out of the box", () => {
		const misses: string[] = [];
		const defaults: EngineSwitches = {llm: true, opus: true, nllb: false};

		for (const platform of PLATFORMS) {
			for (const deploy of DEPLOYS) {
				for (const [from, to] of pairs(SUPPORTED_LANGUAGES)) {
					for (const gpuLost of [false, true]) {
						const c: Case = {
							platform,
							deploy,
							from,
							to,
							switches: defaults,
							llmDevice: "auto",
							cached: new Set(),
							gpuLost,
						};
						const want = ladder(c);
						const got = routed(c);

						if (want !== got && misses.length < 40) {
							misses.push(`${describeCase(c)}: want ${want}, got ${got}`);
						}
					}
				}
			}
		}

		expect(misses).to.deep.equal([]);
	});

	it("gives each platform the GPU model the facts say", () => {
		for (const platform of PLATFORMS) {
			expect(
				catalogFor(DEPLOYS[0], platform.capability, "auto").llm.id,
				platform.name
			).to.equal(platform.model);
			// A GPU lost here before: a model with a CPU copy.
			expect(
				catalogFor(DEPLOYS[0], lost(platform.capability), "auto").llm.id,
				`${platform.name}, GPU lost`
			).to.equal(QWEN3_1_7B_ID);
		}
	});

	it("says translation is available wherever the ladder finds a route out of the box", () => {
		const defaults: EngineSwitches = {llm: true, opus: true, nllb: false};

		for (const platform of PLATFORMS) {
			const capability = platform.capability;
			const catalog = catalogFor(DEPLOYS[0], capability, "auto");

			expect(
				translationBlock(catalog, capability, defaults, {
					llm: "auto",
					opus: "auto",
					nllb: "auto",
				}),
				platform.name
			).to.equal(null);
		}
	});
});
