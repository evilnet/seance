/* eslint-disable no-console */
// An offline runner for the translation LLM: the browser's own
// `WebLlmEngine` (client/js/translate/engines/webllm.ts) driven over a Node
// backend, so a prompt or a piece of post-processing can be tried from the
// command line without a WebGPU browser.
//
//   npx tsx tools/translate-llm.ts "hello, how are you?" --to de [--from en]
//       [--purpose read|write|polish] [--context fixture.json] [--show-prompt]
//       [--raw] [--device cpu|cuda] [--markers placeholder|literal|tags]
//   npx tsx tools/translate-llm.ts --capture capture.json
//   npx tsx tools/translate-llm.ts --eval tools/translate-eval/prompts.json [--to de]
//
// Only the model backend differs from the browser. The think-block
// stripping, the echo and canned-answer guards, the blank-line rule,
// `cleanOutput` and the abort/drain loop are the shipped engine itself
// (`--raw` says what each line of a reply was kept or dropped as), and the
// request is assembled by `protect()` and `emptyContext()` exactly as
// `reader.ts` and `outgoing.ts` assemble theirs — so what this prints is
// what the app would show, up to the weights.
//
// The weights are the ONNX build of the same model
// (`onnx-community/Qwen3-1.7B-ONNX`, `q4f16`) rather than WebLLM's MLC
// `q4f16_1`, so token-level output can differ slightly; what the prompt
// makes the model do is the same.
//
// Run it from the repository root: the download (~1.4 GB, first use only)
// is cached in `tmp/models/` — gitignored — unless `SEANCE_MODEL_CACHE`
// says otherwise.
//
// `--device cuda` is a convenience, not a supported path, and the fallback
// below only catches a session that will not *build*: an ONNX Runtime CUDA
// provider without cuDNN loads the fp16 weights happily and then decodes
// nothing but `!` (token 0). Read the output before trusting it; `cpu` is
// the default because it is the one that is always right.

import {existsSync, readdirSync, readFileSync, statSync} from "node:fs";
import path from "node:path";
import {
	AutoModelForCausalLM,
	AutoTokenizer,
	InterruptableStoppingCriteria,
	StoppingCriteriaList,
	TextStreamer,
	env,
	type ProgressInfo,
} from "@huggingface/transformers";
import {
	ContextLine,
	PromptContext,
	TranslateRequest,
	emptyContext,
} from "../client/js/translate/engine";
import {ModelRecord, WebLlmEngine} from "../client/js/translate/engines/webllm";
import {
	ChatDelta,
	ChatRequest,
	DTYPE,
	DTYPES,
	MlcLike,
	NodeMlc,
	ONNX_REPO,
	WebLlmDeps,
	asError,
	message,
	type Device,
	type Dtype,
	type Purpose,
	nodeDeps,
} from "./llm-node-backend";
import {languageName} from "../client/js/translate/languages";
import {QWEN3_1_7B_ID, buildCatalog} from "../client/js/translate/models";
import {promptProfileFor} from "../client/js/translate/prompts";
import type {TranslateCapture} from "../client/js/translate/outgoing";
import {
	EXAMPLE_ANSWERS,
	cleanOutput,
	parseBatchedOutput,
	stripSentinel,
} from "../client/js/translate/prompt";
import {type MarkerForm, placeholdersIn, protect, restoreAll} from "../client/js/translate/spans";

interface Fixture extends Partial<PromptContext> {
	nicks?: string[];
}

interface EvalCase {
	text: string;
	from?: string | null;
	to?: string;
	purpose?: Purpose;
	/** The channel's names, for `protect()`; a nick becomes a placeholder. */
	nicks?: string[];
	/** The case's own channel: a `PromptContext` (plus `nicks`), as `--context` takes one. */
	context?: Fixture;
	note?: string;
	/** What a correct answer carries. Printed, never asserted. */
	expect?: string;
}

interface Options {
	text: string | null;
	to: string;
	from: string | null;
	purpose: Purpose;
	/** The route's marker form (spans.ts `renderMarkers`); the app's LLM route uses `LLM_MARKERS`. */
	markers: MarkerForm;
	contextFile: string | null;
	/** `--capture`: a `seanceTranslateLast` object saved from the app. */
	captureFile: string | null;
	capture: TranslateCapture | null;
	showPrompt: boolean;
	raw: boolean;
	device: Device;
	evalFile: string | null;
	repo: string;
	dtype: Dtype;
	/** A local model directory (`tmp/models/web/<id>`), loaded instead of `repo`. */
	local: string | null;
	/** `--profile`: the GPU model id whose prompt profile asks (client/js/translate/prompts/). */
	profile: string;
	/** `--threads`: ONNX Runtime worker threads (default: every core). */
	threads: number | null;
}

