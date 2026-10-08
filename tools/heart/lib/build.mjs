// From a rig and its sequence to the four files (tools/heart/README.md):
// sample the segments into poses, outline the frames that will be stored
// (one cycle of a gait, every frame of anything else), derive the travel
// from the planted feet over every frame, then write the near file, the
// distant-visitor file and their stills, with an audit that refuses what
// the meadow must not show.

import {cyc, sampleGait, samplePose, sampleWobble} from "./sampler.mjs";
import {align, feetOf, outlineFrame, P as pathOf} from "./outline.mjs";
import {stanceTravel} from "./travel.mjs";
import {animalSvg, encodePath, fmt, mix, SKY, stillSvg, TRAVEL_DECIMALS} from "./svg.mjs";

/** The pose a gait is in at cycle phase t (0–1). */
export function gaitPose(gait, channels, t) {
	const v = {};
	for (const ch of channels) {
		const k = gait.ch[ch.key];
		v[ch.name] = k ? cyc(k, t, ch.phase ?? 0) : ch.rest ?? 0;
	}
	return v;
}

/**
 * Sample every segment into one pose list. A gait is sampled a cycle at a
 * time so the clip stored for it (its first cycle) repeats to exactly the
 * sampled length; each segment remembers its id (s1, s2, …), frame range,
 * frames per cycle and its span [t0, t1].
 */
export function samplePoses(def) {
	const {rig, sequence} = def;
	const poses = [];
	const segs = [];
	let t = 0;
	sequence.segments.forEach((seg, i) => {
		const start = poses.length;
		const t0 = t;
		let cycleFrames = 0;
		if (seg.gait) {
			const gait = rig.gaits[seg.gait];
			const channels = rig.channels(seg.gait);
			cycleFrames = Math.round(gait.dur * seg.fps);
			for (let c = 0; c < seg.cycles; c++)
				t = sampleGait(gait, channels, 1, seg.fps, poses, t);
		} else if (seg.blendTo) {
			const gait = rig.gaits[seg.blendTo];
			const channels = rig.channels(seg.blendTo);
			t = samplePose(gaitPose(gait, channels, 0), channels, 0, seg.secs, seg.fps, poses, t);
		} else if (seg.wobble) {
			const channels = rig.channels();
			t = sampleWobble(
				rig.poses[seg.pose],
				rig.wobbles[seg.wobble],
				channels,
				seg.secs,
				seg.fps,
				poses,
				t
			);
		} else {
			t = samplePose(
				rig.poses[seg.pose],
				rig.channels(),
				seg.hold,
				seg.blend,
				seg.fps,
				poses,
				t
			);
		}
		const count = poses.length - start;
		if (!count) throw new Error(`segment ${i + 1} of ${def.name} samples no frames`);
		segs.push({...seg, id: `s${i + 1}`, start, count, cycleFrames, t0, t1: t});
	});
	return {poses, segs, onStage: t};
}

/**
 * Outline the frames each clip stores: one cycle of a gait, every frame of a
 * pose or wobble, aligned frame to frame across segment boundaries. Every
 * clip is closed at its own duration — a gait on its first frame, aligned
 * to its last, so the repeat is seamless; a pose on a hold of its last.
 *
 * **A ramp cycle closes on its own end instead** (`once: true`, and only
 * with `cycles: 1` — see README § The pipeline). A gait whose root channel
 * ramps one way across the cycle — the ladybug's climb, the bird's take-off
 * — is not periodic, so closing it on its own frame 0 would replay the
 * whole ramp backwards in the clip's last frame interval. Nothing else
 * catches that: a `ty` ramp is a pure translate, so the outline's *length*
 * never changes and the audit's 5 % rule sees nothing. The closing frame is
 * instead the gait's pose at phase 1 − ε, which for every cyclic channel
 * (a limb beat, phased or not — `cyc` wraps `t − phase`) is exactly its
 * frame-0 value again and differs only in the ramping ones.
 */
