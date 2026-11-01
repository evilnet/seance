# Client-side translation

Seance translates on the user's device: no server, no translation API. This
file is the reference for the engine layer (`client/js/translate/`); the
design is `docs/projects/client-translation.md` and the deploy knobs are
`docs/resources/branding.md` § Translation.

## Two engines, one router

> Since 2026-10-29 the engine is no longer the device: every model runs on the
> GPU or the CPU (§ Devices). Read "GPU" and "CPU" below as the device a
> model ran on **before** that: the language model on the GPU through WebLLM,
> OPUS-MT and NLLB-200 on the CPU through transformers.js. The language model
> now also has a CPU copy (wllama); OPUS-MT and NLLB-200 have GPU copies
> (transformers.js on WebGPU) in the catalog's logic but not in this build,
> which runs them on the CPU alone (§ Devices); and the switches are one per
> model: `translateLlm`, `translateCpu` (= OPUS-MT) and `translateNllb`.

- **The language model on the GPU: WebLLM.** An instruction LLM on WebGPU, prompted to translate with
  the channel's context. Greedy at temperature 0.1, thinking off, one line
  of output. Needs an adapter with `shader-f16` and a storage binding
  (`capability.ts`: `min(maxBufferSize, maxStorageBufferBindingSize)`)
  that holds the smallest GPU model's largest tensor -- `models.ts`
  `LLM_MIN_BUFFER_BYTES`, since a model binds each weight tensor whole. The
  1.7B's own largest tensor is its 148 MiB vocabulary embedding
  (155,582,464 bytes), the 4B's 185 MiB; the floor is the 1.7B's
  small-buffer build, 74.2 MiB (§ Phones and small GPUs). Which model fits
  is `llmFits(ref, maxBufferBytes)` against its smallest build. WebLLM
  0.2.85 itself asks the GPU for 1 GiB, or WebGPU's 128 MiB floor when the
  adapter cannot give that -- nothing between -- so on a phone offering
  512 MiB it got 128 MiB and no model loaded; the worker wraps
  `GPUAdapter.prototype.requestDevice` (`engines/gpuLimits.ts`, installed
  by `webllm.real.ts`) to ask for what the adapter offers, capped at
  WebLLM's own 1 GiB so a desktop's device is unchanged, and to make the
  original request should the raised one be refused. A device whose
  binding is under 148 MiB (WebGPU's 128 MiB minimum, which many phones
  report) runs the 1.7B as its small-buffer build.
  There must be a `navigator.gpu` at all: away from localhost a plain-HTTP
  origin is not a secure context and the API does not exist, so the probe's
  reason says so — "insecure origin: WebGPU needs HTTPS or localhost —
  serve the app over HTTPS" — where a bare "no WebGPU" would send someone
  shopping for a GPU they already have. Settings' device note shows it.
- **Two GPU models, one chosen.** `models.ts` `LLM_CHOICES`: `Qwen3-1.7B-q4f16_1-MLC`
  (the default, 984 MB download, ~2.0 GB of GPU memory) and
  `Qwen3-4B-q4f16_1-MLC` (2.28 GB, ~3.4 GB); NLLB is 912 MB with its
  tokenizer and an OPUS-MT pair about 113 MB (Hugging Face's listings,
  2026-10-27; Settings shows them). On 45 casual chat lines into
  French, German and Spanish they scored alike (41 and 40 clean), and 4B's
  phrasing read noticeably more natural; it is also slower and needs more
  memory. It is nonetheless the **default** on a computer with the memory
  for it (`models.ts` `defaultLlmForAdapter`): only a model the GPU can
  bind (`llmFits`) is a candidate, and the 4B needs the probe to have read
  **6 GiB** of `navigator.deviceMemory` (`LARGE_LLM_MIN_MEMORY_GIB`) on a
  device that is not a phone or tablet (`Capability.mobile`:
  `userAgentData.mobile`, else the user agent, an iPad asking for desktop
  sites by its touch points) -- Chrome reports 8 GiB on many phones, where
  3.4 GB is most of the memory. Without a `deviceMemory` reading (Safari,
  Firefox) the default is the 1.7B: the adapter's limit is per buffer and
  says nothing about the total. A model this GPU cannot bind is greyed in
  the "GPU model" select (a disabled option, a hint under the select
  naming it with the buffer numbers: `Translation.vue` `llmUnfit`, the
  `buffer` or `device` block of `modelBlock`, on a `gpu`-tier device only --
  elsewhere the choice only keys the route table), so it cannot be chosen
  and then quietly not run; a stored choice that does not fit (a restored
  backup, another device) still runs the default instead (`llmChoice`),
  so a `gpu` tier always means the model in use can load, and its Settings
  row says why. The pick
  stands in for an unset setting **at read time and is never persisted as a
  choice**, and only on a `gpu`-tier device — the selected model also picks
  the route table, whose non-LLM entries differ between the two, so a device
  that can run neither keeps the catalog's default. A user who never picked
  and a deploy that named no model of its own follow the device, and the resolution is redone when the probe lands
  (`service.ts` `capabilities`, `llmChoice(catalog, setting, capability)`).
  Settings → Translation's
  "GPU model" select writes `translateLlmModel` (carried by the settings
  backup like any setting); the model manager lists both rows, whichever is
  selected, and marks the selected one "In use". The setting stays `""`
  until the user picks a model, and an unset value resolves to the
  deploy's model, else the device's pick, else the catalog's default each
  time it is read, so a deploy's
  `translation.llm.model` is the default for everyone who never chose (and
  a later deploy default reaches them too); it is added to the choices when
  it is neither shipped model, its `lib` on its own ref only
  (`ModelRef.lib`). A stored id that is no longer a choice resolves like
  an unset one (`llmChoice`). **GPU work is one model at a time**: a request or
  a Settings download claims its model (`llmStarted`), and work on another
  model — a request, a download, a switch's unload — waits until those
  claims are released, since WebLLM loading one model tears down the
  engine the other runs on; a load that another model's work may have torn
  down never marks the route down. Deleting a GPU model unloads the engine
  only when it holds that model, after that model's own work ends.
  **A switch takes effect without a reload** (`service.ts` `setLlmModel`):
  nothing in flight is cancelled; a running LLM request finishes on the old
  model, LLM work waits until those are done (WebLLM holds one model, and
  loading another would end them), then the old model is unloaded if it is
  still the one loaded, and every request routed afterwards — a queued
  reading line included — goes to the new model. The switch lifts the LLM
  candidate's down-mark; the new model failing to load marks it down as
  before.
- **One route table per GPU model.** Where the LLM beats NLLB depends on the
  model, so `routes.default.ts` keeps each model's placements as their own
  lists (`NLLB_FIRST`, `NLLB_TIED`, `OPUS_TIED`, `LIMITED_LANGUAGES` for
  1.7B; `QWEN3_4B_NLLB_FIRST`, `QWEN3_4B_NLLB_TIED`, `QWEN3_4B_OPUS_TIED`,
  `QWEN3_4B_LIMITED_LANGUAGES` for 4B) and `routesFor(llmModelId)` /
  `limitedLanguagesFor(llmModelId)` build from them; a model without lists
  of its own (a deploy's) gets 1.7B's. Each model's lists are placed from
  a round trip on its own 4-bit web weights
  (`tools/translate-eval/results/2026-09-13-web-weights.md`); 4B leads NLLB
  outright in pl cs sk hu hi th, ties it in nb fi bg sr fa bn id ms ca gl
  af, trails it in hr sl el he ta eu ga cy sw tl ur, and none of its
  languages is limited (`test/translate/routes.ts` pins where the two tables
  differ).
- **Only the languages that translate well are offered.** Estonian,
  Latvian, Lithuanian and Icelandic came back under 55% of a line's content
  words from every engine (1.7B, 4B, NLLB), so they were dropped from
  `SUPPORTED_LANGUAGES` and the route lists; the remaining 46 are listed in
  `SUPPORTED_LANGUAGES` itself (`client/js/translate/languages.ts`) — a
  translation-engine list independent of the interface's target list at
  `translation-languages.txt`, which the beta trimmed to 24 (§ i18n.md
  "Adding a language"). A line in a dropped language
  is no longer detected as that language (franc's candidates are the
  supported list), so it reads as unplaced; the reading language is the
  interface's (`reader.ts` `readingLanguage`, `fromLocaleTag`), which
  maps any tag the supported list lacks to English, and a channel's stored read
  language — the per-channel picker the unification removed — loads as
  plain "on" (`channelStore.ts`). All four scores rest on three cases each
  (`tools/translate-eval/results/2026-09-13-web-weights.md`); the best were
  NLLB's, 43–54%. The service builds its table from
  the selected model's with the deploy's `translation.routes` merged over
  it, and rebuilds it on a switch.
- **One prompt profile per GPU model** (`prompts/`). The prompt was tuned
  on 1.7B, and a different build already reacts differently to the same
  wording (the float16 1.7B wrapped 11 of 45 casual answers in markdown
  marks), so the wording is chosen per model: `promptProfileFor(modelId)`
  returns a `PromptProfile` — `systemPrompt`, `userPrompt`,
  `buildMessages`, `maxTokensFor`, `KEEP_MARKS`, `KEEP_TAGS`,
  `ONLY_THE_TRANSLATION`. `QWEN3_1_7B_PROMPT` is `prompt.ts` itself (its
  builders, not copies, so `test/translate/prompt.ts` pins it byte for
  byte); `QWEN3_4B_PROMPT` (`prompts/qwen3-4b.ts`) started as a copy in its
  own module, so 4B's wording changes without touching 1.7B's and the
  other way round. Today they render the same: each was measured on its
  own web weights, and both say the marks sentence only on a line that
  carries a mark (casual set, 45 lines: 1.7B 32 to 40 clean, 4B 30 to 37;
  4B also kept the register sentence, which measured 2 lines better than
  without it); `test/translate/promptProfile.ts` pins them equal. A
  model without a profile of its own gets 1.7B's. `WebLlmEngine` asks with
  the loaded model's profile; the batch sentinel, the output parsing and
  the canned answers stay shared in `prompt.ts`. The offline runner takes
  `--profile <model id>` (default 1.7B) to choose the wording apart from
  the weights it loads.
- **OPUS-MT and NLLB-200 on the CPU: transformers.js on ONNX Runtime WASM.** Purpose-built translation
  models: NLLB-200 distilled 600M (any pair, FLORES codes) and OPUS-MT pair
  models (30-80 MB each). Two stay loaded, least recently used evicted.
  Several times faster with WASM threads, which need the cross-origin
  isolation headers (branding.md). **NLLB is sent one sentence at a time**
  (`engines/seq2seq.ts` `splitSentences`: after `.` `!` `?` `…` and
  whitespace or the end, after `。` `！` `？` whatever follows, never inside
  a placeholder or at a decimal point), the results joined with a space
  and streamed after each sentence: handed a two-sentence line whole it
  translates the first sentence and stops (35% of content words back whole,
  51% split, over 27 languages). OPUS-MT keeps every sentence of a whole
  line and scores the same or better whole, so its requests stay whole.
- **The router** (`router.ts`, `routes.default.ts`) picks per pair from a
  table entry of **quality classes**, best first, narrowed by the device
  tier, the two engine settings, the catalog and the session's down-marks
  (a candidate whose model failed to load or translate is skipped until
  reload). The first class with a usable candidate takes the request.
  Inside it, a candidate whose model is **already downloaded** wins over
  the class's own order; a better class is never skipped for a downloaded
  model in a worse one. In an entry a bare candidate is a class of one and
  a nested list a class of equivalent candidates: `["nllb", "llm"]` is a
  strict order, `[["llm", "opus:de-en"], "nllb"]` makes the LLM and the
  OPUS pair interchangeable ahead of NLLB. A deploy's `translation.routes`
  has the same shape, so an older flat override stays valid and reads as a
  strict order. The row for a pair is the target's row for the source, the
  target's wildcard, the wildcard target's row for the source, then the
  global wildcard. The service asks the worker which models are downloaded
  on its first route, once, so the preference works before Settings has
  been opened.
- **A better class that is not downloaded is downloaded on demand**, not
  passed over: the strip or the reading line says "Downloading <model>… N%"
  while it waits, or "Loading <model> into memory… N%" when the model is
  already on the device and only being loaded back (after an idle unload, a
  GPU model switch or a reload; `service.ts` `loadNote`, off the model
  views' `cached`), and
  the request's deadline (two minutes in the queue and the composer) waits
  the download out: `outgoing.ts` `armDeadline` re-arms a deadline that
  runs out while the service's `loadTicks` counter is still moving, and
  fires once the download stalls. A download that fails marks the class
  down; the next class answers, and the reason stays on the model's row and
  in the error. The alternative -- answer from the best downloaded class
  while the better one downloads -- was not taken: it is exactly how a
  Filipino draft reached Qwen, and a device with nothing downloaded has to
  wait for a download anyway.
- **The source hint.** A seq2seq model has no prompt to detect a source in,
  so a request whose `from` is null used to skip every CPU candidate. A
  request's routing hint now picks the table row when `from` is null and
  lets a seq2seq candidate run: the service sends that request with the
  hint as its `from`, while an LLM request keeps `from: null`. The hint is
  `TranslateRequest.hint` when the caller sets one, else
  `context.sourceHint` (the reader's channel prior, which the LLM prompt
  already carried). The composer puts the draft's weak detector verdict in
  `hint` only (`outgoing.ts` `sourceHintFor`) when `writeSource` names no
  source: it never reaches the prompt, since telling the LLM a guess the
  code judged too weak to trust is what the prompt measurements warn
  against. The bare second try drops `context.sourceHint` as before and
  keeps `hint`, so it goes down the same route.
- **The shipped 1.7B table follows a measurement** (4B's its own, above):
  `tools/translate-eval/results/2026-09-12-languages.md`, the share of an
  English line's content words that come back after a round trip through
  each engine (Qwen on 3-9 chat shapes, NLLB and OPUS-MT on a question, a
  casual line and a two-sentence line; `tmp/cpu-roundtrip.ts` for the CPU
  models), with Qwen re-scored on the web build's own 4-bit weights
  (`2026-09-13-web-weights.md`: the ONNX export's float16 output head had
  flattered it on the long tail). Differences under ~10 points are ties.
  NLLB first with the LLM as the fallback class for sr hr sl el he fa bn ta
  et lv lt eu cy is sw af tl ur fi hu hi; the LLM and NLLB in one class for
  sk ms gl th cs nb bg id; the LLM and OPUS-MT in one class for de nl ru fr,
  the LLM then OPUS-MT for es it; the LLM then NLLB everywhere else (pl, ca
  and ga measured the LLM ahead). Arabic measured NLLB well ahead (29 points
  on the web weights) and is placed LLM-first anyway: the LLM reads the
  channel's context and the seq2seq models do not, and a short-line round
  trip flatters benchmark-trained models in chat. Each placement
  applies to the language as source and as target. `LIMITED_LANGUAGES`
  (is lv et hi lt bn hu sk ko) are the languages whose best engine brought back
  under 55%: the panel's write picker and the Settings language select say
  "Translations into and out of this language are often wrong." when one is
  chosen — the selected GPU model's list.

### What runs here, and why not

One Vue-free rule answers "can this run on this device, and if not why" for
every surface, so nothing is offered that the router would refuse and
nothing the router would take is hidden:

- **Per model** -- `models.ts` `modelBlock(ref, capability, switches, enabled)` returns null or a reason, in the order the user can do least
  about first: `disabled` (the deploy), `probing` (no probe answer yet),
  `device` (a capability code: for a GPU model the first of PROBE_FAILED,
  INSECURE_ORIGIN, NO_WEBGPU, NO_ADAPTER, NO_F16; for a CPU model
  NO_WASM_SIMD), `buffer` (`{needed, limit}`: the model's largest tensor
  against the adapter's binding, given to every GPU row, on a cpu-tier
  SMALL_BUFFER device too, and never when f16 is missing), then `off` (its
  engine switched off in Settings, or NLLB-200's own opt-in, `engine: "nllb"`). A model the device cannot run is never reported as switched
  off.
- **Per pair** -- `router.ts` `explainRoute(table, catalog, input)` is the
  router: `resolveRoute` is `explainRoute(...).route`. With no route it
  gives the reason (a candidate's `modelBlock`, `down` for one that failed
  this session, `download` for a model whose download the user declined,
  `unserved`) and `polish` for a one-language request. Of several
  candidates' reasons a switch the user turned off wins (both off is
  `engine: "all"`), then a declined download, else the best class's. `routeInput(capability, switches, pair)` builds the input from the probe for the service and the
  UI alike, including WebAssembly SIMD on a gpu-tier device; a UI question
  with no source yet (`sourceLater`) counts the CPU models as the detector
  will name one.
- **At all** -- `router.ts` `translationBlock` (the GPU model in use and
  the CPU models): null while either runs.

`reader.ts` `pairVerdict(from, to)` and `currentTranslationBlock()` are the
store glue, `helpers/translateWhy.ts` the words (one whole sentence per
reason, shown under a lead sentence, never spliced into it). Where it
shows: Settings -> Translation, per model family (`reader.ts`
`modelDevices`): "Run on" (Auto / GPU / CPU, a radiogroup; a device that
cannot run the family is a disabled, struck-through choice with its reason
as text below it and as its description, a switched-off family keeping
every choice open), under Auto "Auto picks the GPU here." / "… the CPU
here." / the first device's reason when nothing runs (said once: that
choice is then described by this line), then one line per copy
("Downloaded · <size>" with Remove, "Not downloaded · <size>" with
Download, disabled and described by its reason where that copy cannot run;
OPUS-MT adds a per-device "<n> pairs downloaded · <size>" summary above its
pairs); the composer's translate dialog and
the chips' "Retranslate from…" (the confirm disabled, the reason in a polite
live region that describes it); the panel (a notice when nothing runs, the
reading switch's On disabled, languages nothing can write in greyed under
"Send my messages in" with the reason, the note naming the greyed option);
the header button (dimmed, labelled "Translation can't run here right
now." on touch as with a pointer, its click opens the panel); the message
toolbar's Translate (with a pointer disabled, the reason as its tooltip and
description; under a finger, which shows no tooltip, `aria-disabled` and
its tap opens the panel with the reason); and a line or strip that failed for
want of an engine names why. Tests: `test/translate/availability.ts`;
browser check `tools/scenarios/translate-capability.mjs` (five stubbed
adapters, also `--mobile`).

### A download asks first

The router sends a request to the best class whether its model is
downloaded or not, and the service downloads on demand, so one click on the
header's translate button could start a 1-2 GB download. Before the first
download of a model that is not on the device, not downloading already and
never agreed to, the user is asked once (`consent.ts` `DownloadConsent`,
held by the service): the app's confirm dialog (`ConfirmDialog.vue`, its
`note`/`cancel`/`primary` options) titled "Download <model>?", the size from
`ModelRef.sizeBytes` through `friendlysize`, a line about the connection
when `navigator.connection` reports Save-Data or a cellular link, and
Download / Not now. The question is asked **when the route is resolved**
(`service.ts` `resolve`, which `route()` and `translate()`'s own walk go
through), before the reading queue or the composer arms a request
deadline, so a dialog left open times nothing out and the queue's engine
and marker form are chosen with the answer known.

