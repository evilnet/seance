/* eslint-disable no-console */
// tools/heart/gait-probe.mjs — the numbers neither the audit nor the contact
// sheet can show you.
//
//     node tools/heart/gait-probe.mjs deer
//     node tools/heart/gait-probe.mjs deer --cycles=3
//
// The audit prints one mean speed per segment, and the contact sheet tracks the
// animal so that it sits in the middle of every cell — which is exactly what
// hides a gait's two characteristic defects:
//
//   * a foot that never really leaves the ground, so the animal moonwalks. The
//     stance measurement (lib/travel.mjs) picks the lowest planted foot within
//     `tol` units of the ground; a swing that lifts barely past `tol` is read as
//     planted through its whole swing and drags.
//   * a ground speed that steps at a cycle boundary. A gait stores one cycle and
//     repeats it, so a speed that differs between the cycle's first and last
//     frame is replayed as a lurch once per stride, forever.
//
// Both are invisible in a still frame and both need a number. Run this on every
// new rig before believing a contact sheet that looks fine.
//
// Reading the foot table: feet come out in the rig tree's own order, which for
// the existing quadrupeds is far legs first, then near. The rig rules keep a far
// leg slightly raised, so a far foot reads as clear of the ground for most of
// the cycle and its row means little — judge the near feet. A near foot in a
// four-beat walk should be clear for roughly a quarter of the cycle; in a gallop,
// most of it.

import {feetOf} from "./lib/outline.mjs";
import {gaitPose, samplePoses, travelOf} from "./lib/build.mjs";

const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith("--"));
const cycles = Number((args.find((a) => a.startsWith("--cycles=")) ?? "--cycles=2").slice(9));
if (!name) {
	console.error("usage: node tools/heart/gait-probe.mjs <animal> [--cycles=N]");
	process.exit(2);
}

const def = (await import(`./rigs/${name}.mjs`)).default;
const {rig} = def;
const TOL = 6; // lib/travel.mjs's plant tolerance
const SAMPLES = 40;
const height = rig.ground - rig.viewBox.y; // drawn height above the ground line

console.log(`${name} — gait probe (plant tolerance ${TOL} units, drawn height ${height})`);

// ── 1. does every foot actually leave the ground? ────────────────────────────
for (const [gname, gait] of Object.entries(rig.gaits ?? {})) {
	console.log(`\nfoot lift through one ${gname} cycle`);
	const chans = rig.channels(gname);
	const lifts = [];
	for (let i = 0; i < SAMPLES; i++) {
		lifts.push(feetOf(rig, gaitPose(gait, chans, i / SAMPLES)).map((f) => rig.ground - f.y));
	}
	const count = lifts[0].length;
	for (let f = 0; f < count; f++) {
		const series = lifts.map((l) => l[f]);
		const max = Math.max(...series);
		const above = series.filter((x) => x > TOL).length;
		const verdict =
			max <= TOL
				? "  DRAGS — never clears the plant tolerance"
				: above < SAMPLES * 0.15
				? "  thin — clears the tolerance for under 15 % of the cycle"
				: "";
		console.log(
			`  foot ${String(f).padStart(2)}  max lift ${max.toFixed(1).padStart(6)} ` +
				`(${((max / height) * 100).toFixed(0).padStart(3)} % of height)  ` +
				`frames clear of the ground ${String(above).padStart(2)}/${SAMPLES}${verdict}`
		);
	}
}

// ── 2. is the ground speed smooth, and smooth across a repeat? ───────────────
// `travelOf` hands back both curves: `xs` is what is APPLIED (a pinned or ramped
// `travel` overrides the measurement) and `v` is the RAW stance measurement the
// rig's own feet produce. Judge a gait on the raw series — the applied one is
// flat by construction wherever a segment pins its speed, so checking that alone
// reports a clean seam for exactly the segments that most needed pinning.
const {poses, segs} = samplePoses(def);
const {xs, v: raw} = travelOf(def, poses, segs);

const stats = (a) => {
	const min = Math.min(...a);
	const max = Math.max(...a);
	const mean = a.reduce((x, y) => x + y, 0) / a.length;
	return {min, max, mean, spread: mean > 0 ? ((max - min) / 2 / mean) * 100 : 0};
};

console.log("\nground speed per segment — raw stance measurement vs what is applied");
for (const s of segs) {
	const applied = [];
	const stance = [];
	for (let i = s.start + 1; i < s.start + s.count; i++) {
		const dt = poses[i].t - poses[i - 1].t;
		if (dt <= 0) continue;
		applied.push((xs[i] - xs[i - 1]) / dt);
		stance.push(raw[i]);
	}
	if (!applied.length) continue;
	const A = stats(applied.map(Math.abs));
	const R = stats(stance);
	const what = s.gait ?? s.blendTo ?? s.wobble ?? s.pose ?? "?";
	const pinned = s.travel !== undefined;
	console.log(
		`  ${s.id} ${String(what).padEnd(10)} applied mean ${A.mean.toFixed(1).padStart(7)}` +
			`${pinned ? " (pinned)" : "        "}   raw mean ${R.mean.toFixed(1).padStart(7)} ` +
			`min ${R.min.toFixed(1).padStart(6)} max ${R.max.toFixed(1).padStart(6)} ` +
			`spread ${R.spread.toFixed(0).padStart(3)} %`
	);
	const stalled = stance.filter((x) => x < 0.5).length;
	if (s.gait && stalled > stance.length * 0.1) {
		console.log(
			`    the raw measurement stalls on ${stalled}/${stance.length} frames — ` +
				(pinned
					? "pinning is hiding it, which is the right call, but the mean you pinned at is drawn from these"
					: "PIN THIS SEGMENT, or the animal stops dead once per stride")
		);
	}
	// a gait stores one cycle and repeats it, so the seam is replayed every stride
	if (s.gait && rig.gaits[s.gait]) {
		const per = Math.round(rig.gaits[s.gait].dur * s.fps);
		for (let c = 1; c <= cycles; c++) {
			const i = c * per;
			if (i - 2 >= 0 && i < stance.length) {
				const before = stance[i - 2];
				const across = stance[i - 1];
				const after = stance[i];
				const step = Math.abs(after - before);
				const rel = R.mean > 0 ? (step / R.mean) * 100 : 0;
				console.log(
					`    cycle seam ${c} (raw): before ${before.toFixed(1)} → across ` +
						`${across.toFixed(1)} → after ${after.toFixed(1)} ` +
						`(step ${step.toFixed(1)}, ${rel.toFixed(0)} % of the raw mean)` +
						(rel > 25 ? "  LURCHES — a repeat replays this every stride" : "")
				);
			}
		}
	}
}
