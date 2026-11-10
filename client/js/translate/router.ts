// The router (spec § router.ts): a table keyed by target language, then
// source, each entry the candidates in **quality classes**, best class
// first. `resolveRoute` walks the classes in order and takes the first
// class with a candidate the device allows (an `llm` candidate on Auto is
// skipped, never failed, below the gpu tier), the user's engine settings
// allow, the catalog has a model for, and that is not marked down for the
// session. Each candidate is tried on its devices in turn (models.ts
// `deviceOrder`: a pinned device alone, Auto's order otherwise): a copy
// whose device cannot run it (`modelBlock`), marked down (`DownKey`), or
// whose download the caller refuses is passed over for the next device,
// and the candidate's route is its first device left. Under Auto a
// downloaded copy Auto would not otherwise try (the language model's CPU
// copy) joins the walk after the others, and on a phone a copy already on
// the device answers before the better device's download (`walkDevices`).
// A pinned device stands as pinned. Inside a class a candidate whose route is already downloaded
// wins over the class's own order; a better class is never skipped for a
// downloaded model in a worse one: its model is downloaded on demand
// instead (service.ts), once the user has agreed to that download
// (consent.ts). NLLB-200 runs only once the user has switched it on
// (`switches.nllb`; its licence is non-commercial), so the OPUS-MT pairs
// and the language model serve without it. A seq2seq candidate needs a
// source language: the request's `from`, or failing that its source hint.

import {Capability, Tier} from "./capability";
import {Device, ModelRef} from "./engine";
import {
	Candidate,
	DeviceChoices,
	EngineSwitches,
	ModelBlock,
	ModelCatalog,
	candidateOf,
	choiceFor,
	deviceOrder,
	modelBlock,
	refFor,
} from "./models";

/** One copy of a candidate: what the session marks down after it fails (service.ts). */
export type DownKey = `${Candidate}@${Device}`;

/**
 * One table entry: its elements are quality classes, best first. A bare
 * candidate is a class of one, so a flat list (`["llm", "nllb"]`, the
 * shape every deploy override had) is a strict order, and a nested list
 * (`[["llm", "opus:de-en"], "nllb"]`) makes its candidates equivalent: the
 * downloaded one is preferred, the list's order breaks the tie.
 */
export type RouteEntry = (Candidate | Candidate[])[];

/** to → (from | "*") → classes; "*" → from and "*" → "*" behind a target's own rows. */
export type RouteTable = Record<string, Record<string, RouteEntry>>;

export interface RouteInput {
	from: string | null;
	/**
	 * The language the caller's detector placed the text in when the verdict
	 * was too weak to name as `from`: the reading queue's
	 * `QueueItem.routeHint` and the composer's `sourceHintFor`, which travel
	 * as `TranslateRequest.hint` -- routing only, never the prompt's
	 * `PromptContext.sourceHint`. It picks the table row when `from` is
	 * null, and lets a seq2seq candidate run with it as its source; the LLM
	 * request keeps `from: null`.
	 */
	hint: string | null;
	to: string;
	/** The probe's tier: `none` routes nothing (translation is hidden there). */
	tier: Tier;
	/** The user's switch per model family (`translateLlm`, `translateCpu`, `translateNllb`). */
	switches: EngineSwitches;
	/** The user's device setting per model family (`translate*Device`). */
	devices: DeviceChoices;
	down: ReadonlySet<DownKey>;
	/**
	 * Is this copy already downloaded? Optional: without it every candidate
	 * counts as unknown and each class's order is the table's own.
	 */
	cached?: (ref: ModelRef, device: Device) => boolean;
	/**
	 * A copy this request must not download: the user said "not now" to an
	 * implicit download this session (service.ts `resolve`, consent.ts). Such
	 * a copy is blocked as `download`, naming the model and the device, and
	 * the walk goes on to one that needs no download. Absent, nothing is
	 * refused.
	 */
	refuse?: (ref: ModelRef, device: Device) => boolean;
	/**
	 * The source will be named before any request goes out: a question asked
	 * ahead of time ("could this pair run?") for a line whose language the
	 * detector has yet to place. A seq2seq candidate then counts with a null
	 * source, as the request it stands for will carry a hint.
	 */
	sourceLater?: boolean;
	/**
	 * The probe: what every copy is judged against (`modelBlock`) and what
	 * Auto's device order reads (`deviceOrder`). Null while it runs, when
	 * nothing routes.
	 */
	capability: Capability | null;
	/**
	 * The session's yes to the language model on the CPU after its GPU copy
	 * stopped (service.ts `askCpuFallback`): its Auto order is the GPU, then
	 * the CPU (`deviceOrder`). Absent, the GPU alone.
	 */
	llmCpuAfterGpu?: boolean;
	/**
	 * The user's engine preference (`translatePrefer`, Settings → Advanced):
	 * `llm` takes the language model ahead of every class, `small` puts it
	 * behind them. Either way every other candidate stays a fallback in the
	 * table's order, so a preference reorders and never refuses. Absent (or
	 * Automatic), the table's own order.
	 */
	prefer?: EnginePreference;
}

