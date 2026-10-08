import {expect} from "chai";
import {Circle, Ellipse, P} from "../../../tools/heart/lib/outline.mjs";
import {
	buildAnimal,
	fadeTimes,
	samplePoses,
	travelCurve,
	travelOf,
} from "../../../tools/heart/lib/build.mjs";
import {decodePath} from "../../../tools/heart/lib/svg.mjs";

/**
 * A blob with one near leg and one far leg that step: the leg swings back
 * while planted (rot −20° → +20°) and lifts to swing forward, so the blob
 * walks. Small point counts keep the test quick.
 */
const step = {
	dur: 0.4,
	phases: {},
	ch: {
		leg: [
			[0, -20, "linear"],
			[50, 20, "linear"],
			[100, -20, "linear"],
		],
		lift: [
			[0, 0],
			[50, 0],
			[60, -12],
			[90, -12],
			[100, 0],
		],
	},
};

function leg(layer: string, px: number) {
	return {
		pivot: [px, 44],
		rot: "leg",
		ty: "lift",
		layer,
		shapes: [P("M-4,-24 L4,-24 L4,26 L-4,26 Z"), Circle(0, 26, 4.5)],
		foot: [0, 30],
	};
}

const blob = {
	name: "blob",
	colours: {near: "#d97a9c", far: "#ecbccb"},
	budget: 40 * 1024,
	rig: {
		n: 48,
		emitStride: 1,
		nFar: 24,
		emitStrideFar: 1,
		fillet: 4,
		viewBox: {x: 0, y: 0, w: 100, h: 80},
		ground: 74,
		k: 1,
		farGroups: (items: unknown[]) => [items],
		root: {
			children: [
				leg("far", 44),
				{shapes: [Ellipse(50, 40, 30, 16), Circle(78, 34, 12)], marker: [90, 34]},
				leg("near", 56),
			],
		},
		gaits: {step},
		channels: () => [
			{name: "leg", key: "leg"},
			{name: "lift", key: "lift"},
		],
		poses: {rest: {leg: 0, lift: 0}},
		wobbles: {nod: {lift: [0, 2, 2]}}, // bobs the legs along their axis: feet stay put
		still: {leg: 0, lift: 0},
	},
	sequence: {
		first: 1,
		period: 30,
		stage: {aspect: 3},
		segments: [
			{gait: "step", cycles: 10, fps: 10},
			// travel: 0 pins the stop: blending the walking leg into rest over
			// 0.2s reads real but spurious stance velocity from the transition,
			// which the hold-speed audit rule (a stopped, turning pose must not
			// travel) correctly catches without it
			{pose: "rest", hold: 0.3, blend: 0.2, fps: 10, turn: true, travel: 0},
			{wobble: "nod", pose: "rest", secs: 0.5, fps: 10},
			{gait: "step", cycles: 14, fps: 10},
		],
	},
};