export function outlineSequence(def, poses, segs) {
	let prev = null;
	let failures = 0;
	let retries = 0;
	const problems = [];
	for (const seg of segs) {
		const n = seg.gait ? seg.cycleFrames : seg.count;
		seg.frames = [];
		for (let i = 0; i < n; i++) {
			const f = poses[seg.start + i];
			const o = outlineFrame(def.rig, f.v, prev);
			if (o.failed) failures++;
			retries += o.attempts;
			seg.frames.push({t: f.t - seg.t0, layers: o.layers});
			prev = o.layers;
		}
		seg.dur = seg.gait ? seg.cycleFrames / seg.fps : seg.t1 - seg.t0;
		if (seg.once && !(seg.gait && seg.cycles === 1)) {
			problems.push(`${seg.id} is marked once but is not a gait played with cycles: 1`);
		}
		let closing;
		if (seg.gait && seg.once) {
			const gait = def.rig.gaits[seg.gait];
			const end = gaitPose(gait, def.rig.channels(seg.gait), 1 - 1e-9);
			const o = outlineFrame(def.rig, end, prev);
			if (o.failed) failures++;
			retries += o.attempts;
			closing = o.layers;
		} else if (seg.gait) {
			closing = seg.frames[0].layers.map((l, li) => ({
				cls: l.cls,
				pts: align(l.pts, prev[li].pts),
			}));
		} else {
			closing = prev;
		}
		seg.frames.push({t: seg.dur, layers: closing});
		prev = closing;
	}
	return {failures, retries, problems};
}

/**
 * The velocity a segment's numeric or ramped `travel` applies at sequence
 * time `t`: a number is a constant; `[from, to]` ramps linearly across the
 * segment's own span (`seg.t0`–`seg.t1`), `from` at the start and `to` at
 * the end, so a gait switch that changes speed does not also stall or jump.
 * Clamped to `[t0, t1]` — `segStep` below only ever asks for a time inside
 * the segment's own span, but the clamp keeps this safe to call with
 * anything.
 */
function rampV(seg, t) {
	const [from, to] = seg.travel;
	const span = seg.t1 - seg.t0;
	if (span <= 0) return from;
	const w = Math.min(1, Math.max(0, (t - seg.t0) / span));
	return from + (to - from) * w;
}

/**
 * `seg`'s overridden rate at time `t` (its own ramp or a constant), or
 * `null` when `seg` has no override and the caller should fall back to the
 * measured stance velocity instead.
 */
function segRate(seg, t) {
	if (Array.isArray(seg?.travel)) return rampV(seg, t);
	if (typeof seg?.travel === "number") return seg.travel;
	return null;
}

/** The distance `seg`'s overridden rate covers from `ta` to `tb` (both within its own span), or `null`. */
function segStep(seg, ta, tb) {
	const va = segRate(seg, ta);
	const vb = segRate(seg, tb);
	return va === null || vb === null ? null : ((va + vb) / 2) * (tb - ta);
}

/**
 * The travel over every sampled frame, facing flipped at each segment marked
 * `turn`. A segment may set `travel` (units/s, forward in the facing
 * direction) to override the stance measurement for its own frames — for a
 * rig whose swing does not lift the feet clearly, the plant-detection this
 * is built on cannot be trusted — as a constant number, or `[from, to]` to
 * ramp linearly across the segment (a step's distance is then the trapezoid
 * under the ramp between the two frames' velocities, exact for a line, so a
 * gait blend's speed never stalls to zero or jumps at the switch). A step
 * that crosses into the next segment is split exactly at the boundary and
 * each half integrated under its own segment's rate — evaluating a ramp's
 * neighbour's frame spacing under the ramp's own formula (or vice versa)
 * would otherwise dip or spike right at the switch, since neither side's
 * frames land exactly on the shared boundary time. The split only applies
 * when both sides have an override; a boundary next to a measured (no
 * override) segment keeps the single whole-step rule, since there is no
 * continuous function on the measured side to split against. `v` stays the
 * measured velocity either way; only the accumulated position is affected.
 */
