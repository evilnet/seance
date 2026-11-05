// The CPU tier (spec § engines/seq2seq.ts): transformers.js translation
// pipelines on ONNX Runtime WASM. Two model families behind one engine,
// NLLB-200 (any pair, FLORES codes on every call) and OPUS-MT (one pair
// per model, no options). At most two pipelines stay loaded, evicted by
// last use. The library arrives through `Seq2seqDeps`; seq2seq.real.ts is
// its only import. A transformers.js pipeline call cannot be cancelled, so
// a cancelled request runs to completion and only its result is dropped
// (`signal.aborted` is checked after the call). NLLB is given a request one
// sentence at a time (`splitSentences`): handed a two-sentence line whole it
// translates the first sentence and stops. OPUS-MT keeps every sentence of
// a whole line and scores the same or better whole, so its requests stay
// whole (docs/resources/translation.md § Two engines, one router).

import {
	BATCH_REFUSED,
	Device,
	DeviceCopy,
	Engine,
	EngineCapabilities,
	EngineError,
	gpuLost,
	EngineStatus,
	LoadProgress,
	ModelRef,
	TranslateChunk,
	TranslateRequest,
} from "../engine";
import {nllbCode} from "../languages";

export interface PipelineLike {
	(text: string, options: Record<string, string>): Promise<{translation_text: string}[]>;
	dispose(): Promise<void>;
}

export interface PipelineProgress {
	file: string;
	loaded: number;
	total: number;
}

export interface Seq2seqDeps {
	pipeline(
		copy: DeviceCopy,
		device: Device,
		onProgress: (p: PipelineProgress) => void
	): Promise<PipelineLike>;
	threads(): boolean;
	/**
	 * The GPU instance's: the last device loss recorded (gpuLimits.ts
	 * `takeDeviceLoss`), so a GPU failure can say the GPU stopped. The CPU
	 * instance passes none.
	 */
	takeDeviceLoss?: () => {reason: string; message: string} | null;
}

export const SEQ2SEQ_MAX_LOADED = 2;

function isNllb(modelId: string): boolean {
	return /nllb/i.test(modelId);
}

/** Marks that end a sentence when whitespace or the end of the text follows. */
const SENTENCE_END = new Set([".", "!", "?", "\u2026"]);
/** The full-width marks, which end a sentence whatever follows: CJK puts no space after them. */
const WIDE_SENTENCE_END = new Set(["\u3002", "\uff01", "\uff1f"]);
/** Closing quotes and brackets that stay with the sentence they close. */
const CLOSERS = new Set(['"', "'", "\u201d", "\u2019", "\u00bb", ")", "]"]);

function isDigit(ch: string | undefined): boolean {
	return ch !== undefined && ch >= "0" && ch <= "9";
}

/**
 * A text's sentences, trimmed, for an engine that translates one at a time.
 * A sentence ends after `.`, `!`, `?` or `…` (a run of them, and any closing
 * quote or bracket after it) followed by whitespace or the end of the text,
 * and after `。`, `！` or `？` whatever follows. Never inside a placeholder
 * (`⟦n⟧`), and never at a decimal point between digits. A text with one
 * sentence, or none, comes back as itself in a one-element list.
 */
export function splitSentences(text: string): string[] {
	const sentences: string[] = [];
	let start = 0;
	let i = 0;

	while (i < text.length) {
		const ch = text[i];

		if (ch === "\u27e6") {
			const close = text.indexOf("\u27e7", i);

			if (close > i) {
				i = close + 1;
				continue;
			}
		}

		if (!SENTENCE_END.has(ch) && !WIDE_SENTENCE_END.has(ch)) {
			i++;
			continue;
		}

		if (ch === "." && isDigit(text[i - 1]) && isDigit(text[i + 1])) {
			i++;
			continue;
		}

		let end = i;
		let wide = false;

		while (
			end < text.length &&
			(SENTENCE_END.has(text[end]) || WIDE_SENTENCE_END.has(text[end]))
		) {
			wide = wide || WIDE_SENTENCE_END.has(text[end]);
			end++;
		}

		while (end < text.length && CLOSERS.has(text[end])) {
			end++;
		}

		if (wide || end === text.length || /\s/.test(text[end])) {
			const sentence = text.slice(start, end).trim();

			if (sentence !== "") {
				sentences.push(sentence);
			}

			start = end;
		}

		i = end;
	}

	const rest = text.slice(start).trim();

	if (rest !== "") {
		sentences.push(rest);
	}

	return sentences.length > 1 ? sentences : [text];
}

export function translationOptions(req: TranslateRequest): Record<string, string> {
	if (!isNllb(req.model)) {
		return {};
	}

	const from = req.from ?? req.context.sourceHint ?? null;

	if (!from) {
		throw new Error("NLLB needs a source language");
	}

	const src = nllbCode(from);
	const tgt = nllbCode(req.to);

	if (!src) {
		throw new Error(`no NLLB code for ${from}`);
	}

	if (!tgt) {
		throw new Error(`no NLLB code for ${req.to}`);
	}

	return {src_lang: src, tgt_lang: tgt};
}

export class Seq2seqEngine implements Engine {
	readonly name = "seq2seq" as const;
	/** Insertion order is recency: the first entry is the least recently used. */
	private loaded = new Map<string, PipelineLike>();
	/** In-flight `deps.pipeline(...)` calls, deduped by model id. */
	private loading = new Map<string, Promise<PipelineLike>>();
	/** How many `translate()` calls are currently mid-`await pipe(...)` for a model. */
	private inUse = new Map<string, number>();
	/** The device each loaded model's pipeline runs on. */
	private devices = new Map<string, Device>();
	private state: EngineStatus = "cold";
	private deps: Seq2seqDeps;

