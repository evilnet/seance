# Client-side translation

_Started 2026-09-11 on the `client-translation` branch (from `origin/develop`
at `d6b6624b`). Status: **all four delivery phases implemented** — the
engine layer, reading, the composer and the evaluation that placed the
default route table. What followed was localization (every surface through
the catalog, `docs/resources/i18n.md`) and the `wild-international` review
round of 2026-09-17, which is where this document's behaviour was last
corrected; `docs/resources/translation.md` describes what the code does
today. This file is the spec; the implementation plan follows from it._

## Goal

Translate IRC conversation in the browser, on the user's device, with no
server in between: incoming messages in channels the user switches on are
shown with a translation under the original, and the composer can translate
what the user types before it is sent. "Many languages" and "high quality"
pull against each other on a client device, so the engine is two engines
behind one interface and a router that picks per language pair, and the
quality claim is measured by a script rather than assumed.

> **Update 2026-10-29:** "GPU tier" and "CPU tier" below describe the first
> build, where the device was the engine. Every model now runs on either
> device, chosen per model in Settings; see `docs/projects/translation-devices.md`
> and `docs/resources/translation.md` § Devices.

## Decisions (from the design session)

| Question        | Decision                                                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Direction       | Both: incoming messages and the composer.                                                                                        |
| GPU engine      | WebLLM (MLC) running a 1-2 GB instruction LLM (Qwen3 1.7B or Gemma 3 1B class, q4f16) via WebGPU.                                |
| CPU engine      | transformers.js on ONNX Runtime WASM running purpose-built translation models (NLLB-200 distilled, OPUS-MT).                     |
| Engine choice   | A router table per language pair. The CPU engine is a peer preferred for the languages where it measures better, not a fallback. |
| Reading trigger | Automatic per channel, opt-in; language detection gates the queue.                                                               |
| Reading display | Translation under the original as a muted line with a "from German" chip; streaming text with a caret.                           |
| Channel switch  | A globe button in the chat header, lit when on; its menu (and the channel menu) holds the languages and options.                 |
| Composer        | Translation only, after a preview: a strip above the input (like the reply and edit strips), second Enter sends.                 |
| Weights         | `config.json` `translation.modelBase`; unset means the public Hugging Face CDN. Cached in the browser.                           |
| Labels          | Full language names everywhere ("from German", "to German"), never codes.                                                        |

Quality levers in the first version: recent messages as context, the reply
target, the channel topic and language prior, deterministic span protection,
a nick glossary, per-channel term memory, multiline messages as one unit,
queue batching, a round-trip check on the strip, and voice
examples and formality as settings. Deferred: draft-and-refine across the two
engines, and a "wrong?" feedback log.

### Deviations recorded during implementation

Plan 1 (engine layer):

- `Engine.capabilities()` carries no language lists; the model catalog
  (`models.ts`) does.
- `TranslateChunk` has no `line`; batched results are parsed once on `done`.
- `translateEngines` is two boolean settings, `translateLlm` and
  `translateCpu`.
- `TranslateRequest` names its `model`; the service picks it from the route.
- Engines expose `loadedModels()` / `isLoaded(model)` rather than one loaded
  flag.
- A candidate is marked down only on a load-class failure (`EngineError`
  cause `"load"`); a request failure is reported per line and the candidate
  stays up.

Plan 2 (reading pipeline):

- Language detection uses `franc` (a lazy chunk) with the channel's
  recent-language prior, not hand-built n-gram profiles. When franc's best
  guess is a language the catalog does not know, the detection is
  undetermined (no lower-ranked guess is used); a forced (manual)
  translation still lets the LLM detect the source.
- Eligibility: the shortcode pattern requires a letter, so a clock time
  like `12:30:45` is never treated as an emoji shortcode (applied to span
  protection too).
- WebGPU device loss: the reload-once counter belongs to the model id;
  loading a different model resets it, a second consecutive loss of the
  same model marks the LLM candidate down.
- Queue: a pair without a route fails the line ("no route") instead of
  hanging; every request carries an AbortSignal end to end and a 120 s
  deadline ("timed out"); a channel switch cancels its in-flight requests
  eagerly; lines older than 200 arrivals in their channel are dropped
  rather than translated late.
- The per-channel record lives in `translate/channelStore.ts`, not
  `helpers/translateStore.ts`, and persists only `read`, `write`,
  `formality`, `variant`, `languages`, `terms`
  (`thelounge.translate`); runtime
  patches never write `terms`, and a `read`/`write` the build
  cannot route is loaded as null.
