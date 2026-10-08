// Regenerates the meadow's animals — client/themes/ps/<animal>.svg, the
// distant-visitor -far.svg and the two -still.svg files — from the rigs
// under tools/heart/rigs/. The files are committed; run this after changing
// a rig or a sequence, read the audit, then commit what it wrote:
//
//   node tools/heart/generate.mjs            # every animal
//   node tools/heart/generate.mjs puppy      # one
//
// A problem in the audit (a failed union, an outline that jumps, a visit that
// ends on stage, a file over budget) leaves the old files alone and exits 1.
// tools/heart/README.md explains the pipeline and the rules a rig must keep.

import {writeFileSync} from "fs";
import path from "path";
import {buildAnimal} from "./lib/build.mjs";

const OUT = path.resolve(import.meta.dirname, "../../client/themes/ps");
const ALL = ["horse", "puppy", "bunny", "deer", "kitten", "frog", "ladybug", "bird"];

/**
 * Rigs that are built and reviewed but not currently cast in any scene, so
 * their files are not generated and not shipped. `client/themes/ps/` is
 * copied into `public/` whole, so a file no scene casts is dead weight in
 * every deploy — the rigs stay, the output does not.
 *
 * - `teddy`: held 2026-09-12. "let's put a hold on the teddy bear as an
 *   animal, since it can't move" — a stuffed toy that walks itself reads
 *   wrong, whatever the drawing does. An unfinished side-on redraw of it is
 *   parked as a patch outside the repo.
 * - `dolphin`: held 2026-09-12, same message.
 *
 * Both still build: `node tools/heart/generate.mjs teddy` works, since names
 * given on the command line are imported directly. To bring one back, add it
 * to ALL, regenerate, and cast it in a scene in `client/themes/ps.css`.
 */
const HELD = ["teddy", "dolphin"];
const names = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
if (!process.argv.slice(2).length && HELD.length) {
	console.log(`held, not generated: ${HELD.join(", ")} (see HELD in this file)`);
}
let ok = true;

for (const name of names) {
	const def = (await import(`./rigs/${name}.mjs`)).default;
	const started = Date.now();
	const {files, audit} = buildAnimal(def);
	const secs = ((Date.now() - started) / 1000).toFixed(1);
	console.log(
		`${name}: ${audit.frames} frames stored, on stage ${audit.onStage.toFixed(1)} s of a ${
			def.sequence.period
		} s loop (gap ${audit.gap.toFixed(1)} s), ${secs} s to build`
	);
	console.log(
		`  outline change ≤ ${(audit.worstNear * 100).toFixed(2)} % near / ${(
			audit.worstFar * 100
		).toFixed(2)} % far, ${audit.retries} union retries, ends at x=${audit.xEnd.toFixed(
			0
		)} of ${audit.stageW}`
	);
	console.log(
		`  fades out by t=${audit.tExit.toFixed(2)} s (on stage ${audit.onStage.toFixed(2)} s)${
			audit.tExitFallback ? " — exit condition not found, fell back to onStage" : ""
		}`
	);
	console.log(
		`  clip chain ${audit.clipTotalDur.toFixed(3)} s vs onStage ${audit.onStage.toFixed(
			3
		)} s (diff ${((audit.clipTotalDur - audit.onStage) * 1000).toFixed(1)} ms)`
	);
	for (const s of audit.speeds) {
		const note =
			s.mean !== s.measured ? ` (stance measured ${s.measured.toFixed(0)} units/s)` : "";
		const hold = s.hold ? " [hold]" : "";
		console.log(`  ${s.id} ${s.kind}: ${s.mean.toFixed(0)} units/s${note}${hold}`);
	}
	for (const p of audit.problems) console.log(`  ✗ ${p}`);
	if (audit.problems.length) {
		ok = false;
		continue;
	}
	for (const [file, text] of Object.entries(files)) {
		writeFileSync(path.join(OUT, file), text);
		console.log(`  ${file} ${(text.length / 1024).toFixed(1)} KB`);
	}
}

process.exit(ok ? 0 : 1);