	constructor(deps: Seq2seqDeps) {
		this.deps = deps;
	}

	async load(
		ref: ModelRef,
		device: Device,
		onProgress: (p: LoadProgress) => void
	): Promise<void> {
		const copy = ref.copies[device];

		if (!copy) {
			throw new EngineError(`no ${device} copy of ${ref.id}`, "load");
		}

		if (this.loaded.has(ref.id)) {
			this.touch(ref.id);
			return;
		}

		const inFlight = this.loading.get(ref.id);

		if (inFlight) {
			await inFlight;
			return;
		}

		this.state = "loading";

		const files = new Map<string, PipelineProgress>();
		const promise = this.deps.pipeline(copy, device, (p) => {
			files.set(p.file, p);
			let loaded = 0;
			let total = 0;

			for (const file of files.values()) {
				loaded += file.loaded;
				total += file.total;
			}

			onProgress({fraction: total > 0 ? loaded / total : 0, text: p.file});
		});

		this.loading.set(ref.id, promise);

		let pipe: PipelineLike;

		try {
			pipe = await promise;
		} catch (e) {
			this.state = this.loaded.size > 0 ? "ready" : "failed";
			throw e;
		} finally {
			this.loading.delete(ref.id);
		}

		this.loaded.set(ref.id, pipe);
		this.devices.set(ref.id, device);
		this.state = "ready";
		await this.evict();
	}

	async unload(): Promise<void> {
		await Promise.allSettled([...this.loaded.values()].map((pipe) => pipe.dispose()));
		this.loaded.clear();
		this.devices.clear();
		this.inUse.clear();
		this.state = "cold";
	}

	status(): EngineStatus {
		return this.state;
	}

	loadedModels(): string[] {
		return [...this.loaded.keys()];
	}

	isLoaded(id: string, device?: Device): boolean {
		return this.loaded.has(id) && (device === undefined || this.devices.get(id) === device);
	}

	capabilities(): EngineCapabilities {
		return {streams: false, batches: false, threads: this.deps.threads()};
	}

	async *translate(req: TranslateRequest, signal: AbortSignal): AsyncIterable<TranslateChunk> {
		if (req.lines) {
			throw new Error(BATCH_REFUSED);
		}

		const pipe = this.loaded.get(req.model);

		if (!pipe) {
			throw new Error(`model not loaded: ${req.model}`);
		}

		this.touch(req.model);
		const options = translationOptions(req);
		// NLLB one sentence at a time, OPUS whole (see the header).
		const parts = isNllb(req.model) ? splitSentences(req.text) : [req.text];
		const done: string[] = [];

		this.inUse.set(req.model, (this.inUse.get(req.model) ?? 0) + 1);

		// The eviction deferred while this pipeline was in use only resumes
		// once this `finally` runs, which requires the caller to drain the
		// generator (an abandoned generator pins the model in `inUse`). The
		// count covers every sentence, so no eviction lands between two.
		try {
			for (let n = 0; n < parts.length; n++) {
				// A sentence of several with no letters (a placeholder on its
				// own) has nothing to translate, and NLLB given one invents
				// something. A one-part request is sent as it always was.
				if (parts.length > 1 && !/\p{L}/u.test(parts[n])) {
					done.push(parts[n].trim());
				} else {
					const result = await this.run(pipe, parts[n], options, req.model);

					done.push((result[0]?.translation_text ?? "").trim());
				}

				if (signal.aborted) {
					return;
				}

				// The text so far after each sentence but the last, which is
				// yielded once the pipeline is released.
				if (n < parts.length - 1) {
					yield {id: req.id, text: done.join(" "), done: false};
				}
			}
		} finally {
			const count = (this.inUse.get(req.model) ?? 1) - 1;

			if (count > 0) {
				this.inUse.set(req.model, count);
			} else {
				this.inUse.delete(req.model);
			}

			await this.evict();
		}

		if (signal.aborted) {
			return;
		}

		yield {id: req.id, text: done.join(" "), done: true};
	}

	/** One pipeline call; a GPU failure says why the GPU went away when it did (as webllm.ts). */
	private async run(
		pipe: PipelineLike,
		text: string,
		options: Record<string, string>,
		model: string
	): Promise<{translation_text: string}[]> {
		try {
			return await pipe(text, options);
		} catch (e) {
			const take = this.deps.takeDeviceLoss;

			if (this.devices.get(model) !== "gpu" || !take) {
				throw e;
			}

			await new Promise((resolve) => setTimeout(resolve, 50));
			const loss = take();

			if (!loss) {
				throw e;
			}

			throw new EngineError(
				gpuLost(loss.message || loss.reason, e instanceof Error ? e.message : String(e)),
				"request"
			);
		}
	}

	private touch(id: string): void {
		const pipe = this.loaded.get(id);

		if (pipe) {
			this.loaded.delete(id);
			this.loaded.set(id, pipe);
		}
	}

	private async evict(): Promise<void> {
		for (const id of this.loaded.keys()) {
			if (this.loaded.size <= SEQ2SEQ_MAX_LOADED) {
				break;
			}

			if ((this.inUse.get(id) ?? 0) > 0) {
				continue;
			}

			const pipe = this.loaded.get(id) as PipelineLike;

			this.loaded.delete(id);
			this.devices.delete(id);
			await pipe.dispose().catch(() => {});
		}
	}
}
