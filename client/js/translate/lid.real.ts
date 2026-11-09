// The language identifiers detect.ts asks, wired to their libraries. The
// only module that imports them: mocha never loads it (detect.ts
// `setIdentifier` scripts a result instead), and the app loads it on the
// first line it has to place, in a chunk of its own.
//
// fastText's lid.176 (Facebook's 176-language model, the compressed `.ftz`,
// ~0.9 MB, CC-BY-SA-3.0) runs in its WebAssembly build; ELD (Efficient
// Language Detector, the `small` n-gram table, Apache-2.0) is plain
// JavaScript. Both files are fetched from the app's own origin.

import {getLIDModel} from "fasttext.wasm.js/common";
import wasmUrl from "fasttext.wasm.js/dist/core/fastText.common.wasm?url";
import modelUrl from "fasttext.wasm.js/dist/models/language-identification/assets/lid.176.ftz?url";
import {eld} from "eld/small";
import type {Identifier} from "./detect";
import {SUPPORTED_LANGUAGES} from "./languages";

/** Both libraries call Norwegian Bokmål `no`; the app calls it `nb`. */
const own = (code: string | null | undefined): string | null =>
	!code ? null : code === "no" ? "nb" : code;

export async function makeIdentifier(): Promise<Identifier> {
	const model = await getLIDModel({wasmPath: wasmUrl, modelPath: modelUrl});

	await model.load();
	// ELD weighs only the languages the app can translate (and `no`, its
	// Bokmål): a language it was never going to be asked about cannot win.
	eld.setLanguageSubset([...SUPPORTED_LANGUAGES, "no"]);

	return async (text) => {
		// lid.176 was trained on lower-cased text: measured on chat lines,
		// lower-casing places more of them (tools/translate-eval/lid.mts).
		const ranked = await model.identify(text.toLowerCase(), 5);
		const fast = ranked
			.map((entry) => ({lang: own(entry.alpha2), p: entry.possibility}))
			.filter((entry): entry is {lang: string; p: number} => entry.lang !== null);
		const result = eld.detect(text);

		return {
			fast,
			eld: {lang: own(result.language), reliable: result.isReliable()},
		};
	};
}
