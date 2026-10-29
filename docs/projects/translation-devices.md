# Translation devices: every model on the GPU or the CPU

Status: built 2026-10-29 on wild-international (671090ac..47157490). Approved in
conversation from the mockup (Settings → Translation → Models on a phone and
on a desktop).

## Why

The user's Android phone (Chrome, WebGPU storage binding 128 MiB) runs the
1.7B's small-buffer build, and the GPU is taken away mid-translation:
`vkQueueSubmit failed with VK_ERROR_DEVICE_LOST` (Dawn's Vulkan backend; the
error the user saw first was the `mapAsync` that happened to be running).
The cause on the phone is not known yet (a driver watchdog, memory, or the
f16 build on that driver). Whatever it is, the user wants a way to keep the
language model working: a setting that decides which device runs each
model, defaulting to the best one, so Qwen can be moved to the CPU by hand.

Today the device is the engine: `EngineName` `"llm"` means WebLLM on the
GPU and `"seq2seq"` means transformers.js on the CPU, and that pairing runs
through the catalog, the router, the capability rule, the service, the
worker, the settings and about 45 interface strings ("the GPU model", "the
CPU models"). This design separates the model from the device.

## What the user decided

- **Every model gets a device choice**: the language model (Qwen3, or a
  deploy's own), OPUS-MT, NLLB-200. One choice per model family, not per
  OPUS pair.
- **Auto, GPU, CPU**, default **Auto** = the best device for that model on
  this device.
- **Settings shows, per model** (the mockup): its on/off switch, "Run on"
  as a three-way control, a line under it saying what Auto picked here and
  why, and one line per device copy: downloaded with its size (and Remove),
  or not downloaded with its size (and Download).
- **A choice this device cannot run is shown disabled with its reason**
  beside it, by the same rule that already explains a blocked model
  (`modelBlock`, `explainRoute`, `helpers/translateWhy.ts`).
- **A device's copy is its own download**, asked for first like every
  implicit download (`consent.ts`).

## Goals

1. Each model family runs on the GPU or the CPU, chosen per family.
2. Auto picks per model and per device, and says what it picked.
3. Every surface that says why something cannot translate says it per
   device ("Qwen3 can't run on the CPU: …"), from one Vue-free rule.
4. The phone can run Qwen3-1.7B on the CPU.

## Non-goals

- (Was: multithreaded WebAssembly. The user asked for it on 2026-10-29;
  see § Multithreading.)
- More devices: a laptop's integrated vs dedicated GPU, Chrome's software
  GPU, the NPU through WebNN.
- A device per OPUS pair.
- Fixing the phone's device loss itself (that waits on the user's answers
  to the diagnosis questions).
- Measuring GPU speeds: there is no GPU in the sandbox. Auto's rule is a
  stated placeholder (below) until someone measures on real hardware.

## Anti-goals (a failure even if it works)

- A download the user did not agree to. Switching a device, or Auto
  picking one whose copy is not on the device, must go through the
  download question, and "Not now" must leave the other device's copy in
  use.
- A choice that looks available and then fails because the device cannot
  run it.
- A device without a usable GPU starting to run the language model on its
  CPU by itself.
- A desktop that used to translate on its GPU and its CPU models now
  behaving differently without the user touching anything — except where
  Auto's rule below says so explicitly (NLLB-200 and OPUS-MT moving to a
  desktop GPU that fits them; see "Auto" for the download consequence).
- English left in the interface, or a string concatenated from fragments
  (CLAUDE.md § i18n).

## Constraints

- No new dependency unless the spike (below) shows the existing one cannot
  do the job; a new one must be pinned and bundled into the worker only.
- Modules under `client/js/translate/` stay Vue-free except the three that
  import the store (`index.ts`, `reader.ts`, `writer.ts`); mocha loads the
  rest.
- `localStorage` keys stay `thelounge.*`; existing settings keys keep their
  names (the settings backup carries them; no migration).
- Every new string through the pot with translator context, translated into
  all 23 catalogs; changed msgids keep their keys and go through
  `tools/i18n/merge.ts`.
- Host CPU: one heavy job at a time, `nice -n 19` and `taskset` (the host
  crashed under parallel model runs).
- The phone build (small-buffer split) stays as it is.

## The facts the design rests on (2026-10-29, Hugging Face listings)