export function travelOf(def, poses, segs) {
	const feetFrames = poses.map((p) => ({t: p.t, feet: feetOf(def.rig, p.v)}));
	const {x, v} = stanceTravel(feetFrames, def.rig.ground);
	const turns = new Set(segs.filter((s) => s.turn).map((s) => s.start));
	const owner = new Array(poses.length);
	for (const s of segs) for (let i = s.start; i < s.start + s.count; i++) owner[i] = s;
	const xs = [];
	const flips = [];
	let facing = 1;
	let acc = 0;
	for (let i = 0; i < poses.length; i++) {
		if (turns.has(i)) {
			facing = -facing;
			flips.push(poses[i].t);
		}
		if (i > 0) {
			const segA = owner[i - 1];
			const segB = owner[i];
			const ta = poses[i - 1].t;
			const tb = poses[i].t;
			let step = null;
			if (segA !== segB) {
				const boundary = segB.t0;
				const partA = segStep(segA, ta, boundary);
				const partB = segStep(segB, boundary, tb);
				if (partA !== null && partB !== null) step = partA + partB;
			}
			if (step === null) step = segStep(segB, ta, tb);
			if (step === null) step = x[i] - x[i - 1];
			acc += facing * step;
		}
		xs.push(acc);
	}
	return {xs, v, flips};
}

/**
 * The (time, position) samples for the SVG's translate animation: the same
 * per-pose curve `travelOf` returns, except within a ramp segment
 * (`Array.isArray(seg.travel)`), subdivided into at least `steps` (never
 * fewer than its own pose count — this only adds density, on the side where
 * poses are the sparse one) virtual samples across its own span, regardless
 * of how many poses (and so outline frames — every outline frame costs
 * bytes) it has. The translate is its own `<animateTransform>`, independent
 * of the outline's `d`-morph clips, so it is free to sample the ramp's
 * exact linear speed as finely as it needs to look smooth at no outline
 * cost — the outline only needs enough frames for the shape blend itself to
 * look right.
 *
 * Every subdivided time is snapped to the same `TRAVEL_DECIMALS`-precision
 * keyTime fraction `fmt` (svg.mjs) will round it to before its matching
 * position is computed, and integration carries on from the *snapped*
 * previous point, not the ideal one: `fmt` rounds the emitted keyTime and
 * position independently, and a fine subdivision's ideal spacing (of a
 * short ramp against the whole loop's period) can be only a few multiples
 * of that rounding grain, so computing a position for a time the file will
 * not actually store reads back as a wrong, jumpy velocity once the
 * (different) stored time is paired with it. Snapping first keeps every
 * stored position exactly consistent with its stored time; two ideal steps
 * landing on the same grain collapse to one (`tb <= ta`), self-limiting
 * `steps` to whatever the grain actually supports for this span and
 * period. A ramp segment's own last sample lands exactly on its `t1`, which
 * is exactly the next segment's first pose time too; `push` collapses that
 * shared instant to one keyframe rather than a zero-length step.
 */
