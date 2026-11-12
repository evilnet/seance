// How a translation model is named on screen. `ModelRef.label` is data (a
// kind plus its values) because `translate/models.ts` is Vue-free and never
// imports the i18n runtime; the phrase itself lives in the catalog and is
// rendered here, once, for the three surfaces that show a model: Settings →
// Translation, the composer's translation strip and a reading line's
// "downloading…" note.

import {t} from "../i18n/core";
import type {ModelRef} from "../translate/engine";
import {languageName} from "../translate/languages";
import {modelRefById, readingLanguage} from "../translate/reader";
import type {LoadNote} from "../translate/service";

/** The model's full name, as Settings lists it. */
export function modelLabel(ref: ModelRef): string {
	switch (ref.label.kind) {
		case "opus": {
			// An OPUS-MT model is named by the pair it translates, and the
			// pair is named in the language its reader reads — the same
			// languageName(code, readingLanguage()) every other translation
			// surface uses, not languageName()'s English default. A deploy's
			// own pair model carries its own name (`OpusPairOption.name`).
			const pair = {
				from: languageName(ref.label.from, readingLanguage()),
				to: languageName(ref.label.to, readingLanguage()),
			};

			return ref.label.name
				? t("translate.model.namedPair", {name: ref.label.name, ...pair})
				: t("translate.model.opus", pair);
		}
		case "nllb":
			return t("translate.model.nllb");
		case "apple":
			return t("translate.model.apple");
		default:
			return t("translate.model.llm", {name: ref.label.name});
	}
}

/**
 * "Translated on this device by …", the foot of a line's "Translation
 * options", or null for a line whose model is not known.
 */
export function translatedByText(modelId: string | undefined): string | null {
	const ref = modelId ? modelRefById(modelId) : null;

	if (!ref) {
		return null;
	}

	return ref.label.kind === "apple"
		? t("translate.menu.byApple")
		: t("translate.menu.byModel", {model: modelLabel(ref)});
}

/** What a strip or a reading line says while this model loads. */
export function loadNoteText(note: LoadNote): string {
	const vars = {model: modelLabel(note.ref), percent: note.percent};

	return note.phase === "loading"
		? t("translate.load.loading", vars)
		: t("translate.load.downloading", vars);
}