- An edited or deleted message loses its translation (an edit is re-queued
  as the new line's own). Parting a channel discards its queue, priors and
  arrival counters and the translations of its messages but keeps its
  persisted record, so a rejoin reads on; a network's quit also discards
  the records (the switch, formality, variant and term memory); the
  message-limit trim in `socket-events/msg.ts` drops the entries of the
  messages it splices. `state.translations` is in memory only, but it is
  not kept for the life of the tab.
- `TERM_LINES` (20) lives in `context.ts` rather than `prompt.ts`: the
  context builder is where the slice happens. A prompt carries the newest
  20 of the channel's own terms.
- The deploy's `translation.glossary` is merged into every request at
  context-build time rather than seeded into the persisted records, keyed
  by the source term with the channel's own memory winning; the glossary
  itself is not subject to `TERM_LINES`.
- **Own lines are read too** (live test, 2026-09-13: the user's past lines
  stayed bare): eligibility no longer excludes `self` (§ Reading pipeline,
  1, said own messages were excluded), only pending copies. A posted
  translation keeps the composer's read-back instead of being translated
  again: the reader's live listener skips an own line that carries a
  translation or that a read-back record still covers
  (`sentReadBack.ts` `takesReadBack`), which holds in either listener
  order. A language change retranslates own lines with the rest, except a
  read-back already in the new language, which is kept and not requeued.
- **Reading covers what the channel shows** (live test, 2026-09-12; this reverses plan 2's switch-on-moment rule): no `since` gate on any path, history capped at `HISTORY_QUEUE_CAP` per load (a page, a replay batch, the requeue of a switch-on or language change), newest first, and leaving a channel keeps its setting.
- A channel's **declared languages** (`channelStore.ts` `languages`, the
  panel's _Languages spoken here_) are an explicit prior above the
  automatic one, added after the live test of 2026-09-12: a declared
  language within `DECLARED_MARGIN` (0.25) of franc's best wins over an
  undeclared best; two declared contenders that close resolve by their own
  gap, then by the prior, and otherwise stay undetermined; a best franc
  names but the catalog cannot route is rescued by a declared contender
  rather than coming back undetermined; and a line under
  `DETECT_MIN_LENGTH` is taken as the single declared language that is not
  the reader's target when there is exactly one, at confidence 0 and
  without noting the automatic prior. `candidates` puts declared
  contenders first. `detectLanguage` grew a fourth argument for it
  (`options: {exclude}` — the reader's target), which the brief left
  implicit; the composer passes neither `declared` nor `exclude`.
- Detection thresholds: `DETECT_MIN_GAP` (0.1) over the best guess's lead
  on the runner-up, not the spec's `DETECT_MIN_CONFIDENCE` (0.6) over a
  normalised confidence -- a different quantity: `francAll` normalises its
  best score to 1, so only the lead over the runner-up carries
  information, and a near tie goes to the channel's prior.
- `NAMES_CAP` (20) caps the names in a prompt where the spec says "the
  channel's NAMES list".
- The channel menu's "Translation…" switches to the channel and asks
  through `state.translation.panelFor` (a store slot the view clears),
  not an eventbus event: the view of a channel that is not open does not
  exist to hear one.
- The reader waits for the capability probe before the first line of a
  channel, and re-reads the channel's settings after language detection so
  a setting changed mid-flight wins.
- The translation panel is a sibling of the channel header (absolutely
  positioned under it), not a child: the header clips its overflow.

Plan 3 (composer):

- A message edit never translates: `startEdit` pre-fills the draft with
  the sent text, already in the write language, and the gate treats
  `channel.editing` like a slash command. "Escape or Edit removes the
  strip" is the strip's own Edit button, not the edit compose bar.
- The round trip's reverse language is always the user's reading language,
  never the draft's detected language -- the read-back is for the person
  reading it; when the reading language equals the write target there is
  nothing to read back into and no check runs. The check always starts as
  soon as the translation ends and Send waits for it. `writeSource`
  likewise trusts the reading language over a differing detector verdict
  unless the verdict clears `WRITE_DETECT_MIN_GAP` (0.3): a live-test fix
  after a short English draft was misdetected as Italian and sent, and read
  back, in the wrong language.
- **The composer's reading language is the channel's, and a fallback source
  is never the target** — a live-test fix of 2026-09-12, after the strip
  showed English drafts back as their own "translation". `writer.ts`
  `readingLanguage` takes `channelTranslation(network, channel).read` with
  the global setting only as the fallback, the way the reader does (the
  read-back wave had the composer reading the global alone, so a channel
  reading English with the global still on the write target asked for
  German into German); and `writeSource` never names the write target as
  the source — a weak verdict for it, like a fallback that would be it,
  leaves the source to the LLM. `canCheckOutgoing`, which had no caller,
  is gone.
- **An echo is not a translation, nor is a line without letters** — the
  other half of the 2026-09-12 live-test fix. `outgoing.ts` `isUnchanged`
  (past case, collapsed whitespace and trailing `.,!?…`) and `hasNoLetters`
  (no `\p{L}`/`\p{N}`, a placeholder's digit not counting) fail the answer
  instead of showing it: in the composer with `UNCHANGED` /
  `EMPTY_TRANSLATION` — the strip's existing "send as written?" being the
  right offer for a line with nothing to translate as well as for a model
  that did not translate — in the round trip as "couldn't check", and in
  the reading queue as the line's own failure, which deliberately does
  _not_ go through `fail()` and counts toward no `PAUSE_AFTER_FAILURES`
  (the engine completed). Neither answer joins the prompt's `voice` or the
  term memory. The strip's chip gained a `title` naming the route
  (`<Source> → <Target> · <model id> (GPU|CPU)`, from `OutgoingTranslation`'s
  new `engine`/`model`), because "why does this read like the draft" was
  unanswerable from the UI. The fake's `[echo]` token (`fakePort.ts`) is
  how both scenarios exercise it.
- **An echo gets one bare second try, and a development build keeps the
  request** — the composer (not the reading queue) sends an echoed draft
  once more as `bareRetry()` builds it (`from: null`, `emptyContext()` plus
  the register, the route kept) and reports `UNCHANGED` only if that comes
  back unchanged too; the round trip retries its read-back the same way.
  `answerError()` is the one place the two answer rules are ordered.
  `BUILD === "dev"` records every attempt on `window.seanceTranslateLast` /
  `seanceTranslateLog` (nothing in a production build), and
  `tools/translate-llm.ts --capture <file>` replays one exactly as the page
  asked for it. The fake's `[echo-once]` token is the retry succeeding.
- **A round-trip suite measures prompt changes** (`tools/translate-eval/`:
  108 cases, twenty languages, forward and back). Naming the source _and_
  asking the model to detect it stopped two long lines being echoed but cost
  more elsewhere (a dropped date, a lost term, a garbled draft line, the mean
  68% → 66%), so that stayed out. The echo's cause was the keep-placeholders sentence said
  on lines with nothing to keep: it is now said only where there is a
  placeholder, a mark or a tag (Turkish and Korean first-token copy 28% and
  52% to under 2%), and the bare retry stays as the net. Hindi and Greek scored 24% and 22% and belong on the CPU
  models in plan 4's route table.
- The Check button and its Settings → Translation choice were removed on
  the user's direction: the round trip always runs, so there was nothing
  left to offer a choice about.
- Term memory takes term-sized pairs only: a one-line draft of at most
  `TERM_MAX_WORDS` (3) words and `TERM_MAX_CHARS` (40) characters whose
  translation is also short and differs from it. Sentences never enter
  the memory.
- A write runs beside the reading queue but ahead of it: `holdReading()`
  stops new reading runs (a run already in flight finishes) while a
  draft translates, and again while the round trip reads it back; the
  worker correlates chunks by request id, and the WebLLM engine
  interrupts only the generation the aborted request owns, so a stream
  cancelled on one side never truncates the other.
- A draft the detector cannot place (under ten characters, or
  undetermined) is translated as if written in the user's reading
  language when that differs from the write target; otherwise the
  source is left to the LLM, so a CPU-only device with no route gets the
  failure strip.
- A multi-line draft translates as one batched numbered request when the
  route's engine batches, else line by line; a batch whose numbering
  does not parse, or a batch the candidate refuses, is retried line by
  line. Blank lines between lines stay in place, so a translated draft's
  multiline decision sees the shape the draft had; a draft whose only
  non-blank line sits among blank lines is sent as that line alone.
- The globe's light means reading: `translationOn` is `read !== null`.
  A write-only channel shows an unlit globe whose tooltip still says
  "sending in German" — the click toggles reading, so the light has to
  say what the click will undo.
- Escape with a strip up removes only the strip; without one it behaves
  as it always has (it blurs, it does not clear).
- Typing notifications are left alone: the first Enter sends nothing, so
  the 5 s idle timer reports "paused" and the message lands a few
  seconds late.
- A translation longer than 500 bytes splits into two `PRIVMSG`s like any
  long text; the strip does not warn.
- Formality for a write is `channel.formality` when it is not `"auto"`,
  else the global `translateFormality` setting; reading keeps using the
  channel's alone.
- The strip's copy: chip `to German`; failure `couldn't translate, send as written?` with the send button reading `Send as written`; the check
  row's label `reads back as:`.
- `writeTarget()` does not wait for the device probe: it returns the
  channel's `write` target as soon as the service is enabled, so a
  placeholder can say "sent in German" a moment before the probe
  answers. `translateOutgoing` awaits the probe itself before judging
  availability, so a fresh page's first draft is not sent untranslated
  while the probe is still in flight.
- An empty translation is treated as a failure ("send as written"), not
  as a message with nothing in it. A translation that begins with `/` is
  escaped as `//…` so the IRC layer sends it as text, the same trick a
  literal `/` in the draft already relies on. A translation started for
  one channel is only ever sent in that channel, and only while its
  network is up.

Fix wave after the first live test on a CPU-only device (2026-09-12):

- A load failure is no longer swallowed. `service.translate()` records the
  reason on the model view the way `download()` does (Settings' row reads
  `Failed: …`), and when every candidate has failed in one call the thrown
  `TRANSLATION_UNAVAILABLE` carries `<model id>: <reason>` of the last one.
  The composer's strip and the reading line show that reason beside
  "couldn't translate", truncated to 120 characters with the whole of it in
  the `title`. The first live test on a CPU-only device produced nothing but
  "couldn't translate, send as written?" for a fault (ONNX Runtime refusing
  the q8 weights) that was named precisely in an error nobody could see.
- The router prefers a candidate whose model is **already downloaded**
  over one that would have to be fetched, whatever order the table lists
  them in (`RouteInput.cached`, supplied by `service.route()` from the
  model views; without it the order is unchanged). The spec's router picks
  the first allowed candidate full stop, which on a CPU-only device sent
  English → German to an OPUS pair that was not on the device while a
  downloaded NLLB sat there, and the request then spent its two-minute
  deadline downloading.

Fix wave after the first real-model test of fidelity (2026-09-12):

- **Markdown markers are placeholders, not prose.** `*German*` came back
  from a real model as `German`. Span protection now covers the client's
  own markdown: an emphasis pair (`*`, `**`, `__`, `~~`, `||`) and a link's
  `[` / `](target)` are a **marker pair**, the model translates between
  them, and if it loses either half neither goes back — a lost marker never
  leaves a stray `*` behind.
- **Line prefixes are restored to their line.** A header, bullet, ordered
  item or quote marker at a line start is its own kind of span; when the
  engine drops it, it is re-prepended to the line rather than appended
  after the text like a lost URL.
- **Nicknames are protected.** The channel's names (whole word,
  case-insensitive, longest first, at least two characters) are
  placeholders too. They are still listed in the prompt as data, so the
  model sees the placeholder and the name it stands for.
- **A fenced code block is one span across its lines**, which means the
  text has to be protected _before_ it is split: `translateDraft` now
  protects the whole text once rather than a line at a time, and a line
  holding nothing but a placeholder is put back rather than translated. The
  spec had protection per request; one protection per message is what makes
  a construct that spans lines survive, and it also gives every line of a
  message one shared numbering.
- **The link stage can nest.** URLs are protected before links, so a
  link's closing `](⟦1⟧)` span carries a placeholder of its own; restore
  resolves a span's own placeholders (one level, bounded) and never reports
  a nested span as lost.
- **A multi-line incoming message goes through the composer's line
  logic.** The reading queue sent it as one single-line request and the
  engine's cut kept only the first line. It now reuses `translateDraft`
  (never batched with other lines, `purpose: "read"`, `batches` from the
  route's engine), with the text arriving already protected. The work is
  raced against the queue's abort the way `run()` races its iterator, so a
  cancelled channel frees the engine at once.
- **The translation can be copied and selected.** `body` is
  `user-select: none`; `#chat .msg-translation-text` and
  `#form .translate-bar-text` opt back in, the chip's menu gains a first
  item "Copy translation", and the composer's strip gains a Copy button
  that reads "Copied" for two seconds.

Panel redraw after the live test (2026-09-12):

- **The per-channel panel is one component in two layouts.** Every setting
  is a label with its control beneath it, so the four controls share one
  width; on a touch-primary device (or a window as narrow as the phone's
  chat layout, `max-width: 479px`) the same markup `<Teleport>`s to
  `<body>` as a full-screen sheet with 2.75rem controls, the two sections
  under their headings, a one-line hint under each control and a full-width
  Done above the safe area. Formality is a native picker in the column and
  a three-way segmented control (`role="radiogroup"`) on the sheet -- three
  targets to press instead of a picker to open.
- **On touch the globe's tap opens the panel** rather than toggling
  reading, since there is no right-click to reach the panel with; the
  reading switch is the panel's first control and the button's label reads
  "Translation settings". With a pointer nothing changes: click toggles,
  right-click opens.
- The panel's footer links to Settings -> Translation, for the choices that
  are not per channel.
- The sheet sits at `z-index: 1001`, above the sidebar and its overlay. The
  spec's "below context menus" is not achievable as written --
  `#context-menu-container` is 1000 -- and costs nothing: the container is
  only in the document while a menu is open, and no menu can be opened from
  the sheet.

The prompt measured against the real model (2026-09-12):

- **No worked example in the prompt.** The spec's one-shot pair
  (`Example: hello, how are you? → hallo, wie geht es dir?`) is gone: over
  `tools/translate-eval/prompts.json` the model copied it rather than read
  it -- returning the example's own answer on lines that mention the target
  language or carry placeholders, and translating only the first word of
  the user's own `*German*` line. Offering it as prior chat turns was
  measured too (`[system, user, assistant, user]`) and scored no better, so
  `buildMessages` stays two messages.
- **`EXAMPLES` stays as a guard, not as a prompt.** The table is now the
  canned greetings the engine refuses: an answer equal to one of them is
  skipped like an echo, and a reply that is nothing else fails the request
  with "the model answered with the example" (request-class -- the model
  stays loaded, the line offers Retry). A line that is both the source and
  a canned greeting is an echo, not a refusal.
- **The earlier lines render as `nick: text`,** not `<nick> text`: with
  angle brackets a line that arrived with context came back untranslated.
  `cleanOutput`'s `<nick>` strip stays for the reply target's line, which
  still uses brackets.
- **"Output only the translation of the last message, nothing else."**
  is the last line before the cue, and only when something stands above the
  line (topic, data block, earlier lines, reply target). On a bare request
  it measurably costs the translation.
- **No single-line cut.** A single-line generation is consumed whole and
  the answer is its lines up to the first blank one, echoes and canned
  answers dropped, joined with single spaces -- the spec's "first line that
  is not an echo" dropped every later sentence of a long message. The token
  budget is unchanged (`3 × input + 48 + 16`, capped at 512).
- Nick protection is unchanged (measured with it off: same answers), and
  so is the `⟦n⟧` placeholder syntax (measured as paired `<1>…</1>` tags:
  same answers).

Retranslating from a chosen source (2026-09-12):

- **The detector keeps its ranking.** `Detection` carries `candidates`: the
  known languages in franc's order, deduplicated (`cmn`/`zho` are one
  language), at most `DETECT_CANDIDATES` (3), whatever the verdict — an
  unknown best still lists the known runners-up, so a line franc placed in
  a language the catalog does not know is still one click from a
  translation. They ride on the store's `TranslationEntry` (session only,
  like the rest of it).
- **The chip's menu leaves the line's own source off its one-click list.**
  The brief asked for the candidates that differ from `entry.from`, and
  also for the scenario to find "Retranslate from German" on a line read as
  German: those cannot both hold — that item would only repeat
  Retranslate. The filter is what shipped. The scenario proves the rest of
  the ruling instead: the first menu offers runners-up, none of them the
  line's own source; after retranslating from French the same menu offers
  "Retranslate from German", which is also the proof that an explicit
  source keeps the candidates it inherited.
- **An explicit source is used as it stands**, even when it equals the
  target: the reader asked for that translation. It skips detection
  entirely (no franc chunk, no verdict) and notes nothing into the
  channel's prior.
- **A retry keeps the failed entry's source.** The fast path already
  re-queues the remembered item, which carries its `from`; the rebuild path
  now passes `entry.from` explicitly, so a retry is the same translation
  rather than a fresh guess — and, like any explicit source, skips the
  prior.
- **`stripNickPrefix` lives in `spans.ts`** (the nick list is already a
  spans concept) and runs only where a finished text is committed: the
  reading entry's `done` and the composer's strip and round-trip
  read-back. Never on a streaming partial — mid-stream, `alex` is not yet
  a prefix.
- **A prefix the source itself carried is never stripped.** Ruling 10 reads
  a leading `nick:` as the model copying its context, but addressing
  somebody is the commonest shape on IRC and `protectNicks` sees it through
  the engine intact — so the reading entry's strip is judged against the
  message's own text, the composer's against the draft, and the round
  trip's against the translation it reads back
  (`stripCopiedNickPrefix`). Without the gate a translated `alice: kannst du das prüfen?` lost who it was addressed to, and a draft addressed to
  somebody was sent without their name. A source that cannot be found
  leaves the text alone. Neither scenario can see this (the fake engine
  answers `[English] <text>`, so its output never opens with a nick), so
  it is pinned by unit tests alone.
- **Switching a channel on opens its panel.** A desktop click on the globe
  that turns reading on now opens the panel too; a click that turns it off
  only turns it off, and the touch tap is unchanged.

TeX and pipe tables survive translation (2026-09-12):

- **Math is verbatim, one span each.** Display math `$$…$$` (may span
  lines, fences included) and inline math `` $`…`$ `` (the dollar-backtick
  shape, one line) are protected before the code-span pattern and before
  emphasis, mirroring `parseMarkdown.ts`'s own math scan without importing
  it.
- **A pipe table's alignment row uses the prefix policy, not verbatim.**
  The ruling that shipped this called it a verbatim span "re-prepended to
  its line if lost" -- that behaviour is what `spans.ts`'s **prefix** kind
  already does (a lost prefix goes back to its own line), so the row is a
  `{kind: "prefix"}` span rather than a second, special-cased verbatim
  policy. A lost cell separator elsewhere in the table keeps the ordinary
  **verbatim** policy and is appended after the text instead of at its
  column -- accepted as-is, not special-cased.
- **Tables and math run before the opaque-span stage, after fences.** So a
  URL or emphasis pair inside a table cell is still protected by the later
  stages; only the pipes themselves and the whole alignment row are claimed
  up front.

Emphasis marks on the LLM route, measured (2026-09-12):

- **A marker pair's form is chosen per route; every other span is a
  numbered placeholder everywhere.** `⟦n⟧` pairs _around words to
  translate_ are what the 1.7B LLM cannot handle -- the reported draft came
  back with its emphasised words untranslated and a placeholder mangled --
  so the LLM route is given the marks themselves (`spans.ts` `LLM_MARKERS`
  = `literal`, with one added system sentence) and the seq2seq engines keep
  the pairs. Measured over `tools/translate-eval/markers.json`: literal 5
  correct of 8 (3 partial, nothing garbled) against the placeholder
  baseline's 3 (3 sentences lost) and XML-ish tag pairs' 4 (4 lost).
- **`protect()` stays the one canonical protection; the form is a
  rendering.** The spec's `protect(text, {markers})` exists, but it is
  `renderMarkers()` underneath, and that function is what the reading queue
  uses: `reader.ts` protects a message when it arrives and its route is
  resolved per item later, so the queue renders the pairs in `enqueueAt`
  (where the engine first becomes known) and keeps the one `Protected` the
  request and the restore are both built from.
- **A link keeps its whole shape literal, only its target hidden.** The
  brief for this measurement said the `](url)` half should stay a verbatim
  placeholder; measured, that half-literal `[the log⟦3⟧` cost the case
  (`*now*` came back untranslated) while the well-formed
  `[the log](⟦1⟧)` was translated whole. The URL is a placeholder either
  way.
- **Tag numbers are span indices, not per-pair ordinals.** `**` is matched
  before `*`, so `*timestamps* … **ordering**` renders as
  `<3>timestamps</3> … <1>ordering</1>`. The form is kept only because the
  runner measures it (`--markers tags`).
- **A mark can now be half-lost, and that is the trade.** With literal
  marks the answer's marks are the model's own: one it drops is gone and one
  it misplaces is misplaced. A lost mark leaves a correctly translated
  sentence; the mangled placeholder left the user's own English in the
  composer.
- **Term memory is kept per language** (live test, 2026-09-12): an entry is
  `{source, target, from, to}` and a prompt carries only its own pair's
  terms (`channelStore.ts` `termsFor`); stored bare pairs are dropped once.
- **The read-back sees what a recipient sees, and the posted line shows
  it** (live test, 2026-09-12): the round trip is built with the channel's
  context like an incoming line's translation, and a sent translation's
  line takes the
  finished read-back as its translation, matched by channel and exact text.
- **Routing by quality class** (live test, 2026-09-12: Filipino reached
  Qwen, which writes it poorly, though the table put NLLB first). A route
  table entry is ordered quality classes, not one ordered list, and a
  downloaded model is preferred only inside its class (§ `router.ts` said
  a table entry is an ordered list, and the implementation had let any
  downloaded candidate win). A better class that is not downloaded is
  downloaded on demand, the request's deadline re-armed while the download
  progresses (`armDeadline`, `loadTicks`), instead of the request going to
  a downloaded worse class. The service asks the worker what is downloaded
  on its first route. A route takes the request's source hint when `from`
  is null, so a seq2seq candidate no longer needs a named source.
- **NLLB is sent sentence by sentence**, OPUS-MT whole
  (`splitSentences`): NLLB drops the later sentences of a line.
- **The default table is placed from a round-trip measurement**
  (`tools/translate-eval/results/2026-09-12-languages.md`, Qwen re-scored on
  the web build's own weights in `2026-09-13-web-weights.md`) rather than
  plan 4's chrF evaluation, and `LIMITED_LANGUAGES` marks the languages no
  engine handles well.
- **An answer stuck repeating itself is a failure** (`REPETITION`),
  handled like a narration.
- **Incoming lines take the global formality where the channel says
  "auto"**, as the composer always did (`channelStore.ts`
  `effectiveFormality`).
- **A line the detector cannot place is translated unless it could be the
  reading language** (live test, 2026-09-13). § Reading pipeline skipped
  every line detection could not place, which left 21 of a real channel's
  71 lines untranslated, most of them Spanish that franc could not tell
  from Galician. `detect.ts` `detectionSkip` skips an unplaced line only
  when the reading language is among its candidates (or it has none) and
  the reader queues the rest with `from: null` and no source hint.
- **A line detection skips is marked** (`status: "skipped"`, `reason`
  `same` or `unsure`), a muted tag after the message whose menu offers
  "Translate anyway"; the spec had such a line show nothing.
- **An answered question is a failure** (`ANSWERED`, live test,
  2026-09-13): judged by the question mark alone (`isAnsweredQuestion`),
  handled like a narration.

The GPU model is a choice (2026-09-13):

- **Qwen3-1.7B or Qwen3-4B, chosen in Settings** (`translateLlmModel`,
  `models.ts` `LLM_CHOICES`); the spec had one GPU model, named by the
  deploy. On 45 casual lines into French, German and Spanish 4B scored like
  1.7B (40 against 41 clean) with more natural phrasing, at ~3.4 GB of GPU
  memory against ~2.0 GB. The catalog lists every choice
  (`catalog.llmChoices`) and `catalog.llm` is the selected one; a deploy's
  `translation.llm.model` becomes the default and, when it is neither
  shipped model, a third choice. Its `lib` travels on its own ref
  (`ModelRef.lib`) instead of the catalog-wide `llmLib` the engines used to
  read, which would have handed the deploy's library to the other models.
- **The setting is `""` until the user picks a model** and an unset value
  resolves to the catalog default at read time (`llmChoice`): `settings.ts`
  computes defaults before `config.json` loads, and writing the deploy's
  default into settings on first run (tried first) would have kept a later
  deploy default from anyone who never chose.
- **GPU downloads and deletes are GPU work** (fix round 1): a Settings
  download claims its model like a request, work on another GPU model
  waits for it, and a delete unloads the engine only when it holds the
  deleted model, after that model's work ends.
- **A switch settles before any LLM work continues**
  (`service.ts` `setLlmModel`): WebLLM holds one model and loading another
  ends a running generation, so later LLM requests and LLM downloads wait
  for the old model's running requests, the old model is unloaded if it is
  still loaded, and only then does LLM work resume. The switch lifts the
  LLM candidate's down-mark, and a load failure of a model already switched
  away from does not mark the new one down.
- **One route table per GPU model** (`routes.default.ts`
  `routesFor(llmModelId)`, `limitedLanguagesFor`), each from its own
  placement lists, each measured on its own model's 4-bit web weights
  (`2026-09-13-web-weights.md`). The service merges
  the deploy's `translation.routes` over the selected model's table and
  rebuilds it on a switch (`ServiceOptions.routes` is now the deploy's
  overrides alone, `routesFor` the shipped tables).
- **Each GPU model has its own prompt profile** (`prompts/`,
  `promptProfileFor`); the spec had one prompt (§ `prompt.ts`). 1.7B's
  profile is `prompt.ts` itself; 4B's started as a copy in its own module, to
  be reworded from 4B's own measurements (1.7B's marks sentence has since
  been scoped to marked lines, 4B's has not). `maxTokensFor` moved into the
  profiles (`engines/webllm.ts` keeps an export of 1.7B's), and
  `WebLlmDeps.promptProfileFor` lets a caller swap the lookup
  (`tools/translate-llm.ts --profile`).
- **Models unload when translation is not in use** (the user: "unload these
  models from memory when they are not in use, or translation is disabled
  on all channels"); the spec had one 10-minute idle unload of everything.
  Now per tier — the GPU model after 3 idle minutes, a CPU model after 5,
  either at once when its tier is switched off — and everything at once
  when nothing wants translation: no channel in the store reading or
  writing, nothing queued, no composer strip open (`reader.ts`
  `translationInUse`), and nothing in flight. A channel that was left keeps
  its setting but does not count. The check runs on the next tick
  (`service.ts` `usageChanged`) so a queue between two lines has started
  the next one first. The fake worker publishes what its engines hold
  (`__seanceTranslateFake.loaded`) and frees it when terminated, which is
  what `translate-settings.mjs` checks.

## Non-goals

- No translation of the lobby, notices from the server, events (join, part,
  mode, topic lines) or slash commands.
- No persistence of translations across reloads; a message is retranslated on
  demand.
- No server component and no deploy-side translation endpoint.
- No change to the bus contract or `SharedMsg`. The translation layer runs
  beside the store, keyed by message id.

## Architecture: `client/js/translate/`

Vue-free except for the components that render it. The rest of the app only
ever calls `translateService` (`service.ts`); it never knows which engine ran.

### `engine.ts`: the interface

```ts
interface TranslateRequest {
  id: number; // request id, for cancellation and progress
  text: string; // after span protection (placeholders in place)
  lines?: string[]; // a batched request: numbered lines in, numbered lines out
  from: string | null; // ISO 639-1 (or 639-3 for the NLLB tail), null = unknown
  to: string;
  purpose: "read" | "write";
  context: PromptContext; // see prompt.ts; engines that cannot use it ignore it
}
interface TranslateChunk {
  id: number;
  text: string; // cumulative for streaming engines, the whole result for seq2seq
  done: boolean;
  line?: number; // which line of a batched request this chunk belongs to
}
interface Engine {
  readonly name: "llm" | "seq2seq";
  load(model: ModelRef, onProgress: (p: LoadProgress) => void): Promise<void>;
  unload(): Promise<void>;
  status(): "cold" | "loading" | "ready" | "failed";
  capabilities(): {
    languages: string[];
    pairs?: [string, string][];
    streams: boolean;
    batches: boolean;
  };
  translate(req: TranslateRequest, signal: AbortSignal): AsyncIterable<TranslateChunk>;
}
```

Streaming is the base contract so the LLM's partial output renders as it
arrives; the seq2seq engine yields once with `done: true`.

### `engines/webllm.ts`: the GPU tier

Wraps `MLCEngine` through WebLLM's own web-worker handler. One model at a
time. Default model: a Qwen3 1.7B q4f16 entry from WebLLM's prebuilt list;
`config.json` can name any entry in that list or an operator-hosted
equivalent (a mirror needs both the weights URL and the compiled model
library `.wasm` URL). Generation: greedy, temperature 0.1, thinking off, max
tokens derived from the input length (`2 × input tokens + 32`, capped at
512), stop at the first newline for a single-line request and at the
`END` sentinel for a batched one. No prompt cache is assumed, so the system
prompt stays short and the context is trimmed to a token budget
(`CONTEXT_TOKEN_BUDGET`, 700).

### `engines/seq2seq.ts`: the CPU tier

transformers.js pipelines on ONNX Runtime WASM. Two model families behind one
engine: NLLB-200 distilled 600M int8 (any pair in its 200 languages) and
OPUS-MT pair models (30-80 MB each, for the pairs where a pair model measures
better than NLLB). At most two seq2seq models loaded at once, evicted by last
use. Multi-threaded WASM needs `SharedArrayBuffer`, which needs the
cross-origin isolation headers; a static deploy may not send them, so the
engine runs single-threaded when it must and reports `threads: false` in
`status()`. `docs/resources/branding.md` tells operators which headers turn
threads on.

### `router.ts`

A table keyed by target language, then source, each entry an ordered list of
candidates (implemented as ordered quality classes; see the deviation list):

```ts
type Candidate = "llm" | "nllb" | `opus:${string}-${string}`;
type RouteTable = Record<string, Record<string, Candidate[]> & {"*"?: Candidate[]}>;
```

`resolve({from, to, tier, down})` returns, as `{engine, model}`, the first
candidate that the device
tier allows (an `llm` candidate is skipped, never failed, below the GPU
threshold), the user's engine settings allow, and is not marked down for the
session. The shipped default table (`routes.default.ts`) is derived from the
evaluation table in `docs/resources/translation.md` (§ Testing and
evaluation below): the LLM for the languages where it wins on a GPU-capable
device, NLLB or an OPUS-MT pair model for the tail. `config.json`
`translation.routes` overrides entries one at a time. When a candidate cannot
load (download failed, out of memory, WebGPU device lost twice) the router
marks it down for the session and takes the next.

### `capability.ts`

The probe, run once per page and cached in memory only: `navigator.gpu`
adapter present, `shader-f16` feature, adapter `maxBufferSize` and
`maxStorageBufferBindingSize`, `navigator.deviceMemory` (where exposed) and
`navigator.storage.estimate()`. Output: `{tier: "gpu" | "cpu" | "none", reasons: string[]}`. The `gpu` tier needs an adapter with f16 and a
storage binding as large as the smallest GPU model's largest tensor
(`models.ts` `LLM_MIN_BUFFER_BYTES`, the 1.7B's 148 MiB embedding;
2026-10-27 — the spec's "1 GiB, WebLLM's floor" was WebLLM's request, not a
model's need, and `engines/gpuLimits.ts` now raises that request to what the
adapter offers); `none` means not even WASM SIMD, and the feature
hides itself. The reasons are what Settings shows ("no WebGPU", "The GPU
binds at most … in one buffer") instead of a missing row; since 2026-10-28
each model row also says whether this device runs it and why not
(`models.ts` `modelBlock`, `router.ts` `explainRoute`;
`docs/resources/translation.md` § What runs here, and why not).

### `worker.ts` and `client.ts`: the worker and its protocol

A dedicated Web Worker (`translate.worker.js`, its own webpack entry) hosts
both engines so inference never blocks the UI thread. `client.ts` is the
main-thread side: a typed message channel with request ids, `cancel(id)`,
model load progress events, per-request streaming chunks, and `status`
snapshots. Messages:

```
main → worker: {type: "load", engine, model} | {type: "unload", engine} |
               {type: "translate", req} | {type: "cancel", id} | {type: "status"}
worker → main: {type: "progress", engine, loaded, total} | {type: "chunk", chunk} |
               {type: "error", id?, engine?, message} | {type: "status", engines: {...}}
```

The worker is created lazily the first time a channel switch turns on or the
composer needs it, and terminated by the idle timeout (§ Lifecycle).

### `detect.ts`

Language identification on the main thread, cheap enough for every incoming
message: n-gram profiles (character trigrams, one profile per language the
router knows, about 200 KB), bundled as its own chunk and loaded the first
time a switch turns on. Input is the plain text with formatting stripped and
URLs, nicks and channel names removed. Output `{lang, confidence}` plus a
`DETECT_MIN_CONFIDENCE` (0.6) below which no language is named. The channel's
language prior (§ Prompt context) biases short inputs.

### `queue.ts`

One FIFO per network with priorities: the active channel first, then
channels in sidebar order, oldest message first within a channel.
Concurrency is one in-flight request per engine, so the GPU and CPU engines
run in parallel. Batching: when several queued messages share a channel and
a pair and the engine `batches`, up to `BATCH_MAX_LINES` (6) go out as one
numbered request. A message that scrolls more than `DROP_AFTER_LINES` (200)
out of view before its turn is dropped from the queue (the per-message
toolbar action brings it back). `pause(engine)`/`resume(engine)` are what
the failure policy uses.

### `prompt.ts`: context assembly

Builds `PromptContext` for a request and, for the LLM, the messages array:

- **System instruction** (short): translate from `<source or "the detected language">` to `<target>`; keep placeholders, names and channel names
  verbatim; keep the register (an IRC one-liner stays a one-liner); answer
  with the translation only; for a batched request, answer with the same
  numbered lines and nothing else, then `END`.
- **Recent messages**: the last `CONTEXT_LINES` (10) messages of the channel
  (originals, with our translations where we have them), labelled and quoted
  as context, oldest first, trimmed to the token budget from the oldest end.
- **The reply target**: when the message carries a `+draft/reply` msgid or
  starts with `<nick>:` (IRC's address convention), the parent's original
  and translation are spelled out ("this line replies to <nick>: ...").
- **Topic and language prior**: the channel topic as one framing line; the
  dominant language of the channel over the last few hundred messages (kept
  by `detect.ts`) as the source hint when the detector is unsure.
- **Nick glossary**: the channel's NAMES list and the network's channel
  names as "these are names, not words".
- **Term memory**: the channel's `TermMemory` (§ Persistence) as "earlier in
  this channel: rig → Testaufbau", capped at `TERM_LINES` (20) most recent.
- **Multiline**: a `draft/multiline` message is one request with its lines
  joined; the result is split back on the same line breaks.
- **Write purpose adds**: the user's last `VOICE_LINES` (5) sent messages in
  the target language (or their previous translated sends) as examples of
  their voice; the formality and variant lines from the channel's settings.

Span protection (`spans.ts`) runs before and after any engine: URLs, code
spans, emoji shortcodes, IRC formatting codes and `+draft/reply` quotes are
swapped for numbered placeholders (`⟦1⟧`) and restored after; a result that
lost a placeholder is retried once, then shown with the placeholder text
restored at the end.

## Reading pipeline

1. **Eligibility.** A store plugin watches new `message`, `action` and
   `notice` types in channels whose `read` target is set. Excluded: own
   messages (`self`), replay older than the switch-on time (a fresh channel
   would otherwise queue its backlog), messages under 3 words or consisting
   only of URLs, emoji, nick mentions or code, and edits until they settle.
2. **Detection.** If the detector names the target language, or names
   nothing, the message is skipped. Otherwise it is queued with its source.
3. **Queue.** As above; the visible tail of a burst translates first.
4. **Translation.** `purpose: "read"`, streaming chunks forwarded as they
   arrive.
5. **State.** `store.state.translations: Map<id, Translation>` with
   `{status: "pending" | "done" | "failed", text, from, to, engine}`, in
   memory only.
6. **Render.** `Message.vue` renders the muted line under the content with
   the "from German" chip and, while pending, the streamed text with a
   caret. The chip's click menu: Retranslate, Show original only (this
   message). The message toolbar gains "Translate" for switched-off channels
   and dropped messages. Unread, highlight and notification logic is
   untouched, since it runs on the original.

The language names come from `Intl.DisplayNames` in the app's language, with
a bundled English table as the fallback for the NLLB tail codes.

## Composer

The `write` target is per channel and separate from `read`. On Enter with
`write` set:

1. **Gate.** Slash commands (`/me` included) never translate. Nor does a
   draft the detector already places in the target language.
2. **Request.** `purpose: "write"` with the same context as reading plus the
   voice examples and formality line; span protection applies; a multi-line
   draft translates as a unit and goes out through the multiline path.
3. **Strip.** `.compose-bar`-style strip above the input with the "to
   German" chip and the text streaming in; Send disabled until the stream
   ends. The input keeps the original and stays editable; typing invalidates
   the strip and Enter requests a fresh translation.
4. **Check.** The round trip always runs once the translation is done and
   shows "reads back as: …" under it; Send waits for it, a failed check
   never blocks Send.
5. **Send.** Enter or Send ships the translation through `sendMessage`
   exactly as typed text would: pending copy, `@label`, echo. The input
   history entry keeps the original so Up recalls what the user wrote. The
   pair goes into term memory.
6. **Escape.** Escape or Edit removes the strip and leaves the input alone;
   a second Escape clears the input as today.

Failure: an engine error shows "couldn't translate, sent as written?" in
the strip with Send now meaning the original. Nothing is ever sent without
the user's second Enter.

## Header switch

`Chat.vue` gains a globe button beside the mentions and menu buttons, shown
when `capability.tier !== "none"` and `translation.enabled`. Click toggles
`read` for the channel (target = `translateTo`); lit (accent colour, accent
tint background) when `read` is set — the light means reading, which is what
the click toggles, so a channel that only sends in another language shows
an unlit globe. The tooltip states the whole state either way
("Translating into English", "Translating into English, sending in
German", or "Translate messages into English, sending in German" when
only the write target is set). Right-click or long press opens the same
panel the channel menu's "Translation…" entry opens: reading target (with
"off"), outgoing target (with "off"), formality, variant. A paused engine
shows in the tooltip.

## Settings, persistence, deploy configuration

- **User settings** (`store-settings.ts`, `thelounge.settings`):
  `translateTo` (default from `navigator.language`), `translateFormality`
  (`auto | formal | casual`), `translateEngines` (`{llm: boolean, cpu: boolean}`). Settings → Translation
  holds them and the model manager: every known model with size, cached or
  not, download with progress, delete; below the GPU tier the LLM row shows
  the probe's reason.
- **Per-channel state** (`helpers/translateStore.ts`, `thelounge.translate`,
  keyed by network uuid then channel name): `{read, write, variant, formality}` plus `terms: [source, target][]` capped at `TERM_CAP` (300),
  oldest evicted. Applied on join, dropped when the channel leaves the saved
  network's list. Tests swap storage via `useStorageBackend`.
- **`config.json`** (`branding.ts` `translation` block, all optional):
  `enabled` (default true), `modelBase`, `llm: {model, lib}`, `cpu: {nllb, opus: Record<pair, model>}`, `routes: RouteTable` (merged over the
  default), `glossary: [source, target][]` (seeded into every channel's term
  memory). Documented in `docs/resources/branding.md`
  § Translation with the cross-origin isolation headers. (`defaultTarget`
  was dropped when the reading language unified with the interface's:
  `translation.md` § The language selections unify.)
- **Caches.** Weights in Cache Storage under the two libraries' own keys;
  `service-worker.js` never intercepts those requests, so a shell update
  cannot evict a model. The detector profiles and the worker bundle are
  ordinary webpack chunks the shell cache handles.
- **Native shells.** Nothing extra; the probe reports what the platform's
  web view gives.

## Lifecycle, memory, errors

- Ceiling: one GPU model plus two CPU models.
- Idle: a GPU model unloads after 3 minutes with no request and a CPU
  model after 5 (`GPU_IDLE_UNLOAD_MS`, `CPU_IDLE_UNLOAD_MS`); a tier
  switched off in Settings unloads at once; everything unloads at once when
  no channel has reading or writing on, nothing is queued, no composer strip
  is open and nothing is in flight; and on `pagehide`. The last model going
  terminates the worker (see the deviation list, 2026-09-13).
- WebGPU `device lost`: reload the model once; a second loss marks `llm`
  down for the session.
- A failed request marks the entry `failed` with a "couldn't translate"
  label that retries on click. Three consecutive failures on one engine
  pause its queue and surface in the globe's tooltip; the queue resumes on
  the next successful load or on the user's retry.
- The queue and any in-flight request are cancelled when the channel's
  switch turns off or the network disconnects.

## Testing and evaluation

- **Mocha, Vue-free** (`test/translate/`): `detect.ts` against a labelled
  sample per language; `queue.ts` priorities, batching and drops with fake
  timers; `router.ts` resolution, tier gating and down-marking; `prompt.ts`
  output for each context shape (reply target, glossary, term memory,
  multiline, budget trimming) and the batched-lines parser with its
  mismatch fallback; `spans.ts` protect/restore round trips; term memory
  eviction; `translateStore.ts` persistence through `useStorageBackend`;
  the worker protocol with a fake `postMessage` pair. A `FakeEngine` that
  yields scripted chunks stands in for both engines. New test files follow
  the `socket.dispatch.isSinonProxy` spy convention.
- **Browser** (`tools/scenarios/`, on the fake engine injected through a
  `?fakeTranslate` query the dev build honours): `translate-reading.mjs`
  (switch on, burst, streaming line, chip menu, scroll drop, failure label)
  and `translate-composer.mjs` (strip, check, edit invalidation, escape,
  error path), both also `--mobile`.
- **Quality** (`tools/translate-eval.mjs`): runs the real engines in headless
  Chromium over a FLORES-200 sample and a small IRC-style set kept in
  `tools/translate-eval/`, reports chrF per pair per engine, and writes the
  table into `docs/resources/translation.md`. The router's default table is
  derived from that table, so "the CPU engine is preferred for some
  languages" is a measured decision that can be rerun when a model changes.

## Documentation to update

- `docs/resources/translation.md` (new): engines, router, the evaluation
  table, prompt shape, how to mirror the weights.
- `docs/resources/branding.md` § Translation: the `config.json` block and
  the isolation headers.
- `CLAUDE.md`: a "Translation" paragraph under the client architecture.
- `CONTEXT.md`: the vocabulary (switch, chip, strip, term memory, router,
  tier).
- `docs/projects/initial_conversion.md` is untouched; this is not part of
  the conversion.

## Delivery order

One implementation plan in four phases, each leaving the branch green and
the app usable without the next:

1. **Engine layer**: `capability.ts`, `engine.ts`, the worker and its
   protocol, the two engines, `router.ts` with a provisional default table,
   `spans.ts`, the `FakeEngine`, and Settings → Translation with the model
   manager. Verifiable from Settings alone: download a model, see it cached.
   Plan: docs/superpowers/plans/2026-09-11-client-translation-1-engine-layer.md
   (gitignored, local).
2. **Reading**: `detect.ts`, `queue.ts`, `prompt.ts`, the store map, the
   header switch, `Message.vue`, the per-channel store, `translate-reading.mjs`.
3. **Composer**: the strip, the check, the gate, the send path,
   `translate-composer.mjs`.
4. **Evaluation**: `tools/translate-eval.mjs`, `docs/resources/translation.md`,
   and the default route table rewritten from its numbers.

## Deferred

- Draft-and-refine: the seq2seq engine drafts, the LLM refines with context.
- A "wrong?" action on the chip that retranslates with the other engine and
  logs the case locally for the evaluation set.
- Persisting translations across reloads.