- **Once.** Every request waiting on the same model shares one question,
  and one dialog is open at a time across models; a channel with fifty
  queued lines asks once.
- **Download** is remembered per model in `thelounge.state.translateConsent`
  (`storedConsent`; `thelounge.state.*` is never in the settings backup).
  Settings' own Download button is consent already (it shows the size) and
  records it; deleting a model in Settings takes it back.
- **Not now** holds implicit downloads back for the rest of the session:
  that walk, and every later one, takes only a model that needs no
  download (on the device, agreed to, or downloading already), so the
  fallback never pops a second dialog for NLLB or an OPUS pair. With none,
  the request fails with `needsDownloadError(ref)` -- a code and the model
  as JSON, which `helpers/translateErrors.ts` words as "Needs <model>, a
  <size> download: get it in Settings → Translation." (the line's reason, in
  full in its tooltip). The reading queue gets it as a rejected route
  (`reader.ts`, through `enqueueAt`'s rejection path) or, should
  `translate()` report it, through `fail()`, which counts it toward no
  pause (`PAUSE_AFTER_FAILURES` never trips on a declined download). A
  Retry on a line is a new question (`service.forgetDeclines`).
- The UI's availability questions (`pairVerdict`) do not read declines:
  the actions stay offered, and a line or strip says why it did not run.
- Without a dialog wired (`ServiceDeps.askDownload` absent) every download
  goes ahead unasked; the in-page fake (`?fakeTranslate`) asks only when
  the URL also has `askDownloads`.

Tests: `test/translate/consent.ts`, `test/translate/service.ts` "download
consent"; browser check `tools/scenarios/translate-capability.mjs` (one
question for a channel's lines, Not now naming the model on each line, no
pause) and `tools/scenarios/translate-consent.mjs` (the fake: Not now
falling back to a downloaded OPUS pair).

### Phones and small GPUs

A WebGPU device binds at most `maxStorageBufferBindingSize` per storage
buffer, WebGPU's floor is 128 MiB, and many phone GPUs (Adreno 7xx) offer
no more. The 1.7B's quantized vocabulary table is one 148 MiB tensor, so
the model as published cannot load there. The app ships a build of the
1.7B's library of its own that splits the table by rows into two halves
(`model.embed_tokens.part0.*`, rows 0–75967, and `part1.*`), whose largest
tensor is 75968 × 1024 bytes = 74.2 MiB (`tools/translate-split/`: the
model patch, the toolchain, how it is rebuilt and checked).

