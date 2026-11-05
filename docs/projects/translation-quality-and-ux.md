# Translation quality and UX — spec

**Status:** implemented, 2026-09-17 (decisions recorded in §2)
**Companion:** `docs/projects/client-translation.md` (the feature's design doc — this spec
amends its detection, eligibility and failure-presentation sections)

## 1. Problem

Five reported defects share one root, plus two independent items:

- **Short-line detection is garbage.** franc's trigram model on chat-length text
  misplaces confidently: measured with the app's own language set,
  "I just woke up again." → Dutch (1.0), "good morning" → Swedish (1.0),
  "helo their friend" → Scots. A misdetection routes the line to the engine with a
  wrong source; the model hands the line back unchanged; the judgment layer reports
  `UNCHANGED` / `ANSWERED`; the row shows raw English prose
  ("couldn't translate came back unchanged").
- **One- and two-word lines never translate at all** — `eligibility.ts`
  `MIN_WORDS = 3` drops them before detection.
- **The failure presentation is raw English prose** for every judged failure
  (i18n convention violation), and the skipped line's `?` chip is styled
  differently from the `lang → lang` chip.
- **The build does not track the language list**: a tag added to
  `translation-languages.txt` gets no `.po` until someone remembers `scaffold.ts`
  (whose `--force` wiped completed fills once already); a removed tag's `.po`
  keeps compiling forever.
- **The translation icon is a globe**, which reads as "region/website", not
  "translate".

## 2. Decisions (user, 2026-09-17)

1. **No word floor**: one word translates; stripped/symbol-only lines still don't queue.
2. **Only `unchanged` gets the compact treatment.** Production shows an icon alone;
   dev builds additionally surface the reason. Other judged failures keep the
   (translated) prose row.
3. The compact chip is framed **"Not translated"** — not a failure; it may simply
   not need translating. Icon, not a word.
4. Removed tags **archive to `client/locales/attic/`**.
5. Classifier data: **generated function-word tables for all 46 languages**
   (option B), vendored into the repo with the generation script.
6. **`fa-language` (`文A`) becomes the translation mark**; the globe keeps the
   language-setting role (the sidebar's dev locale selector).

## 3. Design

### 3.1 Function-word classifier (detection for chat-length text)

New data + module, wired into `detect.ts`:

- **`tools/generate-stopwords.py`** (generation-time only, rerunnable):
  - Primary source: **`wordfreq`** (pip, dev-only) — per-language frequency-ordered
    lists; take the head of the top function words. Frequency order matters: the
    top of a language's list is its most distinctive glue.
  - Fallback for languages wordfreq lacks (eu, ga, cy, tl/fil, …): **`stopwords-iso`**.
  - Cross-language noise filter: drop any word appearing in ≥4 languages' lists
    (`de`, `la`, `han`… — shared tokens carry no signal).
  - Output: **`client/js/translate/stopwords.json`** — `{<tag>: string[]}`, capped
    (~60 per language), lowercase, committed. Target ≤ 20 KB.
- **`client/js/translate/chatdetect.ts`** (Vue-free, mocha-testable):
  `chatDetect(text, only: string[]): {lang: string | null, strength: number}` —
  tokenize on non-letters, count per-language function-word hits (exact match,
  lowercased), return the best language when its lead is decisive (best ≥ 2 hits
  and strictly ahead, or 1 distinctive hit on a 1–2 word line); `null` otherwise.
  Misspelling-tolerant in practice: "helo **their** friend" still hits "their".
- **Integration** (`detect.ts`): `detectLanguage` runs `chatDetect` first on every
  line. A decisive classifier verdict wins over franc outright; otherwise the
  existing pipeline runs unchanged (franc → gap/prior/declared → `detectionSkip`).
  The verdict feeds the prior as before. `detectionSkip`'s semantics do not change:
  "I just woke up again." now lands as `same` with the chip naming English, where
  today it translates en→en and fails as unchanged.

### 3.2 Eligibility

`MIN_WORDS` 3 → 1 (constant + tests + doc comment). `plainTextOf` already strips
URLs, code, emoji, shortcodes and bare nick mentions, so a 1-word line is a real
word; "lol" resolves as English (`same`, chip names it) instead of erroring.

### 3.3 The "Not translated" chip (`unchanged` presentation)

- Store shape unchanged: a judged `UNCHANGED` stays `{status: "failed", error}`.
  The **view** interprets: `TranslationLine.vue` renders an `unchanged` failed
  entry as the compact chip instead of the prose row.
- Chip: **`fa-equals`** glyph + `title`/`aria-label` **"Not translated"** (t() key),
  same interactive menu as the skipped chip (Retranslate / Retranslate from… /
  Retranslate from ⌖ / Show original only — no Copy: there is no translation).
- Dev builds append the reason ("came back unchanged") after the icon; production
  shows the icon alone. Dev/prod via the repo's existing build flag pattern.
- Other judged failures (`ANSWERED`, `NARRATION`, `DEGENERATE`) and engine errors
  keep the failed prose row — but every string goes through t(): the "couldn't
  translate" frame becomes a key, and the known reason constants map to keys
  (`translate.reason.answered`, …). Unknown engine errors keep their verbatim text
  in the title attribute (server/technical text is not translated).

### 3.4 Chip style unification

`.msg-translation-skipped-tag` adopts `.msg-translation-chip`'s accent styling
(same border/ink/hover from `--chat-accent`/`--link-color`); the unchanged chip
reuses it. The muted look disappears. One shared rule in `style.css`; theme files
touched only if they override these classes today (audit step).

### 3.5 Translation icon split

- **`fa-language`** (`文A`, FA5 `\f1ab`, already bundled) becomes the translation
  mark on: the channel-header toggle (`Chat.vue` `button.translate` — CSS-drawn
  glyph, swap the mask/content), the message action (`MessageActions.vue` 🌐 →
  `fa-language`), and any other translation entry point found by the audit grep.
- The **globe/🌐 keeps the language-setting role** (sidebar's dev locale selector,
  Settings copy that says "the globe in the channel header" gets reworded to match
  the new icon).

### 3.6 `tools/i18n/sync.ts` — the build tracks the language list

- Diff `TARGETS` against top-level `client/locales/*.po`:
  - target without a `.po` → **scaffold it** (headers + plural forms, empty
    msgstr; never touches an existing file);
  - `.po` whose tag is no longer a target → **`git mv` to `client/locales/attic/`**
    (subdirectory; `compile.ts`'s non-recursive `readdirSync` ignores it naturally);
  - log every action.
- Runs inside `i18n:compile` (before compilation) and standalone (`i18n:sync`).
- `scaffold.ts` refactor: extract the per-tag writer into an exported function
  (the fill/sweep side-effect import trap must not repeat).

### 3.7 Tests

- **mocha**: `chatdetect` (real generated table: the measured failures flip to
  correct verdicts; misspellings; every table non-empty and deduplicated),
  `eligibility` (floor), `outgoing`/`queue` unchanged, `sync`'s extracted
  scaffold function (new tag scaffolds, existing file untouched).
- **Browser scenario** (`tools/scenarios/`, the suite has no DOM): extend
  `translate-reading.mjs` — the unchanged chip renders with icon + tooltip, the
  skipped chip carries the accent style, the header toggle shows `文A`.

### 3.8 Out of scope

The fill/residue pipeline, route tables, the TranslationPanel's layout, and the
other judged failures' retry semantics (they keep today's bare-retry flow).