export function travelCurve(poses, xs, segs, flips, first, period, steps = 20) {
	const grid = 10 ** TRAVEL_DECIMALS;
	const snap = (t) => (Math.round(((first + t) / period) * grid) / grid) * period - first;
	const times = [];
	const out = [];
	const push = (t, x) => {
		if (times.length && times[times.length - 1] === t) {
			out[out.length - 1] = x;
		} else {
			times.push(t);
			out.push(x);
		}
	};
	for (const seg of segs) {
		if (Array.isArray(seg.travel) && seg.t1 > seg.t0) {
			// never sample coarser than the segment's own poses already do —
			// `steps` only adds density where the poses are the sparse side
			const n = Math.max(steps, seg.count);
			const facing = flips.filter((t) => t <= seg.t0).length % 2 === 0 ? 1 : -1;
			let acc = xs[seg.start];
			let ta = seg.t0;
			push(ta, acc);
			for (let k = 1; k <= n; k++) {
				const ideal = seg.t0 + ((seg.t1 - seg.t0) * k) / n;
				const tb = k === n ? seg.t1 : snap(ideal);
				if (tb <= ta) continue;
				acc += facing * ((rampV(seg, ta) + rampV(seg, tb)) / 2) * (tb - ta);
				push(tb, acc);
				ta = tb;
			}
		} else {
			for (let i = seg.start; i < seg.start + seg.count; i++) push(poses[i].t, xs[i]);
		}
	}
	return {times, xs: out};
}

/**
 * When the animal's box starts to cross the stage boundary it leaves by, so
 * the fade-out can finish exactly there instead of hanging on past it: the
 * last contiguous run of frames whose box already crosses one edge —
 * rightward when `x0 + xs[i] + vb.x + vb.w >= stageW`, leftward when
 * `x0 + xs[i] + vb.x <= 0` — walking back from the end so the flush-left
 * start (`x0 = -vb.x`, which trivially satisfies the leftward test at frame
 * 0) is never mistaken for the exit. The exit rule guarantees the last frame
 * satisfies one of the two; `found: false` only if it somehow doesn't.
 */
export function findExitTime(poses, xs, x0, vb, stageW) {
	const exits = (i) => {
		const pos = x0 + xs[i];
		return pos + vb.x + vb.w >= stageW || pos + vb.x <= 0;
	};
	const n = poses.length;
	if (!exits(n - 1)) return {t: null, found: false};
	// walks back from the end, so this is the start of the *trailing*
	// contiguous run past the boundary: a rig whose box crossed the edge,
	// bounced back on stage, then crossed again right before the end would
	// fade late (no current rig does this — travel is monotonic per facing).
	let i = n - 1;
	while (i > 0 && exits(i - 1)) i--;
	return {t: poses[i].t, found: true};
}

/**
 * The six opacity keyTimes for a visit's fade, as fractions of `period`: 0,
 * when the loop places the animal on stage (`first`), when the fade-in
 * ends, when the fade-out starts, when it ends (at `tExit` — see
 * `findExitTime` — not `onStage`), and 1. `fade` is a second, or a quarter
 * of `onStage` if that is shorter. A visit too short for two such fades
 * back to back would give the fade-in's end and the fade-out's start the
 * same keyTime, which SMIL's linear calcMode rejects — a visit under three
 * fades instead splits `tExit` into three equal thirds (fade in, plateau,
 * fade out), which keeps every keyTime strictly increasing however short
 * the visit is.
 */
export function fadeTimes({first, onStage, tExit, period}) {
	let fade = Math.min(1, onStage / 4);
	if (tExit < 3 * fade) fade = tExit / 3;
	const keyTimes = [
		0,
		first / period,
		(first + fade) / period,
		(first + tExit - fade) / period,
		(first + tExit) / period,
		1,
	];
	return {fade, keyTimes};
}

const lengthOf = (pts) => {
	let L = 0;
	for (let i = 0; i < pts.length; i += 2) {
		const j = (i + 2) % pts.length;
		L += Math.hypot(pts[j] - pts[i], pts[j + 1] - pts[i + 1]);
	}
	return L;
};

/**
 * How much slack the containment rule below allows, in rig units. Not zero,
 * because the outline is a resampled polygon: the extreme is measured at
 * sample points, the fillet nudges concave vertices, and `encodePath` rounds
 * to integers, so an exact-containment demand would make a rig's box twitch
 * by a fraction of a unit whenever a pose is retouched. One unit is under
 * 1 % of every box in the cast and far below what an eye can see, while the
 * defects this catches are 2–17 units — the smallest real one (the deer's
 * hind hoof) is twice the allowance and the worst (the bunny's ears) is
 * seventeen times it. A rig should still be given a few units of true
 * clearance rather than parked on the allowance.
 */
