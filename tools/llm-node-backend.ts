// The Node backend for tools/translate-llm.ts and tools/i18n/fill.ts: the
// shipped WebLlmEngine's `MlcLike` surface over transformers.js/ONNX, with
// the device-fallback load (cuda -> cuda-basic -> cpu) and a streaming
// generate. Extracted verbatim from the runner so both CLIs share it.
//
// The weights come from an ONNX export — the stock onnx-community one, or a
// local directory built by tools/translate-eval/mlc-to-q4.py +
// norm-fp32.py (the fp32-layer-norm CUDA fix — see that script's header
// for the all-NaN CUDA story).

import {
	AutoModelForCausalLM,
	AutoTokenizer,
	InterruptableStoppingCriteria,
	StoppingCriteriaList,
	TextStreamer,
	type ProgressInfo,
} from "@huggingface/transformers";
import {
	ChatDelta,
	ChatRequest,
	MlcLike,
	ModelRecord,
	WebLlmDeps,
} from "../client/js/translate/engines/webllm";

// The engine surface the CLIs build on travels with this module, so a tool
// imports the backend alone (tools/translate-llm.ts, tools/i18n/fill.ts).
export type {ChatDelta, ChatRequest, MlcLike, ModelRecord, WebLlmDeps};

export type Device = "cpu" | "cuda";
export type Purpose = "read" | "write" | "polish";
type Tokenizer = Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
type Model = Awaited<ReturnType<typeof AutoModelForCausalLM.from_pretrained>>;

/** The Hugging Face repository the MLC model id is served from here. */
export const ONNX_REPO = "onnx-community/Qwen3-1.7B-ONNX";
/** The default ONNX export (`--dtype`). */
export const DTYPE = "q4f16";
/** The ONNX exports transformers.js can load by name (`--dtype`). */
export const DTYPES = ["q4f16", "fp16", "fp32", "int8", "uint8", "q4", "q8", "bnb4"] as const;

export type Dtype = typeof DTYPES[number];
/** What WebLLM pushes into the output when thinking is off; see `create()`. */
export const THINK_BLOCK = "<think>\n\n</think>\n\n";
/** The same block as the chat template renders it, wherever it put it. */
export const CLOSED_THINK = /<think>\s*<\/think>/;

export function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

/** The earliest of `stops` in `text`; -1 when none of them is there. */
export function firstStop(text: string, stops: string[]): number {
	let at = -1;

	for (const stop of stops) {
		if (stop === "") {
			continue;
		}

		const found = text.indexOf(stop);

		if (found !== -1 && (at === -1 || found < at)) {
			at = found;
		}
	}

	return at;
}

/**
 * The deltas a generation produces, as the async iterable `MlcLike` owes the
 * engine: `model.generate()` is one await with a streamer callback, and the
 * engine consumes a stream, so the callback fills this and the loop drains it.
 */
export class DeltaQueue implements AsyncIterable<ChatDelta> {
	private items: string[] = [];
	private ended = false;
	private failure: unknown = null;
	private wake: (() => void) | null = null;

	push(text: string): void {
		this.items.push(text);
		this.signal();
	}

	finish(): void {
		this.ended = true;
		this.signal();
	}

	fail(error: unknown): void {
		this.failure = error;
		this.ended = true;
		this.signal();
	}

