/* eslint-disable no-console */
// A round trip over an eval fixture: every case is translated forward by the
// offline runner (tools/translate-llm.ts --eval), each answer is then sent
// back into the case's source language in the reading shape with no
// context, and the two ends are compared with overlap.ts. The runner is
// spawned twice — once per direction — so the model loads twice, not once
// per case.
//
//   npx tsx tools/translate-eval/roundtrip.ts tools/translate-eval/suite.json [--markers literal] [--out tmp/roundtrip.md]
//
// Output: a markdown table (case, forward answer, back-translation, the
// share of the original's content words that came back, and the ones that
// did not), lowest scores flagged, plus the two runner transcripts beside
// the table file (`<out>.forward.txt`, `<out>.back.txt`).

import {spawnSync} from "node:child_process";
import {existsSync, readFileSync, writeFileSync} from "node:fs";
import {contentOverlap} from "./overlap";

interface EvalCase {
	text: string;
	from?: string | null;
	to?: string;
	purpose?: "read" | "write";
	nicks?: string[];
	context?: unknown;
	note?: string;
	expect?: string;
}

interface Run {
	outs: string[];
	transcript: string;
}

function runEval(fixture: string, markers: string, runnerArgs: string[], expected: number): Run {
	const result = spawnSync(
		"npx",
		["tsx", "tools/translate-llm.ts", "--eval", fixture, "--markers", markers, ...runnerArgs],
		{encoding: "utf8", maxBuffer: 64 * 1024 * 1024}
	);
	const transcript = `${result.stdout}\n${result.stderr}`;
	const outs = outsOf(result.stdout);

	if (result.status !== 0) {
		// ONNX Runtime's CUDA provider can abort while the process tears down
		// ("corrupted double-linked list", status 134), after every answer was
		// written: a run that answered every case is kept.
		if (outs.length !== expected) {
			throw new Error(`runner failed on ${fixture}:\n${transcript.slice(-2000)}`);
		}

		console.log(`  (runner exited with ${result.status} after all ${expected} answers; kept)`);
	}

	return {outs, transcript};
}

/** The answers in a runner transcript, in case order. */
function outsOf(transcript: string): string[] {
	const outs: string[] = [];

	for (const line of transcript.split("\n")) {
		const match = /^ {2}out {2}(.*)$/.exec(line);

		if (match) {
			outs.push(JSON.parse(match[1]) as string);
		}
	}

	return outs;
}

function main(): void {
	const all = process.argv.slice(2);
	// Everything after a bare `--` goes to the runner as it is (`--repo`, `--dtype`).
	const split = all.indexOf("--");
	const args = split >= 0 ? all.slice(0, split) : all;
	const runnerArgs = split >= 0 ? all.slice(split + 1) : [];
	const fixture = args.find((a) => !a.startsWith("--"));

	if (!fixture) {
		throw new Error(
			"usage: roundtrip.ts <fixture.json> [--markers literal] [--out file.md] [--resume] [-- <runner flags>]"
		);
	}

	const flag = (name: string, fallback: string): string => {
		const i = args.indexOf(name);

		return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
	};

	const markers = flag("--markers", "literal");
	const out = flag("--out", "tmp/roundtrip.md");
	const cases = JSON.parse(readFileSync(fixture, "utf8")) as EvalCase[];
	// `--resume`: a forward transcript already beside the output (a run that
	// was stopped during its back pass) is used instead of running it again.
	const resumeFrom = `${out}.forward.txt`;
	const resumed = args.includes("--resume") && existsSync(resumeFrom);

	console.log(`forward: ${cases.length} cases from ${fixture}${resumed ? " (resumed)" : ""}`);

	let forward: Run;

	if (resumed) {
		const transcript = readFileSync(resumeFrom, "utf8");

		forward = {outs: outsOf(transcript), transcript};
	} else {
		forward = runEval(fixture, markers, runnerArgs, cases.length);
		writeFileSync(`${out}.forward.txt`, forward.transcript);
	}

	if (forward.outs.length !== cases.length) {
		throw new Error(
			`forward run gave ${forward.outs.length} answers for ${cases.length} cases`
		);
	}

	// Back into the source language, in the reading shape, no context: the
	// answer is what a reader on the other side would be shown.
	const back: EvalCase[] = cases.map((item, i) => ({
		note: `back ${i + 1}: ${item.to} → ${item.from ?? "en"}`,
		text: forward.outs[i],
		from: item.to ?? null,
		to: item.from ?? "en",
		purpose: "read",
		nicks: item.nicks,
	}));
	const backFixture = `${out}.back.json`;

	writeFileSync(backFixture, JSON.stringify(back, null, 1));
	console.log(`back: ${back.length} cases`);

	const backward = runEval(backFixture, markers, runnerArgs, back.length);

	writeFileSync(`${out}.back.txt`, backward.transcript);

	const rows: string[] = [
		"| # | case | forward | back | kept | missing |",
		"| - | ---- | ------- | ---- | ---- | ------- |",
	];
	const scores: {note: string; score: number}[] = [];
	const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ⏎ ");

	cases.forEach((item, i) => {
		const overlap = contentOverlap(item.text, backward.outs[i] ?? "");
		const score = overlap.total ? overlap.found / overlap.total : 1;

		scores.push({note: item.note ?? String(i + 1), score});
		rows.push(
			`| ${i + 1} | ${cell(item.note ?? "")} | ${cell(forward.outs[i])} | ${cell(
				backward.outs[i] ?? ""
			)} | ${overlap.found}/${overlap.total} | ${overlap.missing.join(", ")} |`
		);
	});

	const mean = scores.reduce((sum, s) => sum + s.score, 0) / Math.max(1, scores.length);
	const low = scores.filter((s) => s.score < 0.5);
	const summary = [
		`# Round trip: ${fixture} (${markers} markers)`,
		"",
		`Cases: ${cases.length}. Mean share of content words back: ${(mean * 100).toFixed(
			0
		)}%. Below 50%: ${low.length}.`,
		"",
		...(low.length
			? ["Lowest:", ...low.map((s) => `- ${s.note}: ${(s.score * 100).toFixed(0)}%`), ""]
			: []),
		...rows,
		"",
	].join("\n");

	writeFileSync(out, summary);
	console.log(
		summary
			.split("\n")
			.slice(0, 4 + low.length + 1)
			.join("\n")
	);
	console.log(`table: ${out}`);
}

main();