| Model         | GPU copy                                                                                                                                                                                                                                          | CPU copy                                                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Qwen3-1.7B    | MLC q4f16_1, ~0.98 GB (as today)                                                                                                                                                                                                                  | `onnx-community/Qwen3-1.7B-ONNX` `model_quantized.onnx` (int8, one file) **1.66 GB**; or a GGUF Q4_K_M (~1.1 GB) through llama.cpp — the spike decides                        |
| Qwen3-4B      | MLC q4f16_1, ~2.3 GB                                                                                                                                                                                                                              | **none usable**: the ONNX repo has only fp16 and q4f16 (2.6 GB+, fp16 kernels the WASM backend lacks); a GGUF is ~2.5 GB, past a phone and slow anywhere. The 4B is GPU-only. |
| NLLB-200 600M | `Xenova/nllb-200-distilled-600M` fp16 encoder 791 MiB + merged decoder 888 MiB, or q4f16 584 + 612 MiB. Its shared embedding (256,206 × 1024 in fp16) is ~500 MiB in one tensor, so it needs a binding of at least that: never on a 128 MiB phone | q8, ~0.9 GB (as today)                                                                                                                                                        |
| OPUS-MT pair  | fp16 encoder ~93 MiB + merged decoder ~106 MiB; largest tensor (the shared embedding, ~58k × 512 fp16) ~57 MiB                                                                                                                                    | q8, ~0.11 GB (as today)                                                                                                                                                       |

The fp16 weights need WebGPU's `shader-f16`; a GPU without it runs these
models on the CPU (below).

## The shape

### One model, two copies

`ModelRef` keeps naming a model (family, id, label) and gains a per-device
description of its copies:

- `gpu?: DeviceCopy` and `cpu?: DeviceCopy`, each with what that copy
  downloads (`sizeBytes`), the library that runs it, the repo/id and dtype
  it loads, and what it binds (`largestBufferBytes`, GPU only). A model
  without a copy for a device cannot run there (the 4B's `cpu` is absent).
- The existing GPU fields (`vramBytes`, `largestBufferBytes`,
  `smallBuffer`, `lib`) move under `gpu`; the q8 transformers.js id moves
  under `cpu`. `engine`/`EngineName` stops meaning a device.

### Devices and the choice

- `Device = "gpu" | "cpu"`; `DeviceChoice = "auto" | Device`.
- Settings keys, all defaulting to `"auto"`: `translateLlmDevice`,
  `translateOpusDevice`, `translateNllbDevice`.
- The existing switches keep their keys and become one switch per family:
  `translateLlm` = the language model, `translateCpu` = OPUS-MT,
  `translateNllb` = NLLB-200. NLLB-200 no longer also needs `translateCpu`.
  No migration: a user who had NLLB-200 on and the CPU models off gets
  NLLB-200 back on, which their NLLB-200 opt-in already chose (my call).

### Can it run there: one rule

`modelBlock(ref, device, capability, switches)` answers for one model on
one device, using the rules that exist today, now keyed by device:

- **GPU**: the GPU device codes (`GPU_REASONS`), then the copy's binding
  need against `capability.maxBufferBytes` (the small-buffer build counts,
  as today), then a phone's memory (`tooLargeForPhone`, the 4B), then the
  switch.
- **CPU**: `PROBE_FAILED`, then no WebAssembly SIMD, then no WebAssembly
  Memory64 for the language model (`NO_MEMORY64`: wllama's standard
  build; desktop Safari), then "no CPU copy"
  (the 4B: a new block, `{kind: "noCopy", device: "cpu"}`, worded "Qwen3 4B
  can't run on the CPU; choose 1.7B to run it there"), then the phone's
  memory, then the switch. Phones may run the CPU copy (goal 4); an
  iPhone or iPad (WebKit kills a page past ~2.1 GB) blocks it with the
  `memory` reason only when the spike's measured peak worker memory is
  above 1.8 GB **(my call)**.
- **A GPU copy of NLLB-200 or OPUS-MT** needs a WebGPU adapter with
  `shader-f16` and a storage binding of at least that copy's largest
  tensor; WebLLM's own minimum limits (`GPU_LIMITS`) and the language
  model's buffer floor do not apply to it. No fp32 copies: a GPU without
  `shader-f16` runs these models on the CPU **(my call)**. The probe keeps
  the adapter's own verdict (adapter present, `shader-f16`, binding) apart
  from the `gpu` tier, which stays the language model's.
- **The 4B and the CPU**: a 4B the user never chose (the adapter default,
  `llmChoice`) resolves to the 1.7B whenever the language model is to run
  on the CPU, as `llmChoice` already falls back for a model the GPU cannot
  bind; a 4B the user chose blocks the CPU with "choose 1.7B" **(my
  call)**.

### Auto: which device is best

`deviceFor(ref, choice, capability, switches, cached)` returns the device
order to try, or the block. A pinned choice is that device alone. **Auto**
is an order of two:

- **Language model**: the GPU alone. The user asked for "a manual way"
  to put it on the CPU, and a single-threaded language model reading a
  channel waits tens of seconds per batch: a device whose GPU cannot run
  it (Firefox, no `shader-f16`, a binding under 74 MiB) keeps today's
  behaviour, the language model blocked with the GPU's reason, and the
  CPU runs it only when the user pins it there **(my call)**.
- **NLLB-200**: GPU, then CPU, where the GPU copy fits (it never fits a
  phone); else CPU alone.
- **OPUS-MT**: CPU, then GPU, on a phone (the models are small and the
  GPU's memory is kept for the language model); GPU, then CPU, on a
  computer.

These orders are a placeholder, stated as such in the code and the docs,
until measured on real GPUs (non-goal above).

The router walks a candidate's devices in Auto's order the way it walks
candidates now: a device whose copy is blocked, marked down, or refused for
download (the user said "Not now") is passed over for the next one. So:

- Auto on a desktop where OPUS-MT's CPU copy is downloaded and its GPU copy
  is not: the GPU copy is asked for once; "Not now" keeps the pair running
  on its CPU copy for the session. **(My call:** the mockup showed Auto
  picking the GPU there; a downloaded copy does not outrank the better
  device, but a declined download falls back to it.)
- A GPU copy marked down after two failures in a row (the device loss the
  phone hits) moves an Auto NLLB-200 or OPUS-MT to its other copy; the
  language model has no other copy under Auto, so it stays down for the
  session as today.
- The session's down set and refusals are keyed by model **and device**: a
  GPU loss marks down that model's GPU copy alone, for the session, as
  today (no stored state) **(my call)**.
- **A pinned CPU language model keeps its place** in the route tables
  against OPUS-MT and NLLB-200: the user chose it. The reading queue's
  request timeout and batch size follow the device (a CPU batch is smaller
  and its timeout longer; builder's numbers, from the spike's speeds).

`explainRoute` reports, when nothing can run, the block of the device the
user can most usefully act on: a pinned device's own block; under Auto the
first device's block unless it is a device code the user cannot change
while the other device's block is one they can (a switch, a download, the
4B's "choose 1.7B") — then that one. (Builder: keep it one sentence; the
UI renders one reason.)

### Engines and the worker

The service keeps its two slots, now named by what they hold rather than
where: the **language model** slot and the **seq2seq** slot (on a phone
one slot at a time, `makeRoom`, as today). Each slot holds one loaded model
on one device; asking for the other device unloads the first.

- Language model on the GPU: `WebLlmEngine`, unchanged.
- Language model on the CPU: a new engine behind the same `Engine`
  interface, with the same prompt profiles (`prompts/`), the same
  think-block handling, `fitToWindow` (`budget.ts`) against a CPU context
  window, the same greedy polish and temperature, streaming its output.
  Its library is the spike's winner.
- Seq2seq: `Seq2seqEngine` takes the device from the request and loads the
  pipeline with `device: "wasm", dtype: "q8"` (as today) or `device: "webgpu"` and the GPU copy's dtype; a loaded pipeline is keyed by model
  and device.
- `TranslateRequest` carries the device; the protocol's `has`/`delete`
  take a model and a device; the cache API answers per copy. The idle
  unload delay follows the device (`GPU_IDLE_UNLOAD_MS` /
  `CPU_IDLE_UNLOAD_MS`).
- A GPU loss (`GPU_LOST`, gpuLimits.ts) applies to whichever engine was on
  the GPU, seq2seq included.

### The CPU context window

The CPU prefills perhaps 20–60 tokens a second on one thread, so the
reading prompt's context lines cost tens of seconds. The CPU engine uses a
smaller window than the GPU (`fitToWindow` already trims context first):
start at 1024 tokens and let the spike's prefill speed set it so that a
typical composer translation with its context finishes in about 15 s on
the sandbox's desktop CPU (builder's call within that target).

### Settings → Translation (the mockup)

- The device line becomes "This device has a GPU and a CPU" / "… a CPU
  only" / nothing usable, followed by the buffer limit and the test cap as
  today.
- One block per model family, in this order: the language model (its
  name, and the size select as today, a choice the GPU cannot bind
  disabled as today), OPUS-MT ("12 language pairs"), NLLB-200 (licence
  line as today). Each: the switch, "Run on" (Auto / GPU / CPU as a
  radiogroup, a disabled choice struck through with its reason as text
  beside it, not only a tooltip), "Auto picks GPU here" with a one-phrase
  why when Auto is selected, then one line per device copy: "Downloaded ·
  1.0 GB" with Remove, or "Not downloaded · 1.6 GB" with Download (asks
  nothing more: pressing Download is the yes). OPUS-MT's copies count
  pairs ("2 pairs downloaded · 200 MB"); its per-pair rows stay below as
  today, each pair with its copies.
