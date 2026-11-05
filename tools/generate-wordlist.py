#!/usr/bin/env python3
"""Generate client/js/translate/wordlist.json — the frequency lookup table
that places a short line (one to three words) the function-word classifier
could not place (client/js/translate/wordlookup.ts). Generation-time only;
committed output; rerun only when the language list in
client/js/i18n/targets.ts changes.

The tag list and the source ladder per tag (wordfreq "best" → stopwordsiso →
a hand-curated set) are tools/wordsources.py, shared with
tools/generate-stopwords.py. A tag whose words did not come from a wordfreq
"best" list gets whatever the stopword source gives — a few dozen function
words rather than a frequency-ordered WORDS_PER_LANG — and is listed under
"partial", so a reader of the table knows its ranks are not comparable.

Unlike the stopword tables, nothing is dropped for being common across
languages: every word keeps its rank, and the lookup's 1/rank scoring is what
handles a word many languages share.

Shape:

    {"words": {"<word>": [["<tag>", rank], …]},  # rank 1 = most frequent
     "langs": ["<tag>", …],
     "partial": ["<tag>", …]}

wordfreq and stopwordsiso are not project dependencies — run from a venv:

    python3 -m venv tmp/venv-words
    tmp/venv-words/bin/pip install wordfreq stopwordsiso
    tmp/venv-words/bin/python tools/generate-wordlist.py

`--check` regenerates in memory and fails when the committed JSON differs,
byte for byte (the test the committed table is still what the sources say).
"""
import json
import sys

from wordsources import ROOT, source_words, target_tags

# Frequency-ordered words kept per language. 800, not the spec's 600,
# because the report this table was built for is the word "test": it is rank
# 667 in wordfreq's English list (645 once digits and single characters are
# dropped), so a 600-word table does not carry it at all. At 800 it is
# English and nothing else; the next language to list it is Italian at rank
# ~1165, so a cap of 1200 would make it a three-way tie the lookup's 3x lead
# rule leaves unplaced. 800 costs ~390 KB against 600's ~290 KB.
WORDS_PER_LANG = 800
MIN_TABLE = 10        # a language under this many words is a hard error

OUT = ROOT / "client/js/translate/wordlist.json"


def usable(word: str) -> bool:
    """Words with digits, apostrophe-initial list artifacts ("'ll") and
    single characters carry no signal, like the stopword generator's."""
    return (
        len(word) > 1
        and word.isprintable()
        and not word.startswith("'")
        and not any(c.isdigit() for c in word)
    )


def build() -> dict:
    from wordfreq import available_languages

    wf = set(available_languages("best"))
    tags = target_tags()
    words: dict[str, list[list]] = {}
    langs: list[str] = []
    partial: list[str] = []
    nosource: list[str] = []
    thin: list[tuple[str, int]] = []

    for tag in tags:
        raw, source = source_words(tag, WORDS_PER_LANG * 2, wf)
        if source is None:
            nosource.append(tag)
            continue

        seen: set[str] = set()
        kept: list[str] = []
        for word in raw:
            word = word.strip().lower()
            if usable(word) and word not in seen:
                seen.add(word)
                kept.append(word)
            if len(kept) >= WORDS_PER_LANG:
                break

        if len(kept) < MIN_TABLE:
            thin.append((tag, len(kept)))
            continue

        langs.append(tag)
        if source != "wordfreq":
            partial.append(tag)
        for rank, word in enumerate(kept, start=1):
            words.setdefault(word, []).append([tag, rank])

    if nosource:
        sys.exit(f"no source for target tag(s): {', '.join(sorted(nosource))}")
    if thin:
        listing = ", ".join(f"{t} ({n})" for t, n in thin)
        sys.exit(f"languages under {MIN_TABLE} words: {listing}")

    return {"words": words, "langs": langs, "partial": partial}


def serialize(table: dict) -> str:
    return json.dumps(table, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def main() -> None:
    text = serialize(build())

    if "--check" in sys.argv[1:]:
        if not OUT.exists():
            sys.exit(f"{OUT} is missing")
        if OUT.read_text(encoding="utf-8") != text:
            sys.exit(f"{OUT} differs from what the sources generate — rerun the generator")
        print(f"{OUT} is up to date ({len(text.encode('utf-8'))} bytes)")
        return

    OUT.write_text(text, encoding="utf-8")
    table = json.loads(text)
    print(
        f"wrote {OUT} ({OUT.stat().st_size} bytes, {len(table['words'])} words, "
        f"{len(table['langs'])} languages, {len(table['partial'])} partial)"
    )


if __name__ == "__main__":
    main()
