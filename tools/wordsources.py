#!/usr/bin/env python3
"""Shared word sources for the two generated translation tables:
tools/generate-stopwords.py (client/js/translate/stopwords.json, the
function-word classifier) and tools/generate-wordlist.py
(client/js/translate/wordlist.json, the short-line frequency lookup).

Both read the same tag list (client/js/i18n/targets.ts) and the same source
ladder per tag, in order:

  - wordfreq top_n_list(tag, n), but only when available_languages("best")
    lists the tag itself — wordfreq silently "nearest-matches" codes it
    lacks, which would poison tables, so a miss here means the next source;
  - stopwordsiso.stopwords(tag), with apostrophe-initial words and words
    containing digits dropped (list artifacts like "'ll" and "10");
  - HAND_CURATED below, for the few languages neither library serves.

Only the ladder and the tag list are shared. What each generator does with
the words afterwards is its own: the stopword tables drop cross-language
noise (they carry no rank, so a ubiquitous word is only noise there), the
word list keeps every word with its rank (scoring handles ubiquity).

Neither library is a project dependency; both generators run from a venv:

    python3 -m venv tmp/venv-words
    tmp/venv-words/bin/pip install wordfreq stopwordsiso
    tmp/venv-words/bin/python tools/generate-wordlist.py
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGETS = ROOT / "client/js/i18n/targets.ts"

# hand-curated: function words for languages neither wordfreq ("best") nor
# stopwordsiso serve. Verbs/particles/articles/pronouns/conjunctions that
# dominate running text. te is kept for completeness even though Telugu is
# not currently a translation target, so it is never consulted.
HAND_CURATED = {
    "cy": [
        # article: y, yr — aspect/nominal particle: yn — perfective: wedi
        # negation: nid, ddim, na, nad, mai — copulas/verbs: mae, yw, oedd,
        # roedd, bod, sy, sydd — prepositions: i, o, ar, am, at, gan, gyda,
        # dros, dan, rhwng, er, fel — possessives: ei, eu, fy, dy, ein, eich
        # conjunctions: a, ac, ond, neu, os, pan — pronoun-ish/quantifiers:
        # hyn, hynny — adverbs: felly, hefyd — questions: beth, sut, pwy, ble
        "y", "yr", "yn", "wedi", "nid", "ddim", "na", "nad", "mai",
        "mae", "yw", "oedd", "roedd", "bod", "sy", "sydd",
        "i", "o", "ar", "am", "at", "gan", "gyda", "dros", "dan", "rhwng",
        "er", "fel", "ei", "eu", "fy", "dy", "ein", "eich",
        "a", "ac", "ond", "neu", "os", "pan", "hyn", "hynny",
        "felly", "hefyd", "beth", "sut", "pwy", "ble",
    ],
    "sr": [
        # Cyrillic and Latin mirrors of the same function words — either
        # script a line of Serbian may arrive in. Copulas/auxiliaries: је,
        # није, су, ће, би — reflexive: се — negation/interrogative: не, да,
        # шта, ко, где, када, како — pronouns: ја, ти, он, она, оно, они,
        # ово, то — prepositions: у, на, за, од, са — conjunctions: и, али,
        # или, па
        "је", "није", "су", "ће", "би", "да", "не", "се",
        "и", "у", "на", "за", "од", "са", "шта", "ко",
        "ја", "ти", "он", "она", "оно", "они", "ово", "то",
        "али", "или", "па", "где", "када", "како",
        "je", "nije", "su", "će", "bi", "da", "ne", "se",
        "i", "u", "na", "za", "od", "sa", "šta", "ko",
        "ja", "ti", "on", "ona", "ono", "oni", "ovo", "to",
        "ali", "ili", "pa", "gde", "kada", "kako",
    ],
    "te": [
        # pronouns: nēnu, nuvvu, mīru, mēmu, manaṁ, vāru, atanu, āme —
        # demonstratives: adi, idi, avi, ivi, ī, ā, oka — copulas/verbs:
        # undi, unnāyi, uṁṭundi, kādu, lēdu — conjunctions: mariyu, lēdā,
        # kānī, ayitē — postpositions: tō, ki, ku, lō, nuṁḍi, varaku,
        # kōsaṁ, gurin̄ci, cēta, vadda — focus: kūḍā — questions: ēmi, ēvaru,
        # ekkada, eppuḍu, ēlā, ēṁduku — time/place: ippuḍu, ikkaḍa
        "నేను", "నువ్వు", "మీరు", "మేము", "మనం", "వారు", "అతను", "ఆమె",
        "అది", "ఇది", "అవి", "ఇవి", "ఈ", "ఆ", "ఒక",
        "ఉంది", "ఉన్నాయి", "ఉంటుంది", "కాదు", "లేదు",
        "మరియు", "లేదా", "కానీ", "అయితే",
        "తో", "కి", "కు", "లో", "నుండి", "వరకు", "కోసం", "గురించి",
        "చేత", "వద్ద", "కూడా",
        "ఏమి", "ఎవరు", "ఎక్కడ", "ఎప్పుడు", "ఎలా", "ఎందుకు",
        "ఇప్పుడు", "ఇక్కడ",
    ],
}


def target_tags() -> list[str]:
    """The tags of targets.ts — the source of truth for the output keys."""
    tags = re.findall(r'"tag":\s*"([^"]+)"', TARGETS.read_text(encoding="utf-8"))
    if not tags:
        sys.exit(f"no tags parsed from {TARGETS}")
    return tags


def clean(words, cap: int) -> list[str]:
    """Lowercase, strip, deduplicate, cap, preserving order."""
    seen: set[str] = set()
    out: list[str] = []
    for w in words:
        w = w.strip().lower()
        if w and w not in seen and w.isprintable():
            seen.add(w)
            out.append(w)
        if len(out) >= cap:
            break
    return out


def source_words(tag: str, want: int, wf: set[str]) -> tuple[list[str], str | None]:
    """The raw (uncleaned) words for `tag` and which source gave them:
    "wordfreq", "stopwordsiso", "hand" or None when nothing serves the tag.
    `wf` is `set(wordfreq.available_languages("best"))`."""
    from wordfreq import top_n_list
    import stopwordsiso as stopwords

    if tag in wf:
        return list(top_n_list(tag, want)), "wordfreq"

    raw = [
        w
        for w in sorted(stopwords.stopwords(tag))
        if not w.startswith("'") and not any(c.isdigit() for c in w)
    ]
    if raw:
        return raw, "stopwordsiso"
    if tag in HAND_CURATED:
        return list(HAND_CURATED[tag]), "hand"
    return [], None
