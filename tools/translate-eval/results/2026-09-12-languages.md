NLLB two-sentence line across 27 languages: whole 35%, split 51%. The nine
languages measured second (fi ca hu nb th cs ar id pl, `npx tsx
tmp/cpu-roundtrip.ts --langs fi,ca,hu,nb,th,cs,ar,id,pl`, q8 with basic graph
optimisation, as the app loads it): whole 27%, split 52%.

Each percentage is the content words found over the content words in the
English lines, summed over the cases: Qwen 3-9 chat shapes on the shipped
prompt; NLLB and OPUS a question, a casual line and the two-sentence line
(NLLB split into sentences, as the engine now sends it). s/line is the
question and casual round trips' time over their four translations, on
whatever else the runner's 56 cores were doing (the second batch ran on a
quieter machine, which is why it is faster). "Routed today" is the table
before these measurements.

| Language | Routed today | Qwen | NLLB (split) | OPUS | s/line NLLB | Best measured |
| --- | --- | --- | --- | --- | --- | --- |
| de | Qwen, then OPUS | 66% | 51% | 80% | 4.6 | OPUS |
| fr | Qwen, then OPUS | 75% | — | 63% | — | Qwen |
| es | Qwen, then OPUS | 79% | — | 60% | — | Qwen |
| it | Qwen, then OPUS | 72% | — | 63% | — | Qwen |
| pt | Qwen, then NLLB | 80% | — | — | — | Qwen |
| nl | Qwen, then OPUS | 77% | — | 88% | — | OPUS |
| sv | Qwen, then NLLB | 62% | — | — | — | Qwen |
| da | Qwen, then NLLB | 72% | — | — | — | Qwen |
| nb | Qwen, then NLLB | 54% | 72% | — | 3.4 | NLLB |
| fi | Qwen, then NLLB | 35% | 56% | — | 3.3 | NLLB |
| pl | Qwen, then NLLB | 56% | 56% | — | 3.0 | tie |
| cs | Qwen, then NLLB | 53% | 61% | — | 3.0 | NLLB (tie band) |
| sk | NLLB, then Qwen | 56% | 51% | — | 4.5 | Qwen |
| hu | Qwen, then NLLB | 52% | 44% | — | 2.7 | Qwen (tie band) |
| ro | Qwen, then NLLB | 62% | — | — | — | Qwen |
| bg | NLLB, then Qwen | 53% | 68% | — | 5.2 | NLLB |
| ru | Qwen, then OPUS | 68% | — | 77% | — | OPUS |
| uk | Qwen, then NLLB | 64% | — | — | — | Qwen |
| sr | NLLB, then Qwen | 28% | 71% | — | 5.6 | NLLB |
| hr | NLLB, then Qwen | 55% | 77% | — | 5.4 | NLLB |
| sl | NLLB, then Qwen | 36% | 68% | — | 5.5 | NLLB |
| el | Qwen, then NLLB | 8% | 77% | — | 5.5 | NLLB |
| tr | Qwen, then NLLB | 58% | — | — | — | Qwen |
| ar | Qwen, then NLLB | 55% | 67% | — | 3.1 | NLLB |
| he | NLLB, then Qwen | 31% | 71% | — | 4.5 | NLLB |
| fa | NLLB, then Qwen | 45% | 62% | — | 5.2 | NLLB |
| hi | Qwen, then NLLB | 50% | 49% | — | 4.4 | Qwen |
| bn | NLLB, then Qwen | 23% | 54% | — | 4.9 | NLLB |
| ta | NLLB, then Qwen | 2% | 68% | — | 4.8 | NLLB |
| th | Qwen, then NLLB | 50% | 56% | — | 2.9 | NLLB (tie band) |
| vi | Qwen, then NLLB | 77% | — | — | — | Qwen |
| id | Qwen, then NLLB | 54% | 78% | — | 2.7 | NLLB |
| ms | NLLB, then Qwen | 67% | 66% | — | 3.9 | Qwen |
| zh | Qwen, then NLLB | 70% | 65% | — | 4.9 | Qwen |
| ja | Qwen, then NLLB | 61% | 45% | — | 4.6 | Qwen |
| ko | Qwen, then NLLB | 58% | — | — | — | Qwen |
| et | NLLB, then Qwen | 13% | 49% | — | 5.4 | NLLB |
| lv | NLLB, then Qwen | 9% | 43% | — | 5.1 | NLLB |
| lt | NLLB, then Qwen | 9% | 54% | — | 6.1 | NLLB |
| ca | Qwen, then NLLB | 34% | 61% | — | 3.1 | NLLB |
| eu | NLLB, then Qwen | 11% | 57% | — | 5.9 | NLLB |
| gl | NLLB, then Qwen | 83% | 77% | — | 5.7 | Qwen |
| ga | NLLB, then Qwen | 33% | 56% | — | 5.7 | NLLB |
| cy | NLLB, then Qwen | 0% | 88% | — | 5.6 | NLLB |
| is | NLLB, then Qwen | 5% | 43% | — | 6.7 | NLLB |
| sw | NLLB, then Qwen | 33% | 62% | — | 4.6 | NLLB |
| af | NLLB, then Qwen | 61% | 88% | — | 5.7 | NLLB |
| tl | NLLB, then Qwen | 47% | 89% | — | 5.4 | NLLB |
| ur | NLLB, then Qwen | 33% | 66% | — | 4.4 | NLLB |

## Where the table places each language

`client/js/translate/routes.default.ts`, reading differences under ~10
points as ties. Each placement applies to the language as the source and as
the target.

- **NLLB first, Qwen as the fallback class** (NLLB ahead by more than the tie
  band): sr, hr, sl, bg, el, he, fa, bn, ta, et, lv, lt, eu, ga, cy, is, sw,
  af, tl, ur, and from the second batch fi (+21), ca (+27), nb (+18) and id
  (+24).
- **Qwen and NLLB in one class** (a downloaded NLLB preferred, Qwen
  otherwise): sk, ms, gl, hi, and from the second batch hu (-8), th (+6), cs
  (+8), pl (0).
- **Qwen and OPUS-MT in one class**: de, nl, ru. **Qwen, then OPUS-MT**: fr,
  es, it.
- **Qwen first, NLLB next**: pt, sv, da, ro, uk, tr, vi, zh, ja, ko, and any
  language not measured — and ar, though NLLB measured 12 points ahead: Qwen
  reads the channel's context and the seq2seq models do not, and a short-line
  round trip flatters benchmark-trained models in chat (the user's call,
  2026-09-13).

**Limited** (`LIMITED_LANGUAGES`, the best engine under 55%): is 43, lv 43,
et 49, hi 50, hu 52, lt 54, bn 54.