const USAGE = [
	'usage: npx tsx tools/translate-llm.ts "text" --to de [--from en] [--purpose read|write|polish]',
	"                                     [--context fixture.json] [--show-prompt] [--raw]",
	"                                     [--device cpu|cuda] [--threads N] [--repo <hf repo>] [--dtype q4f16|fp16|int8|…]",
	"                                     [--local tmp/models/web/<model id>]",
	"                                     [--markers placeholder|literal|tags]",
	"                                     [--profile <model id>]",
	"       npx tsx tools/translate-llm.ts --capture capture.json [--to de] [--show-prompt]",
	"       npx tsx tools/translate-llm.ts --eval tools/translate-eval/prompts.json [--to de]",
].join("\n");

function parseArgs(argv: string[]): Options {
	const options: Options = {
		text: null,
		to: "de",
		from: null,
		purpose: "read",
		markers: "placeholder",
		contextFile: null,
		captureFile: null,
		capture: null,
		showPrompt: false,
		raw: false,
		device: "cpu",
		evalFile: null,
		repo: ONNX_REPO,
		dtype: DTYPE,
		local: null,
		profile: QWEN3_1_7B_ID,
		threads: null,
	};

	// Which flags the command line actually carried: a capture supplies the
	// rest, and "the default is still there" cannot be told from "the user
	// asked for the default" any other way (`--from` has no value that means
	// "unset" -- null is a real source).
	const given = new Set<string>();

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];

		given.add(arg);

		const value = () => {
			const next = argv[++i];

			if (next === undefined) {
				throw new Error(`${arg} wants a value\n${USAGE}`);
			}

			return next;
		};

		if (arg === "--to") {
			options.to = value();
		} else if (arg === "--from") {
			options.from = value();
		} else if (arg === "--purpose") {
			const purpose = value();

			if (purpose !== "read" && purpose !== "write" && purpose !== "polish") {
				throw new Error(`--purpose is read or write, not ${purpose}`);
			}

			options.purpose = purpose;
		} else if (arg === "--markers") {
			const markers = value();

			if (markers !== "placeholder" && markers !== "literal" && markers !== "tags") {
				throw new Error(`--markers is placeholder, literal or tags, not ${markers}`);
			}

			options.markers = markers;
		} else if (arg === "--context") {
			options.contextFile = value();
		} else if (arg === "--capture") {
			options.captureFile = value();
		} else if (arg === "--eval") {
			options.evalFile = value();
		} else if (arg === "--threads") {
			const threads = Number(value());

			if (!Number.isInteger(threads) || threads < 1) {
				throw new Error("--threads is a whole number of threads, at least 1");
			}

			options.threads = threads;
		} else if (arg === "--device") {
			const device = value();

			if (device !== "cpu" && device !== "cuda") {
				throw new Error(`--device is cpu or cuda, not ${device}`);
			}

			options.device = device;
		} else if (arg === "--repo") {
			options.repo = value();
		} else if (arg === "--local") {
			// A directory in the layout transformers.js loads from disk, such as
			// the web build's own q4f16_1 weights that
			// tools/translate-eval/mlc-to-onnx.py writes: its name is the id.
			options.local = path.resolve(value());
			options.repo = path.basename(options.local);
		} else if (arg === "--dtype") {
			const dtype = value();

			if (!(DTYPES as readonly string[]).includes(dtype)) {
				throw new Error(`--dtype is one of ${DTYPES.join(", ")}, not ${dtype}`);
			}

			options.dtype = dtype as Dtype;
		} else if (arg === "--profile") {
			options.profile = value();
		} else if (arg === "--show-prompt") {
			options.showPrompt = true;
		} else if (arg === "--raw") {
			options.raw = true;
		} else if (arg === "--help" || arg === "-h") {
			console.log(USAGE);
			process.exit(0);
		} else if (arg.startsWith("--")) {
			throw new Error(`unknown option ${arg}\n${USAGE}`);
		} else if (options.text === null) {
			options.text = arg;
		} else {
			throw new Error(`unexpected argument ${arg}\n${USAGE}`);
		}
	}

	// Before the check below: a capture brings the text with it.
	if (options.captureFile) {
		options.capture = JSON.parse(readFileSync(options.captureFile, "utf8")) as TranslateCapture;
		applyCapture(options, options.capture, given);
	}

	if (options.text === null && options.evalFile === null) {
		throw new Error(USAGE);
	}

	return options;
}

