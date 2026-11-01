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
// and the candidate's route is its first device left. A downloaded copy
// never reorders a candidate's devices -- the better device's copy is
// asked for, and only a declined download falls back to the copy already
// there. Inside a class a candidate whose route is already downloaded
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

	for (const device of deviceOrder(ref, choiceFor(ref, input.devices), input.capability)) {
		const block: RouteBlock | null =
			modelBlock(ref, device, input.capability, input.switches) ??
			(input.down.has(`${candidate}@${device}`)
				? {kind: "down"}
				: input.refuse?.(ref, device)
				? {kind: "download", ref, device}
				: null);

		if (!block) {
			return {device, why: null};
		}

		blocks.push(block);
	}

	return {device: null, why: deviceReason(blocks)};
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
		const answer = candidateRoute("llm", refFor(catalog, "llm"), input, source);

		return answer.route
			? {route: answer.route, why: null, polish}
			: {route: null, why: answer.why, polish};
	}

	const blocks: RouteBlock[] = [];

	for (const group of candidatesFor(table, source, input.to)) {
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

	return {route: null, why: pickReason(blocks), polish};
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
	const llm = walk(catalog.llm);

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
