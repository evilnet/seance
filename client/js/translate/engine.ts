// The one interface both translation engines implement (spec:
// docs/projects/client-translation.md § engine.ts). Streaming is the base
// contract: the LLM yields cumulative text as it decodes, a seq2seq engine
// yields once with `done: true`. Nothing here touches Vue, the store, the
// DOM or a library, so mocha loads it and test/translate/fakeEngine.ts can
// stand in for either engine.

import type {MarkerForm} from "./spans";
import type {EmbeddingSplit} from "./engines/splitManifest";

/**
 * The service's slot for a model: `llm` is the language model's, `seq2seq`
 * is OPUS-MT's and NLLB-200's. It names a slot, not a device: every model
 * can run on either device its `copies` list (models.ts).
 */
export type EngineName = "llm" | "seq2seq";
/** Where a model runs: WebGPU, or the CPU (WASM). */
export type Device = "gpu" | "cpu";
/** A device setting: let the router pick, or pin one. */
export type DeviceChoice = "auto" | Device;
export type ModelFamily = "llm" | "nllb" | "opus";
export type EngineStatus = "cold" | "loading" | "ready" | "failed";

/**
 * How a model is named in the interface, as a code plus the values the
 * phrase needs: an OPUS-MT pair names its two languages, NLLB names
 * itself, a GPU model carries its own product name.
 */
export type ModelLabel =
	| {kind: "opus"; from: string; to: string}
	| {kind: "nllb"}
	| {kind: "llm"; name: string};

/**
 * A GPU model built for small buffers (tools/translate-split/): its own
 * WebLLM record and cache keys, the published weights through a rewritten
 * tensor manifest (engines/splitManifest.ts), the app's own library.
 */
export interface SmallBufferBuild {
	/** Its WebLLM `model_id`: never the model's own, so nothing in the caches is shared. */
	id: string;
	/**
	 * The published model directory the split was cut from, with its
	 * revision pinned (`/resolve/<commit>/`): the byte ranges the rewrite
	 * names cannot drift under it, and its cache keys differ from the
	 * `resolve/main/` the model itself uses.
	 */
	model: string;
	/** The compiled library, a path under the app's own root (public/models/). */
	lib: string;
	/** The rows and the tensors' shapes the library was compiled for. */
	split: EmbeddingSplit;
	/** Its largest weight tensor: one half of the vocabulary table. */
	largestBufferBytes: number;
}

/**
 * One device's copy of a model: its own weights, so its own download,
 * size and (on the GPU) largest binding.
 */
export interface DeviceCopy {
	/** Approximate download size for Settings; 0 when unknown. */
	sizeBytes: number;
	/** The library's own id for this copy: a WebLLM `model_id`, a Hugging Face repo, a GGUF repo. */
	source: string;
	/** The weights' dtype where the library takes one (transformers.js). */
	dtype?: string;
	/** The single file to fetch, where the copy is one (a GGUF). */
	file?: string;
	/**
	 * The largest single buffer the copy binds on the GPU: every weight
	 * tensor is one storage binding, so a device below this cannot load it.
	 * Unknown (a deploy's own model): trusted to fit. CPU copies have none.
	 */
	largestBufferBytes?: number;
}

export interface ModelRef {
	engine: EngineName;
	family: ModelFamily;
	/** The library's own id: a WebLLM `model_id` or a Hugging Face repo. */
	id: string;
	/**
	 * What Settings shows, as data: this module is Vue-free and never
	 * imports the i18n runtime, so the catalog entry names its kind and
	 * the component renders it (helpers/modelLabel.ts).
	 */
	label: ModelLabel;
	/**
	 * The copies of this model by device; a device missing from the record
	 * has no copy (the 4B has no CPU one). Sizes and buffers live here.
	 */
	copies: Partial<Record<Device, DeviceCopy>>;
	/**
	 * The graphics memory the model needs at runtime (GPU copy only):
	 * what the capability probe's adapter limit is checked against when
	 * the default model is picked (models.ts `defaultLlmForAdapter`).
	 */
	vramBytes?: number;
	/**
	 * A GPU model's small-buffer build (models.ts `smallBufferBuildFor`):
	 * the same published weights read by a library of our own that splits
	 * the vocabulary table in two, for a GPU that cannot bind the model's
	 * `largestBufferBytes` (a phone's 128 MiB). Settings lists one model;
	 * which build loads is decided per device, at the WebLLM boundary.
	 */
	smallBuffer?: SmallBufferBuild;
	/** OPUS-MT pair models: [from, to] in ISO 639-1. */
	pair?: [string, string];
	/**
	 * A GPU model's compiled WebLLM library, when the deploy named one
	 * (`translation.llm.lib`): it belongs to that model alone, never to the
	 * other GPU choices.
	 */
	lib?: string;
}

export interface LoadProgress {
	/** 0..1 of the whole download. */
	fraction: number;
	text?: string;
}

export interface ContextLine {
	nick: string;
	text: string;
	translated?: string;
}

/** One batched line's own context (`TranslateRequest.lineContexts`). */
export interface LineContext {
	replyTo?: ContextLine;
}

/** What prompt.ts turns into the LLM's messages; seq2seq engines ignore it. */
export interface PromptContext {
	recent: ContextLine[];
	replyTo?: ContextLine;
	topic?: string;
	/**
	 * The channel's dominant language when the detector was unsure: the LLM
	 * is told it as a guess. Absent `TranslateRequest.hint`, a seq2seq route
	 * also takes it as the source (router.ts, service.ts).
	 */
	sourceHint?: string;
	names: string[];
	terms: [string, string][];
	/** The user's own recent lines in the target language (`purpose: "write"`). */
	voice: string[];
	formality: "auto" | "formal" | "casual";
	variant?: string;
}