/**
 * `--capture` takes a saved `seanceTranslateLast` (translate/writer.ts, a
 * development build only) as the whole request: the draft, the pair, the
 * marker form and the context the page built, so a translation someone
 * reports can be replayed exactly as it was asked for rather than
 * approximated. `--to`, `--from`, `--purpose`, `--markers` and a text
 * argument on the command line still override it, and `--context` replaces
 * the context.
 *
 * `purpose` comes from `kind`: the draft's translation is a write, the round
 * trip reading one back is a read -- the default (`read`) would otherwise
 * build the wrong prompt for every captured draft.
 */
function applyCapture(options: Options, capture: TranslateCapture, given: Set<string>): void {
	if (options.text === null) {
		options.text = capture.draft;
	}

	if (!given.has("--from")) {
		options.from = capture.from;
	}

	if (!given.has("--to")) {
		options.to = capture.to;
	}

	if (!given.has("--purpose")) {
		options.purpose = capture.kind === "write" ? "write" : "read";
	}

	if (!given.has("--markers")) {
		options.markers = capture.markers;
	}
}

function fixtureContext(fixture: Fixture): PromptContext {
	const context: PromptContext = {
		recent: fixture.recent ?? [],
		names: fixture.names ?? [],
		terms: fixture.terms ?? [],
		voice: fixture.voice ?? [],
		formality: fixture.formality ?? "auto",
	};

	if (fixture.topic) {
		context.topic = fixture.topic;
	}

	if (fixture.replyTo) {
		context.replyTo = fixture.replyTo as ContextLine;
	}

	if (fixture.variant) {
		context.variant = fixture.variant;
	}

	if (fixture.sourceHint) {
		context.sourceHint = fixture.sourceHint;
	}

	return context;
}

function loadFixture(file: string | null): {context: PromptContext; nicks: string[]} {
	if (!file) {
		return {context: emptyContext(), nicks: []};
	}

	const fixture = JSON.parse(readFileSync(file, "utf8")) as Fixture;

	return {context: fixtureContext(fixture), nicks: fixture.nicks ?? []};
}

/**
 * For comparing a line with the source the way `isEcho()` in webllm.ts does
 * — mirrored here only so `--raw` can say *why* a line was dropped; the
 * engine's own copy is what decides.
 */
function normalise(text: string): string {
	return text
		.trim()
		.replace(/\s+/g, " ")
		.toLowerCase()
		.replace(/[.!?]$/, "");
}

/**
 * The engine's view of the raw stream, line by line, for `--raw`: what each
 * line is kept or dropped as, and where the answer stops. The kept lines are
 * what the engine joins with single spaces.
 */