export const BOX_MARGIN = 1;

/**
 * **Nothing may be drawn outside its own viewBox.** Every stored frame's
 * outlines — and the still's — against the rig's box, per side, in rig
 * units (the `d` strings are these coordinates × `k`, so a `k: 2` rig reads
 * double in the shipped file; the numbers here are always the rig's own).
 *
 * A box that does not contain its animal clips it, silently, in the shipped
 * file: the still is written in the rig's box on all four sides, and the
 * animated file is the rig's box vertically (`0 … stageW` horizontally, so
 * only the two vertical sides bite there — but the box is also what
 * `findExitTime` fades the visit out on, so an outline hanging past `vb.x`
 * or `vb.x + vb.w` is an animal the fade lets reach the stage edge). This
 * shipped wrong on four of the first five rigs — the bunny lost 17 units of
 * ear through the sit-up that is the whole point of the animal — while the
 * bird's own report already said "nothing leaves the viewBox, tightest
 * margin 7.2 units". The knowledge existed; nothing enforced it. Now
 * something does.
 *
 * `frames` is `[{label, layers}]`; `worst` names the frame that reached
 * furthest on each side, so the message says which pose to look at.
 */
export function boxOverflow(vb, frames) {
	const bounds = {minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity};
	const worst = {};
	for (const f of frames) {
		for (const l of f.layers) {
			for (let i = 0; i < l.pts.length; i += 2) {
				const x = l.pts[i];
				const y = l.pts[i + 1];
				if (x < bounds.minX) [bounds.minX, worst.left] = [x, f.label];
				if (x > bounds.maxX) [bounds.maxX, worst.right] = [x, f.label];
				if (y < bounds.minY) [bounds.minY, worst.above] = [y, f.label];
				if (y > bounds.maxY) [bounds.maxY, worst.below] = [y, f.label];
			}
		}
	}
	const over = {
		above: vb.y - bounds.minY,
		below: bounds.maxY - (vb.y + vb.h),
		left: vb.x - bounds.minX,
		right: bounds.maxX - (vb.x + vb.w),
	};
	return {bounds, over, worst};
}

