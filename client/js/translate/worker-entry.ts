/**
 * Entry of the translation worker (public/js/translate-worker.js, built by
 * vite.translate.config.mts). The page starts it with
 * `new Worker("js/translate-worker.js?v=<build>")` (client/js/translate/
 * index.ts) and speaks the protocol in protocol.ts to it. This is the only
 * file that wires the real engines: everything else is injected.
 *
 * Each slot holds an engine per device (engines/onDevice.ts, one device in
 * memory at a time): the language model on the GPU through WebLLM and on
 * the CPU through wllama (engines/cpuLlm.ts), the seq2seq models through
 * transformers.js on either. Only the GPU instances read the GPU's losses.
 */
import {WebLlmEngine} from "./engines/webllm";
import {realWebLlmDeps, webllmCache} from "./engines/webllm.real";
import {createCpuMlc} from "./engines/cpuLlm";
import {cpuLlmCache, wllamaBackend} from "./engines/cpuLlm.real";
import {OnDevice} from "./engines/onDevice";
import type {EngineName} from "./engine";
import {Seq2seqEngine} from "./engines/seq2seq";
import {
	configureTransformers,
	realSeq2seqDeps,
	seq2seqCache,
	seq2seqStore,
} from "./engines/seq2seq.real";
import {dropRepos} from "./engines/seq2seqCache";
import {languageName} from "./languages";
import {CPU_CONTEXT_WINDOW, CacheApi, GpuBudget, ModelCatalog, retiredRepos} from "./models";
import {setBufferCap, takeDeviceLoss} from "./engines/gpuLimits";
import {WorkerPort} from "./protocol";
import {serveEngines} from "./worker";

let catalog: ModelCatalog | null = null;
let gpu: GpuBudget | null = null;

const modelBase = () => catalog?.modelBase;

/** A language model's CPU copy, from the catalog the page last sent. */
const cpuCopyFor = (id: string) =>
	catalog?.llmChoices.find((ref) => ref.id === id)?.copies.cpu ?? null;

const cpuBackend = wllamaBackend(modelBase, () => gpu?.mobile === true);

const webllmGpu = new WebLlmEngine({...realWebLlmDeps, takeDeviceLoss}, languageName);
const webllmCpu = new WebLlmEngine(
	{
		prebuilt: [],
		create: (_appConfig, onProgress) => createCpuMlc(cpuBackend, cpuCopyFor, onProgress),
	},
	languageName,
	{device: "cpu", contextWindow: CPU_CONTEXT_WINDOW}
);
const seqGpu = new Seq2seqEngine({...realSeq2seqDeps, takeDeviceLoss});
const seqCpu = new Seq2seqEngine(realSeq2seqDeps);

const llmGpuCache = webllmCache(
	() => catalog,
	() => gpu
);
const llmCpuCache = cpuLlmCache(modelBase);
const seqStore = seq2seqStore();
const seqCache = seq2seqCache(seqStore);

// `apple` never reaches the worker (engine.ts `EngineName`).
const cacheFor = (engine: EngineName, device: "gpu" | "cpu"): CacheApi =>
	engine === "seq2seq" ? seqCache : device === "gpu" ? llmGpuCache : llmCpuCache;

const cache: CacheApi = {
	has: (ref, device) => cacheFor(ref.engine, device).has(ref, device),
	delete: (ref, device) => cacheFor(ref.engine, device).delete(ref, device),
};

serveEngines(
	self as unknown as WorkerPort,
	{
		llm: new OnDevice("llm", {gpu: webllmGpu, cpu: webllmCpu}),
		seq2seq: new OnDevice("seq2seq", {gpu: seqGpu, cpu: seqCpu}),
	},
	{
		cache,
		configure(next, ortBase, budget) {
			catalog = next;

			// Absent before the page's probe answered: what an earlier
			// configure said stands.
			if (budget) {
				gpu = budget;
				setBufferCap(budget.capBytes);
			}

			webllmGpu.configure(next, budget);
			webllmCpu.configure(next);
			configureTransformers({modelBase: next.modelBase, ortBase});
			// The files of models this build replaced: nothing lists them to delete.
			void dropRepos(seqStore, retiredRepos(next)).catch(() => undefined);
		},
	}
);
