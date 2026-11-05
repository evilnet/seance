#!/usr/bin/env python3
"""Generate client/js/translate/stopwords.json — the function-word tables the
short-line language classifier (client/js/translate/chatdetect.ts) matches
against. Generation-time only; committed output; rerun only when the language
list in client/js/i18n/targets.ts changes.

The output is keyed by the tags parsed from targets.ts (en is a legitimate
source candidate, qqx does not exist there). The tag list and the source
ladder per tag (wordfreq "best" → stopwordsiso → a hand-curated set) live in
tools/wordsources.py, shared with tools/generate-wordlist.py.

Afterwards a word found in >= NOISE_TABLES tables is dropped everywhere: it
carries no cross-language signal ("in", "la"). Every emitted table must hold
at least MIN_TABLE words; anything thinner is a hard error, not written.

wordfreq and stopwordsiso are not project dependencies — run from a venv:

    python3 -m venv tmp/venv-words
    tmp/venv-words/bin/pip install wordfreq stopwordsiso
    tmp/venv-words/bin/python tools/generate-stopwords.py
"""
import json
import sys

from wordsources import ROOT, clean, source_words, target_tags

CAP = 60          # max words per table
NOISE_TABLES = 4  # a word in >= this many tables is dropped everywhere
MIN_TABLE = 10    # a table under this many words after noise-filtering fails

OUT = ROOT / "client/js/translate/stopwords.json"


def main() -> None:
    from wordfreq import available_languages

    wf = set(available_languages("best"))
    tags = target_tags()
    tables: dict[str, list[str]] = {}
    nosource: list[str] = []
    for tag in tags:
        raw, source = source_words(tag, CAP * 2, wf)
        if source is None:
            nosource.append(tag)
            continue
        tables[tag] = clean(raw, CAP)
    if nosource:
        sys.exit(f"no source for target tag(s): {', '.join(sorted(nosource))}")

    # Cross-language noise: a word in >=4 tables carries no signal ("in", "la").
    counts: dict[str, int] = {}
    for words in tables.values():
        for w in set(words):
            counts[w] = counts.get(w, 0) + 1
    noisy = {w for w, n in counts.items() if n >= NOISE_TABLES}
    for tag, words in tables.items():
        tables[tag] = [w for w in words if w not in noisy]

    under = sorted((t, len(w)) for t, w in tables.items() if len(w) < MIN_TABLE)
    if under:
        listing = ", ".join(f"{t} ({n})" for t, n in under)
        sys.exit(f"tables under {MIN_TABLE} words after noise filtering: {listing}")

    OUT.write_text(json.dumps(tables, ensure_ascii=False, sort_keys=True, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes, {len(tables)} languages)")


if __name__ == "__main__":
    main()