- Download progress, errors and the "Can't run" lines keep today's
  behaviour, per copy.

### Words

- "The GPU model" stops being the language model's name everywhere it
  appears in the interface (about 39 msgids) and "the CPU models" (about 7)
  stops meaning OPUS-MT and NLLB-200. Where a phrase names the model, it
  takes the model's own name as a `{model}` placeholder (`llmName`); where
  it cannot, "the language model". A device is named "the GPU" / "the CPU".
  Keys stay; msgids change; `merge.ts` marks the catalogs fuzzy; every
  changed and new string is translated into the 23 catalogs and swept.
- The composer's and the panel's reasons, the header button, the toolbar's
  Translate and the consent dialog all name the device where it matters
  ("Download Qwen3 1.7B for the CPU? 1.6 GB").

## Multithreading (added 2026-10-29, the user: "add multithreading with the service worker workaround too")

The spike measured the CPU at about 1.2 tokens a second on one thread: a
composer translation with context took 107 s. Multithreaded WebAssembly
needs a cross-origin-isolated page, which a deploy that sets headers
already gets (`docs/resources/branding.md` § Threads, `tools/serve.py`) and
GitHub Pages cannot. So the app's own service worker supplies the headers.

- **The root service worker** (`client/service-worker.js`, not the
  push-only workers under `push/<uuid>/`) adds
  `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: credentialless` to every response it
  serves for the app's documents (navigations) and for the app's own
  worker scripts (`request.destination === "worker"`, same origin), from
  the network and from the shell cache alike.
- **`credentialless`, not `require-corp` (my call):** link-preview images,
  video and audio, the uploader and a model mirror keep loading without
  any header of their own; they are fetched without cookies. The app
  embeds no iframes. `COOP: same-origin` severs `window.opener` between
  the app and windows of other origins; the app opens links in new tabs
  and relies on no opener.
- **WebKit does not support `credentialless`:** Safari and every iOS
  browser stay single-threaded (the CPU language model is blocked there on
  memory anyway). Nothing else changes for them.
- **No forced reload (my call):** a page is isolated only once the worker
  controls it — from the second load on, and always in an installed app.
  The app never reloads itself for it; Settings says when a reload would
  bring threads ("Reload the app to use 4 CPU threads").
- **Threads:** the CPU language model runs wllama's multithreaded build
  when the worker is isolated, with `cpuThreads(hardwareConcurrency, mobile)` threads: on a phone at most 4 (its little cores hold the big
  ones back), on a computer a cap measured on this host (1, 2, 4, 8
  threads timed; the cap is the count past which the gain is under 15 %),
  never more than `hardwareConcurrency - 1`. The seq2seq models take
  onnxruntime-web's own thread default, which already follows isolation
  (`seq2seq.real.ts` `threads`).
- **The batch and the deadline** (`CPU_BATCH_MAX_LINES`,
  `CPU_REQUEST_TIMEOUT_MS`) stay as measured single-threaded: they are the
  floor a non-isolated page needs.

## First step: the spike (measure, then build)

Before the CPU language-model engine is written, measure in headless
Chromium on this host (`nice -n 19`, `taskset`), one run at a time:

1. transformers.js 4.2 `text-generation` with
   `onnx-community/Qwen3-1.7B-ONNX` int8 on `device: "wasm"`: does it load;
   the worker's peak memory while loading and while generating
   (`performance.measureUserAgentSpecificMemory` or the process RSS);
   prefill tokens/s and decode tokens/s on one thread; whether the chat
   template honours `enable_thinking: false`; the output on three of the
   eval fixture's lines (`tools/translate-eval/`) and on the polish fixture.
