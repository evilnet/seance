# Translation Quality and UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix short-line language detection with a function-word classifier, drop the word floor, present `unchanged` as a "Not translated" chip instead of error prose, unify chip styling, split the translate/language icons, and make the i18n build track the language list.

**Architecture:** A generated stopword table (`stopwords.json`) feeds a new Vue-free classifier (`chatdetect.ts`) that votes before franc inside `detect.ts`; eligibility drops to 1 word; `TranslationLine.vue` interprets a failed entry with the `UNCHANGED` error as a compact icon chip (store shape untouched); CSS unifies the chip styles; FA5's `fa-language` glyph replaces the globe on translation surfaces; `tools/i18n/sync.ts` scaffolds new tags and archives removed ones inside `i18n:compile`.

**Tech Stack:** TypeScript (strict), Vue 3 SFCs, mocha+chai (`test/translate/`), Python 3.11 generation script (`wordfreq`, `stopwordsiso` — generation-time only), FontAwesome Free 5.15.4 (already bundled).

**Spec:** `docs/projects/translation-quality-and-ux.md` (committed) — executors read both.

## Global Constraints

- `client/` compiles with `strict: true`; new code carries explicit types; no Node built-ins in `client/`.
- Every UI string goes through `t()`; register keys with `npx tsx tools/i18n/add.ts`; **`client/locales/messages.pot` is the only source of English copy**. Run `npx tsx tools/i18n/merge.ts` after pot changes.
- Logical CSS properties only (`margin-inline-start`, not `left`); sizes in `rem`/`em`.
- Mocha suite has no DOM: component work is verified by `tools/scenarios/` browser checks.
- After `client/` changes, `corepack yarn build` so `public/` is fresh.
- Tests mirror source: `test/translate/<name>.ts` for `client/js/translate/<name>.ts`.
- Do NOT run `tools/i18n/scaffold.ts --force` (it wipes filled `.po` files).
- The background i18n fills (`fill.ts` processes) may be running; do not kill them; expect `client/locales/*.po` mtimes to move.

---

### Task 1: Generate the stopword table

**Files:**

- Create: `tools/generate-stopwords.py`
- Create: `client/js/translate/stopwords.json` (generated, committed)

**Interfaces:**

- Produces: `client/js/translate/stopwords.json` — `{[tag: string]: string[]}`, exactly the 46 tags of `client/js/i18n/targets.ts` minus `en` (45 reading-language tags; `en` still included as a source candidate — include `en`, exclude `qqx`), ≤60 words each, lowercase, deduplicated. Task 2 consumes it.

- [ ] **Step 1: Write the generator**

