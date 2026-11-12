/* eslint-disable no-console */
// The language identification the reading pipeline runs (client/js/translate/
// detect.ts: the script check, then fastText's lid.176 and ELD under
// `decide`), measured on lid-set.json's labelled chat lines. In Node, so
// fastText loads its own copy of the model from the package.
//
//   pnpm exec tsx tools/translate-eval/lid.mts [--misses]
//
// Two numbers matter: how many English lines are placed in another language
// (each one is a line of an English channel translated "from Polish" for
// nobody), and how many foreign lines are placed in the right one. Danish
// and Norwegian Bokmål count as each other: they translate the same way.
// Results: results/2026-11-08-lid.md.

import {readFileSync} from "fs";
import * as path from "path";
import {getLIDModel} from "fasttext.wasm.js";
import {eld} from "eld/small";
import {detectLanguage, setIdentifier} from "../../client/js/translate/detect.ts";
import {SUPPORTED_LANGUAGES} from "../../client/js/translate/languages.ts";

const {lines} = JSON.parse(
	readFileSync(path.join(import.meta.dirname, "lid-set.json"), "utf8")
) as {lines: [string, string][]};
const misses = process.argv.includes("--misses");

// lid.real.ts, with the Node build of fastText.
const own = (code: string | null | undefined) => (!code ? null : code === "no" ? "nb" : code);
const model = await getLIDModel();
await model.load();
eld.setLanguageSubset([...SUPPORTED_LANGUAGES, "no"]);
setIdentifier(async (text) => {
	const ranked = (await model.identify(text.toLowerCase(), 5)) as unknown as {
		alpha2: string | null;
		possibility: number;
	}[];
	const result = eld.detect(text);

	return {
		fast: ranked
			.map((entry) => ({lang: own(entry.alpha2), p: entry.possibility}))
			.filter((entry): entry is {lang: string; p: number} => entry.lang !== null),
		eld: {lang: own(result.language), reliable: result.isReliable()},
	};
});

const same = (want: string, got: string | null) =>
	got === want || (["da", "nb"].includes(want) && ["da", "nb"].includes(got ?? ""));
let english = 0;
let englishWrong = 0;
let foreign = 0;
let foreignRight = 0;
let foreignWrong = 0;
const wrong: string[] = [];

for (const [want, text] of lines) {
	const {lang} = await detectLanguage(text, null);

	if (want === "en") {
		english++;

		if (lang !== null && lang !== "en") {
			englishWrong++;
			wrong.push(`en  ${JSON.stringify(text)} -> ${lang}`);
		}
	} else {
		foreign++;

		if (same(want, lang)) {
			foreignRight++;
		} else {
			if (lang !== null) {
				foreignWrong++;
			}

			wrong.push(`${want}  ${JSON.stringify(text)} -> ${lang ?? "unplaced"}`);
		}
	}
}

const pct = (n: number, of: number) => `${((100 * n) / of).toFixed(1)}%`;

console.log(`English placed elsewhere: ${englishWrong}/${english} (${pct(englishWrong, english)})`);
console.log(`Foreign placed right:     ${foreignRight}/${foreign} (${pct(foreignRight, foreign)})`);
console.log(`Foreign placed wrong:     ${foreignWrong}/${foreign}`);

if (misses) {
	console.log("\n" + wrong.join("\n"));
}