	private signal(): void {
		const wake = this.wake;

		this.wake = null;
		wake?.();
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<ChatDelta> {
		for (;;) {
			while (this.items.length > 0) {
				yield {choices: [{delta: {content: this.items.shift() ?? ""}}]};
			}

			if (this.failure !== null) {
				throw asError(this.failure);
			}

			if (this.ended) {
				return;
			}

			await new Promise<void>((resolve) => {
				this.wake = resolve;
			});
		}
	}
}

export interface BackendOptions {
	device: Device;
	repo: string;
	/** The ONNX export to load: q4f16 (the default), fp16, fp32, int8, uint8, q4, q8, bnb4. */
	dtype: Dtype;
	/** ONNX Runtime worker threads; null leaves its default (every core). */
	threads: number | null;
	log(text: string): void;
}

export interface LoadAttempt {
	device: Device;
	/** ONNX Runtime's `basic` graph optimization: the fallback for a session that will not build. */
	basic: boolean;
}

export function attemptsFor(device: Device): LoadAttempt[] {
	const cpu: LoadAttempt[] = [
		{device: "cpu", basic: false},
		{device: "cpu", basic: true},
	];

	return device === "cuda"
		? [{device: "cuda", basic: false}, {device: "cuda", basic: true}, ...cpu]
		: cpu;
}

/**
 * `MlcLike` over transformers.js. Everything the engine asks of WebLLM —
 * load one model, generate a stream, interrupt it, unload — with ONNX
 * Runtime underneath.
 */
export class NodeMlc implements MlcLike {
	readonly chat: MlcLike["chat"];
	/** The last rendered chat-template prompt, for `--show-prompt`. */
	lastPrompt = "";
	/** The last delta stream as the engine saw it, for `--raw`. */
	lastRaw = "";
	/** Whether the rendered prompt carried the closed thinking block. */
	promptHasThinkBlock = false;
	/** Which ONNX Runtime execution provider the weights actually loaded on. */
	device: Device = "cpu";

	private options: BackendOptions;
	private onProgress: (report: {progress: number; text: string}) => void;
	private tokenizer: Tokenizer | null = null;
	private model: Model | null = null;
	private loaded: string | null = null;
	private stopper: InterruptableStoppingCriteria | null = null;

	constructor(
		options: BackendOptions,
		onProgress: (report: {progress: number; text: string}) => void
	) {
		this.options = options;
		this.onProgress = onProgress;

		const create = (request: ChatRequest) => this.create(request);

		this.chat = {completions: {create}};
	}

	async reload(modelId: string): Promise<void> {
		if (this.loaded === modelId && this.model) {
			return;
		}

		const repo = this.options.repo;

		this.tokenizer = await AutoTokenizer.from_pretrained(repo, {
			progress_callback: (info: ProgressInfo) => this.progress(info),
		});

		let last: unknown = new Error("no load attempt was made");

		for (const attempt of attemptsFor(this.options.device)) {
			try {
				this.model = await AutoModelForCausalLM.from_pretrained(repo, {
					dtype: this.options.dtype,
					device: attempt.device,
					session_options: {
						...(attempt.basic ? {graphOptimizationLevel: "basic"} : {}),
						// `--threads`: ONNX Runtime pins its own worker threads, so a
						// process-level core limit (taskset) does not bound it.
						...(this.options.threads
							? {intraOpNumThreads: this.options.threads, interOpNumThreads: 1}
							: {}),
					},
					progress_callback: (info: ProgressInfo) => this.progress(info),
				});
				this.device = attempt.device;
				this.loaded = modelId;
				return;
			} catch (error) {
				last = error;
				this.options.log(
					`  ! ${attempt.device}${
						attempt.basic ? " with basic graph optimization" : ""
					} would not load: ${message(error)}`
				);
			}
		}

		throw asError(last);
	}

	async unload(): Promise<void> {
		const model = this.model;

		this.model = null;
		this.tokenizer = null;
		this.loaded = null;
		await model?.dispose();
	}

	interruptGenerate(): void {
		this.stopper?.interrupt();
	}

	/** transformers.js reports per file; the engine wants one fraction. */
	private progress(info: ProgressInfo): void {
		const report = info as {status: string; file?: string; progress?: number};

		this.onProgress({
			progress: typeof report.progress === "number" ? report.progress / 100 : 0,
			text: `${report.status} ${report.file ?? ""}`.trim(),
		});
	}

