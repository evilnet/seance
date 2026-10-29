// A worker that never leaves the page, for `?fakeTranslate` on a
// development build (index.ts) and for tools/scenarios/translate-*.mjs:
// scripted engines that "download" over a few hundred milliseconds,
// remember what was downloaded in memory, and translate by echoing the
// text behind the target language's name, word by word. Vue-free so a
// mocha test can pin its shape.
//
// index.ts reaches this module behind `BUILD === "dev"`, and webpack
// folds it out of a production build: `NODE_ENV=production yarn build`
// ships neither the scripted engines nor the request log (grep
// `public/js/*.js` for `__seanceTranslateFake` to check).

import {
	Device,
	Engine,
	EngineCapabilities,
	EngineName,
	EngineStatus,
	LoadProgress,
	ModelRef,
	TranslateChunk,
	TranslateRequest,
} from "./engine";
import {languageName} from "./languages";
import {Capability} from "./capability";
import {MainPort, createPortPair} from "./protocol";
import {END_SENTINEL} from "./prompt";
import {serveEngines} from "./worker";

export const FAKE_CAPABILITY: Capability = {
	tier: "gpu",
	reasons: [],
	f16: true,
	maxBufferBytes: 4 * 1024 * 1024 * 1024,
	deviceMemoryGiB: 8,
	storageQuotaBytes: 50 * 1024 * 1024 * 1024,
	mobile: false,
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The token a request's text (or any of its lines) can carry to fail once:
 *  browser scenarios exercise the failed-line/retry UI without a real
 *  engine ever failing. */
const FAIL_TOKEN = "[fail]";
/** The token a request's text (or any of its lines) can carry to come back
 *  as it went in: browser scenarios exercise the echo rule (outgoing.ts
 *  `isUnchanged`) without a real model ever declining to translate. Like
 *  `[fail]`'s, the token itself stays in the answer — what an echo drops is
 *  the `[Language]` prefix the fake otherwise puts in front, since an
 *  answer differing from the text by anything at all would not be one. */
const ECHO_TOKEN = "[echo]";
/** The same, once: the first request carrying it comes back as it went in
 *  and every later one translates, so a scenario can watch the composer's
 *  bare second try succeed (`outgoing.ts` `bareRetry`). Keyed like
 *  `[fail]`'s single failure, on the request's text -- and a retry is the
 *  same protected text, so it is the same key. */
const ECHO_ONCE_TOKEN = "[echo-once]";
/** The token a read request's text (or any of its lines) can carry to be
 *  answered rather than translated: the fake replies with `ANSWER_REPLY`,
 *  which has no question mark, so a scenario exercises the answered-question
 *  rule (outgoing.ts `isAnsweredQuestion`) on an incoming question and on
 *  the composer's read-back. Reads only: a draft's own translation (a write)
 *  carries the token as well, and has to reach its read-back. */
const ANSWER_TOKEN = "[answer]";
const ANSWER_REPLY = "Yes, of course, it starts at nine.";

interface TranslateFakeRequestLog {
	id: number;
	model: string;
	text: string;
	purpose: "read" | "write" | "polish";
	lines: number;
	/** The source the request asked for: null when it was left to the engine. */
	from: string | null;
	to: string;
	engine: EngineName;
	/** The marker form the route chose (spans.ts `renderMarkers`). */
	markers: string;
	/** How many recent lines the context carried: 0 is a bare request. */
	contextLines: number;
	/** How many of the user's own lines the context quoted (`purpose: "write"`). */
	voice: number;
	/** The source the prompt calls probable (`context.sourceHint`), or null. */
	sourceHint: string | null;
}

interface TranslateFakeGlobal {
	requests: TranslateFakeRequestLog[];
	/**
	 * The model ids each scripted engine holds right now: what a scenario
	 * reads to see a model unloaded (service.ts idle and not-in-use unloads).
	 * A terminated fake worker holds nothing, as a real one frees its memory.
	 */
	loaded?: Partial<Record<EngineName, string[]>>;
}

function fakeGlobal(): TranslateFakeGlobal {
	return (globalThis.__seanceTranslateFake ??= {requests: []});
}

function publishLoaded(engine: EngineName, ids: string[]): void {
	const g = fakeGlobal();

	g.loaded = {...(g.loaded ?? {}), [engine]: [...ids]};
}

declare global {
	// eslint-disable-next-line no-var
	var __seanceTranslateFake: TranslateFakeGlobal | undefined;
}

function logRequest(req: TranslateRequest, engine: EngineName): void {
	const g = fakeGlobal();

	g.requests.push({
		id: req.id,
		model: req.model,
		text: req.text,
		purpose: req.purpose,
		lines: req.lines ? req.lines.length : 0,
		from: req.from,
		to: req.to,
		engine,
		markers: req.markers ?? "placeholder",
		contextLines: req.context.recent.length,
		voice: req.context.voice.length,
		sourceHint: req.context.sourceHint ?? null,
	});
}

class ScriptedEngine implements Engine {
	readonly name: "llm" | "seq2seq";
	private stepMs: number;
	private loaded: string[] = [];
	/** The device `loaded` is on: a slot holds one device's models (engines/onDevice.ts). */
	private device: Device | null = null;
	private state: EngineStatus = "cold";
	/** Texts this engine has already failed once, so a retry succeeds. */
	private failedOnce = new Set<string>();
	/** Texts this engine has already echoed once, so a retry translates. */
	private echoedOnce = new Set<string>();

	constructor(name: "llm" | "seq2seq", stepMs: number) {
		this.name = name;
		this.stepMs = stepMs;
	}

	async load(
		ref: ModelRef,
		device: Device,
		onProgress: (p: LoadProgress) => void
	): Promise<void> {
		this.state = "loading";

		if (this.device !== device) {
			this.loaded = [];
			this.device = device;
		}

		for (let i = 1; i <= 10; i++) {
			await wait(this.stepMs);
			onProgress({fraction: i / 10, text: `shard ${i} of 10`});
		}

		this.loaded = this.name === "llm" ? [ref.id] : [...this.loaded, ref.id];
		this.state = "ready";
		publishLoaded(this.name, this.loaded);
	}

	unload(): Promise<void> {
		this.loaded = [];
		this.device = null;
		this.state = "cold";
		publishLoaded(this.name, this.loaded);

		return Promise.resolve();
	}

	status(): EngineStatus {
		return this.state;
	}

	loadedModels(): string[] {
		return [...this.loaded];
	}

	isLoaded(id: string, device?: Device): boolean {
		return this.loaded.includes(id) && (device === undefined || device === this.device);
	}

	capabilities(): EngineCapabilities {
		return {streams: this.name === "llm", batches: this.name === "llm", threads: false};
	}

	async *translate(req: TranslateRequest, signal: AbortSignal): AsyncIterable<TranslateChunk> {
		if (!this.isLoaded(req.model)) {
			throw new Error(`model not loaded: ${req.model}`);
		}

		logRequest(req, this.name);

		// A batch holding a failing line answers with nothing a batch parser
		// accepts, so the queue sends its lines again one at a time (what it
		// does with a batch a model botched) and only that line's own request
		// fails: a channel's backlog queued together must not fail every line
		// beside one scripted failure. Whether that line has had its one
		// failure already makes no difference -- the failure is keyed on the
		// request's text, and a batch is a text of its own, so a batch that
		// threw would take its neighbours down every time it is queued again
		// (a requeue does exactly that). A multi-line draft (`purpose`
		// "write") keeps failing as one request.
		if (
			req.lines &&
			req.purpose === "read" &&
			req.lines.some((line) => line.includes(FAIL_TOKEN))
		) {
			yield {id: req.id, text: "", done: true};
			return;
		}

		const failKey = req.lines ? req.lines.join("\n") : req.text;

		if (failKey.includes(FAIL_TOKEN) && !this.failedOnce.has(failKey)) {
			this.failedOnce.add(failKey);
			throw new Error("scripted failure");
		}

		if (req.lines) {
			let text = "";

			for (let i = 0; i < req.lines.length; i++) {
				if (signal.aborted) {
					return;
				}

				await wait(this.stepMs);

				// A batch echoes only the lines carrying a token, as a model
				// handing back one line of several would: a channel's backlog
				// queued together (a switch-on, a language change) must not
				// fail every line batched with one scripted echo.
				const line = this.answers(req, req.lines[i])
					? `${i + 1}. ${ANSWER_REPLY}`
					: this.echoes(req.lines[i])
					? `${i + 1}. ${req.lines[i]}`
					: `${i + 1}. [${languageName(req.to)}] ${req.lines[i]}`;

				text = text ? `${text}\n${line}` : line;
				yield {id: req.id, text, done: false};
			}

			if (signal.aborted) {
				return;
			}

			yield {id: req.id, text: `${text}\n${END_SENTINEL}`, done: true};
			return;
		}

		const words = (
			this.answers(req, req.text)
				? ANSWER_REPLY
				: this.echoes(req.text)
				? req.text
				: req.purpose === "polish"
				? `[Corrected] ${req.text}`
				: `[${languageName(req.to)}] ${req.text}`
		).split(" ");
		let text = "";

		for (const word of words) {
			if (signal.aborted) {
				return;
			}

			await wait(this.stepMs);
			text = text ? `${text} ${word}` : word;
			yield {id: req.id, text, done: false};
		}

		yield {id: req.id, text, done: true};
	}

	/** `[answer]` on a read request: replied to, not translated. */
	private answers(req: TranslateRequest, text: string): boolean {
		return req.purpose === "read" && text.includes(ANSWER_TOKEN);
	}

	/** `[echo]` every time; `[echo-once]` the first time this text is seen. */
	private echoes(text: string): boolean {
		if (text.includes(ECHO_ONCE_TOKEN) && !this.echoedOnce.has(text)) {
			this.echoedOnce.add(text);
			return true;
		}

		return text.includes(ECHO_TOKEN);
	}
}

export function fakePort(options: {stepMs?: number} = {}): {port: MainPort; terminate: () => void} {
	const stepMs = options.stepMs ?? 120;
	const [mainPort, workerPort] = createPortPair();
	// One entry per copy: `<id>@<device>`.
	const cached = new Set<string>();
	const llm = new ScriptedEngine("llm", stepMs);
	const seq2seq = new ScriptedEngine("seq2seq", stepMs);
	const stop = serveEngines(
		workerPort,
		{llm, seq2seq},
		{
			configure() {},
			cache: {
				has(ref, device) {
					return Promise.resolve(cached.has(`${ref.id}@${device}`));
				},
				delete(ref, device) {
					cached.delete(`${ref.id}@${device}`);

					return Promise.resolve();
				},
			},
		}
	);
	// a "downloaded" copy is one that was loaded once, on its device; a
	// request without a device (none from the service) counts as the GPU's
	const originalOnMessage = workerPort.onmessage;

	workerPort.onmessage = (event) => {
		const message = event.data;

		if (message.type === "load") {
			cached.add(`${message.ref.id}@${message.device}`);
		} else if (message.type === "translate") {
			cached.add(`${message.ref.id}@${message.req.device ?? "gpu"}`);
		}

		originalOnMessage?.(event);
	};

	return {
		port: mainPort,
		// A terminated worker frees what its engines held.
		terminate() {
			stop();
			void llm.unload();
			void seq2seq.unload();
		},
	};
}