```python
#!/usr/bin/env python3
"""Generate client/js/translate/stopwords.json — the function-word tables the
short-line language classifier (client/js/translate/chatdetect.ts) matches
against. Generation-time only: wordfreq for languages it genuinely covers
(verified via available_languages — wordfreq silently "nearest-matches" codes
it lacks, which would poison tables), stopwords-iso for the rest. Committed
output; rerun only when the language list changes."""
import json, sys
from pathlib import Path

# wordfreq must list the code in available_languages; hr/sr are excluded even
# though a lookup "works" (it maps to Serbo-Croatian 'sh', identical tables).
WORDFREQ = {"en","de","fr","es","pt","it","nl","ru","pl","tr","sv","da","nb","fi",
            "cs","el","he","hu","ro","vi","uk","bg","sk","sl","id","ms","ja","ko",
            "zh","ar","fa","hi","bn","ta","ur","ca","lt","lv","tl"}
ISO_FALLBACK = {"af","cy","eu","ga","gl","hr","sr","sw","te","et","th"}
TAG_TO_CODE = {"tl": "tl", "nb": "nb"}  # wordfreq knows 'tl' via fil, 'nb' directly

CAP = 60
OUT = Path(__file__).resolve().parent.parent / "client/js/translate/stopwords.json"

def main() -> None:
    from wordfreq import available_languages, top_n_list
    import stopwordsiso as stopwords

    real_wf = {c.replace("fil", "tl", 1) if c == "fil" else c
               for c in available_languages("largest")}
    tables: dict[str, list[str]] = {}
    for tag in sorted(WORDFREQ | ISO_FALLBACK):
        if tag in WORDFREQ and TAG_TO_CODE.get(tag, tag) in real_wf:
            words = top_n_list(TAG_TO_CODE.get(tag, tag), CAP * 2)
        else:
            words = sorted(stopwords.stopwords(tag))
        seen: set[str] = set()
        clean: list[str] = []
        for w in words:
            w = w.strip().lower()
            if w and w not in seen and w.isprintable():
                seen.add(w)
                clean.append(w)
            if len(clean) >= CAP:
                break
        tables[tag] = clean
        if not clean:
            sys.exit(f"empty table for {tag}")

    # Cross-language noise: a word in >=4 tables carries no signal ("in", "la").
    counts: dict[str, int] = {}
    for words in tables.values():
        for w in set(words):
            counts[w] = counts.get(w, 0) + 1
    noisy = {w for w, n in counts.items() if n >= 4}
    for tag, words in tables.items():
        tables[tag] = [w for w in words if w not in noisy]

    OUT.write_text(json.dumps(tables, ensure_ascii=False, sort_keys=True, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes, {len(tables)} languages)")

if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Install generation deps and run**

```bash
python3 -m venv /seance/tmp/venv-words 2>/dev/null || true
/seance/tmp/venv-words/bin/pip install -q wordfreq stopwordsiso
/seance/tmp/venv-words/bin/python tools/generate-stopwords.py
```

Expected: `wrote .../stopwords.json (~N bytes, 45 languages)` and file size ≤ 25 KB. Spot-check: `python3 -c "import json; t=json.load(open('client/js/translate/stopwords.json')); print(t['en'][:8]); print('de' in t, 'ja' in t)"` — `en` head contains `the`/`i`; `de` and `ja` present.

- [ ] **Step 3: Commit**

```bash
git add tools/generate-stopwords.py client/js/translate/stopwords.json
git commit -m "translate: generated function-word tables for short-line detection"
```

---

### Task 2: The classifier (`chatdetect.ts`) and detection integration

**Files:**

- Create: `client/js/translate/chatdetect.ts`
- Modify: `client/js/translate/detect.ts`
- Test: `test/translate/chatdetect.ts` (new), `test/translate/detect.ts` (extend)

**Interfaces:**

- Consumes: `client/js/translate/stopwords.json` (Task 1).
- Produces: `chatDetect(text: string, only: readonly string[]): ChatVerdict` where `ChatVerdict = {lang: string | null; strength: number}`. `detect.ts` imports it; nothing else.

- [ ] **Step 1: Write the failing tests** (`test/translate/chatdetect.ts`)

```ts
import {expect} from "chai";
import {chatDetect} from "../../client/js/translate/chatdetect";

const TABLE_LANGS = Object.keys(require("../../client/js/translate/stopwords.json"));

