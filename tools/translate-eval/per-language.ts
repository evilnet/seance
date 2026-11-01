/* eslint-disable no-console */
// Per-language round-trip score in the shape of
// tools/translate-eval/results/2026-09-12-languages.md: the content words found
// over the content words in the English lines, summed over a language's cases.
//
//   npx tsx tools/translate-eval/per-language.ts <label> <fixture.json> <out.md> [<fixture.json> <out.md> …]
//
// <out.md> is a roundtrip.ts output; its back transcript `<out.md>.back.txt`
// holds the back-translations in case order.

import {readFileSync} from "node:fs";
import {contentOverlap} from "./overlap";

interface Case {
	text: string;
	to?: string;
	note?: string;
}

const [label, ...pairs] = process.argv.slice(2);

if (!label || pairs.length === 0 || pairs.length % 2 !== 0) {
	throw new Error(
		"usage: per-language.ts <label> <fixture.json> <out.md> [<fixture.json> <out.md> …]"
	);
}

function outsOf(path: string): string[] {
	const outs: string[] = [];

	for (const line of readFileSync(path, "utf8").split("\n")) {
		const match = /^ {2}out {2}(.*)$/.exec(line);

		if (match) {
			outs.push(JSON.parse(match[1]) as string);
		}
	}

	return outs;
}

const sums = new Map<string, {found: number; total: number; cases: number}>();

for (let p = 0; p < pairs.length; p += 2) {
	const cases = JSON.parse(readFileSync(pairs[p], "utf8")) as Case[];
	const backs = outsOf(`${pairs[p + 1]}.back.txt`);

	if (backs.length !== cases.length) {
		throw new Error(`${pairs[p + 1]}: ${backs.length} back answers for ${cases.length} cases`);
	}

	cases.forEach((item, i) => {
		const lang = item.to ?? "?";
		const overlap = contentOverlap(item.text, backs[i]);
		const sum = sums.get(lang) ?? {found: 0, total: 0, cases: 0};

		sum.found += overlap.found;
		sum.total += overlap.total;
		sum.cases += 1;
		sums.set(lang, sum);
	});
}

console.log(`| Language | ${label} | cases |`);
console.log("| --- | --- | --- |");

for (const [lang, sum] of sums) {
	const share = sum.total ? Math.round((sum.found / sum.total) * 100) : 100;

	console.log(`| ${lang} | ${share}% | ${sum.cases} |`);
}
