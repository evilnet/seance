// The GPU tier (spec § engines/webllm.ts): WebLLM's MLCEngine behind the
// Engine interface. One model at a time. Generation is greedy at a low
// temperature, thinking off, a token budget from the input length, and a
// stop at the batch sentinel — a single-line request has no stop at all,
// because with thinking off WebLLM prepends an empty `<think></think>`
// block to the reply that a "\n" stop matched inside.
//
// So a single-line generation is consumed whole and the answer is picked
// out of it here: the lines up to the first **blank** one (a blank line
// opens the note the prompt forbade), minus the source echoed back, a bare
// `"""` fence and the canned greetings of `EXAMPLES` — a small model asked
// to translate often repeats the text before it gets to the translation,
// and sometimes greets instead of translating at all. What is left is
// joined back into one line, so a long message the model wrapped over
// several lines arrives whole; it used to be cut at the first of them.
//
// The library arrives through `WebLlmDeps` so this file never imports it;
// webllm.real.ts does.
//
// A GPU model may load as its small-buffer build (models.ts
// `smallBufferBuildFor`, docs/resources/translation.md § Phones and small
// GPUs): WebLLM is then handed that build's own record — its id, the pinned
// weights, the app's library — after its rewritten manifest has been put
// where WebLLM reads it (`WebLlmDeps.seedSplit`). Everything above the
// engine keeps the model's own id: `isLoaded`, `loadedModels` and the
// requests' `model` name the 1.7B whichever build runs.
//
// The same engine runs the language model on the CPU (cpuLlm.ts): created
// with `{device: "cpu", contextWindow: CPU_CONTEXT_WINDOW}` over an
// `MlcLike` of the CPU library's. On the CPU no WebLLM record is read (its
// `create` ignores the app config), no small-buffer build applies, and a
// failure is never a lost GPU: only the GPU instance is handed
// `takeDeviceLoss`.

import {fitToWindow} from "../budget";
import {
	BATCH_REFUSED,
	Device,
	CONTEXT_OVERFLOW,
	gpuLost,
	Engine,
	EngineCapabilities,
	EngineError,
	EngineStatus,
	LoadProgress,
	ModelRef,
	SmallBufferBuild,
	TranslateChunk,
	TranslateRequest,
} from "../engine";
import {
	DEFAULT_CONTEXT_WINDOW,
	GpuBudget,
	ModelCatalog,
	contextWindowFor,
	smallBufferBuildFor,
} from "../models";
import {
	ChatMessage,
	END_SENTINEL,
	EXAMPLE_ANSWERS,
	cleanOutput,
	stripSentinel,
	EXAMPLES,
} from "../prompt";
import {PromptProfile, promptProfileFor} from "../prompts";
import {QWEN3_1_7B_PROMPT} from "../prompts/qwen3-1.7b";

export interface ChatRequest {
	messages: ChatMessage[];
	stream: true;
	temperature: number;
	max_tokens: number;
	stop?: string[];
	extra_body?: {enable_thinking?: boolean};
}

export interface ChatDelta {
	choices: {delta: {content?: string | null}}[];
}

/** The `chatOpts` a reload may carry: WebLLM's `ChatOptions`, the field used here. */
export interface ReloadOptions {
	/** Overrides the record's `overrides.context_window_size`: the KV cache is sized to it at load. */
	context_window_size?: number;
}

/** The slice of MLCEngine the engine uses. */
export interface MlcLike {
	reload(modelId: string, chatOpts?: ReloadOptions): Promise<void>;
	unload(): Promise<void>;
	interruptGenerate(): void;
	chat: {completions: {create(request: ChatRequest): Promise<AsyncIterable<ChatDelta>>}};
}

/** WebLLM's `ModelRecord`, the fields that matter here. */
export interface ModelRecord {
	model_id: string;
	model: string;
	model_lib: string;
	vram_required_MB?: number;
	low_resource_required?: boolean;
	/** WebLLM's per-model config overrides (context window, sliding window, …). */
	overrides?: Record<string, unknown>;
}