export function buildAnimal(def) {
	const {rig, sequence, colours, name} = def;
	const k = rig.k ?? 1;
	const vb = rig.viewBox;
	const stageW = sequence.stage.aspect * vb.h;
	const stride = (cls) => (cls === "near" ? rig.emitStride ?? 1 : rig.emitStrideFar ?? 1);
	const {poses, segs, onStage} = samplePoses(def);
	const {failures, retries, problems: clipProblems} = outlineSequence(def, poses, segs);
	const {xs, v, flips} = travelOf(def, poses, segs);
	// Outlined here rather than beside the file it is written into, so the
	// containment rule below sees it: the still is a stored frame like any
	// other and clips like any other (the bunny's ears were cut off in both).
	const stillV = {};
	for (const ch of rig.channels())
		stillV[ch.name] = rig.still[ch.name] ?? rig.still[ch.key] ?? ch.rest ?? 0;
	const stillLayers = outlineFrame(rig, stillV, null).layers;
	const problems = [...clipProblems];
	if (failures) problems.push(`${failures} frame(s) whose union failed after retries`);
	if (flips.length > 1) problems.push("more than one turn (a file carries one flip)");
	// The idle tail inside one period: the visit occupies [first, first + onStage],
	// so this is how long the animal is away before the period ends. It is the
	// "is it gone long enough" check, and deliberately NOT the chain's restart
	// offset — see `restart` below, where confusing the two was a real bug.
	const gap = sequence.period - sequence.first - onStage;
	if (gap < 2)
		problems.push(`the off-stage gap is ${gap.toFixed(1)} s (need ≥ 2 s): raise the period`);
	const x0 = -vb.x;
	const xEnd = x0 + xs[xs.length - 1];
	if (!(xEnd + vb.x + vb.w <= 0 || xEnd + vb.x >= stageW)) {
		problems.push(
			`the sequence ends on stage at x=${xEnd.toFixed(
				0
			)} of ${stageW}: add cycles to the last gait`
		);
	}
	const exitTime = findExitTime(poses, xs, x0, vb, stageW);
	const tExit = exitTime.found ? exitTime.t : onStage;
	let worstNear = 0;
	let worstFar = 0;
	for (const seg of segs) {
		for (let i = 1; i < seg.frames.length; i++) {
			seg.frames[i].layers.forEach((l, li) => {
				const a = lengthOf(seg.frames[i - 1].layers[li].pts);
				const d = Math.abs(lengthOf(l.pts) - a) / a;
				if (l.cls === "near") worstNear = Math.max(worstNear, d);
				else worstFar = Math.max(worstFar, d);
			});
		}
	}
	if (worstNear > 0.05)
		problems.push(
			`the near outline's length jumps ${(worstNear * 100).toFixed(
				1
			)} % between frames (limit 5 %)`
		);
	if (worstFar > 0.1)
		problems.push(
			`a far leg's outline length jumps ${(worstFar * 100).toFixed(
				1
			)} % between frames (limit 10 %)`
		);

	// Nothing may be drawn outside its own viewBox — see `boxOverflow`. The
	// hearts are in this too, as the two corners of the box the glyph sweeps
	// at the top of its rise: they ride inside the same groups and clip to
	// the same viewBox, and they are the one thing here already known to have
	// been clipped away *entirely* (see the puppy rig's header), so a rule
	// that watched only the outlines would still not have caught them. Their
	// `d` is in the file's k-scaled space while `x`/`y`/`rise` are scaled by
	// `k` on the way out, so the glyph's own bounds come back to rig units
	// divided by `k`.
	const heartBox = [];
	if (def.hearts) {
		const b = pathOf(def.hearts.d).bounds;
		heartBox.push({
			label: "the hearts",
			layers: [
				{
					pts: [
						def.hearts.x + b.left / k,
						def.hearts.y - def.hearts.rise + b.top / k,
						def.hearts.x + b.right / k,
						def.hearts.y + b.bottom / k,
					],
				},
			],
		});
	}
	const box = boxOverflow(vb, [
		...segs.flatMap((s) =>
			s.frames.map((f, i) => ({label: `${s.id} frame ${i}`, layers: f.layers}))
		),
		{label: "the still", layers: stillLayers},
		...heartBox,
	]);
	const spill = Object.entries(box.over)
		.filter(([, d]) => d > BOX_MARGIN)
		.map(([side, d]) => `${d.toFixed(1)} ${side} (${box.worst[side]})`);
	if (spill.length)
		problems.push(
			`the outline leaves the viewBox by ${spill.join(", ")}, in rig units: the box is ` +
				`x ${fmt(vb.x)}…${fmt(vb.x + vb.w)}, y ${fmt(vb.y)}…${fmt(vb.y + vb.h)} and the ` +
				`outline reaches x ${fmt(box.bounds.minX, 1)}…${fmt(box.bounds.maxX, 1)}, ` +
				`y ${fmt(box.bounds.minY, 1)}…${fmt(box.bounds.maxY, 1)}. Grow the box, and with ` +
				`it the theme's --ps-<animal>-h (× the new h / the old) and this rig's ` +
				`stage.aspect (× the old h / the new), or the animal changes size and travel`
		);

	const lastId = segs[segs.length - 1].id;
	const clips = segs.map((seg, i) => ({
		id: seg.id,
		repeat: seg.gait ? seg.cycles : 1,
		dur: seg.dur,
		keyTimes: seg.frames.map((f) => f.t / seg.dur),
		values: seg.frames.map((f) => f.layers.map((l) => encodePath(l.pts, k, stride(l.cls)))),
		begin: i === 0 ? null : `${segs[i - 1].id}.end`,
	}));
	const P = sequence.period;

	// What the clip chain restarts on, and it is NOT `gap`.
	//
	// The shape clips are a syncbase chain: each begins on the previous one's
	// `.end`, and the first restarts on the last one's `.end` plus this offset.
	// The travel, the flip and the fade are separate animateTransforms with
	// `dur` = the period, repeating on the document clock. Two clocks, and they
	// only stay together if the chain's period is exactly the travel's.
	//
	// The last clip ends at `first + onStage`, and the next visit must begin at
	// `first + period`, so the offset is `period - onStage`. Using `gap`
	// (`period - first - onStage`, the right number for the "is it away long
	// enough" check below) restarts the chain at `period` instead — `first`
	// seconds early, every single loop. The pose then walks out of phase with
	// the position by `first` seconds per period until the animal is drawn in
	// an arbitrary pose while its position glides on regardless. That was the
	// "animations lose sync and the animals just glide around" report, and at
	// the puppy's `first: 14` against a 75 s period it only takes a few loops.
	//
	// Derive it from the durations *as they will be written* rather than from
	// the unrounded `onStage`: every `dur` is emitted through `fmt`, so a chain
	// summed from unrounded values would still creep a fraction of a
	// ten-thousandth each loop. Subtracting the rounded sum from the period
	// makes the emitted chain period exactly the emitted travel period, with no
	// residue to accumulate.
	const roundedOnStage = clips.reduce((a, c) => a + Number(fmt(c.dur)) * c.repeat, 0);
	const restart = P - roundedOnStage;
	clips[0].begin = `${fmt(sequence.first)}s;${lastId}.end+${fmt(restart)}s`;

	const chainPeriod = roundedOnStage + Number(fmt(restart));
	if (Math.abs(chainPeriod - P) > 0.0005)
		problems.push(
			`the clip chain's period is ${chainPeriod.toFixed(4)} s against a travel period of ` +
				`${P.toFixed(4)} s: the shape animation would drift out of phase with the ` +
				`position by ${(P - chainPeriod).toFixed(4)} s every loop`
		);
	const curve = travelCurve(poses, xs, segs, flips, sequence.first, P);
	const xLast = (x0 + curve.xs[curve.xs.length - 1]) * k;
	const {fade, keyTimes: fadeKeyTimes} = fadeTimes({
		first: sequence.first,
		onStage,
		tExit,
		period: P,
	});
	const travel = {
		period: P,
		first: sequence.first,
		onStage,
		tExit,
		fade,
		fadeKeyTimes,
		keyTimes: [
			0,
			...curve.times.map((t) => (sequence.first + t) / P),
			(sequence.first + onStage) / P,
			1,
		],
		xs: [x0 * k, ...curve.xs.map((x) => (x0 + x) * k), xLast, xLast],
	};
	const flip = flips.length ? {at: (sequence.first + flips[0]) / P} : null;
	const heartSeg = segs.find((s) => s.hearts);
	const hearts =
		def.hearts && heartSeg
			? {
					d: def.hearts.d,
					fill: mix("#d9457f", SKY, 0.35),
					x: def.hearts.x * k,
					y: def.hearts.y * k,
					rise: def.hearts.rise * k,
					begin: def.hearts.times.map((t) => `${heartSeg.id}.begin+${fmt(t)}s`).join(";"),
			  }
			: null;

	const layersWith = (near, far) =>
		segs[0].frames[0].layers.map((l) => ({cls: l.cls, fill: l.cls === "near" ? near : far}));
	const spec = (layers) => ({
		viewBox: vb,
		k,
		stageW,
		layers,
		clips,
		travel,
		flip,
		hearts,
		decor: def.decor,
	});
	const farTint = mix(colours.far, SKY, 0.45);
	const farLayers = layersWith(farTint, farTint);
	// Lazy, so a rig that ships no near tint need not invent a near colour:
	// `colours.near` is read only where the near file is actually written.
	const nearLayers = () => layersWith(mix(colours.near, SKY, 0.35), mix(colours.far, SKY, 0.35));

	const stillFrame = stillLayers.map((l) => encodePath(l.pts, k, stride(l.cls)));

	// Which *tints* are written, not which layers exist: every rig still has
	// near and far layers, and the far tint simply paints them all alike. A
	// rig cast only in the distance (the dolphin) asks for `["far"]` and
	// ships two files instead of four. The order below is the order all four
	// have always been written in.
	const variants = def.variants ?? ["near", "far"];
	if (!variants.length || variants.some((t) => t !== "near" && t !== "far")) {
		problems.push(
			`variants must be a non-empty subset of ["near", "far"], not ${JSON.stringify(
				def.variants
			)}`
		);
	}
	const wants = (tint) => variants.includes(tint);
	/** @type {Record<string, string>} */
	const files = {};
	if (wants("near")) files[`${name}.svg`] = animalSvg(spec(nearLayers()));
	if (wants("far")) files[`${name}-far.svg`] = animalSvg(spec(farLayers));
	// `stillDecor`, never `decor`: stage scenery is authored against a box
	// `aspect × vb.h` wide and would crop to a band in the rig's own box.
	if (wants("near"))
		files[`${name}-still.svg`] = stillSvg({
			viewBox: vb,
			k,
			layers: nearLayers(),
			frame: stillFrame,
			decor: def.stillDecor,
		});
	if (wants("far"))
		files[`${name}-far-still.svg`] = stillSvg({
			viewBox: vb,
			k,
			layers: farLayers,
			frame: stillFrame,
			decor: def.stillDecor,
		});
	for (const [f, s] of Object.entries(files)) {
		const limit = f.includes("still") ? 8 * 1024 : def.budget;
		if (s.length > limit)
			problems.push(`${f} is ${(s.length / 1024).toFixed(0)} KB (limit ${limit / 1024} KB)`);
	}
	const speeds = segs.map((s) => {
		const vs = v.slice(s.start, s.start + s.count);
		const measured = vs.reduce((a, b) => a + Math.abs(b), 0) / vs.length;
		const mean = Array.isArray(s.travel)
			? (s.travel[0] + s.travel[1]) / 2
			: typeof s.travel === "number"
			? s.travel
			: measured;
		const hold = (s.hold ?? 0) > 0 || !!s.wobble;
		if (hold && Math.abs(mean) >= 5)
			problems.push(
				`${s.id} (${
					s.gait ?? s.blendTo ?? s.wobble ?? s.pose
				}) is a hold but applies ${mean.toFixed(1)} units/s (must be < 5)`
			);
		return {
			id: s.id,
			kind: s.gait ?? s.blendTo ?? s.wobble ?? s.pose,
			mean,
			measured,
			hold,
		};
	});
	const clipTotalDur = clips.reduce((a, c) => a + c.dur * c.repeat, 0);
	if (Math.abs(clipTotalDur - onStage) > 0.005)
		problems.push(
			`the clip chain totals ${clipTotalDur.toFixed(3)} s but ${onStage.toFixed(
				3
			)} s was sampled (must agree within 5 ms)`
		);
	const audit = {
		frames: segs.reduce((a, s) => a + s.frames.length, 0),
		onStage,
		clipTotalDur,
		gap,
		retries,
		failures,
		worstNear,
		worstFar,
		xEnd,
		stageW,
		tExit,
		tExitFallback: !exitTime.found,
		speeds,
		bytes: Object.fromEntries(Object.entries(files).map(([f, s]) => [f, s.length])),
		problems,
	};
	return {files, audit};
}