2. The same for llama.cpp in WebAssembly (`@wllama/wllama` 3.8.1, pinned)
   with `unsloth/Qwen3-1.7B-GGUF` `Qwen3-1.7B-Q4_K_M.gguf` (1,056 MiB).
3. transformers.js `translation` for one OPUS pair on `device: "webgpu"`
   under SwiftShader. SwiftShader has no `shader-f16`, so this proves the
   code path with the fp32 files only, as a test seam; the shipped GPU
   copies are fp16.

Decision rule: a library that fails to load or produces wrong output is
out. Of what remains, prefer transformers.js (no new dependency) unless its
peak memory is above 2.0 GB where the other's is below it, or the other is
at least 1.5× faster at decode. Write the numbers and the decision to
`tools/translate-eval/results/2026-10-29-cpu-llm.md`. If neither works,
stop and report: the CPU choice for the language model is then disabled
with a reason, and the rest of the design still stands.

## Tests and checks

- Mocha: `modelBlock` per device (every probe shape × model × device),
  `deviceFor` (each family × phone/desktop × pinned/Auto × cached/declined/
  down), `explainRoute` with devices, the availability grid extended, the
  CPU language-model engine through injected deps (as `webllm.ts` is
  tested), the seq2seq device keying, the service's slots with a device
  switch, consent keyed by device, the settings defaults, the strings
  (`test/helpers/translateWhy.ts`).
- `yarn test` (lint, i18n check, mocha) green; `vue-tsc` green.
- Browser: extend `tools/scenarios/translate-capability.mjs` (its stubbed
  adapters, also `--mobile`) and `translate-settings.mjs` to the new rows:
  the radiogroup, a disabled choice with its reason, Auto's line, the
  per-copy lines; screenshots of phone and desktop shapes looked at.
- Docs: `docs/resources/translation.md` (a § Devices), the CLAUDE.md
  translation bullet, `docs/projects/client-translation.md` where it says
  GPU tier / CPU tier.

## Not in this build (2026-10-29, the final review, Ruling Z)

**The seq2seq GPU copies.** OPUS-MT and NLLB-200 ship with their CPU copy
alone. The worker's ONNX Runtime is the wasm-only bundle:
`webpack.config.ts` aliases `onnxruntime-web/webgpu` to
`onnxruntime-web/wasm`, whose `ort.wasm.bundle.min.mjs` registers only the
cpu/wasm backends, and `js/ort/` ships no jsep wasm (`test/tests/build.ts`
pins that). `seq2seq.real.ts`'s `device: "webgpu"` would find no backend,
and transformers.js downloads the weights before ORT fails the session: a
yes would cost 210 MB per OPUS-MT pair or 1.26 GB for NLLB-200, and Auto
(GPU first on a computer) would ask it of every desktop with WebGPU and f16.
So the shipped catalog leaves the copies out (`models.ts`
`CatalogOptions.seq2seqGpu`, off, never read from a deploy's
`config.json`); their GPU choice is struck through with its own reason
(`noCopy`, `device: "gpu"`, `translate.why.noGpuCopy`), Auto leaves out a
device the model has no copy for, and the tests turn the option on so the
GPU rules, routing, consent and loading stay covered.

Shipping them needs:

- onnxruntime-web's WebGPU bundle in the worker (drop the alias) and its
  jsep wasm (~26 MB) under `js/ort/`, which changes the CPU path for
  everyone too (the same runtime serves both) and the build test's pins;
- a check on a real GPU (none here: this host has no headless GPU) that
  both models load, translate and fit the bindings `largestBufferBytes`
  claims, with OPUS-MT's per-pair figure measured rather than the en-de one;
- seq2seq GPU-loss handling (Ruling AA, deferred): a lost device marks the
  copy down and Auto moves to the CPU copy, as the language model's does;
- `seq2seqGpu: true` in `index.ts`, and the docs' copies table back.

## Left to the builder

The names of types and functions above are suggestions; the module
boundaries are not (the rule in `models.ts`/`router.ts`, store glue in
`reader.ts`, sentences in `translateWhy.ts`). The CPU window within its
target; the exact phrasing of the new strings within the words rule; how
the radiogroup is laid out on a phone.