export interface WebLlmDeps {
	create(
		appConfig: {model_list: ModelRecord[]},
		onProgress: (report: {progress: number; text: string}) => void
	): MlcLike;
	prebuilt: ModelRecord[];
	/** The loaded model's prompt profile; `prompts/index.ts` `promptProfileFor` unless a caller swaps it. */
	promptProfileFor?: (modelId: string) => PromptProfile;
	/**
	 * The app's root URL, which a small-buffer build's `lib` is relative
	 * to: the worker's own location less its `js/` (webllm.real.ts), never
	 * "/", since a deploy may live under a subpath.
	 */
	appRoot?: string;
	/**
	 * Puts a small-buffer build's rewritten manifest where WebLLM will read
	 * it, before its reload (splitManifest.ts `seedSplitManifest`). Rejects
	 * with the reason when the published manifest is not the model the
	 * library was built from; the build then does not load.
	 */
	seedSplit?(build: SmallBufferBuild): Promise<unknown>;
	/**
	 * The GPU instance's: the last device loss recorded (gpuLimits.ts
	 * `takeDeviceLoss`), so a failed generation can say the GPU stopped. The
	 * CPU instance has none, and a GPU loss is never reported as its own.
	 */
	takeDeviceLoss?: () => {reason: string; message: string} | null;
}

/** How one instance runs: on which device, and with which window. */
export interface WebLlmOptions {
	/** The device this instance's models load on; "gpu" unless said. */
	device?: Device;
	/**
	 * The context window every reload asks for, in tokens, instead of the
	 * GPU's (`contextWindowFor`): the CPU instance's `CPU_CONTEXT_WINDOW`.
	 */
	contextWindow?: number;
}

const HF_MLC = "https://huggingface.co/mlc-ai/";

/**
 * The `model_list` WebLLM is created with for `ref`: the prebuilt record as
 * it stands, or that record pointed at the deploy's mirror.
 *
 * A mirror is a whole mirror. `translation.modelBase` moves the weights
 * *and* the compiled GPU library, which otherwise comes from
 * raw.githubusercontent.com — a deploy that mirrors to keep its users off
 * third-party hosts (or to work at all behind a firewall) must not be left
 * fetching a WASM from GitHub (findings F18). `translation.llm.lib` names
 * the library outright and wins. Everything else the prebuilt record
 * carries — `overrides`, `vram_required_MB`, `low_resource_required` — is
 * kept: it describes the model, not where it is served from.
 */
export function appConfigFor(
	ref: ModelRef,
	prebuilt: ModelRecord[],
	mirror: {modelBase?: string; lib?: string}
): {model_list: ModelRecord[]} {
	const known = prebuilt.find((record) => record.model_id === ref.id);
	const base = mirror.modelBase?.replace(/\/+$/, "");
	const mirroredLib =
		base && known?.model_lib ? `${base}/${known.model_lib.split("/").pop()!}` : undefined;
	const lib = mirror.lib ?? mirroredLib ?? known?.model_lib;

	if (!lib) {
		throw new Error(`unknown WebLLM model ${ref.id}: set translation.llm.lib`);
	}

	if (known && !base && !mirror.lib) {
		return {model_list: [known]};
	}

	const model = base ? `${base}/${ref.id}/` : known?.model ?? `${HF_MLC}${ref.id}/resolve/main/`;

	return {model_list: [{...known, model_id: ref.id, model, model_lib: lib}]};
}

/**
 * The `model_list` for `ref`'s small-buffer build: the model's prebuilt
 * record — its context window, its memory figures — under the build's own
 * id, pointed at the pinned weights and at the app's library resolved
 * against `appRoot`. An absolute library URL, so WebLLM caches it by that
 * URL (a changed library has a changed name) instead of resolving it
 * against the worker's origin.
 */
export function smallBufferConfig(
	ref: ModelRef,
	build: SmallBufferBuild,
	prebuilt: ModelRecord[],
	appRoot: string
): {model_list: ModelRecord[]} {
	const known = prebuilt.find((record) => record.model_id === ref.id);

	if (!known) {
		throw new Error(`unknown WebLLM model ${ref.id}: no record to build ${build.id} from`);
	}

	return {
		model_list: [
			{
				...known,
				model_id: build.id,
				model: build.model,
				model_lib: new URL(build.lib, appRoot).href,
			},
		],
	};
}

/** Qwen3-1.7B's token budget (prompts/qwen3-1.7b.ts); each profile has its own. */
export function maxTokensFor(req: TranslateRequest): number {
	return QWEN3_1_7B_PROMPT.maxTokensFor(req);
}

/**
 * WebLLM's prompt-too-long error (`ContextWindowSizeExceededError`, thrown
 * before prefill — nothing ran on the GPU): by its name, which WebLLM sets
 * as a string and a minifier keeps, or by its message.
 */