/** Settings → Advanced's "Prefer": the table's order, the language model first, or last. */
export type EnginePreference = "auto" | "llm" | "small";

/** A stored value that is none of the three (a hand edit, an older backup) reads as Automatic. */
export function normalizePreference(value: unknown): EnginePreference {
	return value === "llm" || value === "small" ? value : "auto";
}

/**
 * The classes with the language model taken out of wherever the table put
 * it and made a class of its own, first or last. An entry without it is
 * returned as it is.
 */
export function withLlmAt(classes: Candidate[][], at: "first" | "last"): Candidate[][] {
	if (!classes.some((group) => group.includes("llm"))) {
		return classes;
	}

	const rest = classes
		.map((group) => group.filter((candidate) => candidate !== "llm"))
		.filter((group) => group.length > 0);

	return at === "first" ? [["llm"], ...rest] : [...rest, ["llm"]];
}

export interface Route {
	candidate: Candidate;
	ref: ModelRef;
	/** The device the route's copy runs on. */
	device: Device;
}

/**
 * Why no candidate can take a request: a model's own block (models.ts
 * `modelBlock`), the candidate marked down for the session after it failed,
 * a seq2seq model with no source to start from, or a pair the table and the
 * catalog have no model for at all.
 */
export type RouteBlock =
	| ModelBlock
	| {kind: "down"}
	| {kind: "source"}
	| {kind: "unserved"}
	/** The route's copy is not on the device and its download was declined (consent.ts). */
	| {kind: "download"; ref: ModelRef; device: Device};

/**
 * The router's answer with its reason: a route, or why there is none.
 * `polish` says the request was in one language (the cleanup pass), which
 * only the GPU model does.
 */
export type RouteVerdict =
	| {route: Route; why: null; polish: boolean}
	| {route: null; why: RouteBlock; polish: boolean};

/**
 * The input `resolveRoute` takes, from the probe and the user's switches
 * and device settings, for the service's requests and the UI's questions
 * alike. A capability still unknown routes nothing.
 */
export function routeInput(
	capability: Capability | null,
	switches: EngineSwitches,
	devices: DeviceChoices,
	pair: {from: string | null; to: string; hint?: string | null; sourceLater?: boolean},
	down: ReadonlySet<DownKey> = new Set()
): RouteInput {
	return {
		from: pair.from,
		hint: pair.hint ?? null,
		to: pair.to,
		tier: capability?.tier ?? "none",
		switches,
		devices,
		down,
		sourceLater: pair.sourceLater,
		capability,
	};
}

/** An entry's classes, each a non-empty list of candidates. */
export function classesOf(entry: RouteEntry): Candidate[][] {
	return entry
		.map((element) => (Array.isArray(element) ? [...element] : [element]))
		.filter((group) => group.length > 0);
}

/**
 * The classes for a pair: the target's row for the source, the target's
 * wildcard, the wildcard target's row for the source, then the global
 * wildcard.
 */
export function candidatesFor(table: RouteTable, from: string | null, to: string): Candidate[][] {
	const forTarget = table[to];
	const anyTarget = table["*"];
	const entry =
		(from ? forTarget?.[from] : undefined) ??
		forTarget?.["*"] ??
		(from ? anyTarget?.[from] : undefined) ??
		anyTarget?.["*"] ??
		[];

	return classesOf(entry);
}

/** Every engine switched on: what a device can run, whatever the switches. */
const ALL_ON: EngineSwitches = {llm: true, opus: true, nllb: true};

/** A device code: nothing the user can change in Settings. */
const DEVICE_KINDS: ReadonlySet<RouteBlock["kind"]> = new Set(["device", "buffer", "memory"]);
/** What the user can act on: a switch, a download, the 4B's "choose 1.7B". */
const ACTIONABLE_KINDS: ReadonlySet<RouteBlock["kind"]> = new Set(["off", "download", "noCopy"]);