export function emptyContext(): PromptContext {
	return {recent: [], names: [], terms: [], voice: [], formality: "auto"};
}

export interface TranslateRequest {
	/** Request id, for cancellation and for matching chunks. */
	id: number;
	/**
	 * The device to run on: set by the service on every request it posts;
	 * an engine without it uses the device its model is loaded on.
	 */
	device?: Device;
	/** `ModelRef.id` the router chose. */
	model: string;
	/** After span protection: placeholders are already in place. */
	text: string;
	/**
	 * The form `text`'s marker pairs are in (spans.ts `renderMarkers`), so
	 * the prompt can say what to keep. Absent means `placeholder`; the
	 * seq2seq engines ignore it, having no prompt to say it in.
	 */
	markers?: MarkerForm;
	/** A batched request: numbered lines in, numbered lines out (LLM only). */
	lines?: string[];
	/**
	 * A batched request's per-line context, one entry per `lines` entry: a
	 * batch is several people's lines, and each of them replies to whatever
	 * it replies to. The prompt writes each note against its own line number
	 * (prompt.ts `userPrompt`); without this the head's reply target stood
	 * above the whole block. Everything else -- the earlier lines, the
	 * topic, the names, the terms -- is the channel's and stays in
	 * `context`, which is the batch head's.
	 */
	lineContexts?: LineContext[];
	/** ISO 639-1 (639-3 codes are mapped by languages.ts); null = unknown. */
	from: string | null;
	/**
	 * The language the text is probably in when `from` is null, for routing
	 * only: it picks the table row and is a seq2seq request's source
	 * (service.ts), and never reaches a prompt. The composer's weak detector
	 * verdict travels here, since telling the LLM a guess the code judged
	 * too weak to trust is measured to cost it (prompt.ts). Absent, the
	 * router falls back to `context.sourceHint`.
	 */
	hint?: string | null;
	to: string;
	/**
	 * `read` a line someone else wrote, `write` the user's draft, or
	 * `polish` the user's draft in its own language: spelling, punctuation
	 * and grammar corrected, nothing translated (the composer's translate
	 * button with the same language picked twice; LLM only, router.ts).
	 */
	purpose: "read" | "write" | "polish";
	context: PromptContext;
}

export interface TranslateChunk {
	id: number;
	/** Cumulative for a streaming engine, the whole result for seq2seq. */
	text: string;
	done: boolean;
}

export interface EngineCapabilities {
	streams: boolean;
	batches: boolean;
	/** seq2seq only: multi-threaded WASM is available. */
	threads?: boolean;
}

export interface Engine {
	readonly name: EngineName;
	/** Load `ref`'s copy for `device`; an engine that serves one device only checks it is its own. */
	load(ref: ModelRef, device: Device, onProgress: (p: LoadProgress) => void): Promise<void>;
	unload(): Promise<void>;
	status(): EngineStatus;
	loadedModels(): string[];
	/** Whether `id` is loaded, on `device` when one is named. */
	isLoaded(id: string, device?: Device): boolean;
	capabilities(): EngineCapabilities;
	translate(req: TranslateRequest, signal: AbortSignal): AsyncIterable<TranslateChunk>;
}

/**
 * What a request with `lines` gets from an engine that does not batch (the
 * seq2seq engines; `TranslateService.translate` says it before posting).
 * The router may hand a batch an engine other than the one it was batched
 * for -- the GPU model switched off, or failing to load -- so this is the
 * caller's cue to send the lines one at a time, never the engine's failure.
 */
export const BATCH_REFUSED = "seq2seq engines do not batch";

/**
 * A request too long for the context window the GPU model was loaded with
 * (budget.ts `fitToWindow`, or WebLLM's own `ContextWindowSizeExceededError`
 * when the bound under-counted): the request's failure, never the model's —
 * the model stays loaded, nothing is marked down, and the reading queue
 * retries the line bare and alone and counts it toward no pause.
 */
export const CONTEXT_OVERFLOW = "the request does not fit the model's context window";

/**
 * The GPU went away under a generation (gpuLimits.ts records why from the
 * device's `lost`): `gpuLost` puts the platform's reason and the call that
 * failed on it after this code, and `parseGpuLost` takes them back out for
 * translateErrors.ts, which words the frame. Both parts are the browser's
 * own text and stay as they are.
 */
export const GPU_LOST = "the GPU device was lost";

export function gpuLost(reason: string, failed: string): string {
	return `${GPU_LOST}: ${reason.replace(/\n/g, " ")}\n${failed}`;
}

export function parseGpuLost(error: string): {reason: string; detail: string} | null {
	if (!error.startsWith(`${GPU_LOST}: `)) {
		return null;
	}

	const rest = error.slice(GPU_LOST.length + 2);
	const cut = rest.indexOf("\n");

	return cut < 0
		? {reason: rest, detail: ""}
		: {reason: rest.slice(0, cut), detail: rest.slice(cut + 1)};
}

/**
 * An engine's own failure classification. `load`: the model is gone or
 * cannot be used (a lost WebGPU device, twice); the service marks the
 * candidate down. `request`: this request failed (a bad pair, an
 * unsupported shape); the next request may succeed.
 */
export class EngineError extends Error {
	readonly cause: "load" | "request";

	constructor(message: string, cause: "load" | "request") {
		super(message);
		this.name = "EngineError";
		this.cause = cause;
	}
}