function echoVerdict(raw: string, source: string): string[] {
	const visible = raw.replace(/^\s*<think>[\s\S]*?<\/think>\s*/, "");
	let past = false;

	return visible.split("\n").map((line, i) => {
		const carried = cleanOutput(line.replace(/\r$/, ""));
		const bare = /^(?:"""|["'“”„«»])+$/.test(carried) ? "" : carried;
		const verdict = past
			? "dropped (past the blank line)"
			: line.trim() === ""
			? "the blank line: the answer ends here"
			: bare === ""
			? "dropped (empty or a bare fence)"
			: normalise(bare) === normalise(source)
			? "dropped (the source read back)"
			: EXAMPLE_ANSWERS.some((answer) => normalise(answer) === normalise(bare))
			? "dropped (a canned answer — the example guard)"
			: "kept — part of the translation";

		if (line.trim() === "") {
			past = true;
		}

		return `    [${i}] ${JSON.stringify(line)} → ${JSON.stringify(bare)}  ${verdict}`;
	});
}

interface RunResult {
	text: string;
	ms: number;
}

async function runCase(
	engine: WebLlmEngine,
	backend: () => NodeMlc | null,
	modelId: string,
	item: EvalCase,
	base: {
		to: string;
		from: string | null;
		purpose: Purpose;
		context: PromptContext;
		nicks: string[];
		markers: MarkerForm;
	},
	show: {prompt: boolean; raw: boolean; stream: boolean},
	id: number
): Promise<RunResult> {
	const nicks = item.nicks ?? base.nicks;
	// The app's exact shape: one protection per request, in the marker form
	// the route it is about to take asks for (spans.ts `renderMarkers`).
	const info = protect(item.text, {nicks, markers: base.markers});
	// A draft is protected once and only then split, as outgoing.ts does, so a
	// fenced block is one span rather than a fence per line.
	const lines = info.text.split("\n").filter((line) => line.trim() !== "");
	const batched = lines.length > 1;
	const request: TranslateRequest = {
		id,
		model: modelId,
		text: batched ? "" : info.text,
		from: item.from === undefined ? base.from : item.from,
		to: item.to ?? base.to,
		purpose: item.purpose ?? base.purpose,
		context: base.context,
		markers: base.markers,
	};

	if (batched) {
		request.lines = lines;
	}

	const controller = new AbortController();
	const started = Date.now();
	let last = "";

	for await (const chunk of engine.translate(request, controller.signal)) {
		last = chunk.text;

		if (show.stream) {
			console.log(`… ${chunk.text.replace(/\n/g, "\\n")}`);
		}
	}

	const ms = Date.now() - started;
	const node = backend();

	if (show.prompt && node) {
		console.log("\n--- rendered chat-template prompt ---");
		console.log(node.lastPrompt);
		console.log("--- end of prompt ---");
		console.log(
			node.promptHasThinkBlock
				? "think block: the template put <think></think> in the PROMPT, so it is prepended as the first delta (where WebLLM puts it)"
				: "think block: NOT in the rendered prompt — nothing prepended; the model may generate real reasoning and maxTokensFor's +16 is wrong"
		);
		console.log("");
	}

	if (show.raw && node) {
		console.log(`raw deltas as the engine saw them: ${JSON.stringify(node.lastRaw)}`);

		if (!batched) {
			console.log("  the engine's guards, line by line (the kept lines are joined):");

			for (const line of echoVerdict(node.lastRaw, request.text)) {
				console.log(line);
			}
		}

		console.log(`  engine output before restore: ${JSON.stringify(last)}`);
	}

	if (!batched) {
		return {text: restoreAll(last, info, placeholdersIn(info.text)), ms};
	}

	const parsed = parseBatchedOutput(last, lines.length);

	if (!parsed) {
		console.log("  ! the numbered answer did not parse; showing it as it came");

		return {text: restoreAll(stripSentinel(last), info), ms};
	}

	return {
		text: parsed.map((text, i) => restoreAll(text, info, placeholdersIn(lines[i]))).join("\n"),
		ms,
	};
}

/** What `--local` will load, so a run says which weights it scored. */
function localWeights(dir: string, dtype: Dtype): string {
	const suffix = dtype === "fp32" ? "" : `_${dtype}`;
	const onnxDir = path.join(dir, "onnx");
	const graph = `model${suffix}.onnx`;

	if (!existsSync(path.join(onnxDir, graph))) {
		throw new Error(`--local ${dir} has no onnx/${graph}`);
	}

	const files = readdirSync(onnxDir)
		.filter((file) => file === graph || file.startsWith(`${graph}_data`))
		.map((file) => `${file} ${(statSync(path.join(onnxDir, file)).size / 1e9).toFixed(2)} GB`);
	const statePath = path.join(dir, "conversion-state.json");
	let origin = "local ONNX weights";

	if (existsSync(statePath)) {
		const state = JSON.parse(readFileSync(statePath, "utf8")) as {
			done?: Record<string, unknown>;
		};

		origin = `MLC q4f16_1 weights dequantized into ${
			Object.keys(state.done ?? {}).length
		} tensors`;
	}

	return `${dir}/onnx: ${files.join(", ")} (${origin}; remote models off)`;
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));

	env.cacheDir = process.env.SEANCE_MODEL_CACHE ?? path.resolve(process.cwd(), "tmp", "models");

	const catalog = buildCatalog();
	const {deps, backend} = nodeDeps(catalog.llm.id, {
		device: options.device,
		repo: options.repo,
		dtype: options.dtype,
		threads: options.threads,
		log: (text) => console.log(text),
	});
	// The prompt profile is chosen here, not by the id the backend is loaded
	// under (always the catalog's): the weights and the wording are picked
	// separately, so 4B's wording can be run against any weights.
	const profile = promptProfileFor(options.profile);

	deps.promptProfileFor = () => profile;

	const engine = new WebLlmEngine(deps, (code) => languageName(code));

	engine.configure(catalog);

	console.log(`model   ${catalog.llm.id} → ${options.repo} (${options.dtype})`);
	console.log(`profile ${profile.modelId}`);
	console.log(`cache   ${env.cacheDir}`);

	if (options.local) {
		env.localModelPath = `${path.dirname(options.local)}${path.sep}`;
		env.allowLocalModels = true;
		env.allowRemoteModels = false;
		console.log(`weights ${localWeights(options.local, options.dtype)}`);
	}

	console.log(`device  ${options.device} requested`);
	console.log(`markers ${options.markers}`);

	if (options.capture) {
		const capture = options.capture;

		console.log(
			`capture ${options.captureFile ?? ""} — ${capture.kind}${
				capture.retry ? " (the bare second try)" : ""
			}, ${capture.from ?? "auto"} → ${capture.to}, ${
				capture.model ?? "no model"
			}; the page got ${JSON.stringify(capture.text)}${
				capture.error ? ` (${capture.error})` : ""
			}`
		);
	}

	const loadStarted = Date.now();
	let shown = -1;

	await engine.load(catalog.llm, (progress) => {
		const percent = Math.floor(progress.fraction * 100);

		if (percent >= shown + 10 || percent === 100) {
			shown = percent;
			console.log(`  load ${percent}% ${progress.text ?? ""}`.trimEnd());
		}
	});

	const loadMs = Date.now() - loadStarted;
	const node = backend();

	console.log(`loaded  on ${node?.device ?? "?"} in ${(loadMs / 1000).toFixed(1)}s\n`);

	// A capture carries the context the page sent. It carries no user list,
	// so the context's own `names` stand in for span protection -- they are
	// the recent speakers and the nicks the draft mentions, which is what a
	// nick placeholder is for. `--context` replaces both.
	const fixture =
		options.capture && !options.contextFile
			? {
					context: fixtureContext(options.capture.context),
					nicks: options.capture.context.names,
			  }
			: loadFixture(options.contextFile);
	const base = {
		to: options.to,
		from: options.from,
		purpose: options.purpose,
		context: fixture.context,
		nicks: fixture.nicks,
		markers: options.markers,
	};

	if (options.evalFile) {
		const cases = JSON.parse(readFileSync(options.evalFile, "utf8")) as EvalCase[];

		for (let i = 0; i < cases.length; i++) {
			const item = cases[i];

			console.log(`[${i + 1}/${cases.length}] ${item.note ?? ""}`.trimEnd());
			console.log(
				`  in   (${item.from ?? base.from ?? "auto"} → ${
					item.to ?? base.to
				}) ${JSON.stringify(item.text)}`
			);

			if (item.expect) {
				console.log(`  want ${item.expect}`);
			}

			// A case may bring its own channel: its context replaces the
			// command line's, and its own `nicks` the fixture's.
			const local = item.context
				? {context: fixtureContext(item.context), nicks: item.context.nicks ?? base.nicks}
				: {context: base.context, nicks: base.nicks};

			// A request the engine fails (a canned answer, say) is that case's
			// answer -- an empty one, which the scorers count as a failure --
			// never the end of the run.
			try {
				const result = await runCase(
					engine,
					backend,
					catalog.llm.id,
					item,
					{...base, ...local},
					{prompt: i === 0 && options.showPrompt, raw: options.raw, stream: false},
					i + 1
				);

				console.log(`  out  ${JSON.stringify(result.text)}`);
				console.log(`  time ${(result.ms / 1000).toFixed(1)}s\n`);
			} catch (error) {
				console.log(`  out  ""`);
				console.log(`  error ${error instanceof Error ? error.message : String(error)}\n`);
			}
		}
	} else {
		const result = await runCase(
			engine,
			backend,
			catalog.llm.id,
			{text: options.text ?? ""},
			base,
			{prompt: options.showPrompt, raw: options.raw, stream: true},
			1
		);

		console.log(`done ${JSON.stringify(result.text)}`);
		console.log(`time ${(result.ms / 1000).toFixed(1)}s`);
	}

	await engine.unload();
}

main().catch((error: unknown) => {
	console.error(message(error));
	process.exit(1);
});