/**
 * Of the blocks a model's devices gave, in its device order, the one to tell
 * the user (spec translation-devices.md § explainRoute): the first device's
 * -- a pinned device's own -- unless it is a device code and the next
 * device's is one the user can act on.
 */
function deviceReason(blocks: RouteBlock[]): RouteBlock {
	const [first, next] = blocks;

	return next && DEVICE_KINDS.has(first.kind) && ACTIONABLE_KINDS.has(next.kind) ? next : first;
}

/**
 * One model walked over its devices (`deviceOrder`): the first device whose
 * copy can take the request -- not blocked (`modelBlock`), not marked down,
 * its download not refused -- or, when none can, the reason.
 */
function walkDevices(
	candidate: Candidate,
	ref: ModelRef,
	input: RouteInput
): {device: Device; why: null} | {device: null; why: RouteBlock} {
	const blocks: RouteBlock[] = [];
	const auto = choiceFor(ref, input.devices) === "auto";
	const order = deviceOrder(
		ref,
		choiceFor(ref, input.devices),
		input.capability,
		input.llmCpuAfterGpu
	);
	const cached = (device: Device) => input.cached?.(ref, device) === true;

	// Under Auto a copy already on the device is one the user chose to
	// download, and asking for the other device's (a 1-2 GB question on a
	// phone) when it is there is what made a downloaded CPU copy look
	// ignored. So a downloaded copy Auto would otherwise never try (the
	// language model's CPU copy: Auto runs it on the GPU alone) joins the
	// walk, and whichever usable copy is downloaded answers first. Nothing
	// downloaded: the order stands, the better device first.
	if (auto && input.cached) {
		for (const device of ["gpu", "cpu"] as const) {
			if (!order.includes(device) && ref.copies[device] && cached(device)) {
				order.push(device);
			}
		}
	}

	// Which downloaded copy answers first is a phone's rule: there the
	// better device's download is the language model's 1-2 GB on a GPU
	// that may not hold it. On a computer a downloaded CPU copy would keep
	// Auto off a usable GPU for good, so the GPU is still asked for; the
	// downloaded copy only joins the walk (after the GPU, for a GPU that is
	// blocked, down or declined).
	const preferCached = auto && input.capability?.mobile === true;
	let usable: Device | null = null;

	for (const device of order) {
		const block: RouteBlock | null =
			modelBlock(ref, device, input.capability, input.switches) ??
			(input.down.has(`${candidate}@${device}`)
				? {kind: "down"}
				: input.refuse?.(ref, device)
				? {kind: "download", ref, device}
				: null);

		if (block) {
			blocks.push(block);
			continue;
		}

		if (!preferCached || cached(device)) {
			return {device, why: null};
		}

		usable = usable ?? device;
	}

	return usable ? {device: usable, why: null} : {device: null, why: deviceReason(blocks)};
}

/**
 * What keeps one candidate from taking the request, or the route it takes.
 * The routing and the explanation are the same test: `resolveRoute` takes
 * the first candidate this passes, `explainRoute` reports what it said.
 */
function candidateRoute(
	candidate: Candidate,
	ref: ModelRef | null,
	input: RouteInput,
	source: string | null
): {route: Route; why: null} | {route: null; why: RouteBlock} {
	if (!ref) {
		return {route: null, why: {kind: "unserved"}};
	}

	if (candidate !== "llm" && source === null && !input.sourceLater) {
		// The source is the request's, whatever the device: what blocks every
		// copy (a device code, a switch) outranks it, since naming a language
		// would not make the pair run; a down or declined copy does not.
		const walked = walkDevices(candidate, ref, {...input, down: new Set(), refuse: undefined});

		return {route: null, why: walked.why ?? {kind: "source"}};
	}

	const walked = walkDevices(candidate, ref, input);

	return walked.why
		? {route: null, why: walked.why}
		: {route: {candidate, ref, device: walked.device}, why: null};
}

/**
 * Of the reasons each candidate gave, the one to tell the user: a switch
 * they turned off, when one would serve the pair (the fix is theirs to
 * make; both, when either would), then a download they declined (the
 * best class's model, which Settings can download), else the best class's
 * own reason, a pair the catalog has no model for last.
 */