- **The same weights.** Each half is a byte range of the same published
  shard record, so nothing is re-hosted: before WebLLM loads the build, the
  worker fetches the model's `tensor-cache.json` from Hugging Face at a
  pinned commit (`models.ts` `QWEN3_1_7B_PINNED_MODEL`; the byte ranges
  cannot drift, and none of the build's cache keys is the model's own
  `resolve/main/` one), rewrites the two table records into four
  (`engines/splitManifest.ts` `splitManifest`: each row's bytes are the
  record's `nbytes` over its rows) and puts the result into WebLLM's
  `webllm/model` Cache Storage under the exact URL WebLLM will fetch the
  manifest from (`seedSplitManifest`). WebLLM matches its cache before it
  fetches, so it reads the rewrite. A seed of our own (`metadata` carries
  `SeanceEmbeddingSplit`) is kept; anything else under the key -- the stock
  manifest WebLLM's delete fetches into a missing key -- is replaced. A
  published manifest whose table is not the shape and type the library was
  compiled for is refused, nothing is seeded, and the row says why.
- **The app's own library.** `client/models/qwen3-1.7b-q4f16_1-split-<sha8>.wasm`,
  copied to `public/models/`, which the service worker neither precaches
  nor caches; WebLLM keeps it in `webllm/wasm` by its URL, so a rebuilt
  library gets a new name. The worker resolves it against its own location
  (`js/translate-worker.js`'s parent), so a deploy under a subpath
  (`/seance/develop/`) finds it.
- **One model in Settings.** The user sees "Qwen3 1.7B"; its `ModelRef`
  carries the build (`smallBuffer`: its own WebLLM id
  `Qwen3-1.7B-q4f16_1-MLC-split`, the pinned weights, the library, the
  split, 77,791,232 bytes). Which build loads is one rule, `models.ts`
  `smallBufferBuildFor(ref, maxBufferBytes)`: the model itself where it
  fits or the limit is unknown, the build where only it fits. The engine's
  load, the worker's "is it downloaded" (`engines/webllmCache.ts`), Settings
  and the download consent read it, so a phone's Download downloads the
  build and a desktop's the model; everything above the engine keeps the
  model's id. Delete removes every build whose manifest is in the cache,
  and the seeded manifest. The page tells the worker what its probe
  measured (`configure`'s `gpu`, again when the probe lands after the
  worker started). The 1.7B row on such a device says "This GPU gets a
  build of the model made for small graphics buffers: its largest buffer
  is 74.2 MiB."
- **What has no build.** The 4B (its row keeps "Needs a GPU buffer of
  185.5 MiB; this device binds at most 128 MiB"); a deploy that mirrors the
  weights (`translation.modelBase`) or names its own library for the 1.7B,
  since the build reads Hugging Face through the app's library.
- **What is proven.** The rewrite is byte-for-byte the one the bench ran
  (2026-10-28, headless Chromium on SwiftShader, which has no
  `shader-f16`, so with the q4f32 twin of the library): the stock library
  at a 128 MiB cap gave WebGPU validation errors and garbage, the split one
  no errors and the stock library's greedy tokens. The f16 library the app
  ships was built the same way from the same source but has not run on a
  GPU yet: its first run is the desktop test below, then a phone.

**The test switch.** `localStorage["thelounge.state.gpuTestLimitMiB"]`, a
number of MiB (at least 128, WebGPU's own floor; `translate/gpuTestLimit.ts`),
makes the probe report `min(real, cap)` and the worker hold WebLLM's
device request to it (`gpuLimits.ts` `setBufferCap`, its fallback request
too), so a desktop GPU binds what a phone does and runs the build. Read
once per page: set it in the console and reload --

```js
localStorage.setItem("thelounge.state.gpuTestLimitMiB", "128");
location.reload();
```

-- and Settings → Translation says "Limited to 128 MiB for testing …" under
the device line. To clear it, delete the model in Settings first (Delete
there removes both builds either way), then
`localStorage.removeItem("thelounge.state.gpuTestLimitMiB")` and reload. A
`thelounge.state.*` key, so the settings backup never carries it. Browser
check, no ircd and no model run: `tools/scenarios/translate-small-gpu.mjs`
(the phone, the switch and a desktop over a stubbed `navigator.gpu`, the
app served under a subpath; Download seeds the pinned manifest and fetches
the library from the app's own URL, and stops at WebLLM's device check,
before any weight).

#### Memory: the window, the 4B, one engine at a time

A phone binding enough is not a phone holding enough. On an iPhone,
loading the 1.7B's small-buffer build got the page killed: WebKit counts GPU
memory against the page's own WebContent process, kills it past about
2.1 GB, and its GPU process then dropped a failed Metal command buffer. So
a phone or tablet (`Capability.mobile`, capability.ts `isMobile`: Chromium's
`userAgentData.mobile`, else iPhone/iPad/Android/"Mobi" in the agent, and
an iPad asking for desktop sites, which reads as a Mac with
`maxTouchPoints > 1`) is held to three rules.

- **The window is memory.** WebLLM sizes the KV cache for the whole context
  window at load, and the app never named one, so the record's 4096 held.
  Measured on a SwiftShader bench (the f32 build; the shipped f16 KV is
  half): 1,278 MiB at load with `context_window_size` 1024, 1,502 at 2048,
  1,950 at 4096 -- about 1,050 / 1,160 / 1,390 MiB in f16. On a phone the
  engine reloads with `{context_window_size: MOBILE_CONTEXT_WINDOW}` (2048,
  `models.ts` `contextWindowFor`, told to the worker as
  `GpuBudget.mobile`; WebLLM 0.2.85's `reload(modelId, chatOpts)` overrides
  the record with it); a computer's reload is the one-argument call it
  always was. 1024 would save ~110 MiB more and cannot hold a full line
  with its context; the library's prefill chunk is 1k.
- **What a prompt costs** (2026-10-28, the shipped prompt code tokenized
  with Qwen3's own tokenizer, the chat frame and WebLLM's empty think block
  included, plus the reply's `max_tokens`). The worst single read -- ten
  earlier lines at IRC's full ~440 bytes each with their translations (the
  profile's own 700-token trim lets them all through), a 250-byte topic
  (TOPICLEN), 20 names (`NAMES_CAP` holds a 2,000-user channel to the
  speakers and the mentioned), 20 terms, a reply target, a full line --
  is 1,469–1,996 prompt tokens and 1,716–2,390 with the reply (Russian,
  Arabic, Japanese, English source); a write with five voice lines
  2,209–2,896; a batch of six full lines (`BATCH_MAX_LINES`) 2,430–3,549;
  the cleanup pass about 300 + its reply. A typical channel (120-byte
  lines, six terms, a short topic) is 1,305–1,586 for a single request and
  fits 2048 whole; its batches drop four to seven earlier lines. And a
  100-line `draft/multiline` message sent as one numbered batch is
  4,515–5,737 prompt tokens -- over the desktop's 4096 too.
- **Every request is fitted to the window** (`budget.ts`, in the engine,
  so the reader, the composer and multi-line messages alike): the prompt's
  bound and the reply's `max_tokens` must fit -- WebLLM checks only the
  prompt, and a reply that runs into the end of the window just stops, a
  batch with lines missing or a line cut short, both reading as answers.
  Over it, the oldest earlier lines go first, then the terms (oldest
  first, the deploy's glossary last), the names, the user's earlier lines,
  each batched line's reply note, the topic and the reply target. A batch
  that does not fit even bare is refused as `BATCH_REFUSED`, so its lines
  go one at a time (queue.ts `resplit`, outgoing.ts `translateDraft`); a
  single line that does not fit is `CONTEXT_OVERFLOW`, "too long for
  this device". There is no tokenizer before the model loads
  and none under mocha, so the count is `tokenBound`, a per-class bound
  calibrated on the real tokenizer (`test/translate/budget.ts` holds the
  counts: 14 languages, URLs, digits -- Qwen3 splits numbers into single
  digits --, hex, emoji, code, zalgo): it over-counts prose by 1.1–1.8× (Vietnamese 2×)
  and under-counts only long random letter runs, rare ideographs and
  archaic Cyrillic. At 2048 the worst single read above keeps one of its
  ten earlier lines (none for an English source with Japanese
  translations) and the worst write none, at 1,426–1,670 real tokens.
- **The backstop.** When the bound under-counts, WebLLM throws
  `ContextWindowSizeExceededError` before prefill (`isContextOverflow`, by
  name or message). The engine keeps the model loaded and counts no
  failure -- the generic path would have dropped the engine and reloaded a
  gigabyte, which on a phone is what kills the page -- and reports
  `CONTEXT_OVERFLOW` as the request's failure. The reading queue retries
  each line bare and alone (a batch is taken apart, a multi-line message
  retried whole and bare), fails one that overflowed bare, and counts none
  of it toward `PAUSE_AFTER_FAILURES`. The composer shows the error.
- **The 4B cannot run on a phone.** Its weights alone are 2.2 GB
  (`vramBytes` 3.4 GB). `modelBlock` answers `{kind: "memory", needed}`
  for a GPU model over `MOBILE_LLM_MAX_VRAM_BYTES` (2.5 GB) on a mobile
  device, after the device and buffer reasons and before the switch -- "It
  needs more memory than a phone or tablet lets a web page use."
  (`translate.why.phoneMemory`; the select's hint above gives the size) -- so its Settings row cannot be
  downloaded, the GPU select greys it (`llmUnfit`), and `llmRunsOn` keeps it
  out of `defaultLlmForAdapter` and out of `llmChoice`, an explicit choice
  and a deploy's `translation.llm.model` included (both run the 1.7B on a
  phone); the router hears the same reason for a catalog that still names
  it. The 1.7B stays allowed.
- **One engine in memory at a time.** The CPU engine's ONNX Runtime heap
  (NLLB-200 ~900 MB, an OPUS-MT pair ~110 MB) lives in the same worker,
  so in the same page. On a mobile device `service.ts` `makeRoom` runs
  before a request or a Settings download claims its engine: the other
  engine running, it waits; the other loaded, it unloads it; and the GPU
  model wanted in a worker the CPU engine has run in, it starts a fresh
  worker (`recycleWorker`, without the teardown's generation step), since
  a WebAssembly heap grows and never shrinks. Every caller waits for one
  unload to be answered before it loads (`evicting`). A download now waits
  for the probe first, which says whether this is a phone, and on a phone
  its progress moves `loadTicks`, so a request waiting behind it for the
  other engine keeps its deadline alive rather than timing out (and
  pausing its engine) through a long Settings download. The cost: a phone
  whose channels route some lines to the GPU model and others to an
  OPUS-MT pair reloads a model at every switch. A computer keeps both, side
  by side.
- **Not addressed.** The load-time peak: WebLLM reads each weight shard
  into an `ArrayBuffer` before uploading it, so the page briefly holds a
  shard twice. Only a run on an iPhone shows whether 2048 and the other
  rules bring the load under the limit.

## Devices

Design `docs/projects/translation-devices.md`; measurements
`tools/translate-eval/results/2026-10-29-cpu-llm.md`. Every model has up to
two **copies**, one per device, in the catalog (`models.ts` `ModelRef.copies`:
`gpu?` and `cpu?`, each a `DeviceCopy` with its download size, source, dtype
and, for a GPU copy, what it binds). Settings → Translation has one block per
model with a switch, **Run on** (Auto / GPU / CPU, default Auto: the settings
`translateLlmDevice`, `translateOpusDevice`, `translateNllbDevice`; a restored
backup's unknown value reads as Auto, `normalizeDeviceChoice`) and a line per
copy with its own Download and Remove. A pinned device is that device alone; a
copy that cannot run there says why and the model never falls to the other
device behind the user's back.

| Model                       | GPU copy                                                                                                                      | CPU copy                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Language model (Qwen3 1.7B) | WebLLM q4f16, ~984 MB (a small-buffer build for a 128 MiB binding)                                                            | wllama 3.8.1, `unsloth/Qwen3-1.7B-GGUF` Q4_K_M, 1,107,409,472 bytes (pinned commit `CPU_LLM_REVISION`)         |
| Language model (Qwen3 4B)   | WebLLM, ~2.3 GB                                                                                                               | none: pinning the CPU blocks it with `noCopy`; an unset choice resolves to the 1.7B when the CPU is the device |
| OPUS-MT pair                | none in this build\*; with `seq2seqGpu`: transformers.js on WebGPU, fp16, ~210 MB (encoder ~93 MiB, merged decoder ~106 MiB)  | transformers.js on WASM, q8, ~113 MB                                                                           |
| NLLB-200 600M               | none in this build\*; with `seq2seqGpu`: transformers.js on WebGPU, q4f16, ~1.26 GB (encoder 584 MiB, merged decoder 612 MiB) | transformers.js on WASM, q8, ~912 MB                                                                           |

\* The worker's ONNX Runtime is the wasm-only bundle (`webpack.config.ts`
aliases `onnxruntime-web/webgpu` to `onnxruntime-web/wasm`, and `js/ort/`
ships no WebGPU wasm), so a seq2seq GPU copy would download its weights and
then fail to start a session. The shipped catalog therefore has none
(`models.ts` `CatalogOptions.seq2seqGpu`, off, never read from `config.json`):
their **Run on** GPU choice is struck through with "This model can't run on
the GPU in this version of the app." (`noCopy`, `device: "gpu"`), Settings
lists only their CPU copy, and Auto runs them on the CPU. The tests build the
catalog with the option on, so the GPU logic below stays covered; what
shipping the copies needs is in `docs/projects/translation-devices.md` § Not
in this build.

What each copy needs (`models.ts` `modelBlock`, per device):

- **A GPU copy**: WebGPU (no `NO_WEBGPU`, `INSECURE_ORIGIN`, `NO_ADAPTER` or
  `PROBE_FAILED`), `shader-f16`, and a storage binding that holds its largest
  tensor (`largestBufferBytes`: NLLB-200 524,709,888, OPUS-MT's shared
  embedding 59,495,424, which is the en-de figure used for every pair).
  The language model's own rule (`LLM_MIN_BUFFER_BYTES`, the 4B's 185 MiB)
  is unchanged; `GPU_LIMITS` does not apply to a seq2seq GPU copy.
- **Every copy, GPU seq2seq ones included**: WASM SIMD (`capability.cpu`), the
  runtimes are WebAssembly.
- **The CPU language model**: WebAssembly Memory64 too (wllama 3.8.1 is a
  64-bit build).
- **iPhone and iPad**: the CPU language model's peak (`CPU_LLM_PEAK_BYTES`,
  2,921,910,272, the whole browser tree measured by the spike) is over the
  page budget WebKit allows there (`APPLE_PAGE_BUDGET_BYTES`), so it is a
  `memory` block; the 4B has no CPU copy at all.

**Auto's device order is a placeholder until measured on real GPUs**
(`models.ts` `deviceOrder`): the language model, GPU only (a single-threaded
language model reading a channel waits tens of seconds per batch; it runs on
the CPU only when the user pins it); NLLB-200, GPU then CPU where its GPU copy
fits (never a phone), else CPU; OPUS-MT, CPU then GPU on a phone (the models
are small and the GPU's memory is kept for the language model), GPU then CPU
on a computer. Auto leaves out a device the model has no copy for, so in this
build OPUS-MT and NLLB-200 are CPU only. The router walks candidate x device in that order, passing over
a copy that is blocked, marked down or whose download the user declined, so
under Auto a declined download falls back to the other device's downloaded
copy for OPUS-MT and NLLB-200 and never for the language model. A GPU loss
(`GPU_LOST`) marks down that model's GPU copy alone, for the session
(`DownKey` is `<candidate>@<device>`); in this build that is only ever the
language model's, since OPUS-MT and NLLB-200 have no GPU copy to lose. A
device switch lets the running request finish; the next one loads on the new
device and the old device's model is unloaded. Deleting a copy that is loaded
unloads it first and leaves the other device's copy untouched. `OnDevice`
(`engines/onDevice.ts`) is each slot's holder of one loaded model on one
device at a time; a load on one device first waits for a load still in flight
on the other, then unloads it, since a language model's reload is listed as
loaded only once it finishes.

**The CPU language model's numbers** (`models.ts`): a context window of 1024
tokens (`CPU_CONTEXT_WINDOW`: it holds the 700-token context budget, the
prompt and a 160-token answer; the prompt costs what it costs on the CPU
whatever the window, so a smaller one would cut context and not time), reading
batches of 2 lines (`CPU_BATCH_MAX_LINES`) and a request deadline of 6 minutes
(`CPU_REQUEST_TIMEOUT_MS`). The spike measured about 1.2 tokens a second on one
thread, a composer translation with context at 107 s and a 2-line batch at
101 s; the deadline is 6 minutes because 3x the batch (303 s) is less. These
are the floor a page without isolation needs. The 15 s target of the design
could not be met on the sandbox's core at any window; other devices are not
measured. The model is `wllama`'s, with the same prompt profiles, think-block
handling and `fitToWindow` as the GPU engine (`engines/cpuLlm.ts`; the library
import is only in `cpuLlm.real.ts`). A deploy can mirror the file at
`translation.modelBase` (`{modelBase}/unsloth/Qwen3-1.7B-GGUF/Qwen3-1.7B-Q4_K_M.gguf`).

**Threads and isolation.** Multithreaded WebAssembly needs a cross-origin
isolated page. The root service worker (`client/service-worker.js`, `isolate`)
adds `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: credentialless` to the app's navigations and
its own worker scripts, from the network and the shell cache alike, so a page
is isolated from the load after the worker served it (always, in an installed
app). `credentialless` rather than `require-corp` so link previews, media, the
uploader and a model mirror load without headers of their own. WebKit has no
`credentialless`: Safari and every iOS browser stay single-threaded. The app
never reloads itself for it; `threads.ts` `isolationState` answers `isolated`,
`reload` (the worker did not serve this load) or `unsupported`, and Settings
says when a reload would bring threads. The CPU language model takes
`cpuThreads(hardwareConcurrency, mobile)`: one core left to the page, at most 4
on a phone (`PHONE_THREAD_CAP`) and 8 on a computer (`DESKTOP_THREAD_CAP`; the
measured series was 186.0 s, 95.2 s, 48.4 s and 31.4 s for 1, 2, 4 and 8
threads, and counts past 8 were not measured). The seq2seq models take
onnxruntime-web's own thread default, which follows isolation.

**A download asks per copy.** Consent is kept per copy (`consent.ts`
`consentId`): the copy a model ran on before devices existed (the language
model's GPU copy, OPUS-MT's and NLLB-200's CPU copy) keeps the id its yes
always had, so earlier consents and Settings' Downloads still stand; the other
device's copy is `<id>@<device>`, a download of its own that a yes to the
first never covers. The protocol's `has` and `delete` and the cache API answer
per copy, and `TranslateRequest` carries the device.

## Reading a channel

The translate button in a channel's header switches translation on for that
channel (`Chat.vue`, `translate/reader.ts`; the button carries the
`fa-language` glyph (`文A`) -- the globe keeps only the dev locale
selector's language-setting role): from then on every message in it, the
user's own included, is detected (`detect.ts`: the function-word classifier
first (below), then `franc` in its own chunk, with the channel's declared
languages and then its dominant language settling near ties), skipped when
nothing translatable is left of it (`eligibility.ts`: URLs, code, emoji,
formatting codes and nick mentions stripped -- there is no word floor, a
one-word line reads; a line stripped to nothing still does not queue) or
detected as already in the target -- and marked when detection skips it
(below) -- given its context
(`context.ts`: the last ten lines with the translations already shown,
the reply target, the topic, the names in play, the newest twenty of the
channel's terms and the deploy's glossary behind them) and queued
(`queue.ts`: the active channel first, one request per engine, LLM lines
of one channel and pair batched, items that fell two hundred messages
behind dropped, an engine paused after three failures in a row). The
result lives in `store.state.translations` keyed by the message id and
renders as `TranslationLine.vue` under the original: a "German → English"
chip (source → target; where the engine placed the source itself, the
detector's contenders stand in for it -- "Norwegian / Danish → English",
"French? → English", "? → English" with none -- `labels.ts`), the text streaming with a caret, a retry when it failed (an icon
button, "Retry the translation" its tooltip and accessible name, with the
translated reason beside "Couldn't translate" when there is one -- a model
that would not load says so rather than leaving the tier looking broken;
the one `unchanged` failure renders as the compact chip below instead); the chip's
menu copies, retranslates or hides the line ("Copy translation" puts the
translated text on the clipboard through `js/clipboard.ts`, the helper the
message toolbar's Copy uses, and says nothing when the browser refuses),
and the toolbar's Translate does one
message on request in a channel that is off -- and brings a hidden
translation back, at no cost, once the chip's "Show original only" has
taken it away.

**The toolbar's Translate asks before it guesses.** A line nobody asked
about has not been detected, so an ad-hoc translation of it would be the
detector's guess or nothing; the action therefore opens a menu
(`MessageActions.vue` `openMenu`, the same `contextmenu:items` the chip's
menu uses) of two items -- **Translate**, which is the guess
(`retranslate` with no source), and **Translate from another language…**,
which opens `SourceLanguagePicker.vue` in its `source` form anchored on
the button and retranslates from the pick. The picker opens on the
channel's declared languages (`channelStore.ts` `languages`, the panel's
chips) rather than on whatever sorts first; the detector's runners-up are
not on the menu, since nothing has run a detector on this line yet -- the
chip that follows the translation carries them, and that is where a wrong
guess is corrected. The one click that stays a click is the hidden
translation's: "Show translation" has nothing to choose. The target is
the reading language, here as everywhere; a line is read in the language
the app is read in.

**A pause is a minute off, not the end of reading.** Three failures in a
row take an engine out of the rotation (`PAUSE_AFTER_FAILURES`), and
`PAUSE_RESUME_MS` (60 s) later it resumes itself: the failure count goes
back to zero and `QueueDeps.onResume` clears the header's paused banner.
A user's Retry goes through the same `resume()` and disarms the waiting
timer, so the banner is never cleared twice; a second pause waits again.
Two errors never count toward a pause at all -- `WORKER_DISPOSED` (the
pagehide teardown, an idle unload) and an `ABORTED` the queue did not ask
for. Neither says anything about the engine, so the batch goes back to the
front of that engine's queue with its lines still pending, nothing marked
failed, and the engine waits `REQUEUE_WAIT_MS` (1 s) before running it
again -- without that, three background/return cycles on a phone paused
the engine and every line after that stayed pending for the session. An
abort is also honoured **before** the request is posted: `service.ts`
re-reads the signal after resolving the route, after a GPU model switch
settles and after another model's work finishes, so a line the queue has
given up on never starts a model download.

**The labels on the text are a language pair, in the reader's language.**
The line's chip, the composer strip's chip and the read-back row's label
all read `<Source> → <Target>` -- no "from", "to", "into" or "reads back
as" -- and every language name in them and in their titles is
`languageName(code, readingLanguage())`: the reading language
(`reader.ts` `readingLanguage`, the one helper the composer uses too --
the interface's language; there is no separate reading override). A user who reads
English sees "French → English", one who reads German sees "Französisch →
Englisch". The chip menu's actions keep their wording ("Retranslate from
French") with the names chosen the same way; the language pickers keep
their endonyms.

**An answer is not automatically a translation.** Two of them fail the line
instead: one that came back as the original (the model echoed rather than
translated -- `outgoing.ts` `isUnchanged`, judged past case, spacing and a
dropped full stop, and compared restored against restored so the route's
marker form cancels out) and one with nothing in it a language could be
(`hasNoLetters`: `⟹ `, `--- ---`, the empty string; letters and digits of
any script are content). Both are the _answer's_ failure, not the
engine's, so they never go through the queue's `fail()`: nothing is marked
down and neither counts toward the three-in-a-row pause, since the engine
did complete and the next line may well be one it can do. The line keeps
its chip and its Retry.

**The detector is shown prose and nothing else.** Every detection site --
the reader's, the toolbar's Translate, the chip's "Translate anyway" and
"Retry", and the composer's draft -- passes the line through
`eligibility.ts` `plainTextOf` first, which is also what the word count
behind eligibility measures. Gone before the detector sees it: the IRC
colour and style bytes, the Markdown markers (through the page's own layout
tree, `push/strip.ts` `stripMarkdown`, so the detector reads what the reader
sees -- `*test*` is `test`, `> quoted line` is `quoted line`,
`[see this](https://x.y)` is `see this`, `# not a header?` is a CommonMark
header and reads `not a header?`), fenced and inline code, URLs and `www.`
links, emoji and their shortcodes, the channel names, and every nick in the
fenced set. The order inside it is not free: `stripMarkdown` flattens the
tree to its _text_, so a code span's content survives it and code must go
first, by its backticks, while it still has them; URLs must go after, since
a link loses its target to the link node and would otherwise lose its text
with it. A line that is nothing but syntax -- a bare `#seance` -- is left
with no words at all and is not eligible.

**Detection starts with the function words.** franc's trigram model
misplaces chat-length lines confidently: measured against the app's own
language set, "I just woke up again." came back Dutch at confidence 1.0,
"good morning" Swedish and "helo their friend" Scots -- and a misdetection
routes the line to an engine with a wrong source, which hands it back
unchanged and the row reports a failure for perfectly ordinary English. So
`detectLanguage` asks `chatdetect.ts` first: `stopwords.json` -- generated
by `tools/generate-stopwords.py` (wordfreq's frequency-ordered function
words per language, `stopwords-iso` where wordfreq lacks the tag, any word
shared by four or more tables dropped as noise, ~60 words each, ~19 KB
committed) -- scores each line's tokens against every candidate language's
function words (by containment for ja/zh/ko, which write without spaces).
A verdict two hits or more and strictly ahead of the runner-up wins over
franc outright; on a line too short for trigrams (under `DETECT_MIN_LENGTH`,
10 characters) a single classifier hit is already the answer, where before
there was none; anything weaker falls through to the trigram flow
unchanged. The classifier is misspelling-tolerant by shape: "helo
**their** friend" still hits "their". What the measured failures do now:
"I just woke up again." places as English via the classifier (`same`, the
chip names it); "good morning" is chat content words the classifier
leaves unplaced by design, so it falls through to the trigram flow; and a
misspelled short line with one function word ("helo **their** friend")
places via the classifier.

**A short line the function words cannot place is looked up.** A lone word
carries no grammar at all: "test", "hola", "danke" hit no function-word
table and are far under `DETECT_MIN_LENGTH`, so franc is never asked
either, and the line used to go to the engine with no source named -- which
for one English word means the engine hands that word straight back and the
row reports a failure. `wordlookup.ts` `lookupShortLine` places it instead:
`wordlist.json` -- generated by `tools/generate-wordlist.py`, the 800 most
frequent words of each of the 24 translation targets with their rank, one
map keyed by the word, ~390 KB committed and loaded as its own webpack
chunk on the first short line that reaches it -- gives every language
1/rank for each of the line's words, so a word at rank 5 counts far more
than one at rank 700. One language carrying the words places the line
("test" is English and nothing else, "hola" Spanish); several are settled
first by a leader `LOOKUP_LEAD` (3x) ahead of the runner-up ("hasta luego"
leads 17x), and only where nothing leads by the channel's prior naming one
of the contenders ("ja so gut" is German, Slovak, Polish and English,
German 1.8x ahead, and a German channel decides it). The order is the
point: "the" is English rank 1 against Spanish rank 301, a ~300x lead, and
a Spanish channel's prior must not turn a lone "the" into a line translated
from Spanish. Anything else stays unplaced with its contenders named,
exactly as before. The lookup runs only on a line of at most
`LOOKUP_MAX_WORDS` (3) words the classifier did not place, never overrules
it, never takes a line off franc that franc could have had (a line it will
not place and franc can still see goes to the trigram flow), and notes
nothing into the channel's prior -- one word is no evidence about a
channel. Its verdict is _not_ weak: that is the point, since `sourceFor`
only translates _from_ a verdict that is not weak, and "test" read in
Spanish has to become "prueba". Two limits worth knowing: a word no table
lists ("lol") leaves the lookup silent, and ja/zh/ko/th write without
spaces, so a sentence in one of them arrives as one token that matches
nothing -- the classifier's containment matching is what serves those
languages. That case never fetches the chunk: a line with no letter in it,
or a single space-free token longer than `LOOKUP_MAX_SCRIPTLESS` (9, the
longest entry any of those languages has), is answered before the table is
asked for, so a Japanese reader does not download 390 KB for nothing (a
lone word still is looked up -- "ありがとう" places as Japanese).
A lookup verdict's `confidence` is `min(1, Σ 1/rank)`, so it says how
common the words are: only a word ranked about 4th or better in its
language clears `WRITE_DETECT_MIN_GAP` (0.3), the floor the composer's
`reverseSource` trusts a verdict from. That is the right split for a draft:
a lone "the" (English rank 1, confidence 1) is English and the composer
takes it, while "hola" (Spanish rank 416, confidence 0.0024) or "danke"
(German rank 204) is too thin a claim about what the user is typing and the
composer falls back as before. The reading pipeline has no such floor -- it
reads `weak`, which a lookup verdict never is. Thai is the one
language whose words come from a stopword list rather than a frequency one
(the table lists it under `partial`). Both generators read the same tag list
and source ladder (`tools/wordsources.py`) and both need wordfreq and
stopwordsiso, which are not project dependencies -- run them from a venv
(`python3 -m venv tmp/venv-words && tmp/venv-words/bin/pip install wordfreq stopwordsiso`), and `tools/generate-wordlist.py --check` says whether the
committed table is still byte for byte what the sources generate.

**A thin verdict is a hint, never a source.** A single function-word hit
places "je suis la" in Vietnamese (the noise cut in
`tools/generate-stopwords.py` drops a word shared by four tables or more,
so `je`, `suis` and `la` are all gone from French while `la` survives in
Vietnamese) and a narrow trigram lead places "hasta luego" in Polish.
`Detection.weak` marks both: a classifier verdict under
`CHAT_STRENGTH_MIN` (2) hits, and a franc verdict whose measured lead is
under `WEAK_CONFIDENCE` (0.2). A language the channel declared, or its
prior, is never weak -- `DETECT_MIN_GAP` there is how "the reader's claim
decided it" is written down, not a measurement. `detectionSkip` reads
`lang` whatever its weight, so a weak English verdict still leaves an
English line alone for an English reader; what weak changes is
`detect.ts` `sourceFor(detection, from, to)`, the one place that decides
what a line is translated _from_: a chosen source wins, a verdict that is
neither missing nor weak is the source, and anything else queues the line
with no source named and `unsure` set -- the engine places it, which an
LLM does well and a wrong `from` makes impossible. The router is told more
than the prompt is: `sourceFor` also returns a `routeHint` (the channel's
prior first, the weak verdict as the last resort), which rides on
`QueueItem.routeHint` into `TranslateRequest.hint` and never into the
prompt. Without it a weak line would be unroutable on a CPU-only device --
`router.ts` skips every seq2seq candidate when no source is known at all --
which would mean no translation where there used to be a wrong one. The
composer has the same split (`outgoing.ts` `sourceHintFor`).

**A failure is worded in the reader's language, and `unchanged` barely
speaks at all.** The failed row's frame and its known reasons are catalog
keys now -- "Couldn't translate" (`translate.failed`), and the reason
constants (`ANSWERED`, `NARRATION`, `DEGENERATE`) each have a key of their
own (`translate.reason.*`); an unknown engine error keeps its verbatim text
in the title (server and technical text is never translated). The
`unchanged` verdict -- the model handed the line back, which as often as
not means there was nothing to translate -- drops the prose row for a
compact chip: the `fa-equals` glyph carrying the translated "Not
translated" as its tooltip and accessible name, wearing the same accent
style as every other translation chip and opening the failed row's menu
minus Copy (Retranslate, the per-candidate "Retranslate from
`<Language>`", "Retranslate from...", Show original only -- there is no
translation to copy). Production builds render the icon alone; a
development build appends the reason ("the line came back unchanged") after
it (`devtoolsAvailable`). The line itself is the one to read, since there is
no translation row to be the bright line, so its original takes the
translation's ink (`Message.vue` `unchanged`, `#chat .msg.unchanged .content`) -- over the own-line dimming too: an own line that translated
shows a bright row, and an own line that came back as it was should read
the same rather than stay dim with only the chip to show for it. A
detection skip is not this; its original keeps whatever ink it had. Browser
check: `tools/scenarios/translation-chips.mjs`, which puts the verdict on
the page's own line.

**A line the detector cannot place still translates, unless it could be
the reading language.** `detect.ts` `detectionSkip` decides: a line placed
in the reading language is skipped (`same`); a line it could not place is
skipped (`unsure`) only when the reading language is among its
`candidates`, or when there are none (a line too short to look at), and is
otherwise queued with `from: null` and no `sourceHint` (`sourceFor`, above)
-- neither the weak guess, which would send the line to a seq2seq model
with the wrong source, nor the channel's prior, which announced an unsure
Spanish line as "probably German" in a German channel. Measured on a real channel's
history (71 lines, read in English), skipping every unsure line left 21
untranslated -- 13 of one user's 15 Spanish lines, which franc ranks
within a hundredth of Galician and Portuguese -- where the rule translates
63 and the 8 it still skips are all English. On a device whose router has
no engine for an unnamed source (CPU only) such a line cannot be routed,
and the queue's "no translation engine" failure is written as the `unsure`
mark instead (`reader.ts` `applyUpdate`).

**The topic is read too.** A channel's topic is the line everyone in it
is looking at, so a reading channel reads it like its lines: `reader.ts`
`readTopic` detects it (markdown stripped, nicks fenced, the channel's
prior and declared languages weighed as for a line), leaves it alone when
it is already in the reading language, and otherwise queues it -- never
batched, at the front, with the channel's recent lines and names as
context and the topic itself left out of that context -- under an id no
message can have (`topic.ts` `topicEntryId`, a billion below every history
id) in the same `state.translations` slice. The header (`Chat.vue`) shows
the translation **in the topic's place**, so the header grows no row for
it, with a small flipper before it wearing the chips' accent look: it
swaps the translation and the original (the entry's `hidden`, through
`showOriginal` like a line's), and the tooltip carries whichever is not
showing. The header asks for the read whenever the channel, its topic, the
switch or the reading language changes (idempotent on the topic as it
stands); a switch-off or a fresh read (`requeueReading`) drops the entry
(`forgetTopic`); a double-click still edits the original. Browser check:
`tools/scenarios/translate-reading.mjs` (the speaker sets a German topic
before the switch-on and another after).

**A skipped line is marked.** Every line detection skips gets a store entry
of its own -- `status: "skipped"`, `reason` `same` (with `from` the reading
language) or `unsure` (with the candidates kept) -- which
`TranslationLine.vue` renders as a small chip after the message
(`.msg-translation-skipped-tag`, the same accent style as the `lang → lang`
chip -- the old muted look is gone): the
language's name in the reader's language for `same`, "?" for `unsure`; no
text row, no caret, and the original keeps its ink. The tag's menu offers
**Translate anyway** (the forced `retranslate`; the toolbar's Translate is
offered on such a line too), a **Retranslate from `<Language>`** per
candidate (neither the line's own source nor the reading language) and
**Retranslate from...** with the picker. Lines eligibility turns away
(pending copies, types other than chat, a line with no words left after
the stripping -- there is no word floor) stay unmarked. A
mark is never a translation: `buildContext` quotes only `done` text, the
menu has no Copy, a language change requeues the line like any other (the
one entry the requeue keeps is an own line's `done` read-back), a rebuilt
retry does not take a mark's `from` as its source, and `takesReadBack` does
not count a mark as the line's translation.

**The channel's own languages weight detection.** The panel's _Languages
spoken here_ records what people write in a channel (`channelStore.ts`
`languages`, ISO 639-1, supported codes only, persisted with the rest of
the record), and `detect.ts` weighs them above its automatic prior in
three ways. What they weigh is the trigram flow: a decisive classifier
verdict (above) is already final before the declared languages are
consulted. A declared language that franc ranks within `DECLARED_MARGIN`
(0.25) of its best **wins** over an undeclared best -- a trigram lead that
small is a weaker claim than the reader's; two declared contenders that
close resolve by their own gap, then by the prior, and where neither
separates them the line is left alone rather than translated from a coin
toss. A best franc names but we cannot translate from is **rescued** by a
declared contender instead of coming back undetermined. And a line under
`DETECT_MIN_LENGTH` (10 characters), which franc cannot place at all, is
taken as the one declared language that is **not** what the reader reads
when there is exactly one -- so "So ist es" in a German/English channel
read in English is translated, where before it was skipped. Nothing is
noted into the automatic prior from that last case: a line the detector
never saw is no evidence about the channel. `candidates` -- the chip menu's
one-click corrections -- puts the declared contenders first. The composer
declares nothing: a draft is the user's own language, not a channel
matter.

There are three ways to retranslate on that menu, because detection is the
thing most likely to be wrong: **Retranslate** runs the line again as it
was, **Retranslate from `<Language>`** appears once per runner-up the
detector ranked (`detect.ts` `candidates`, at most `DETECT_CANDIDATES` (3)
known languages in franc's order, carried on the entry; the line's own
source is left off the menu, since that item would only repeat
Retranslate), and **Retranslate from...** opens
`SourceLanguagePicker.vue` for any of the supported languages -- a popover
under the chip where there is a pointer, a bottom sheet on a phone or under
480px, closing on Escape, on Cancel and on a click outside. A chosen source
skips detection altogether: the entry's `from` becomes that language (so
the chip reads "French → English"), the runners-up it inherited stay on the menu
(the detector's own guess among them), and nothing is noted into the
channel's language prior -- one reader's correction of one line is not the
channel's language. A retry keeps whatever source the failed line had. The translated line is `user-select: text` like the
original above it -- `body` is `user-select: none`, so a block that is
meant to be read and quoted has to say so. Once a translation is in, it is
the bright line; the original dims to the muted colour.

A message that arrived as `draft/multiline` is one message whose text
carries newlines, and it goes through the composer's own `translateDraft`
rather than the queue's single-line request: numbered lines to an LLM, one
line at a time to a seq2seq engine, blank lines where they were, and never
batched with the other lines of the channel. Without that the engine's cut
kept the first line and the rest of the message was silently lost. An entry leaves when its message does: an edit or a REDACT
drops it, and so do the message-limit trim, a part and a quit -- and with
the entry goes the queue item the pipeline remembered for that message
(`reader.ts` `forgetTranslations`), which nothing could reach again. The
switch, the outgoing target (plan 3), formality, variant, the languages
spoken here and the term memory are per channel under
`thelounge.translate` (`channelStore.ts`); leaving a channel keeps them,
and only a network's quit forgets them. The channel menu's
"Translation…" switches to the channel and asks for the panel through
`state.translation.panelFor`, which the view clears as it opens it.
Nothing on a message object changes and nothing about unread or highlight
counts does. Browser check: `tools/scenarios/translate-reading.mjs`, on
the in-page fake engine (`?fakeTranslate`, `fakePort.ts`): it answers a
batched request as numbered lines closed by `END`, fails a request whose
text carries `[fail]` once (the retry succeeds), answers a read request
carrying `[answer]` with a reply that has no question mark, and logs every
request (its `from` and `sourceHint` among the fields)
onto `globalThis.__seanceTranslateFake` so a scenario can tell a batch
from a fallback to singles.

**Reading covers what the channel shows, capped per load, newest first.**
A line is considered however old it is: what keeps one out is the rules
above -- pending copies, types other than chat, a line stripped to
nothing, detection -- never when it was said, and never who said it: the
user's own lines are
read too, so a line written before the switch-on, before a rejoin or a
reload, or sent without a read-back gets its translation like anyone's
(an own line already in the reading language is detected as such,
skipped and marked). The one own line the pipeline leaves alone is a posted
translation that keeps the composer's read-back (§ Writing in a channel). History is bounded per _load_, each
load queueing at most `HISTORY_QUEUE_CAP` (40) of its lines, newest first
(`eligibility.ts` `historyQueueOrder`, through `reader.ts` `queueHistory`,
one line after another so the queue's order is that order):

- a history page arriving as `more` (`irc/history.ts` `mode: "prepend"`)
  -- the page `MessageList.vue` asked for and a channel's first fill on
  joining it alike; the reader's second `socket.on("more")` runs after
  `socket-events/more.ts` has prepended the page, so the objects it queues
  are the store's own and their ids are store ids;
- one batch of a reconnect's catch-up or a bouncer replay, which reaches
  the reader as `msg` with `replay`, one line at a time. A batch is
  delivered in one synchronous run (`deliverAppend`) and the bus
  dispatches synchronously, so `eligibility.ts` `ReplayBatches` takes the
  lines a channel receives before a microtask as one batch; the next batch
  counts afresh, with no live line needed in between;
- the requeue of a switch-on or a language change (below).

**Switching reading on, or to another language, retranslates what is on
screen** (`reader.ts` `requeueReading`): the channel's queued work is
cancelled, its remembered items, translations and language prior go, and
its messages are queued again as one load. Switching on again does
nothing, and switching off only cancels what is queued. A posted line's
translation is the composer's read-back (§ Writing in a channel): it is
kept, and left out of the requeue, when it is already in the reading
language; when it is not it goes with the rest and the line is translated
again like any other. The same requeue runs for every reading-on channel
when the reading language itself moves -- the interface's language
changed, in Settings or through the dev globe (`reader.ts`
`restartAllReading`). That path calls `requeueReading` itself: reading is
already on, so `setReading` would return at its no-op guard and retranslate
nothing. The language reading started in is recorded in `initReader`, so
the first change after a page load counts like any other.

**Leaving a channel keeps its setting.** A part cancels that channel's
queued work, forgets its queue items and drops the translations with its
messages, but the record stays: a rejoin finds reading still on, into the
reading language as it stands then, and translates the history the join
loads. A network's quit
still forgets its channels' records. A per-channel generation stops a
history run, or a detection still under way, once the reading restarts or
the channel goes, so nothing is queued twice or into a channel that is no
longer there.

The queue then runs a channel's live lines ahead of its history ones
(`QueueItem.history`, cleared by a retry, since a retry is someone asking
for that line now), and the history ones are what a channel that has
fallen `DROP_AFTER_LINES` behind has left to drop. What counts as falling
behind is what the channel has _said_ since -- `reader.ts` `arrivals`
counts `message`, `action` and `notice` lines alone (`eligibility.ts`
`isChatLine`), so a netsplit's quits or a burst of joins never look like
the conversation moving on. Browser check: the
switch-on, "load more", language-change and rejoin steps of
`tools/scenarios/translate-reading.mjs`.

## The channel's panel

The per-channel choices -- reading on/off, the languages spoken here,
outgoing target, formality, variant -- are one component
(`TranslationPanel.vue`) in two layouts. Where
there is a pointer it is a column anchored under the channel header: each
setting a label with its control beneath it, so the four controls share one
width and one rhythm (20rem wide, 2.125rem controls); the section headings
and the one-line hints are left out, and a footer carries a link to
Settings -> Translation beside Done. Where `helpers/device.ts`
`hasVirtualKeyboard()` reports a touch-primary device, or the window is as
narrow as the phone's chat layout (`max-width: 479px`), the same markup
`<Teleport>`s to `<body>` and takes `.translation-panel--sheet`: a
full-screen sheet with 2.75rem controls, the two sections (Reading,
Writing) under their headings, a hint under each control, formality as a
three-way segmented control (`role="radiogroup"`, "As written" / "Formally"
/ "Casually") rather than a native picker, and a full-width Done above the
safe area. The sheet's height follows `--viewport-height`
(`helpers/viewport.ts`), so iOS's keyboard cannot push Done off the screen.

How it opens splits the same way. With a pointer, a click on the translate
button toggles reading and a right-click opens the panel -- and a click
that turns reading **on** opens the panel with it, so the reader sees and
can adjust the languages at once (a click that turns reading off only
turns it off); on touch there is no
right-click, so the **tap** opens the panel (whose first control is the
reading switch) and the button's label says "Translation settings" (or,
when nothing here can translate, that it cannot run). The
channel menu's "Translation..." reaches it on both. It closes on the X, on
Done, on Escape, and -- the anchored panel only, since the sheet has no
outside -- on a click outside it; the caret goes back to the translate
button when the panel is what held it. Browser checks:
`tools/scenarios/translate-reading.mjs` (the column, and the sheet under
`--mobile`) and `tools/scenarios/translate-composer.mjs --mobile --width=390 --height=844` (the sheet in full).

_Languages spoken here_ is the one field that is not a single choice: the
declared languages show as chips (`.translation-panel-chip`, each the
language's own name and a ✕ that removes it, wrapping above the control),
and a `translateLanguageAdd` select whose first option reads "Add a
language…" appends one at a time and springs back to that option -- a
fifty-long multi-select would be a poor way to name the two or three
languages a channel speaks. It offers only what the channel has not
declared yet. On the sheet its hint reads "Lines in these languages are
recognised even when they are short or look alike."

A language a translation is _about_ is named in the language the interface
is in: the panel's lists, the composer's translate-into dialog and the
chip menu's retranslate-from dialog all call `languageName(code, readingLanguage())` (`Intl.DisplayNames` in the reading language, the
bundled English table behind it), so an English interface offers "French"
and not "Français". The one list that keeps the endonym is the interface's
own language selector (`LanguageSelect.vue` -- Settings -> Translation's
language select and the dev build's sidebar globe, `languageEndonym()`):
someone looking for a language to read the app in is looking for its own
name.

**Every surface here speaks the interface's language.** There is no English
literal left in the feature: the panel, Settings -> Translation, the chips,
the strip, the failure rows, the model manager and the context menu all
render catalog keys (`docs/resources/i18n.md`). The Vue-free modules stay
Vue-free and i18n-free -- `models.ts`, `service.ts` and `capability.ts`
return **codes** (a model's label, a load note's phase, a device verdict's
reason) and the component that shows one maps it to a key, with a prose
fallback for a code it does not know. Three consequences worth keeping:
the Settings -> Translation language select is `LanguageSelect.vue`, the
same control the dev build's sidebar globe uses, so there is one list of
codes and not two that could disagree; the channel menu's "Translation…"
is offered only where the deploy has translation at all
(`reader.ts` `translationAvailable`); and the composer strip's live region
is `aria-live="off"` while a translation is streaming in, `polite` once it
is done or failed, so a screen reader reads the result rather than every
token. The surfaces' CSS is written in logical properties throughout and
verified in both directions through the `qqx` pseudo-locale
(`tools/scenarios/i18n-rtl-layout.mjs`).

## Writing in a channel

The panel also sets an outgoing target per channel (`write`, next to `read`
in `thelounge.translate`); `writeTarget()` returns it as soon as
translation is enabled, without waiting for the device probe, so the
composer can show a placeholder ("sent in German") the instant the target
is picked.

The first Enter on a non-empty, non-command, non-edit draft
(`outgoing.ts` `draftGate`) calls `writer.ts` `translateOutgoing` instead
of sending. **`/me` is the one command that translates**: an ACTION is
prose, and the reading side translates everyone else's, so `draftGate`
answers `{kind: "action", text}` with what follows `/me ` and that text is
what the strip holds, what the watcher compares against and what the voice
and term memory record; the second Enter sends `/me <translation>`, the
command back on the front and never escaped. An action with nothing after
it is the command's own business. The call itself: it detects the draft's language (no channel prior -- it is the
user's own line, not what the channel has been saying), decides the source
with `writeSource` (`outgoing.ts`), and builds context the same way the reader does
(recent lines, reply target, topic, names, terms, glossary) plus a `voice`:
the last `VOICE_LINES` (5) of this channel's own sent translations to this
target, session-only, so the model's phrasing stays consistent across a
conversation without ever touching persisted storage.

The language the user reads in is **one language everywhere**
(`reader.ts` `readingLanguage`): the interface's. One setting, `locale`,
chosen in Settings → Translation (it stays there when a deploy turns
translation off), is both the language the app is written in and the one
messages are translated into; the old `translateTo` reading override is
gone (`settings.ts` `migrateReadingToLocale` moved a pinned one into
`locale` and deleted it). One consequence: the reading language can only
be one of the interface's languages (the 24 of
`translation-languages.txt`), not any of the ~50 the engines support -- a
Finnish or Hebrew reader cannot have lines translated into Finnish or
Hebrew until the interface offers that language. Reading itself
stays on or off per channel; the language does not, which is why the
composer and the reader cannot disagree the way the per-channel picker
once let them (a channel reading English while the global named German
would have had a draft translated from German into German).

`writeSource` has two rules. A draft too short for the detector to place
(`Detection.lang === null`) is taken as the user's reading language when
that differs from the write target, else left to the LLM. A draft the
detector does place is trusted outright when its verdict agrees with the
reading language; when it names another language, that verdict is trusted
only once it clears `WRITE_DETECT_MIN_GAP` (0.3, three times the reading
side's `DETECT_MIN_GAP`) -- a weaker gap is more likely the detector
misplacing a short draft than an actual language switch, so the draft is
taken as the reading language instead. The same threshold gates the
"already in the target" shortcut: a detector verdict that names the write
target skips translation only when it is at least that sure, otherwise the
draft still goes to the LLM under the reading-language source.

**The source is never the target.** Both fallback branches -- the
unplaced draft and the weak differing verdict -- name the reading language
only when it differs from the write target, and otherwise leave the source
to the LLM (`null`); a weak verdict for the target itself (a strong one is
sent as typed before this is asked) names no source either. A request that says "from German into German" is one
the model answers by handing the line back untranslated, which is exactly
what the live test of 2026-09-12 saw. A draft the detector places in the
target with a strong verdict never reaches this: the caller sends it as
typed.

The reading queues are held (`holdReading()`/`releaseReading()`) for the
length of the request, and again for the round-trip check, so a write is
never left waiting behind a channel's incoming traffic; a read already in
flight when the hold starts still finishes. `translateDraft` (`outgoing.ts`) then does the actual work: a
single-line draft as one request, a multi-line one as a numbered batch when
the route's engine batches (else line by line, falling back to line-by-line
whenever the batch's numbering does not parse or the engine refuses the
batch before it yields anything), streamed with the blank lines between a
draft's lines kept where they were -- a draft whose only non-blank line sits
among blank lines is sent as that line alone, since a blank line is nothing
to send -- and given up after `WRITE_TIMEOUT_MS` (2 min).

The result lives in `store.state.outgoingTranslations`, keyed by channel
id, and `ChatInput.vue` renders it as the `.translate-bar` strip above the
input: an "English → German" chip (the draft's language → its target, "→
German" until a source is named; the entry's `from`, which a retry leaves
alone, so the chip reads the same before, during and after one) -- whose
`title` names the route the text came down,
`<Source> → <Target> · <model id> (GPU|CPU)`, from the `requestFrom`, `engine`
and `model` the entry carries (all null, and no title, until the route has
answered); "auto" stands in for a
source the request left to the model, and " · retried without a source" follows
once the bare second try ran (`retried`) -- the streaming
text with a caret, and icon buttons -- their words kept as the tooltip and
accessible name, never as visible text -- for Copy (its tooltip reads "Copied" for two seconds after
it worked), Send (disabled while pending), and Edit. Both rows of the strip are
`user-select: text`: the line the user is being asked to approve has to be
selectable. A failure shows "couldn't translate, send as written?" -- followed by the
reason, truncated, with the whole of it in the title -- and turns
Send's tooltip into "Send as written".

Two answers are failures rather than translations, on the same terms as the
reading side: **an echo** ("came back unchanged") and **an answer with no letters in it** ("empty translation"). A third was added once the
offline runner caught it: **an answer that talks about the request**
("talked about the request instead of translating") -- the model writing
"okay, let's see. The user wants the translation of …" until its token
budget ran out, which the strip showed as a translation and which read as
the model thinking. `isNarration` judges it: the answer quotes the source
line, or says "the user" and "translat…" where the source says neither
(no false positive among the 1,048 answers the runner had produced). The
composer gives it the same bare second try as an echo, and so does the reading queue, which fails the line -- without counting it against the engine -- only if the second answer is judged the same. **Packaging comes off before any of
that** (`tidyAnswer`): a leading clause about the translation ending in a
colon ("Here comes the translation of the last message: …", seen on a
Korean read-back once the read-back carried the channel's context, whose
prompt says "Output only the translation of the last message") is taken
off unless the source line has a colon of its own (a colon the message
carries comes through in its translation) or itself talks about a
translation, and bold,
italics or quotes round the whole answer are unwrapped when the source has
no such wrapper. The composer does this for the draft and the read-back,
the reading queue for every line. A fourth, from the
language measurements: **an answer stuck repeating itself** ("got stuck
repeating itself") -- Qwen answering Icelandic and Swahili questions with
"Höfðu ekki ekki ekki ekki …". `isRepetition` judges it: the same word six
or more times in a row, or in a script written without spaces the same run
of two or three characters six or more times or a single character twelve or
more ("ええええええ、本当に？" and "哈哈哈哈哈哈，太好了" are surprise and laughter,
not a loop -- the loops seen were whole words), and never when the source
repeats itself too ("no no no no" and "hahahaha" pass). It is checked right
after the letterless rule and handled like a narration in the composer (one bare
retry) but not in the reading queue, which fails it at once, uncounted. A fifth, from a
live test: **an answer to the question** ("answered the question instead of
translating it", `ANSWERED`) -- a Russian read-back that replied, in
English, to the question it was given to translate. `isAnsweredQuestion(source, answer, to)` judges it by the mark alone, so the model's wording does not
matter: the source ends in `?`, `？` or `؟` (closing quotes, brackets and
emoji after it aside) and the answer carries none. It is never applied into
a language whose questions often end without one (`ja`, `zh`, `ko`, `th`,
`el`), and a mark inside the line ("Memorizar? Hm...") is not a question.
`answerError(source, answer, to)` checks it after the narration rule and
takes the language the answer is in -- the write target for a draft, the
reading language for a read-back; the composer gives it the bare second try
for the draft and the read-back, and the reading queue retries the line once
bare and fails it, uncounted, only if the second answer is judged the same. The echo needs no `from !== to`
guard any more -- a source is never the target -- so what it means is the
model declining: a line with nothing to translate ("ok, brb", a bare nick)
as much as one it would not touch. The offer the strip already makes is the
right one for either, and the second Enter sends the draft as written. The
round trip refuses a letterless read-back the same way ("couldn't check"),
and neither an echo nor a letterless answer joins the `voice` quoted to the
model next time or the channel's term memory (`termPair`): a voice line in
the wrong language would be quoted into every later prompt.

**The reading queue retries once, bare, before it fails a line.** An echo,
a loop, a narration or an answered question (`UNCHANGED`, `REPETITION`,
`NARRATION`, `ANSWERED`)
in a reading answer is not reported at once: `TranslateQueue.report`
queues the line again, at the front of the channel's work and still
pending, in the composer's `bareRetry` shape -- `from: null`, the context
emptied but for formality and variant, the source kept as `sourceHint`
for a seq2seq route -- never batched, and marked `bare` so only a second
such answer shows "failed" with its reason. Measured on the web build's own
weights, the shipped prompts still hand back 5 of 45 casual English chat
lines on Qwen3-1.7B and 8 on Qwen3-4B, and the bare shape translated all 8
of 4B's and 2 of 1.7B's 5; without the retry each of those lines showed
Retry instead of a translation. An empty answer fails at once, as before;
the composer retries the same five (`BARE_RETRY_ERRORS` in `outgoing.ts`,
which both sides test against: `DEGENERATE` -- a word four or five times
over -- used to be in the queue's set and not the composer's). The retry is dropped by whatever drops a queued line (the
channel switched off, a language change, drop-behind), never un-pauses an
engine, and counts toward no pause; a user's Retry asks in the normal shape
again and gets its own bare retry.

**The composer's translate button is the send target's toggle.** The
language mark beside the paperclip and the plane (`ChatInput.vue`
`translateOnce`) is independent of the globe, which is reading: off, a
click opens the language picker in its "translate into" form
(`SourceLanguagePicker.vue` `purpose="target"`), and the pick becomes the
channel's write target -- `channelStore.ts` `write`, the very setting the
panel's "Send my messages in" shows, so the two controls never disagree --
until the button, lit and `aria-pressed` while a target is set, is clicked
again (the panel's Off does the same). A draft already typed gets its
strip at once. The dialog's **"This message only"** (offered when there is
a draft) makes the pick a one-off instead: `writer.ts` `translateOnce`,
`translateOutgoing` with its target named rather than read off the
channel, so it runs with no write target set and is not invalidated by
the panel's target moving; the strip comes up as it does for a write
target and the next Enter sends what it holds. The dialog preselects the
channel's last one-off language, else its write target (`lastOnceTarget`;
the last pick is kept with the channel's record, `channelStore.ts` `once`,
so it survives a reload and travels in the settings backup), else a
language the channel declares, else **the language the interface is in**
(the cleanup pass), else the first supported language that is not it --
each only where this device serves it from the reading language
(`outgoing.ts` `onceTargetDefault`, the router's `pairVerdict`), so a
device without the GPU model never opens on a disabled cleanup pass. When
nothing routes at all the last pick, else the interface's language, stands
and the dialog says why. The dialog also asks what to translate **from**,
preselected to the language the user reads, with "Detect automatically"
as the write target has it. **The same language twice is a cleanup**: a
draft already in the language it is asked into is not sent as typed the
way a write target would (the user asked for something) but corrected in
place -- `purpose: "polish"`, the LLM as a copy editor with a wording
measured on the 4B weights (`prompt.ts`, `prompts/qwen3-4b.ts`:
misspellings, grammar, punctuation **and a word that is the wrong word
though it is spelled correctly** fixed, every other word kept,
abbreviations and symbols included, nothing rephrased), the router sending a same-language
request to the LLM alone (`router.ts`; no GPU model, no route, and the
dialog says so), and an echo read as "nothing to correct" rather than a
failure. The dialog says what it will do rather than what it is: with the
source and the target the same, its confirm button reads **Correct**, not
Translate -- and it is disabled where the cleanup cannot run at all (no
GPU model, the hint under the selects saying why), which is the state a
freshly opened dialog is in on a CPU-only device, both languages having
defaulted to the interface's. **A polish carries none of the channel**: its prompt is the
copy editor's system message and `Correct: <line>`, nothing above it, and
`writer.ts` gives the request an empty context but for the register.
Measured on the web build's 4B weights (2026-09-19,
`tmp/experiments/polish-context.ts`), and the one measurement that had
never been run, since every earlier wording was scored on an empty
context while the app sent a full one: with the channel's names, its
terms **or** its earlier lines above the line, the model stopped
correcting -- 4 of 5 lines handed back as written, the fifth with the
`Correct:` label copied in front, and, reported 2026-09-18, one draft
answered with an earlier line's translation instead; with nothing above
it, every line that carried a mistake was corrected and only "Thanks!"
came back as it was, which is the right answer for it -- "corected text
being sent hear" (reported 2026-09-19) into "Corrected text being sent
here", the homophone included, and the channel's own jargon
("nefarious2", "rig") left alone. A
keep-list of the channel's jargon inside the system message, tried so
that a polish might still help with a doubtful word, cost two of those
corrections and saved no jargon the bare shape had lost ("nefarious2",
"rig" survive either way). So the context that helps a translation is
what stops a correction, and a polish goes up alone. The wording that
ships was measured as it ships: the frame's last clause, which named the
earlier lines a polish no longer sends, went with them and the lines were
run again.

**What the frame names is what gets fixed.** Measured over ten lines whose
only faults are confusable words (2026-09-19,
`tmp/experiments/polish-grammar.ts`), with three casual lines that were
already right as controls: "Correct the user's message" with the no-rewrite
guard and nothing else fixed **0** of the ten -- the guard smothers it --
the first shipped wording, "Replace only misspelled words and fix only
wrong grammar and punctuation", **4**, since it reads as a bar against
touching a word that is spelled right, which `your` for `you're` is; and
naming that case -- "words that are the wrong word for the sentence even
though they are spelled correctly, such as a word confused with another
that sounds the same" -- **7**: `your going` into `you're going`,
`its to late` into `it's too late`, `dosnt effect` into `doesn't affect`,
`should of` into `should have`, `loose … alot` into `lose … a lot`. Three
lines still beat it: a sentence whose every word is the wrong one
(`there going to they're house over their`), `who's`/`whose`, and
`effect`/`affect` where the spelling is wrong as well. The controls came
back untouched under every wording. **No list of pairs**: a list of English
confusables scored _below_ the plain sentence and would be dead weight in a
German channel, while the sentence alone corrects `das es` into `dass es`,
`ihr seit` into `ihr seid` and `je suis aller a` into `je suis allé à`.

The strip's chip reads "English, corrected"; a corrected line is
no translation, so it is neither read back nor noted into the voice and
term memory. The same happens when detection finds the draft already in
the picked language -- and **when the channel's write target is the
language the user reads**: a write target set to one's own language can
only mean "send my lines corrected", so the first Enter brings up the
cleanup strip (the placeholder reads "sent corrected") and the second
sends it, where a foreign write target that finds the draft already in
it still sends as typed. Browser check:
`tools/scenarios/translate-composer.mjs` § 0.

**An echo buys one more generation, and a bare one.** Before the strip
reports "came back unchanged" the same draft goes out a second time in the
shape `bareRetry()` (`outgoing.ts`) builds: the source left to the model
(`from: null`, so the chip's title drops to `auto → …` and says the retry
ran, while the chip itself keeps the draft's language) and a context
carrying nothing but the register -- no recent lines, no voice, no terms, no
topic, no reply target, no `sourceHint`. The bare request is the shape a
model answers most reliably, and the two things that make one hand a line
back rather than translate it -- a source that is wrong for the draft, and a
context that confounds it -- are exactly what that removes. The route is
kept (`batches`, `markers`, the protection), so it is the same engine over
the same protected text and only what the prompt says about the draft
changes; the strip stays pending and streams the retry. **Neither try shows
an echo while it streams**: `echoingSoFar(source, partial)` holds the row at
its caret while the text so far is still the draft coming back (case and
spacing ignored), and shows the answer the moment it departs from it --
without it the first try's echo streamed out word by word and the retry
then replaced it, which read as the translation rewriting itself. The
read-back row does the same against the translation. Exactly one retry:
a model that echoes a bare request is declining, and the offer then stands.
A letterless answer is reported at once -- there is nothing in it to suggest
the request was the problem. The round trip does the same with a read-back
that is the translation over again, and reports the failure ("couldn't
check") only when the bare try comes back unchanged too. It costs a second
generation only where the first produced nothing usable.

The second Enter is the same `input` bus emit
as any other send (`deliver`, so history, replies and edits do not
diverge): it ships the strip's translation, or the draft itself after a
failure, and calls `noteOutgoingSent`, which extends the voice and, when
the draft and its translation are term-sized (`termPair`: one line, short
both ways, genuinely different), remembers the pair in the channel's term
memory.

**Term memory is kept per language.** An entry (`channelStore.ts`
`TermEntry`) is `{source, target, from, to}`: the draft, what it went out
as, the strip's source (`null` when the write left it to the model) and the
write target. `rememberTerm` replaces an entry only when both the `source`
and the `to` match, so "thanks" can keep a German and a French rendering
side by side, and `TERM_CAP` (300) still bounds the list. A prompt carries
only the terms of its own pair: `termsFor(entries, from, to)` gives an
entry written into `to` as `[source, target]` (when both name a source they
must agree; a `null` on either side matches), an entry written _from_ `to`
as the reverse `[target, source]`, and leaves out the rest, oldest first so
`buildContext` still quotes the newest `TERM_LINES`. The writer asks for
the draft's pair, the reader for the line's source (possibly unknown) and
its reading target. Before this the memory was bare pairs: after a German
session every French write, and every reading prompt, still told the model
to render "thanks" as "danke". A stored legacy pair carries no language and
is dropped on load (the memory starts over once), as is an entry whose `to`
is not a supported language or whose `from` is neither `null` nor one.

**A query's terms are private.** A term is a whole short line the user sent,
so in a query (`channelStore.ts` `isPrivateKey`: the key's name is a nick,
not a `#&!+` channel) it is what was said in private, and it follows the
query log's rules: none is recorded while `keepPrivateConversations` is
off, switching it off drops every query's terms (`forgetPrivateTerms`, the
store's copy reloaded), closing a query drops its own (`forgetTerms` from
the reader's `part` handler; the record's switches stay), and the settings
backup carries channels' terms but never a query's (`withoutPrivateTerms`).

Typing again, walking input history, Escape, the strip's own Edit
button and parting the channel all invalidate the strip; the next Enter
starts over.

The round trip reads a done translation back toward `reverseTarget` (the
user's reading language, whatever the draft was detected as -- when the
reading language equals the write target there is nothing to read back
into and no check runs) and shows it in a second row labelled with the pair it reads back, "German →
English" (the translation's language → the reading language). The check always starts as soon as the translation finishes,
and Send waits for it -- a failed check ("couldn't check") never blocks
Send.

The read-back is built like the translation of an incoming line: the
context a recipient in the channel would give the model, in the output
language -- `buildContext` over the channel's scrollback, as `reader.ts`
calls it, with the recent lines and the translations the reader already
has for them, names, topic, the draft's reply target, the channel's
formality and variant, and the channel's terms for the translation's
language into the reading language (`termsFor`). No voice: that is the
writer's. A read-back given the line cold reads it differently from how
the channel will, and showing how the channel will read it is the point.
The bare second try on an echo, a narration, an answered question or a
loop still drops the
context, all but the register; the routing hint stays.

When the second Enter sends a translation whose read-back finished, the
posted line shows that read-back as its translation, with the same chip
and emphasis as any translated line, and no request is made for it.
`writer.ts` `recordSentReadBack` records the read-back against the exact
text sent **before** the send (the IRC layer puts the line in the store
inside the send's emit), and a `msg` listener in `initWriter` matches own
lines by channel and text (`sentReadBack.ts`, bounded to 20 records, each
dropped after 90 s or once matched): with `echo-message` the pending copy
takes the entry and the echo that replaces it takes it again (the copy's
entry leaves with the copy on `msg:settled`); without it the one line
takes it. A send without a finished read-back -- the reading language is
the write target, the check failed, the draft went out as written -- gets
no entry, and so does a line the IRC layer split (a long line chunked by
`splitMessage`, or a multi-line one on a server without
`draft/multiline`), since no part of it carries the text that was
recorded.

That line is not translated a second time, although the reading pipeline
reads own lines. The reader's live `msg` listener asks
`sentReadBack.ts` `takesReadBack` first, synchronously inside the same
dispatch as the writer's listener: a live own line is skipped when it
already carries a translation (the writer ran first and attached the
read-back) or when a record still covers it (`SentReadBacks.covers`, the
same channel-and-text predicate `match` uses, without taking the record --
the reader ran first, or this is the echo of a pending copy that took the
read-back). Either way the writer's `match` gives it the read-back, so the
check holds whichever listener runs first. A replayed own line has no
read-back coming (the writer ignores replays) and is read.

The scenario's fake logs `purpose: "write"` (or `"read"` for the check) on
every request, so a browser check can tell the composer's traffic from the
reader's, plus `contextLines` and `voice` (how much of the channel the
context carried), so it can tell a bare retry from a full request. A
request whose text carries `[echo]` comes back as it went in (the token
stays, the `[Language]` prefix does not) so the echo rule can be exercised
without a real model declining; `[echo-once]` does that to the first
request carrying it and translates every later one, which is the bare
second try succeeding. Browser check:
`tools/scenarios/translate-composer.mjs` (also `--mobile`).

## Span protection

Fidelity is the code's job, not the model's. `spans.ts` swaps everything
the client itself treats as syntax for numbered placeholders (`⟦1⟧`) before
any engine sees the text, and puts it back afterwards; both sides of the
app go through it, and the composer's `translateDraft` protects the whole
text **once**, before it splits it into lines, so a construct that spans
lines is one span rather than a fragment per line.

The stages run in order and a placeholder never matches a later pattern:
fenced code blocks (` ``` `, closing fence at least as long, the block's
inner newlines inside the span), then TeX -- display math `$$…$$` (may span
lines, block-level like a fence) and inline math `` $`…`$ `` (the
dollar-backtick shape, closed on the same line -- what keeps "$5 and $10"
out of the maths), each one verbatim span, fences included, run before the
code pattern so a backtick inside the TeX is never read as a code span --
then pipe tables (a header row, an alignment row `|---|:-:|…` with the same
number of cells, then every following non-blank line with a pipe: the
alignment row is one span -- nothing to translate there at all -- and every
`|` that bounds a cell on the other rows is its own span, so the cells
between them are the only thing left for the engine to translate), then
inline code, URLs, `www.` links, emoji shortcodes and IRC formatting codes,
then Markdown links, then emphasis pairs (`**`, `__`, `~~`, `||`, then `*`,
`_`, longest first, only same-line pairs and only where the usual emphasis
rule holds -- `2*3*4` is arithmetic), then a line's leading syntax (`#` to
`######`, `-`/`*`/`+`, `1.`/`1)`, `>` with nesting), then the channel names
(`#` or `&` and at least two more characters that are neither whitespace nor
a comma, not preceded by a word character -- `#seance`, `&local`, `#1` is
not one and `Tom & Jerry` is not one either; `#1234` is fenced like any
other channel, and numbers are never translated anyway). A trailing run of
`.,;:!?)` is the **sentence's**, not the name's, and stays in the text
(`treffen in #seance.` fences `#seance` and keeps its full stop, so the
model still sees a sentence that ends), while a dot or a colon inside the
name is part of it -- `#a.b` is whole. Then, finally, the
nicknames (whole word, case-insensitive, longest first, at least two
characters, never inside an earlier placeholder). Channel names run _after_
the line prefixes on purpose: `###` satisfies "at least two more
characters", so a channel stage run first would eat `### Heading`'s marker
and leave a bogus span where the header was. This is a conservative
reading of the client's own grammar
(`helpers/ircmessageparser/parseMarkdown.ts`); protecting a little more
than the client renders is safe, because a span is put back byte for byte.

**Which names are fenced.** The channel's user list is only part of the
answer, so `names.ts` `namesFor` builds one set and everything takes it: the
user list, the **sender** of this very line (still a name once they have
left the channel), a **query's target** (the other party, where there is no
user list at all -- a channel's own name is never a nick, it is a channel
name and fenced as one), and the channel's **recent speakers**, newest
first up to `RECENT_SPEAKERS` (50), so someone who spoke ten lines ago and
is quoted now is still a name. The same set is what the prompt's `Names:`
list is drawn from (`buildContext`'s `opts.nicks`, which every listed name
is filtered through -- a recent speaker outside the set is dropped rather
than listed, so the invariant is structural and not a coincidence of the
two windows lining up), so what the model is told to keep is exactly what
it never sees; it is also what
`stripNickPrefix`/`stripCopiedNickPrefix` judge a copied prefix against, and
what `plainTextOf` removes before the detector reads a line.

Every span says what it is, and each kind has its own restore policy
(`restoreAll`):

- **verbatim** -- put back where the engine left it; appended after the
  text when the engine lost it ("better shown late than lost").
- **marker** -- one half of a pair. Lose either half and neither goes back,
  so a translation never comes out with a stray `*` in it.
- **prefix** -- a line's leading syntax. Lost, it is re-prepended to its
  line (to its own line when the whole text is restored at once and the
  line count held, otherwise to the front of the line being restored).

A placeholder number the engine invented is dropped rather than shown, and
a span nested inside another (a link's `](target)`, whose target the URL
stage already claimed) travels with its parent and is never reported lost.
A line that holds nothing but a placeholder -- a fenced block, a display
math block or a table's alignment row on its own -- is put back rather than
sent for translation at all. A pipe table's alignment row uses the
**prefix** policy (its own line, since it is the whole line); a lost cell
separator elsewhere in the table falls back to the **verbatim** policy and
is appended after the text rather than put back at its column -- accepted
as today's policy rather than special-cased.

### Emphasis marks on the LLM route

A marker pair is the one span whose _content_ the engine has to translate,
and that turned out to be the difference. Everything else a placeholder
stands for -- a URL, a code span, a nickname, a table's separator, a line
prefix -- is meant to come back unchanged, and the models carry those
through happily. Bare `⟦n⟧` pairs _around words to translate_ are what the
1.7B LLM cannot do: asked for `please keep the *timestamps* in the log, I need the **ordering**` it answered `⟧3⟧timestamps⟦4⟧ in der Log ⟦1⟧ordering⟦2⟧` -- the emphasised words untranslated, the first clause
dropped and a placeholder mangled -- and `hello this is supposed to be in *German*` came back as `hallo this is supposed to be in ⟦1⟧German⟦2⟧`, a
near echo.

So the form a pair takes is chosen **per route** (`spans.ts`
`MarkerForm`, `renderMarkers`): `protect()` is still the one canonical
protection and always numbers every span, and the pairs are then rendered
for the engine the request is about to reach.

- **`literal`** -- `LLM_MARKERS`, what the LLM route gets: the marks as the
  user typed them (`*German*`), with one added system sentence (`KEEP_MARKS`
  in `prompt.ts`). A link stays well-formed markdown with only its target
  hidden (`[the log](⟦1⟧)`).
- **`placeholder`** -- `⟦1⟧German⟦2⟧`, what every seq2seq candidate gets.
  They read no prompt, so the code has to do all of it, and they do not have
  the LLM's problem.
- **`tags`** -- `<1>German</1>`, kept because `tools/translate-llm.ts --markers tags` measures it, and reachable from nowhere else.

Measured over `tools/translate-eval/markers.json` (eight cases, the two
reported lines among them, en->de in the composer's shape and de->en in the
reader's, all with one channel's context) and scored on whether the whole
sentence was translated and the marks landed on the right words:
`literal` 5 correct of 8 with 3 partial and nothing garbled, `placeholder`
3 correct with 3 sentences lost, `tags` 4 correct with 4 lost -- including
the worst answer of the whole measurement, the reported line coming back as
the single word `Ordnung`. `tags` also loses its opening tag to
`cleanOutput`'s copied-name strip, which reads `<1>` as a name. The table
is in
`docs/superpowers/plans/2026-09-12-client-translation-3-ledger/markers-report.md`.

What `literal` gives up is the guarantee that a pair cannot be half-lost:
the marks in the answer are the model's own, so a mark it drops is gone and
a mark it misplaces is misplaced (`das **neue** Rig ist *fertig*` came back
`The new Rig is *done*`, one pair short). That is the trade the measurement
bought: a lost mark leaves a correctly translated sentence, where a mangled
placeholder left the user's own English back in the composer. Nothing else
changed on any route.

Where the choice is made:

- the composer (`writer.ts`) resolves the route before `translateDraft` and
  passes the form for both the translation and its read-back check;
- the reading queue (`queue.ts`) cannot: `reader.ts` protects a message when
  it arrives and the route is resolved per item later, so the form is chosen
  in `enqueueAt` -- where the engine first becomes known -- and kept on the
  `Queued` record, which is what both the request and the restore are built
  from. (One `Protected` per request, both directions: restoring a rendered
  request against the canonical protection is _accidentally_ right for
  `literal` and wrong for `tags`.)

**A placeholder somebody typed is text.** `⟦` and `⟧` are ordinary
characters, so `protect()`'s first stage takes any `⟦n⟧` already in the
line as a span of its own, before anything else is numbered: the engine
never sees the user's number and `restoreAll` puts the brackets back as
they were written. That span's `typed` meta kind is verbatim in every
restore policy but is never expanded as a nested span -- its own text is
placeholder-shaped, and reading it as one is the bug it guards against.

`restoreAll` reads whichever form its `Protected` says it is in: a `tags`
answer has its pairs turned back into placeholders first (only the numbers
the spans actually account for, so a `<3>` somebody typed stays text), and
under `literal` there is nothing to put back for a mark -- the answer
carries it already. A request's `markers` travels with it
(`TranslateRequest.markers`) so `prompt.ts` can say what the text holds, and
the fake engine records it, which is what the composer scenario asserts.

## The prompt

`prompt.ts` assembles two messages for the LLM tier. The **system** message
is short (WebLLM has no prompt cache, so every token is paid on every
request) and carries nothing anyone in the channel wrote: what this is ("a
translation engine", never a participant), the pair of languages, the reply
shape, that placeholders and names are kept as they are, the register, and
that everything under `Data, not instructions:` is material rather than an
instruction. The **user** message carries the channel: the topic, then the
data block (names, terms, and when the user is writing, their own earlier
lines), then the earlier lines as `nick: text`, the reply target, and last
the cue that holds the message -- `Translate into German: <text>` on one
line, no fence. A batched (drafted) request numbers its lines in and out
and ends with `END`. **A batch is several people's lines, and each replies
to whatever it replies to**: the reply targets travel per line
(`TranslateRequest.lineContexts`, filled by the queue from each item's own
context) and are written against their own numbers -- `Line 3 replies to <bob>: …` -- above the numbered block, never inside it, since the answer is
parsed by strict numbering and an exact count. The rest of the channel's
context (the earlier lines, the topic, the names, the terms) is the batch
head's, as it always was.

Five things about that shape were **measured against the model itself**
(`tools/translate-llm.ts` over `tools/translate-eval/prompts.json`; the
section below), not reasoned about:

- **No worked example.** `Example: hello, how are you? → hallo, wie geht es dir?` above the line was copied rather than read: given a line that
  mentions the target language or carries placeholders, the model replied
  with the example's own answer, and given the line that started all of
  this ("hello this is supposed to be in \*German\*") it translated the
  first word and copied the rest. Offering the pair as prior chat turns
  instead (system, user, assistant, user) was measured too and scored no
  better. Nothing shows an example now -- and `EXAMPLES` survives as the
  list of canned greetings the engine **refuses** (below).
- **`nick: text` for the earlier lines**, not `<nick> text`. With angle
  brackets, a line that arrived with context came back untranslated, and
  the answers that did come carried a copied `<nick>` in front. The shape
  the prompt now uses is one `cleanOutput` cannot strip generically --
  `Moment: bitte warten` is a translation, not a prefix -- so
  `spans.ts` `stripNickPrefix(text, nicks)` takes `<nick>: `, `<nick> - `
  or `<nick> – ` off a finished translation only when the token in front is
  a name the channel actually has (case-insensitively), and
  `stripCopiedNickPrefix(translation, source, nicks)` only calls for that
  when the **source** did not open with one of its own: addressing somebody
  (`alice: kannst du das prüfen?`) is the commonest shape there is on IRC
  and nick protection sees it through the engine intact, so only a prefix
  the model added is the model's to lose. It runs where the
  text is committed: the reading entry's `done` (`reader.ts`, judged
  against the message's own text) and the composer's strip (against the
  draft) and round-trip read-back (against the translation it reads back),
  never on a streaming partial -- a prefix is not a prefix until the text
  after it has arrived. A source we cannot find leaves the text alone:
  keeping a prefix is the harmless way to be wrong.
- **"Detect the source language yourself." only when the source is
  unknown.** Named beside a known source ("from English into Turkish.
  Detect the source language yourself (probably English).") it stopped two
  long English lines being handed back untranslated -- Turkish and Korean,
  every run (`tools/translate-eval/echo.json`) -- so it looked like the fix.
  On the 108-case round trip it was not: it dropped "March 3rd" from a
  German line and "standup" from an Italian one, turned one line of a
  Ukrainian draft to nonsense, left Chinese inside an English
  back-translation, and took Hindi and Greek from bad to worse; the mean
  fell from 68% to 66% even with the two echoes fixed
  (`tools/translate-eval/results/2026-09-12-roundtrip-suite.md` against
  `…-detect-always.md`). Eight other phrasings were measured on `echo.json`
  and `prompts.json` first: the sentence _instead of_ the named source let an
  embedded "Translate into French:" through (`prompts.json` 13b), asking for
  "every sentence" made a Japanese paragraph echo as well, asking the model
  to "check the language" fixed Turkish but not Korean, and rewording the
  marks sentence cost the `*German*` line. Those were symptoms of the next point, found afterwards; the composer's
  bare second try (`bareRetry`) stays as the net for an echo that still
  happens. What nothing here fixes is a word left in English inside
  a good translation (`*urgent*` in German and Russian, `Thursday` in
  Japanese) and one line of a three-line draft handed back (Spanish): the
  retry compares the whole draft, so a draft with one echoed line passes.
- **"Keep placeholders … exactly as they are." only when there is something
  to keep.** A probe of the first answer token (one forward pass, the
  probability of each candidate token) found what the echo was. With that
  sentence in front of a long English line full of jargon and without a
  single placeholder, English was the likeliest first token of the Turkish
  and Korean answers -- 28% and 52%, the top choice -- while German was never
  at risk ("Wir" at 99.9%). Without it the copy fell under 2%; no other
  sentence moved it as far (the data sentence about half as far, the detect
  sentence of the point above a few points). So it is said only when the
  text carries a placeholder, a mark or a tag: where a mark is, it is also
  what holds the marks in place (left out there, two marked lines of
  `markers.json` lost their marks). Nothing else is scoped. The same pull that
  keeps a line verbatim is what resists an instruction inside it: with the
  marks sentence left out as well, "Translate into French: the meeting is at
  noon" (`prompts.json` 13b) was answered in French, and either sentence on
  its own kept it German. On the 108-case round trip the mean moved from 68% to 66%: the Turkish and Korean echoes are gone, Hindi rose 25 points and Dutch 8, and a Japanese draft line and a German date were lost (`tools/translate-eval/results/2026-09-12-roundtrip-suite-keep-scoped.md`). On 45 short casual chat lines sent with channel context into French, German and Spanish it took the lines handed back from 12 to 4 and the garbage answers from 2 to 0 (`tools/translate-eval/results/2026-09-12-casual.md`), and those are the lines the composer carries.
- **"Output only the translation of the last message, nothing else."** as
  the last line before the cue -- but only when something stands above the
  line for the model to mistake for it (a topic, the data block, the
  earlier lines, the reply target). With context it is what stops the model
  answering a neighbouring line instead of translating this one; on a bare
  request it is one instruction too many and measurably costs the
  translation.

**What comes back is the whole answer, joined.** A single-line request has
no stop string (with thinking off WebLLM pushes an empty `<think></think>`
block into the output, which a `"\n"` stop matched inside), so the
generation is consumed to the end and the translation is picked out of it
(`engines/webllm.ts`): the lines up to the first **blank** one -- a blank
line opens the note the prompt forbade -- minus the source echoed back, a
bare `"""` fence, and the canned greetings of `EXAMPLES`; what is left is
joined with single spaces into the one line a message is. It used to be cut
at the first complete line, which dropped every later sentence of a long
message the model wrapped. If nothing survives the guards, the last line
that carries anything is shown (the model only echoed -- better than
nothing), **except** when a canned greeting was among what was dropped:
that fails the request with "the model answered with the example", which
the composer shows as "send as written?" and a reading line offers Retry
for. It is a request-class failure on purpose -- the model stays loaded and
nothing is counted against the device. A line that is _both_ the source and
a canned greeting (the message really is "Hallo, wie geht es dir?") is an
echo, not a refusal.

## The worker

`js/translate-worker.js` (its own webpack configuration, like the push
chunk) hosts both engines; the page talks to it over `protocol.ts`
(`client.ts` on the page, `worker.ts` in the worker). `service.ts` routes,
loads on demand, marks candidates down and gives memory back when a model
is not needed: a loaded GPU model with no request unloads after 3 minutes
(`GPU_IDLE_UNLOAD_MS`) and a CPU model after 5 (`CPU_IDLE_UNLOAD_MS`); a
tier switched off in Settings unloads at once (once nothing runs on it);
and every model unloads at once when translation is not in use — no
channel in the store reads or writes through it, no line waits in a queue
and no composer strip or read-back is open (`reader.ts` `translationInUse`,
registered through `index.ts` `setTranslationUsage`; the store watch and a
queue's drain ask `service.usageChanged()`, which checks on the next tick)
— and nothing is in flight. The last model going takes the worker with
it, as `pagehide` does; the next request loads again, with its download
note. `index.ts` is the singleton wired to the
store; on a development build `?fakeTranslate` swaps in `fakePort.ts`, an
in-page scripted worker the scenarios use. Plan 2 (reading) starts from the
page-side surface `client.ts` already exposes: `TranslateClient.translate(req, ref, onProgress?)` for the streamed chunks, `WORKER_DISPOSED` as the
rejection every in-flight call gets on teardown, `GPU_IDLE_UNLOAD_MS` and
`CPU_IDLE_UNLOAD_MS` for how long an unused model survives, and `translateService().translate()` as the
one call a new caller (the header switch) needs on the page.

**The caller's half of the contract:** a stream from
`translateService().translate()` must be consumed to the end, or left with
`break`/`return` (anything that runs the generator's `return()`). A
generator simply abandoned never releases the service's in-flight count, so
no unload ever fires and the worker lives until `pagehide`.

**Prerequisites for plan 2**, none of which matter while the service is the
only caller:

- `status` and `models` replies carry no correlation id, so every
  outstanding waiter settles on the first one back. Serialise those calls,
  or give the messages ids, before a second caller exists.
- `Seq2seqEngine.unload()` disposes what is loaded and ignores loads still
  in flight: a pipeline that arrives after it is loaded again, uncounted.
- An abandoned generator leaks an in-flight count (above), and in the
  seq2seq engine it also pins its model against eviction.

**Trying the engine before plan 2.** On a development build, `await seanceTranslate("Hallo Welt", "en", "de")` in the console returns the translation and `seanceTranslate(text, to, from, console.log)` streams it; `from` null leaves detection to the LLM (the seq2seq engines need a source).

## Installing

`@huggingface/transformers` (4.2.0, the seq2seq engine) hard-depends on two
packages the browser build never loads, and both make `yarn install` more
than a download of JavaScript:

- **`onnxruntime-node` (pinned 1.24.3)** ships its CPU runtime for every
  platform in the npm tarball (~220 MB unpacked) and runs a postinstall
  script that, on Linux x64 only, fetches the CUDA 12 and TensorRT
  providers from NuGet (~316 MB under
  `node_modules/onnxruntime-node/bin/napi-v6/linux/x64/`;
  `script/install-metadata.js`). That fetch needs network access beyond
  the npm registry. Nothing in the repository uses CUDA:
  `ONNXRUNTIME_NODE_INSTALL=skip` skips it, and the Pages workflow's
  install sets it.
- **`sharp` (^0.34.5)** installs a platform prebuilt (`@img/sharp-*`
  optional dependencies); its install script only checks for one and,
  where none exists for the platform/libc, falls back to a `node-gyp`
  build, which needs a toolchain.

`yarn install --ignore-scripts` skips both scripts. The browser bundle is
unaffected -- it only ever reaches `onnxruntime-web` -- and the Node-side
tools (`tools/i18n/fill.ts`, `tools/translate-llm.ts`) run on the CPU
runtime the tarball carries; only a platform without a sharp prebuilt is
left without sharp.

**`onnxruntime-web` is a nightly pin** (`1.26.0-dev.20260416-b7804b056c`,
transitively, from `@huggingface/transformers`): it is what ships in
`public/js/ort/`. It is not a stable release, its tarball is a dev build on
the registry, and an upgrade of `@huggingface/transformers` moves it
without notice — re-run the CPU-model browser check
(`SEANCE_REAL_MODELS=1 node tools/browser-drive.mjs tools/scenarios/translate-cpu-real.mjs`)
after any such bump.

## Licences

The code the build ships: `@huggingface/transformers` 4.2.0 and
`@mlc-ai/web-llm` 0.2.85 are Apache-2.0, `onnxruntime-web` (and the
`js/ort/` wasm it loads) MIT, `@wllama/wllama` 3.8.1 MIT (Copyright (c) 2024
Xuan Son NGUYEN) and llama.cpp/ggml, which it compiles into `js/wllama.wasm`,
MIT (Copyright (c) 2023-2024 The ggml authors), `franc` and its three helpers
(the `js/franc.js` chunk) MIT -- all compatible with Seance's MIT. Neither
Apache-2.0 package carries a NOTICE file; their builds carry no notice
either, nor do wllama's, so `webpack.config.ts` (`chunkNotices`) writes one
per library into `js/translate-worker.js.LICENSE.txt`, each licence named
beside the packages it covers, as it does for the markdown chunks.

The weights are fetched at run time from Hugging Face (or the deploy's
`translation.modelBase` mirror), never bundled, and come under their own
licences (the model cards, 2026-10-28): Qwen3 1.7B and 4B Apache-2.0,
Helsinki-NLP's OPUS-MT pairs Apache-2.0 (the weights CC-BY-4.0 upstream),
and **NLLB-200 (distilled 600M) CC-BY-NC-4.0** -- non-commercial.

So NLLB-200 is **opt-in**: Settings → Translation's "Use NLLB-200 for
languages the other models do not cover" (`translateNllb`, under the CPU
models' switch, with a line naming the licence) is off by default, for new
users and existing ones alike -- a stored settings object that never chose
reads as off, and a settings backup made before the switch existed restores
it off. Off, the router passes over every `nllb` candidate
(`RouteInput.allowNllb`, `modelBlock`'s `{kind: "off", engine: "nllb"}`):
the OPUS-MT pairs come before NLLB in every shipped row anyway
(`test/translate/routes.ts`), the GPU model serves the rest where it runs,
and a pair only NLLB could serve here -- a language without an OPUS pair on
a device without the GPU model -- is unavailable with the reason "This needs
NLLB-200, which is switched off in Settings → Translation." The NLLB
family keeps its Run on open, and its copies can still be downloaded ahead
of use.
`translationBlock` counts the CPU models with NLLB on, so the opt-in never
makes translation as a whole unavailable. A deploy can still point
`translation.cpu.nllb` at a model it may use (`docs/resources/branding.md`
§ Translation); the same switch governs it.

## Weights

**Serving.** The worker loads ONNX Runtime with a dynamic `import()` of `js/ort/ort-wasm-simd-threaded.mjs`, and a browser refuses a module served with anything but a JavaScript MIME type ("Failed to fetch dynamically imported module", surfaced by the tab as "no available backend found"). A deploy must serve `.mjs` as `text/javascript` and `.wasm` as `application/wasm` (the latter for streaming compilation; a wrong type there only slows the load). GitHub Pages and nginx do; Python's `http.server` only does where the system MIME table has an `.mjs` entry (on Debian it has none, and the module comes back as `application/octet-stream`), and a hand-rolled static server with its own table may not. For a local check, add the two types on the way in:

```sh
python3 -c 'import http.server as h, mimetypes as m, functools; m.add_type("text/javascript", ".mjs"); m.add_type("application/wasm", ".wasm"); h.test(functools.partial(h.SimpleHTTPRequestHandler, directory="public"), h.ThreadingHTTPServer, port=8021)'
```

**CPU models and ONNX Runtime.** The seq2seq engine loads the `q8` weights with `session_options: {graphOptimizationLevel: "basic"}` (`engines/seq2seq.real.ts`). ONNX Runtime's default level is _extended_, and one of its transforms rejects the QDQ graphs these models ship: `Can't create a session. ERROR_CODE: 1 … qdq_actions.cc:137 TransposeDQWeightsForMatMulNBits Missing required scale: model.shared.weight_merged_0_scale`. Every CPU model then fails to load, which the composer shows as "couldn't translate, send as written?" and the reading line as "couldn't translate" — the whole tier looks broken. `basic` stops short of that transform and the same weights load and run, so do not raise the level to fix a slow load. This is the other half of the serving note above: a wrong `.mjs` type and a wrong optimizer level both end as "no CPU model would load", and only the reason on the model row (Settings → Translation) or beside the failure tells them apart. Browser check, opt-in because it downloads real weights: `SEANCE_REAL_MODELS=1 node tools/browser-drive.mjs tools/scenarios/translate-cpu-real.mjs`.

WebLLM caches under its own Cache Storage keys (`webllm/model` -- where the
worker also seeds the small-buffer build's rewritten manifest --
`webllm/wasm`, `webllm/config`), transformers.js under
`transformers-cache`; `service-worker.js` never touches either, nor a
same-origin mirror under `models/` — and its `activate` cache sweep
(`isModelCache`) explicitly skips these names, so a shell update cannot
evict a model. The ONNX Runtime wasm files ship in
`js/ort/`. Settings → Translation lists every catalog model with its size
and cached state, downloads with progress and deletes.

## Testing prompts offline

`tools/translate-llm.ts` runs the GPU tier from the command line, without a
browser:

```sh
npx tsx tools/translate-llm.ts "hello, how are you?" --to de --from en --show-prompt --raw
npx tsx tools/translate-llm.ts --eval tools/translate-eval/prompts.json
```

It is the shipped `WebLlmEngine` itself — the think-block stripping, the
echo and example guards, the blank-line rule, `cleanOutput`, the stop
strings and the abort drain — over a Node implementation of the engine's
`MlcLike` interface, and the request is built by
`protect()`/`emptyContext()`/`restoreAll()` the way `reader.ts` and
`outgoing.ts` build theirs. Only the weights differ: the backend is
transformers.js with `onnx-community/Qwen3-1.7B-ONNX` at `q4f16` rather
than WebLLM's MLC `q4f16_1` build of the same model, so token-level output
can differ a little while prompt behaviour matches. The first run downloads
1.4 GB into `tmp/models/` (gitignored; `SEANCE_MODEL_CACHE` overrides) —
54 s all in on the first run — and after that a warm load is about 8 s and
a sentence takes a few seconds on the CPU.

`--show-prompt` prints the rendered chat template. Two things it settles:
`enable_thinking: false` does reach Qwen3's template (transformers.js
spreads unknown `apply_chat_template` options into the Jinja render), and
the template puts the empty `<think>\n\n</think>` block at the end of the
**prompt** — where WebLLM instead pushes it into the **output**. So the
Node backend prepends that block as the first delta, and the engine's
`visibleText()` has the same thing to strip as it does in the browser; the
runner says so, or says loudly that the block was absent. `--raw` prints
the raw delta stream and then the echo guard's verdict on each line, which
is what tells "the model echoed the source" apart from "the model
translated and the guard dropped it".

`--markers placeholder|literal|tags` protects the input in that marker form
(spans.ts `renderMarkers`) and sends the form with the request, so a run is
the app's exact shape on that route; `tools/translate-eval/markers.json` is
the set the per-route rule above was chosen with (eight cases: the two
reported lines, a nick to carry through, three pairs in one line, a link, a
spoiler at the front of the line, and two reading-direction lines, each
carrying the composer's own channel context).

**`--capture` replays what the page actually sent.** A development build
(`BUILD === "dev"`, which is every `yarn build` without
`NODE_ENV=production`) records every composer attempt -- the draft's
translation and the round trip's read-back, the bare retry included -- on
two globals: `window.seanceTranslateLast` is the newest and
`window.seanceTranslateLog` the newest ten. Each entry carries `kind`
(`write`/`check`), `at`, `draft`, `from`, `to`, `model`, `engine`,
`markers`, `retry`, the whole `context` as it went out, the `text` that
came back and the `error` it was judged as (`came back unchanged`, `empty translation`, a thrown message, or null). A production build defines
neither global. So a translation that reads wrongly on someone's GPU can be
reproduced here exactly as it was asked for -- open the console on the
page, then:

```js
copy(JSON.stringify(seanceTranslateLast)); // or seanceTranslateLog
```

An attempt the page gave up on is recorded too -- a newer draft, Escape or
the strip's Edit aborts the request and leaves an entry with `text: ""` and
`error: "aborted"` -- so where the newest entry is one of those, take the
request being reported out of `seanceTranslateLog` instead.

```sh
npx tsx tools/translate-llm.ts --capture tmp/capture.json --show-prompt --raw
```

The capture supplies the text, `from`, `to`, `markers` and the context, and
`purpose` from its `kind` (a `write` capture would otherwise be replayed as
a reading request and build the wrong prompt); `--to`, `--from`,
`--purpose`, `--markers` and a text argument on the command line still
override it, and `--context` replaces the context. A capture carries no
user list, so the context's own `names` stand in for span protection --
they are the recent speakers and the nicks the draft mentions, which is
what a placeholder is for. Note that `--context` accepts a captured
`context` object on its own (the fixture shape is exactly a partial
`PromptContext`), but handing it the _whole_ capture silently drops
`draft`, `from`, `to` and `markers` rather than complaining -- that is what
`--capture` is for.

`--context fixture.json` supplies a `PromptContext` (`recent`, `names`,
`terms`, `topic`, `replyTo`, `voice`, `formality`, `variant`, `sourceHint`)
plus `nicks` for span protection; `--eval` takes a JSON array of
`{text, from?, to?, purpose?, nicks?, context?, note?, expect?}` and prints
input, output and wall time for each. A case's own `context` is that same
fixture shape inline, so one file can carry both bare lines and a whole
channel; `expect` is a one-line note of what a correct answer carries,
printed for the reader and asserted by nothing. `tools/translate-eval/prompts.json`
is the measurement set the shipped prompt was chosen with (15 entries: the
user's own `*German*` line, a reading context that reproduced the
untranslated pass-through, a long four-sentence message, instruction-shaped
text, a draft, and the plain cases). A text with a newline goes as a
batched (numbered) request, as a draft does. `--repo` points the backend at
a different Hugging Face repository. `--device cuda` exists but is not a
supported path: an ONNX Runtime CUDA provider without cuDNN builds the
session and then decodes nothing but `!`.

Nothing here asserts: reading the table is the measurement. Run the whole
set per prompt variant rather than per edit — a run is a minute or two —
and keep every variant's table, because the answers move in both
directions at once.

The eval expectations stand as they are now that an echo is a failure in
the app. The `ok, brb` case still expects `"ok, brb" back, or a German equivalent — nothing invented`, and the engine still echoes it: that is the
engine behaving, and a line with nothing to translate is exactly what the
composer now presents as "couldn't translate, send as written?" instead of
offering the draft back as its own translation. Do not change a case's
`expect` to chase the app's rule; the runner measures the model, the app
decides what to do with what the model says.

**The round-trip suite.** `tools/translate-eval/make-suite.mjs` writes
`suite.json`: nine shapes of chat line — a plain question, a long sentence
with three clauses, a four-sentence paragraph, a three-line draft, a line
of commands and shorthand that do not translate (`brb`, `kubectl`, `502`,
`lol`), markdown with code and a URL, an idiom, a line addressed to a nick,
and times, a date and a unit — into the eight languages a user is likeliest
to write (de, fr, es, it, pt, ja, zh, ru), and three of those shapes into
twelve more (nl, pl, uk, tr, ko, sv, cs, ar, hi, vi, id, el): 108 cases.
`tools/translate-eval/roundtrip.ts` runs a fixture forward, sends every
answer back into the case's source language in the reading shape with no
context, and writes a markdown table with the share of each line's content
words that came back (`overlap.ts`: lower-cased, function words out, a
five-character stem counts as a match, so an inflection survives and a
paraphrase does not):

```sh
npx tsx tools/translate-eval/roundtrip.ts tools/translate-eval/suite.json --out tmp/roundtrip.md
```

Two model loads and about twenty minutes on the CPU; the two runner
transcripts land beside the table. A low score is a list of cases for a
person to read, not a verdict — an idiom rendered as its meaning scores
badly and is right. What the 2026-09-12 run measured, for the route table
plan 4 will write: a mean of 69% of content words back over the 108 cases;
the eight main languages and uk, tr, ko, vi between 66% and 78%; idioms
and the three-line draft the weakest shapes everywhere; **hi and el at
24% and 22%, with the question already garbled** — those pairs do not
belong on the LLM; ar, id, cs and pl in the fifties. Two forward answers
were the English line handed back whole (tr and ko, the paragraph), which
the table scores as a perfect trip, so read the forward column for echoes
before trusting a high number.

**The echo set.** `tools/translate-eval/make-echo.mjs` writes `echo.json`:
the lines the model handed back or left half in English on that run (the
tr and ko paragraphs, a Japanese paragraph with `Thursday` and `deploy`
left in English, a Spanish three-line draft with one line untranslated,
`*urgent*` left inside its marks in German and Russian, `week` and `paste`
left in a French paragraph, and two reading-direction lines). A prompt
change is measured against this file **and** `prompts.json`: the first
must improve, the second must not regress.

This is the first `.ts` tool in `tools/` — everything else there is plain
`.mjs`. It runs under `npx tsx`, is type-checked by `npx tsc --noEmit -p tools` and is linted because `.eslintrc.cjs` names `tools/tsconfig.json`
among its projects.

## Tests

`test/translate/*` mirrors the modules on a `FakeEngine` and an in-process
port pair; the real libraries are only imported by the two `*.real.ts`
files and never under mocha. Browser: `tools/scenarios/translate-settings.mjs`.