export function isContextOverflow(e: unknown): boolean {
	return (
		e instanceof Error &&
		(e.name === "ContextWindowSizeExceededError" ||
			e.message.startsWith("Prompt tokens exceed context window size"))
	);
}

/** The window a record loads with when the reload names none: its own override, else 4096. */
function recordWindow(record: ModelRecord | undefined): number {
	const own = record?.overrides?.context_window_size;

	return typeof own === "number" && own > 0 ? own : DEFAULT_CONTEXT_WINDOW;
}

/** The empty thinking block, and the opener on its own while the rest streams in. */
const THINK_BLOCK = /^\s*<think>[\s\S]*?<\/think>\s*/;
const THINK_OPEN = /^\s*<think>/;

/**
 * What of the raw reply is the translation. With `enable_thinking: false`
 * WebLLM does not ask the model not to think: it encodes `<think>\n\n</think>`
 * itself and pushes those tokens into the output before prefill, so every
 * reply starts with a block the model never generated. `null` means the
 * block is still open — there is nothing to show yet.
 */
function visibleText(raw: string): string | null {
	if (THINK_OPEN.test(raw) && !THINK_BLOCK.test(raw)) {
		return null;
	}

	return raw.replace(THINK_BLOCK, "");
}

/** A line of nothing but quotes or a fence: the model opened a block. */
const FENCE_ONLY = /^(?:"""|["'“”„«»])+$/;

/** For comparing a line with the source: spacing, case and one final .!? do not count. */
function normalise(text: string): string {
	return text
		.trim()
		.replace(/\s+/g, " ")
		.toLowerCase()
		.replace(/[.!?]$/, "");
}

/** What a line carries once its fence and its label are off; "" when nothing. */
function content(line: string): string {
	const clean = cleanOutput(line);

	return FENCE_ONLY.test(clean) ? "" : clean;
}

/**
 * Not a translation: the source echoed back, an empty line, or a bare
 * fence. `req.text` is the protected text, the same the model was shown,
 * so the comparison is like for like.
 */
function isEcho(line: string, source: string): boolean {
	const carried = content(line);

	return carried === "" || normalise(carried) === normalise(source);
}

/**
 * A canned greeting the model offers instead of translating (`EXAMPLES` in
 * prompt.ts). It is fluent target-language text and it is not the source,
 * so nothing else would catch it: shown, it is a confident translation of
 * somebody else's sentence.
 */
function isExampleAnswer(carried: string): boolean {
	return (
		carried !== "" && EXAMPLE_ANSWERS.some((answer) => normalise(answer) === normalise(carried))
	);
}

/** Words a source may have and still be a greeting the canned answer translates. */
const GREETING_WORDS = 6;

/**
 * The canned answer that is a translation after all: the target language's
 * own greeting for a source that is a short question -- "hey, how's it
 * going?" into Spanish is "hola, ¿cómo estás?". Measured on the web build's
 * 4B weights, where the guard failed exactly that line. A canned answer in
 * another language, or for a longer or non-question line, is still a
 * greeting instead of a translation.
 */
function greetingFits(carried: string, source: string, to: string | undefined): boolean {
	const own = to ? EXAMPLES[to] : undefined;
	const line = source.trim();

	return (
		own !== undefined &&
		normalise(own) === normalise(carried) &&
		/[?\uff1f]$/.test(line) &&
		line.split(/\s+/).length <= GREETING_WORDS
	);
}

/** What the guards took out of a single-line reply, and what they left. */
interface Scan {
	/** The lines that are the translation, cleaned, in order. */
	kept: string[];
	/** A canned answer was dropped — and it was not the source read back. */
	example: boolean;
}

/**
 * A single-line reply, line by line, up to the first **blank** one: a blank
 * line opens the note or the explanation the prompt forbade, and nothing
 * past it is the translation. Everything before it that is not the source
 * read back, a bare fence or a canned answer is kept — a translation the
 * model wrapped over two lines is both of them, which is why the cut at the
 * first line is gone.
 *
 * The echo check comes first on purpose: a line that is both the source and
 * a canned answer (the source *is* "hallo, wie geht es dir?") is an echo,
 * not a refusal.
 */
function scanLines(text: string, source: string, to?: string): Scan {
	const scan: Scan = {kept: [], example: false};

	for (const raw of text.split("\n")) {
		const line = raw.replace(/\r$/, "");

		if (line.trim() === "") {
			break;
		}

		const carried = content(line);

		if (carried === "" || isEcho(line, source)) {
			continue;
		}

		if (isExampleAnswer(carried) && !greetingFits(carried, source, to)) {
			scan.example = true;
			continue;
		}

		scan.kept.push(carried);
	}

	return scan;
}

/** The last line that carries anything at all: better than showing nothing. */
function lastCarried(text: string): string {
	const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));

	for (let i = lines.length - 1; i >= 0; i--) {
		const carried = content(lines[i]);

		if (carried !== "") {
			return carried;
		}
	}

	return "";
}

/**
 * What to show while a single-line reply is still coming: the lines that
 * are the translation so far, joined, and the line still being generated
 * after them. Past a blank line nothing more is shown.
 */
function progressText(shown: string, source: string, to?: string): string {
	const parts = shown.split("\n");
	const complete = parts.slice(0, -1);
	const scan = scanLines(complete.join("\n"), source, to);
	const done = complete.some((line) => line.trim() === "");

	return (done ? scan.kept : [...scan.kept, parts[parts.length - 1]])
		.filter((part) => part !== "")
		.join(" ");
}

export class WebLlmEngine implements Engine {
	readonly name = "llm" as const;
	private engine: MlcLike | null = null;
	private model: string | null = null;
	/** In-flight `load()` calls, deduped by model id (as in seq2seq.ts). */
	private loading = new Map<string, Promise<void>>();
	private state: EngineStatus = "cold";
	private catalog: ModelCatalog | null = null;
	/** What the page's probe measured (protocol.ts `configure`); null before it. */
	private gpu: GpuBudget | null = null;
	/**
	 * The context window the loaded model was given, in tokens: every
	 * request is fitted to it (budget.ts `fitToWindow`).
	 */
	private window = DEFAULT_CONTEXT_WINDOW;
	private deps: WebLlmDeps;
	private languageName: (code: string) => string;
	private device: Device;
	private fixedWindow: number | null;
	private failures = 0;
	private failuresModel: string | null = null;
	/**
	 * The id of the request whose generation is running. WebLLM serialises
	 * generations per model behind its own lock, so a second request sits in
	 * `create()` until the first is done — but `interruptGenerate()` is
	 * engine-global and would end whatever is generating. Only the request
	 * that owns the generation may interrupt it; a queued one just drops out.
	 */
	private generating: number | null = null;

	constructor(
		deps: WebLlmDeps,
		languageName: (code: string) => string,
		options: WebLlmOptions = {}
	) {
		this.deps = deps;
		this.languageName = languageName;
		this.device = options.device ?? "gpu";
		this.fixedWindow = options.contextWindow ?? null;
	}

	/** Consecutive generation failures; a completed generation resets it. */
	get generationFailures(): number {
		return this.failures;
	}

	/** The loaded model's context window, in tokens (4096 until a model loads). */
	get contextWindow(): number {
		return this.window;
	}

	configure(catalog: ModelCatalog, gpu?: GpuBudget | null): void {
		this.catalog = catalog;

		if (gpu !== undefined) {
			this.gpu = gpu;
		}
	}

	/** The build of `ref` this device loads (models.ts `smallBufferBuildFor`); null: the model itself. */
	buildFor(ref: ModelRef): SmallBufferBuild | null {
		return this.device === "gpu" ? smallBufferBuildFor(ref, this.gpu?.maxBufferBytes) : null;
	}

	/** What WebLLM is created with for `ref`; nothing on the CPU, whose `create` reads none. */
	private appConfig(ref: ModelRef, build: SmallBufferBuild | null): {model_list: ModelRecord[]} {
		if (this.device !== "gpu") {
			return {model_list: []};
		}

		return build
			? smallBufferConfig(ref, build, this.deps.prebuilt, this.appRoot())
			: appConfigFor(ref, this.deps.prebuilt, {
					modelBase: this.catalog?.modelBase,
					lib: ref.lib,
			  });
	}

	// Two callers can ask for the same model at once — Settings downloading it
	// while a translation waits for it — and a reload takes minutes: the second
	// caller waits on the first instead of unloading the engine the first one is
	// still reloading.
	async load(
		ref: ModelRef,
		_device: Device,
		onProgress: (p: LoadProgress) => void
	): Promise<void> {
		const inFlight = this.loading.get(ref.id);

		if (inFlight) {
			await inFlight;
			return;
		}

		const promise = this.loadOnce(ref, onProgress);

		this.loading.set(ref.id, promise);

		try {
			await promise;
		} finally {
			this.loading.delete(ref.id);
		}
	}

	private async loadOnce(ref: ModelRef, onProgress: (p: LoadProgress) => void): Promise<void> {
		this.state = "loading";

		try {
			const build = this.buildFor(ref);
			const appConfig = this.appConfig(ref, build);
			// Let go of the old engine before awaiting its unload, not after: a
			// translate() landing in between must report "model not loaded"
			// rather than generate on an engine that is being torn down.
			const previous = this.engine;

			this.engine = null;
			this.model = null;

			if (previous) {
				await previous.unload();
			}

			if (build) {
				if (!this.deps.seedSplit) {
					throw new Error(`${build.id} needs its manifest seeded, and nothing here can`);
				}

				await this.deps.seedSplit(build);
			}

			this.engine = this.deps.create(appConfig, (report) =>
				onProgress({fraction: report.progress, text: report.text})
			);
			// The build's own id is what WebLLM knows; this engine answers
			// for the model's (isLoaded, loadedModels, the requests' model).
			// A phone's window is smaller than the record's (models.ts
			// `contextWindowFor`): the KV cache is the memory the window
			// costs, allocated whole at load. Elsewhere the reload is the
			// one it always was, and the record's own window holds. An
			// instance given its own window (the CPU's) always asks for it.
			const window = this.fixedWindow ?? contextWindowFor(this.gpu);

			if (window !== null) {
				await this.engine.reload(build?.id ?? ref.id, {context_window_size: window});
			} else {
				await this.engine.reload(build?.id ?? ref.id);
			}

			this.window = window ?? recordWindow(appConfig.model_list[0]);
			this.model = ref.id;
			this.state = "ready";

			if (this.failuresModel !== ref.id) {
				this.failures = 0;
				this.failuresModel = ref.id;
			}
		} catch (e) {
			const created = this.engine;

			this.engine = null;
			this.model = null;
			this.state = "failed";

			if (created) {
				await created.unload().catch(() => {});
			}

			throw e;
		}
	}

	private appRoot(): string {
		if (!this.deps.appRoot) {
			throw new Error("the small-buffer build needs the app's root URL");
		}

		return this.deps.appRoot;
	}

	async unload(): Promise<void> {
		await this.engine?.unload();
		this.engine = null;
		this.model = null;
		this.state = "cold";
	}

	status(): EngineStatus {
		return this.state;
	}

	loadedModels(): string[] {
		return this.model ? [this.model] : [];
	}

	isLoaded(id: string, device?: Device): boolean {
		return (device === undefined || device === this.device) && this.model === id;
	}

	capabilities(): EngineCapabilities {
		return {streams: true, batches: true};
	}

	/**
	 * A finished single-line reply as the one line a message is: everything
	 * up to the first blank line that is not the source read back or a
	 * canned answer, joined with single spaces.
	 *
	 * Nothing left, with a canned answer among what was dropped, is a
	 * refusal rather than an empty translation — the composer's strip offers
	 * "send as written" and a reading line offers Retry. Nothing left with
	 * only the source read back keeps the old fallback: the last line that
	 * carries anything, which beats showing nothing.
	 */
	private oneLine(text: string, source: string, to?: string): string {
		const scan = scanLines(text, source, to);

		if (scan.kept.length > 0) {
			return scan.kept.join(" ");
		}

		if (scan.example) {
			throw new EngineError("the model answered with the example", "request");
		}

		return lastCarried(text);
	}

	async *translate(req: TranslateRequest, signal: AbortSignal): AsyncIterable<TranslateChunk> {
		const engine = this.engine;

		if (!engine || this.model !== req.model) {
			throw new Error(`model not loaded: ${req.model}`);
		}

		const onAbort = () => {
			if (this.generating === req.id) {
				engine.interruptGenerate();
			}
		};

		signal.addEventListener("abort", onAbort);

		// The loaded model's own wording and budget (prompts/): a model is
		// asked the way it was measured, never with another model's prompt.
		const profile = (this.deps.promptProfileFor ?? promptProfileFor)(this.model ?? req.model);

		try {
			// The prompt and the reply's budget inside the loaded window
			// (budget.ts): the context trimmed when it must be. A batch
			// that does not fit even bare is refused the way a batch the
			// engine cannot take is, and its lines come one at a time
			// (queue.ts `resplit`, outgoing.ts `translateDraft`); a single
			// line that does not fit is too long for this window.
			const fitted = fitToWindow(req, this.window, profile, this.languageName);

			if (!fitted) {
				throw new EngineError(req.lines ? BATCH_REFUSED : CONTEXT_OVERFLOW, "request");
			}

			const stream = await engine.chat.completions.create({
				messages: profile.buildMessages(fitted, this.languageName),
				stream: true,
				// A cleanup is decided greedily, as it was measured: on the web
				// weights a correction can hinge on one token's narrow lead
				// ("you" 50.4 % against "your" 47.3 %), and 0.1 turns that
				// into a coin flip.
				temperature: req.purpose === "polish" ? 0 : 0.1,
				max_tokens: profile.maxTokensFor(fitted),
				stop: req.lines ? [`\n${END_SENTINEL}`] : [],
				extra_body: {enable_thinking: false},
			});

			// The lock is ours from here, so an abort from now on is ours to
			// act on — the loop's drain is what ends a generation nobody
			// wants any more, whether the abort came before it or during it.
			this.generating = req.id;

			let text = "";

			for await (const delta of stream) {
				if (signal.aborted) {
					// Drain, never return: WebLLM releases its per-model lock only
					// when its generator finishes, and resets its interrupt flag
					// when a generation starts, so ask again on every chunk until
					// it stops. Nothing is yielded after an abort.
					engine.interruptGenerate();
					continue;
				}

				const piece = delta.choices[0]?.delta?.content ?? "";

				if (piece === "") {
					continue;
				}

				text += piece;

				const visible = visibleText(text);

				if (visible === null) {
					continue;
				}

				// A single-line reply that opens with a newline is not an
				// empty translation: the leading whitespace goes first.
				const shown = req.lines ? visible : visible.trimStart();

				if (req.lines) {
					yield {id: req.id, text: shown, done: false};
					continue;
				}

				// The whole generation is consumed: a single-line request
				// used to be cut at its first complete line, which dropped
				// every later sentence when the model wrapped a long answer
				// or restated the line before translating it.
				yield {id: req.id, text: progressText(shown, req.text, req.to), done: false};
			}

			// A drained (aborted) generation proves nothing about the model:
			// only a completed one clears the failure count.
			if (!signal.aborted) {
				this.failures = 0;

				const visible = visibleText(text);

				if (visible !== null) {
					// A batched answer is cleaned line by line, where it is
					// parsed; a single one is its lines up to the first blank
					// one, the source read back and the canned answers
					// dropped, joined back into the one line a message is.
					const done = stripSentinel(req.lines ? visible : visible.trimStart());

					yield {
						id: req.id,
						text: req.lines ? done : this.oneLine(done, req.text, req.to),
						done: true,
					};
				}
			}
		} catch (e) {
			// A guard's refusal is about this answer, not about the device:
			// the model stays loaded and the request is the one that failed.
			if (e instanceof EngineError) {
				throw e;
			}

			if (signal.aborted) {
				return;
			}

			// WebLLM refused the prompt as longer than the window, before
			// prefill: the bound under-counted (budget.ts). Nothing ran on
			// the GPU, so the model stays loaded and no failure is counted —
			// treating it as a lost device would reload a gigabyte, which on
			// a phone is what gets the page killed. The queue retries the
			// line bare and alone.
			if (isContextOverflow(e)) {
				throw new EngineError(CONTEXT_OVERFLOW, "request");
			}

			// A generation that threw is a device that may be gone (spec
			// § Lifecycle): drop the engine so the next request reloads it;
			// the second failure in a row is the model's failure, not the
			// request's, and the service takes the candidate down.
			this.failures++;
			this.engine = null;
			this.model = null;
			this.state = "failed";
			await engine.unload().catch(() => {});

			// A lost device settles its `lost` promise a moment after the
			// call that failed on it: wait one turn of the event loop, then
			// say why the GPU went away beside what failed (gpuLimits.ts).
			// Only the GPU instance asks; a CPU failure is the CPU's.
			const take = this.deps.takeDeviceLoss;
			let loss: {reason: string; message: string} | null = null;

			if (take) {
				await new Promise((resolve) => setTimeout(resolve, 50));
				loss = take();
			}

			const failed = e instanceof Error ? e.message : String(e);

			throw new EngineError(
				loss ? gpuLost(loss.message || loss.reason, failed) : failed,
				this.failures >= 2 ? "load" : "request"
			);
		} finally {
			if (this.generating === req.id) {
				this.generating = null;
			}

			signal.removeEventListener("abort", onAbort);
		}
	}
}