function pickReason(blocks: RouteBlock[]): RouteBlock {
	const off = (engine: string) =>
		blocks.some((block) => block.kind === "off" && block.engine === engine);

	// Either switch would serve: both are named, as translationBlock does.
	if (off("llm") && off("opus")) {
		return {kind: "off", engine: "all"};
	}

	// The language model or NLLB-200 would serve (English -> Japanese has no
	// OPUS-MT pair): naming the language model's switch alone hid the other
	// way in.
	if (off("llm") && off("nllb")) {
		return {kind: "off", engine: "llmOrNllb"};
	}

	return (
		blocks.find((block) => block.kind === "off") ??
		blocks.find((block) => block.kind === "download") ??
		blocks.find((block) => block.kind !== "unserved") ??
		blocks[0] ?? {kind: "unserved"}
	);
}

/**
 * `resolveRoute` with its reason: the route, or why there is none (see
 * `RouteBlock`). Settings, the composer's dialog, the panel and the toolbar
 * ask this before they offer an action, so what they disable is exactly
 * what the router would refuse.
 */
export function explainRoute(
	table: RouteTable,
	catalog: ModelCatalog,
	input: RouteInput
): RouteVerdict {
	const source = input.from ?? input.hint;
	// A request in one language (purpose "polish": the composer's cleanup
	// pass) is prose work only a language model can do: the language model
	// on its device where it may run, else no route -- a seq2seq model asked
	// to translate English into English would mangle the line.
	const polish = source !== null && source === input.to;

	// Nothing runs here (translation is hidden): the CPU's code, which every
	// device that translates at all gets past.
	if (input.tier === "none") {
		const why =
			(input.capability
				? modelBlock(catalog.nllb, "cpu", input.capability, {
						llm: true,
						opus: true,
						nllb: true,
				  })
				: null) ?? ({kind: "device", reason: "NO_WASM_SIMD"} as const);

		return {route: null, why, polish};
	}

	if (polish) {
		const llm = refFor(catalog, "llm");
		const answer = candidateRoute("llm", llm, input, source);

		if (answer.route) {
			return {route: answer.route, why: null, polish};
		}

		// The cleanup pass is the language model's alone, so its CPU copy
		// is its last way in too, where the GPU cannot run it.
		if (llm && cpuLastResort(llm, input)) {
			const onCpuAnswer = candidateRoute("llm", llm, onCpu(input), source);

			if (onCpuAnswer.route) {
				return {route: onCpuAnswer.route, why: null, polish};
			}

			// Its reason ranks with the GPU's as the table's do: a declined
			// download or a switch off says more than the GPU's code.
			return {route: null, why: pickReason([answer.why, onCpuAnswer.why]), polish};
		}

		return {route: null, why: answer.why, polish};
	}

	const blocks: RouteBlock[] = [];
	const classes = orderedClasses(table, input, source);

	for (const group of classes) {
		let first: Route | null = null;

		for (const candidate of group) {
			const answer = candidateRoute(candidate, refFor(catalog, candidate), input, source);

			if (!answer.route) {
				blocks.push(answer.why);
				continue;
			}

			// Preference inside the class only: an equivalent model whose copy
			// is already on the device answers at once instead of waiting for
			// a download. Only the candidate's own route counts: a copy on a
			// device further down its order does not outrank the better device.
			if (input.cached?.(answer.route.ref, answer.route.device)) {
				return {route: answer.route, why: null, polish};
			}

			first = first ?? answer.route;
		}

		if (first) {
			return {route: first, why: null, polish};
		}
	}

	// Nothing in the table took it: the language model's CPU copy, where
	// the GPU cannot run it, is the last way in (`cpuLastResort`).
	const llm = refFor(catalog, "llm");

	if (llm && classes.some((group) => group.includes("llm")) && cpuLastResort(llm, input)) {
		const answer = candidateRoute("llm", llm, onCpu(input), source);

		if (answer.route) {
			return {route: answer.route, why: null, polish};
		}

		blocks.push(answer.why);
	}

	return {route: null, why: pickReason(blocks), polish};
}

/**
 * Under Auto the language model runs on the GPU alone (models.ts
 * `deviceOrder`), but where the GPU cannot run it at all -- no WebGPU,
 * below WebLLM's limits, a binding too small, a GPU lost here before
 * (`GPU_LOST`) -- its CPU copy is the only way to the pairs no small model
 * covers (translation.md § The ladder, step 6). It comes
 * after every class of the table, since a line on it takes a while: a
 * small model, or NLLB-200 once switched on, answers first. Its download
 * is asked for like any other, as slow (translate/index.ts `askDownload`).
 * Not after a yes to carrying on on the CPU, when Auto's own order already
 * has it, nor for a pinned device.
 */