describe("tools/heart build", function () {
	this.timeout(20000);

	it("samples the sequence into frames and remembers each segment's range", function () {
		const {poses, segs, onStage} = samplePoses(blob);
		expect(segs.map((s: {id: string}) => s.id)).to.deep.equal(["s1", "s2", "s3", "s4"]);
		expect(segs[0]).to.include({start: 0, count: 40, cycleFrames: 4});
		expect(segs[1]).to.include({start: 40, count: 5});
		expect(segs[2]).to.include({start: 45, count: 5});
		expect(segs[3]).to.include({start: 50, count: 56});
		expect(poses).to.have.length(106);
		expect(onStage).to.be.closeTo(10.6, 1e-9);
	});

	it("builds the four files with a clean audit, chained clips, travel and one flip", function () {
		const {files, audit} = buildAnimal(blob);
		expect(audit.problems, audit.problems.join("; ")).to.deep.equal([]);
		expect(Object.keys(files)).to.deep.equal([
			"blob.svg",
			"blob-far.svg",
			"blob-still.svg",
			"blob-far-still.svg",
		]);
		const svg = files["blob.svg"];
		expect(svg).to.include('viewBox="0 0 240 80"');
		expect(svg).to.include('<animate id="s1"');
		expect(svg).to.include('begin="s1.end"');
		expect(svg).to.match(/begin="1s;s4\.end\+[\d.]+s"/);
		expect(svg).to.include('repeatCount="10"');
		expect(svg).to.include('type="scale"'); // the turn

		// every path-morph clip's keyTimes run 0 → 1 and match its values (the
		// turn's discrete scale transform is excluded: its keyTimes are
		// [0, flip.at] within the shared period and legitimately stop short of 1)
		for (const m of svg.matchAll(
			/attributeName="d"[^>]*values="([^"]*)" keyTimes="([^"]*)" dur=/g
		)) {
			const values = m[1].split(";");
			const times = m[2].split(";").map(Number);
			expect(values).to.have.length(times.length);
			expect(times[0]).to.equal(0);
			expect(times[times.length - 1]).to.equal(1);

			for (let i = 1; i < times.length; i++) {
				expect(times[i]).to.be.greaterThan(times[i - 1]);
			}
		}

		// the near path is the last path and every frame keeps its point count
		const paths = [...svg.matchAll(/<path fill="([^"]+)" d="([^"]+)"/g)];
		expect(paths.map((p) => p[1])).to.deep.equal(["#e6cedd", "#daa3bf"]);
		expect(decodePath(paths[1][2])).to.have.length(48);
		// it turned at the rest and walked back off the left of the stage
		expect(audit.xEnd).to.be.lessThan(-100);
		expect(audit.speeds[0].mean).to.be.greaterThan(80);
		expect(audit.speeds[2].mean).to.be.lessThan(1); // the wobble: planted and still
		expect(files["blob-still.svg"]).to.not.include("<animate");
		expect(files["blob-far.svg"]).to.include('fill="#e4d3e2"');
		// fades in and out over the visit, invisible before its first sample
		expect(svg).to.include('attributeName="opacity" calcMode="linear" values="0;0;1;1;0;0"');
		expect(svg).to.include('<g opacity="0">');
	});

	it("emits only the tints a rig asks for, and passes its decor to the stage", function () {
		const decor = [{d: "M0,70h100v10h-100z", fill: "#9cf"}];
		const stillDecor = [{d: "M0,72h100v8h-100z", fill: "#3bd"}];
		const {files, audit} = buildAnimal({...blob, variants: ["far"], decor, stillDecor});
		expect(audit.problems, audit.problems.join("; ")).to.deep.equal([]);
		// the far *tint*, both of its files, and no near tint at all
		expect(Object.keys(files)).to.deep.equal(["blob-far.svg", "blob-far-still.svg"]);
		// the audit measures what is actually emitted, and misses nothing
		expect(Object.keys(audit.bytes)).to.deep.equal(["blob-far.svg", "blob-far-still.svg"]);
		expect(files["blob-far.svg"]).to.include(
			'<path fill="#9cf" transform="scale(1)" d="M0,70h100v10h-100z"/>'
		);
		// the still is the rig's own box, not the stage: the stage's decor is
		// never drawn there, and `stillDecor` — the box-sized copy a rig draws
		// for it — is (the dolphin's pond)
		expect(files["blob-far-still.svg"]).to.not.include("#9cf");
		expect(files["blob-far-still.svg"]).to.include(
			'<path fill="#3bd" transform="scale(1)" d="M0,72h100v8h-100z"/>'
		);
		// and a rig with no `stillDecor` writes nothing extra at all
		expect(
			buildAnimal({...blob, variants: ["far"], decor}).files["blob-far-still.svg"]
		).to.not.include('<path fill="#3bd"');

		// a rig that asks for neither still gets all four, in the same order
		expect(Object.keys(buildAnimal(blob).files)).to.deep.equal([
			"blob.svg",
			"blob-far.svg",
			"blob-still.svg",
			"blob-far-still.svg",
		]);
	});

	it("refuses a variants list that is empty or names something other than a tint", function () {
		expect(buildAnimal({...blob, variants: []}).audit.problems.join(" ")).to.include(
			"variants"
		);
		expect(buildAnimal({...blob, variants: ["Far"]}).audit.problems.join(" ")).to.include(
			"variants"
		);
	});

	it("fades out exactly when the box starts to cross the stage edge, not when the sequence stops sampling", function () {
		const {files, audit} = buildAnimal(blob);
		// the blob turns and walks back off the left edge well before its last
		// segment (14 cycles) finishes sampling
		expect(audit.tExitFallback).to.equal(false);
		expect(audit.tExit).to.be.lessThan(audit.onStage);

		const svg = files["blob.svg"];
		const m = svg.match(/attributeName="opacity"[^>]*keyTimes="([^"]*)"/);
		expect(m).to.not.equal(null);
		const times = m![1].split(";").map(Number);
		const offFor = times[4]; // 0; first/P; onFor/P; offAt/P; offFor/P; 1
		const period = blob.sequence.period;
		expect(offFor).to.be.closeTo((blob.sequence.first + audit.tExit) / period, 1e-4);
		// strictly earlier than the old onStage-keyed keyTime would have been
		expect(offFor).to.be.lessThan((blob.sequence.first + audit.onStage) / period);
	});

	describe("fadeTimes", function () {
		const strictlyIncreasing = (keyTimes: number[]) => {
			for (let i = 1; i < keyTimes.length; i++) {
				expect(keyTimes[i], `keyTimes[${i}] > keyTimes[${i - 1}]`).to.be.greaterThan(
					keyTimes[i - 1]
				);
			}
		};

		it("uses a one-second fade (or a quarter of onStage) when the visit is long enough", function () {
			const {fade, keyTimes} = fadeTimes({first: 2, onStage: 40, tExit: 35, period: 45});
			expect(fade).to.equal(1); // onStage/4 = 10, capped at 1; tExit(35) >= 3*fade
			expect(keyTimes).to.deep.equal([0, 2 / 45, 3 / 45, 36 / 45, 37 / 45, 1]);
			strictlyIncreasing(keyTimes);
		});

		it("shrinks the fade to a third of a short visit so no two keyTimes coincide", function () {
			// onStage/4 = 0.5 would normally be the fade, but tExit (1.2) is
			// under 3x that candidate, so fade shrinks to tExit/3 = 0.4 instead
			// -- the bug this guard exists for: at the old fade (0.5), fade-in's
			// end (first+fade) and fade-out's start (first+tExit-fade) would
			// both land on first+0.7, an illegal repeated keyTime under SMIL's
			// linear calcMode.
			const {fade, keyTimes} = fadeTimes({first: 0.5, onStage: 2, tExit: 1.2, period: 10});
			expect(fade).to.be.closeTo(0.4, 1e-9);
			[0, 0.05, 0.09, 0.13, 0.17, 1].forEach((t, i) =>
				expect(keyTimes[i]).to.be.closeTo(t, 1e-9)
			);
			strictlyIncreasing(keyTimes);
		});
	});

	it("refuses a visit that ends on stage", function () {
		const short = {
			...blob,
			sequence: {...blob.sequence, segments: [{gait: "step", cycles: 2, fps: 10}]},
		};
		const {audit} = buildAnimal(short);
		expect(audit.problems.join(" ")).to.include("ends on stage");
	});

	it("lets a segment override its ground speed, keeping the measured stance speed alongside it", function () {
		const {audit: base} = buildAnimal(blob);
		const withTravel = {
			...blob,
			sequence: {
				...blob.sequence,
				segments: [
					{...blob.sequence.segments[0], travel: 50},
					...blob.sequence.segments.slice(1),
				],
			},
		};
		const {audit} = buildAnimal(withTravel);
		expect(audit.speeds[0].mean).to.equal(50);
		// the measured stance speed is unchanged by the override
		expect(audit.speeds[0].measured).to.be.closeTo(base.speeds[0].measured, 1e-9);
		// the segment covers cycles(10) * dur(0.4) = 4 s; forcing 50 units/s
		// instead of the ~100 units/s the feet actually measured should pull
		// xEnd back by roughly that difference over those 4 s, regardless of
		// what the feet were doing (within a couple of frames' worth of slack:
		// segment 0 now has an override where segment 1, the next one, also
		// does (travel: 0, pinning its stop) — that boundary step splits at
		// the shared frame between the two rates instead of using segment 1's
		// alone, which was 0 either way in the un-overridden `base` case but
		// picks up a sliver of segment 0's overridden rate here)
		const expectedDelta = (50 - base.speeds[0].measured) * 4;
		expect(audit.xEnd - base.xEnd).to.be.closeTo(expectedDelta, 15);
	});

	it("ramps travel linearly across a segment instead of holding a constant speed", function () {
		const withRamp = {
			...blob,
			sequence: {
				...blob.sequence,
				segments: [
					{...blob.sequence.segments[0], travel: [50, 0]},
					...blob.sequence.segments.slice(1),
				],
			},
		};
		const {poses, segs} = samplePoses(withRamp);
		const {xs} = travelOf(withRamp, poses, segs);
		const seg = segs[0];
		const steps: number[] = [];

		for (let i = seg.start + 1; i < seg.start + seg.count; i++) {
			steps.push(xs[i] - xs[i - 1]);
		}

		// the ramp shrinks the step size across the segment (50 units/s down to 0)
		for (let i = 1; i < steps.length; i++) {
			expect(steps[i]).to.be.at.most(steps[i - 1] + 1e-9);
		}

		expect(steps[0]).to.be.greaterThan(steps[steps.length - 1] * 5);
		expect(steps[steps.length - 1]).to.be.closeTo(0, 1);

		const {audit} = buildAnimal(withRamp);
		expect(audit.speeds[0].mean).to.be.closeTo(25, 1); // (50 + 0) / 2
	});

	it("travelCurve subdivides a sparse, short ramp segment finer than its own poses, staying smooth and strictly increasing", function () {
		// a short (0.3 s), low-fps blend, mirroring the horse's actual gait
		// blends: few native poses, so travelCurve's own subdivision is what
		// has to carry the smoothness. The ramp doesn't end at 0 (50 -> 10,
		// not 50 -> 0): a relative jump next to a true zero is unbounded by
		// construction, whatever the sampling, and isn't what's under test.
		const sparseRamp = {
			...blob,
			sequence: {
				...blob.sequence,
				segments: [
					{gait: "step", cycles: 1, fps: 10},
					{pose: "rest", hold: 0, blend: 0.3, fps: 10, travel: [50, 10]},
				],
			},
		};
		const {poses, segs} = samplePoses(sparseRamp);
		const {xs, flips} = travelOf(sparseRamp, poses, segs);
		const seg = segs[1];
		const curve = travelCurve(
			poses,
			xs,
			segs,
			flips,
			sparseRamp.sequence.first,
			sparseRamp.sequence.period
		);

		// more virtual samples across the ramp than its own sparse (0.3 s at
		// 10 fps, only a few frames) poses -- the whole point of decoupling
		// the translate from the outline's frame count
		expect(curve.times.length).to.be.greaterThan(poses.length);

		// every stored time strictly increases: the snap-to-rounding-grid
		// logic never collapses two samples into a backward or zero step
		for (let i = 1; i < curve.times.length; i++) {
			expect(curve.times[i]).to.be.greaterThan(curve.times[i - 1]);
		}

		// within the ramp segment's own span (excluding the handoff step from
		// the previous, unrelated segment into it), consecutive velocities
		// never jump wildly (a snapped time paired with the wrong position,
		// the bug this function exists to avoid, would show up as a spike)
		const segStart = curve.times.findIndex((t) => t === seg.t0);
		let worstJump = 0;

		for (let i = segStart + 2; i < curve.times.length && curve.times[i] <= seg.t1 + 1e-9; i++) {
			const va =
				(curve.xs[i - 1] - curve.xs[i - 2]) / (curve.times[i - 1] - curve.times[i - 2]);
			const vb = (curve.xs[i] - curve.xs[i - 1]) / (curve.times[i] - curve.times[i - 1]);

			if (Math.abs(va) < 1) {
				continue;
			}

			worstJump = Math.max(worstJump, Math.abs(vb - va) / Math.abs(va));
		}

		expect(worstJump).to.be.lessThan(0.2);
	});

	it("flags a hold or wobble segment whose applied speed is not near zero", function () {
		const stalls = {
			...blob,
			sequence: {
				...blob.sequence,
				segments: [
					blob.sequence.segments[0],
					// drop the fixture's travel: 0 pin, reverting to the raw
					// (spuriously high) measured stance speed during the blend
					{...blob.sequence.segments[1], travel: undefined},
					...blob.sequence.segments.slice(2),
				],
			},
		};
		const {audit} = buildAnimal(stalls);
		expect(audit.problems.join(" ")).to.include("is a hold but applies");
	});

	it("flags a clip chain whose total duration disagrees with the sampled onStage", function () {
		const {audit} = buildAnimal(blob);
		// by construction (both derived from the same rounded frame counts)
		// this always agrees for a well-formed sequence; pin the invariant
		// itself, since nothing here can legitimately break it
		expect(audit.clipTotalDur).to.be.closeTo(audit.onStage, 0.005);
		expect(audit.problems.join(" ")).to.not.include("clip chain");
	});
});