describe("translate/chatdetect", () => {
  describe("table", () => {
    it("covers the supported languages with clean tables", () => {
      expect(TABLE_LANGS.length).to.be.at.least(45);
      for (const words of TABLE_LANGS.map(
        (t) => require("../../client/js/translate/stopwords.json")[t]
      )) {
        expect(words.length).to.be.within(10, 60);
        expect(new Set(words).size).to.equal(words.length);
      }
    });
  });

  it("places the measured chat lines franc gets wrong", () => {
    expect(chatDetect("I just woke up again.", ["en", "de", "nl"]).lang).to.equal("en");
    expect(chatDetect("good morning", ["en", "sv", "da"]).lang).to.equal("en");
    expect(chatDetect("helo their friend", ["en", "de"]).lang).to.equal("en");
    expect(chatDetect("Guten Morgen, wie geht es dir?", ["en", "de"]).lang).to.equal("de");
    expect(chatDetect("lol", ["en", "de"]).lang).to.equal("en");
  });

  it("is substring-based for scripts without spaces", () => {
    expect(chatDetect("おはよう、まだ眠い。", ["ja", "en"]).lang).to.equal("ja");
    expect(chatDetect("我醒了。", ["zh", "en"]).lang).to.equal("zh");
  });

  it("refuses to guess on noise", () => {
    expect(chatDetect("xyzzy", ["en", "de"]).lang).to.equal(null);
    expect(chatDetect("...", ["en", "de"]).lang).to.equal(null);
  });

  it("restricts its verdict to the allowed candidates", () => {
    expect(chatDetect("I just woke up again.", ["de", "nl"]).lang).to.not.equal("en");
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx cross-env NODE_ENV=test TS_NODE_PROJECT='./test/tsconfig.json' npx mocha --config=test/.mocharc.yml test/translate/chatdetect.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** `client/js/translate/chatdetect.ts`

```ts
// Function-word classification for chat-length text (spec
// docs/projects/translation-quality-and-ux.md §3.1). franc's trigram model
// misplaces short lines confidently ("I just woke up again." → Dutch 1.0);
// the function words of a language are near-perfect on chat text and
// misspelling-tolerant. Vue-free; the table is generated
// (tools/generate-stopwords.py) and committed.

import table from "./stopwords.json";

/** Languages whose words run without spaces: match by containment. */
const NO_SPACE = new Set(["ja", "zh", "ko"]);

export interface ChatVerdict {
  lang: string | null;
  /** Function-word hits behind the verdict (0 when null). */
  strength: number;
}

const TABLES: Record<string, Set<string>> = Object.fromEntries(
  Object.entries(table).map(([tag, words]) => [tag, new Set(words)])
);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
}

export function chatDetect(text: string, only: readonly string[]): ChatVerdict {
  const allowed = only.filter((lang) => TABLES[lang]);
  const lower = text.toLowerCase();
  const words = tokens(text);
  const scores = new Map<string, number>();

  for (const lang of allowed) {
    const table_ = TABLES[lang];
    let hits = 0;

    if (NO_SPACE.has(lang)) {
      for (const word of table_) {
        if (word.length >= 1 && lower.includes(word)) {
          hits += 1;
        }
      }
    } else {
      for (const word of words) {
        if (table_.has(word)) {
          hits += 1;
        }
      }
    }

    if (hits > 0) {
      scores.set(lang, hits);
    }
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const best = ranked[0];
  const second = ranked[1];

  if (!best) {
    return {lang: null, strength: 0};
  }

  // Decisive: a clear multi-hit lead, or one hit on a line too short for
  // two ("lol" is English; a stray shared word on a long line is not).
  const decisive =
    best[1] >= 2 && (!second || best[1] - second[1] >= 1)
      ? true
      : words.length <= 2 && best[1] >= 1;

  return decisive ? {lang: best[0], strength: best[1]} : {lang: null, strength: best[1]};
}
```

- [ ] **Step 4: Run tests to green** (same command as Step 2). If `Guten Morgen, wie geht es dir?` misplaces, check the `de` table head (top_n_list("de") head is `der die und in den von zu das mit sich des auf...` — hits: der/die/und/es = decisive).

- [ ] **Step 5: Integrate into `detect.ts`.** In `detect.ts`, import `chatDetect` and apply it in `detectLanguage`:

```ts
// In detectLanguage, BEFORE the `text.length < DETECT_MIN_LENGTH` branch:
const chat = chatDetect(
  text,
  declaredLanguages(declared).length > 0
    ? declaredLanguages(declared)
    : Object.keys(ISO1_OF)
        .map((c) => iso3ToIso1(c) ?? "")
        .filter(Boolean)
);
```

Simpler contract (use this): `chatDetect(text, Object.keys(ISO1_OF).map(iso3ToIso1).filter(Boolean))` — all supported languages; the declared/prior machinery below still shapes the verdict. Then:

```ts
if (chat.lang !== null && chat.strength >= 2) {
  return {lang: chat.lang, confidence: round(chat.strength / 10), candidates: [chat.lang]};
}
```

placed **before** the length check so 1-word lines classify ("lol" → en). When `chat.strength === 1` (weak), fall through to the existing flow, and inside the `text.length < DETECT_MIN_LENGTH` branch use `chat.lang` when set instead of `null`:

```ts
if (text.length < DETECT_MIN_LENGTH) {
  const only = declaredLanguages(declared).filter((code) => code !== options.exclude);
  if (only.length === 1) {
    return {lang: only[0], confidence: 0, candidates: only};
  }
  return {lang: chat.lang, confidence: 0, candidates: chat.lang ? [chat.lang] : []};
}
```

For the main franc path, keep `detectWith` unchanged — a decisive chat verdict already returned above.

- [ ] **Step 6: Extend `test/translate/detect.ts`** — a `detectLanguage`-level test: `"I just woke up again."` with empty declared list returns `lang: "en"` (use the real detector: `setDetector(null)`; the franc chunk loads in mocha — confirm `franc` is importable in the test env; if the test file already stubs the detector, add an integration `it` that calls `detectLanguage` after `setDetector(null)`).

- [ ] **Step 7: Run the full translate tests** — `npx cross-env NODE_ENV=test TS_NODE_PROJECT='./test/tsconfig.json' npx mocha --config=test/.mocharc.yml test/translate/detect.ts test/translate/chatdetect.ts` → PASS.

- [ ] **Step 8: Commit** — `git add client/js/translate/chatdetect.ts client/js/translate/detect.ts test/translate/chatdetect.ts test/translate/detect.ts && git commit -m "translate: function-word classifier decides chat-length detection"`

---

### Task 3: Drop the word floor

**Files:**

- Modify: `client/js/translate/eligibility.ts`
- Modify: `test/translate/eligibility.ts`

**Interfaces:** Consumes nothing new. Produces: `MIN_WORDS === 1`.

- [ ] **Step 1: Update the test** — `test/translate/eligibility.ts` line ~145: `expect(MIN_WORDS).to.equal(1)`; the "under MIN_WORDS does not" test's fixture becomes a text whose `plainTextOf` is empty (e.g. all-emoji) rather than 1–2 words; add: one word ("Hallo") is eligible.

- [ ] **Step 2: Run** → FAIL (constant still 3).

- [ ] **Step 3: Implement** — `eligibility.ts`: `export const MIN_WORDS = 1;` and reword the doc comment: "with enough words" → "any word once URLs, code, emoji, formatting codes and nick mentions are gone".

- [ ] **Step 4: Run to green**, then **Commit** — `git commit -m "translate: read one-word lines (no word floor)"`

---

### Task 4: The "Not translated" chip + t() copy

**Files:**

- Modify: `client/components/TranslationLine.vue`
- Test: `tools/scenarios/translation-chips.mjs` (new; run in Task 6 after the build)

**Interfaces:**

- Consumes: `UNCHANGED` from `client/js/translate/outgoing.ts` (existing export); `devtoolsAvailable` from `client/js/devtools.ts` (existing); store entry shape unchanged (`{status: "failed", error: string}`).
- Produces: i18n keys `translate.notTranslated`, `translate.failed`, `translate.reason.answered`, `translate.reason.narration`, `translate.reason.degenerate`, `translate.reason.generic`, `translate.unchangedReason`.

- [ ] **Step 1: Template** — in `TranslationLine.vue`, inside the `status === 'failed'` branch, branch on unchanged:

```vue
<span v-if="entry.status === 'failed'" class="msg-translation-failed">
	<button
		v-if="entry.error === UNCHANGED"
		type="button"
		class="msg-translation-skipped-tag"
		:title="notTranslatedLabel"
		:aria-label="notTranslatedLabel"
		@click.stop="openMenu"
	>
		<i class="fas fa-equals" aria-hidden="true" />
		<span v-if="devtoolsAvailable" class="msg-translation-reason">{{
			t("translate.unchangedReason")
		}}</span>
	</button>
	<template v-else>
		{{ t("translate.failed") }}
		<span v-if="entry.error" class="msg-translation-reason" :title="entry.error">{{
			shortReason(reasonText)
		}}</span>
		<button
			type="button"
			class="msg-translation-retry"
			:title="t('translate.retry')"
			:aria-label="t('translate.retry')"
			@click.stop="retry"
		/>
	</template>
</span>
```

Script additions: `import {UNCHANGED} from "../js/translate/outgoing";`, `import {devtoolsAvailable} from "../js/devtools";`, `const {t} = useI18n();` (follow the component's existing i18n pattern), `const notTranslatedLabel = computed(() => t("translate.notTranslated"));`, and a `reasonText` computed that maps known constants to keys:

```ts
const REASON_KEYS: Record<string, string> = {
  [ANSWERED]: "translate.reason.answered",
  [NARRATION]: "translate.reason.narration",
  [DEGENERATE]: "translate.reason.degenerate",
};
const reasonText = computed(() => {
  const error = entry.value?.error ?? "";
  return REASON_KEYS[error] ? t(REASON_KEYS[error]) : error;
});
```

The unchanged chip's menu reuses `openMenu` — extend the failed-row branch of `openMenu` so an unchanged entry offers Retranslate / Retranslate from… / Show original only (no Copy). `t("translate.retry")` keys the retry button (was a raw literal).

- [ ] **Step 2: Register the keys** — `npx tsx tools/i18n/add.ts` per key with `#.` context comments ("Shown beside a message whose translation came back as the source text; equals icon." etc.). Keys: `translate.notTranslated` = "Not translated", `translate.failed` = "Couldn't translate", `translate.retry` = "Retry the translation", `translate.unchangedReason` = "the line came back unchanged", `translate.reason.answered` = "answered the question instead of translating it", `translate.reason.narration` = "talked about the request instead of translating", `translate.reason.degenerate` = "the answer was symbol garbage". Then `npx tsx tools/i18n/merge.ts`.

- [ ] **Step 3: Typecheck + existing tests** — `npx tsc --noEmit -p tsconfig.json` and `npx cross-env NODE_ENV=test TS_NODE_PROJECT='./test/tsconfig.json' npx mocha --config=test/.mocharc.yml test/translate/` → PASS.

- [ ] **Step 4: Commit** — `git commit -m "translate: present 'unchanged' as a Not-translated chip; translate the failure copy"`

---

### Task 5: Chip style unification

**Files:**

- Modify: `client/css/style.css` (`.msg-translation-skipped-tag` block ~line 5038)

**Interfaces:** Pure CSS; consumed by `TranslationLine.vue`.

- [ ] **Step 1: Audit themes** — `grep -n 'msg-translation' client/themes/*.css` — if any theme overrides these classes, apply the same change there; expect none.

- [ ] **Step 2: Unify** — make the skipped/unchanged tag share the chip's accent rules:

```css
#chat .msg-translation-skipped-tag {
  padding: 0 0.3em;
  border: 1px solid var(--chat-accent-rule, var(--link-color));
  border-radius: 0.2rem;
  background: transparent;
  color: var(--chat-accent, var(--link-color));
  font: inherit;
  font-size: 0.7em;
  line-height: 1.5;
  letter-spacing: 0.05em;
  vertical-align: 0.1em;
  cursor: pointer;
}
```

(drop `color: var(--body-color-muted)` and `opacity: 0.75`; keep the hover/focus block as-is; update the block's comment to note the shared accent look.)

- [ ] **Step 3: Build + browser check** — `corepack yarn build`, then extend `tools/scenarios/translation-chips.mjs` (Task 4's file): inject a skipped entry and an unchanged failed entry into `store.state.translations` for rendered messages via page evaluate, assert `.msg-translation-skipped-tag` computed border-color equals `.msg-translation-chip`'s, assert the unchanged chip contains `.fa-equals` and its title is the "Not translated" string. Run: `node tools/browser-drive.mjs tools/scenarios/translation-chips.mjs` (dev stack on `https://10.0.0.41:8000` is already serving; use `--insecure`/`CHROME_BIN` per `docs/resources/browser-testing.md`).

- [ ] **Step 4: Commit** — `git commit -m "translate: one accent style for translation chips"`

---

### Task 6: The icon split

**Files:**

- Modify: `client/css/style.css` (line ~567)
- Modify: `client/components/MessageActions.vue` (line ~47)
- Modify: `client/components/Settings/Translation.vue` (copy)

**Interfaces:** None new.

- [ ] **Step 1: Header toggle** — `style.css` line ~567: `#chat button.translate::before { content: "\f1ab"; /* https://fontawesome.com/icons/language?style=solid */ }`.

- [ ] **Step 2: Message action** — `MessageActions.vue`: replace the `🌐` text node inside `.msg-action-translate` with `<i class="fas fa-language" aria-hidden="true" />`.

- [ ] **Step 3: Copy reword** — `Settings/Translation.vue` line ~10 says "the globe in the channel header": change the msgid to name the new icon ("the 文 A button in the channel header" — final wording: "the translate button in the channel header"), run `npx tsx tools/i18n/merge.ts`. Audit `grep -rn 'globe' client/ --include='*.vue'` for any other translation-role copy.

- [ ] **Step 4: Build + scenario** — `corepack yarn build`; in `tools/scenarios/translation-chips.mjs` add: the header toggle's `::before` computed content is `"\f1ab"`, the message action contains `.fa-language`, and the sidebar's dev locale toggle still renders 🌐.

- [ ] **Step 5: Commit** — `git commit -m "translate: fa-language marks the translation surfaces; the globe stays the language setting"`

---

### Task 7: `tools/i18n/sync.ts` — the build tracks the language list

**Files:**

- Create: `tools/i18n/sync.ts`
- Modify: `tools/i18n/scaffold.ts` (extract the per-tag writer)
- Modify: `tools/i18n/compile.ts` (call `runSync()` before reading files)
- Modify: `package.json` (add `"i18n:sync"`)
- Test: `test/translate/i18n-sync.ts` (new)

**Interfaces:**

- Produces: `runSync(localesDir?: string): {scaffolded: string[]; archived: string[]}` (exported, side-effect-free at import time; the CLI runs only under the `import.meta.url` guard). `compile.ts` imports `runSync`.
- Consumes: `TARGETS_SOURCE`/`NAME_TO_TAG` from `./targets`, `parsePo`/`serializePo` from `./po`.

- [ ] **Step 1: Extract the writer** — in `scaffold.ts`, move the body of its per-tag loop into `export function scaffoldTag(tag: string, localesDir: string): boolean` (creates the file only when absent; returns whether it wrote). `scaffold.ts`'s `main()` keeps its flags and calls `scaffoldTag`. No behavioral change: `npx tsx tools/i18n/scaffold.ts` output matches today's.

- [ ] **Step 2: Write sync** (`tools/i18n/sync.ts`) — `runSync(localesDir = "client/locales")`: read targets via `NAME_TO_TAG` (`en` excluded); list top-level `*.po`; scaffold missing tags via `scaffoldTag`; for each `.po` whose tag is not a target, `renameSync` into `<localesDir>/attic/` (mkdir -p attic; if the destination exists, leave the file and warn `sync: attic/<tag>.po already exists — left in place`); log `sync: scaffolded <tag>.po (new target)` / `sync: archived <tag>.po`. CLI guard:

```ts
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runSync();
}
```

- [ ] **Step 3: Hook compile** — in `compile.ts` `main()`, immediately before the `readdirSync` listing: `runSync(localesDir);` (import from `./sync`; the attic subdirectory is invisible to the non-recursive listing).

- [ ] **Step 4: package.json** — `"i18n:sync": "tsx tools/i18n/sync.ts"` beside the other i18n scripts.

- [ ] **Step 5: Test** (`test/translate/i18n-sync.ts`) — in a tmp dir: write a target's `.po` (untouched case), a non-target's `.po` (archived case), run `runSync(tmp)`, assert: the target file exists with unchanged content, the stray file moved to `attic/`, return values list it. Use `fs.mkdtempSync`.

- [ ] **Step 6: Run** — mocha on the new test + `corepack yarn i18n:compile` (should log no actions today) → PASS.

- [ ] **Step 7: Commit** — `git commit -m "i18n: the build scaffolds new targets and archives removed ones"`

---

### Task 8: Docs and the final pass

**Files:**

- Modify: `docs/resources/translation.md`, `docs/resources/i18n.md`, `CLAUDE.md`, `docs/projects/translation-quality-and-ux.md` (status line)

- [ ] **Step 1: Docs** — translation.md: detection section (classifier before franc, the measured failures as the rationale), failure presentation (the "Not translated" chip, icon-only in production), eligibility (no word floor), the 文 A mark. i18n.md: the sync step and attic. CLAUDE.md: the translate bullet's detection/eligibility sentences and the i18n sentence about `scaffold.ts` (add sync).
- [ ] **Step 2: Full gate** — `corepack yarn test` (lint + mocha) and `corepack yarn build`; run `tools/scenarios/translation-chips.mjs`.
- [ ] **Step 3: Commit** — `git commit -m "docs: translation quality and UX changes"`

---

## Self-review notes

- Spec coverage: §3.1→Tasks 1–2, §3.2→Task 3, §3.3→Task 4, §3.4→Task 5, §3.5→Task 6, §3.6→Task 7, §3.7→embedded per task, §3.8 respected.
- Type consistency: `ChatVerdict` used identically in Tasks 2's files; `runSync` signature matches between compile.ts and sync.ts.
- Execution order: Task 1 → 2 → 3 (independent of 2) → 4 → 5 (depends on 4's template) → 6 → 7 → 8. Tasks 3, 6, 7 can run parallel to 1–2; Task 5 after 4.