	private create(request: ChatRequest): Promise<AsyncIterable<ChatDelta>> {
		const tokenizer = this.tokenizer;
		const model = this.model;

		if (!tokenizer || !model) {
			throw new Error("model not loaded");
		}

		// Two casts, and only these: the library's generated types describe
		// neither the template kwargs it spreads into the Jinja render nor the
		// encoded inputs spread into generate().
		const applyTemplate = tokenizer.apply_chat_template.bind(tokenizer) as (
			messages: ChatRequest["messages"],
			options: Record<string, unknown>
		) => string;
		const generate = model.generate.bind(model) as (
			options: Record<string, unknown>
		) => Promise<unknown>;

		const prompt = applyTemplate(request.messages, {
			tokenize: false,
			add_generation_prompt: true,
			// Not one of apply_chat_template's own options: what is left of them
			// is spread into the template's variables, which is how Qwen3's
			// template sees it.
			enable_thinking: request.extra_body?.enable_thinking ?? true,
		});

		this.lastPrompt = prompt;
		this.promptHasThinkBlock = CLOSED_THINK.test(prompt);

		const inputs = tokenizer(prompt, {add_special_tokens: false}) as Record<string, unknown>;
		const queue = new DeltaQueue();
		const stopper = new InterruptableStoppingCriteria();
		const criteria = new StoppingCriteriaList();

		criteria.push(stopper);
		this.stopper = stopper;

		const stops = request.stop ?? [];
		let raw = "";
		let stopped = false;

		// With `enable_thinking: false` WebLLM does not ask the model not to
		// think: it encodes `<think>\n\n</think>` itself and pushes those
		// tokens into the *output* before prefill, so every reply the engine
		// sees starts with a block the model never generated — which is what
		// `visibleText()` in webllm.ts strips. Qwen3's chat template puts the
		// same block at the end of the *prompt* instead, so nothing here
		// generates it. Prepending it as the first delta is what makes the
		// engine see exactly what the browser sees.
		if (this.promptHasThinkBlock) {
			raw = THINK_BLOCK;
			queue.push(THINK_BLOCK);
		}

		this.lastRaw = raw;

		const streamer = new TextStreamer(tokenizer, {
			skip_prompt: true,
			skip_special_tokens: true,
			callback_function: (text: string) => {
				if (stopped || text === "") {
					return;
				}

				// A stop string ends the generation and is not part of the
				// answer, as it is not for WebLLM; it can straddle two deltas,
				// so it is looked for in the whole of the text so far.
				const combined = raw + text;
				const at = firstStop(combined, stops);
				const piece =
					at === -1 ? text : combined.slice(raw.length, Math.max(at, raw.length));

				if (at !== -1) {
					stopped = true;
				}

				if (piece !== "") {
					raw += piece;
					this.lastRaw = raw;
					queue.push(piece);
				}

				if (stopped) {
					stopper.interrupt();
				}
			},
		});

		// Greedy, as the spec asks: the engine's `temperature: 0.1` has no
		// sampling to temper. `max_tokens` is the budget the engine computed,
		// which includes 16 tokens for a thinking block this backend does not
		// generate — a little more room than the browser has, never less.
		void (async () => {
			try {
				await generate({
					...inputs,
					max_new_tokens: request.max_tokens,
					do_sample: false,
					streamer,
					stopping_criteria: criteria,
				});
				queue.finish();
			} catch (error) {
				queue.fail(error);
			} finally {
				if (this.stopper === stopper) {
					this.stopper = null;
				}
			}
		})();

		return Promise.resolve(queue);
	}
}

/**
 * `WebLlmDeps` whose `create()` builds the Node backend. `prebuilt` carries
 * the catalog's own id so `appConfigFor()` still resolves — the model_list it
 * produces is WebLLM's business and nothing here reads it.
 */
export function nodeDeps(
	modelId: string,
	options: BackendOptions
): {deps: WebLlmDeps; backend: () => NodeMlc | null} {
	let made: NodeMlc | null = null;
	const prebuilt: ModelRecord[] = [
		{model_id: modelId, model: `node:${options.repo}`, model_lib: "node"},
	];

	function create(
		_appConfig: {model_list: ModelRecord[]},
		onProgress: (report: {progress: number; text: string}) => void
	): MlcLike {
		made = new NodeMlc(options, onProgress);

		return made;
	}

	return {
		deps: {prebuilt, create},
		backend: () => made,
	};
}