export function cpuLastResort(ref: ModelRef, input: RouteInput): boolean {
	return (
		ref.family === "llm" &&
		choiceFor(ref, input.devices) === "auto" &&
		!input.llmCpuAfterGpu &&
		input.capability !== null &&
		modelBlock(ref, "gpu", input.capability, ALL_ON) !== null
	);
}

/** The input with the language model pinned to the CPU. */
function onCpu(input: RouteInput): RouteInput {
	return {...input, devices: {...input.devices, llm: "cpu"}};
}

/**
 * The pair's classes in the order the user's preference asks for (see
 * `RouteInput.prefer`).
 */
function orderedClasses(
	table: RouteTable,
	input: RouteInput,
	source: string | null
): Candidate[][] {
	const classes = candidatesFor(table, source, input.to);

	if (input.prefer === "llm") {
		return withLlmAt(classes, "first");
	}

	if (input.prefer === "small") {
		return withLlmAt(classes, "last");
	}

	return classes;
}

export function resolveRoute(
	table: RouteTable,
	catalog: ModelCatalog,
	input: RouteInput
): Route | null {
	return explainRoute(table, catalog, input).route;
}

/**
 * Whether anything can translate here at all, and if not why: the language
 * model in use, OPUS-MT and NLLB-200, each walked over its devices as the
 * router walks them (`deviceOrder`, `modelBlock`). Null once any runs.
 * NLLB-200 counts only while switched on: its opt-in never makes translation
 * as a whole unavailable (a pair only NLLB serves says so in
 * `explainRoute`). Of the language model's and OPUS-MT's blocks, a switch
 * the user turned off is the one named (turning it on is the fix; both off
 * is `engine: "all"`), else OPUS-MT's (it is the floor every device that
 * translates at all can reach).
 */
export function translationBlock(
	catalog: ModelCatalog,
	capability: Capability | null,
	switches: EngineSwitches,
	devices: DeviceChoices,
	enabled = true
): ModelBlock | null {
	if (!enabled) {
		return {kind: "disabled"};
	}

	// Nothing runs here (translation is hidden): the CPU's code, as
	// `explainRoute` gives it.
	if (capability?.tier === "none") {
		return modelBlock(catalog.nllb, "cpu", capability, {llm: true, opus: true, nllb: true});
	}

	// The walk knows no session state here (nothing down, nothing refused),
	// so the reason it gives is a model's own block.
	const walk = (ref: ModelRef) =>
		walkDevices(candidateOf(ref), ref, {
			from: null,
			hint: null,
			to: "",
			tier: capability?.tier ?? "none",
			switches,
			devices,
			down: new Set(),
			capability,
		}).why as ModelBlock | null;
	const walked = walk(catalog.llm);
	const lastResort: RouteInput = {
		from: null,
		hint: null,
		to: "",
		tier: capability?.tier ?? "none",
		switches,
		devices,
		down: new Set(),
		capability,
	};
	// Where the GPU cannot run it, Auto still reaches its CPU copy after the
	// table (`cpuLastResort`): that is a way in too, and with the language
	// model switched off its switch is what would open it.
	const cpuWhy =
		walked !== null && cpuLastResort(catalog.llm, lastResort)
			? (walkDevices("llm", catalog.llm, onCpu(lastResort)).why as ModelBlock | null)
			: undefined;
	const llm = cpuWhy === null ? null : cpuWhy?.kind === "off" ? cpuWhy : walked;

	// NLLB-200 switched on and able to run is a way in of its own (it needs
	// no other switch); switched off it is never the reason.
	if (switches.nllb && walk(catalog.nllb) === null) {
		return null;
	}

	// Every OPUS-MT pair shares its copies' needs and its switch: one stands
	// for them all. A catalog without any leaves the language model alone.
	const opus = Object.values(catalog.opus)[0];

	if (!opus) {
		return llm;
	}

	const cpu = walk(opus);

	if (!llm || !cpu) {
		return null;
	}

	if (llm.kind === "off" && cpu.kind === "off") {
		return {kind: "off", engine: "all"};
	}

	return llm.kind === "off" ? llm : cpu;
}

/** A deploy's `translation.routes` over the shipped table, one entry at a time. */
export function mergeRoutes(base: RouteTable, override: RouteTable): RouteTable {
	const merged: RouteTable = {};

	for (const [to, sources] of Object.entries(base)) {
		merged[to] = {...sources};
	}

	for (const [to, sources] of Object.entries(override)) {
		merged[to] = {...(merged[to] ?? {}), ...sources};
	}

	return merged;
}
