// The <3 theme's teddy bear (tools/heart/README.md): the cast's only upright
// biped. Facing right, ground y = 100.
//
// A teddy reads by four proportions and nothing else: a head nearly as wide
// as the body (36 against 42), round ears clearly clear of the skull, stubby
// limbs, and no neck. The animation adds the fifth thing, the side-to-side
// rock, which no still frame can carry.
//
// Rotation sign: paper.js rotates clockwise on screen for a positive angle
// (y points down), so a part drawn hanging straight down swings *backward*
// for a positive angle. Every table below is written against that.
//
// **An arm and a leg hanging from the same x is this rig's whole difficulty**,
// and it is not one the quadrupeds have (their front and hind legs are 34
// apart and never meet). Wherever the near arm and the near leg both stick
// out below the torso, a swing brings their edges near-parallel and the
// sliver between them closes into a pocket `largest()` drops — a topology
// jump no frame rate fixes. Two rules keep it out, and anything that moves
// the shoulder, the hip, the arm's length or the torso's bottom has to
// re-check `generate.mjs`'s outline figure against both: the arm reaches
// only ~5 units below the torso, so the two overlap and separate *inside*
// the body where the outline cannot see it; and the paw goes up while the
// bear is standing, never while it sits (see `sitting`).

import {P, Circle, Ellipse, scaled} from "../lib/outline.mjs";

const D = {};
// three ellipses: the shoulders fill the head/body notch so a teddy's neck
// stays a dimple rather than reading as an actual neck
D.body = [Ellipse(50, 59, 17, 9), Ellipse(50, 68, 21, 16), Ellipse(50, 75, 18, 10)];
// head node pivot (50, 52) — buried in the torso, so there is no neck; the
// muzzle clears the skull by 5.5 units, which is what points the bear right
D.head = [Circle(0, -11, 18), Ellipse(13, -2.5, 8.5, 6.8)];
// Ears: discs on the ear node, whose pivot is the skull centre, so `ear`
// swings the pair along the skull's rim and the overlap never changes. Each
// overlaps the skull by ~2.5 units — a third of its own radius — which unions
// cleanly and still leaves a 6-unit-deep valley between two round bumps.
D.ears = [Circle(15.7, -16.9, 7.6), Circle(-15.3, -16.5, 7)];
D.uarm = [P("M-5,-5 C-6.5,4 -5.6,11 -4.6,21 L4.6,21 C5.6,11 6.5,4 5,-5 Z"), Circle(0, 21, 5)];
D.paw = [Ellipse(0, 4.5, 5.5, 5)];
D.thigh = [P("M-7,-6 C-8.5,0 -7.5,6 -6,12 L6,12 C7.5,6 8.5,0 7,-6 Z"), Circle(0, 12, 6.3)];
D.shin = [P("M-5.8,0 C-6.4,4 -5.8,8 -5.2,12 L5.2,12 C5.8,8 6.4,4 5.8,0 Z"), Circle(0, 12, 5.6)];
D.foot = [P("M-5,-4 C-7.5,0 -5.5,8 -1,8 C5,8 9,4 8,-4 Z")];

/** Shoulder (arm → paw). */
function arm(side, px, py) {
	const k = (c) => `arm.${side}.${c}`;
	const thin = side === "far" ? 0.85 : 1;
	const len = side === "far" ? 0.95 : 1;
	return {
		pivot: [px, py],
		rot: k("up"),
		layer: side,
		shapes: scaled(D.uarm, thin, len),
		children: [
			{
				pivot: [0, 21 * len],
				rot: k("paw"),
				layer: side,
				shapes: scaled(D.paw, thin, len),
				marker: [5.5 * thin, 4.5 * len],
			},
		],
	};
}

/**
 * Hip → knee → ankle → boot. The knee is what makes the waddle work: a
 * two-segment leg is at its lowest exactly where the swing needs lift (a
 * pendulum's foot is highest at the extremes), so it can only clear the
 * ground by flipping its sole up, and the stance measurement reads the whole
 * swing as planted. Folding the knee lifts the boot 8–9 units instead.
 */
function leg(side, px, py) {
	const k = (c) => `leg.${side}.${c}`;
	const thin = side === "far" ? 0.85 : 1;
	// 7 % shorter, not the cast's usual 5 %: the waddle's rock is a rotation
	// about (50, 100), so at every double support it lifts the forward foot and
	// drops the rear one by ~1.3 units each — and the rear one is the far leg.
	// 5 % left the far boot planting 1.2 units *below* the near one there.
	const len = side === "far" ? 0.93 : 1;
	return {
		pivot: [px, py],
		rot: k("thigh"),
		layer: side,
		shapes: scaled(D.thigh, thin, len),
		children: [
			{
				pivot: [0, 12 * len],
				rot: k("knee"),
				layer: side,
				shapes: scaled(D.shin, thin, len),
				children: [
					{
						pivot: [0, 12 * len],
						rot: k("foot"),
						layer: side,
						shapes: scaled(D.foot, thin, len),
						marker: [9 * thin, -4 * len],
						foot: [0, 8 * len],
					},
				],
			},
		],
	};
}

/**
 * One gait. Phases 0 and 0.5: each leg is planted for exactly half the cycle,
 * so the two halves of `ty` are the same shape and the far leg's stance sees
 * the same body height the near leg's did.
 *
 * The stance keys (0–50 %, all `linear`) are not eyeballed: they are the
 * closed-form two-link solution that puts the boot's contact point on
 * `y = 100` and slides it back at exactly the pinned rate, so the planted
 * boot never slips. `ty` is part of that solution rather than a styling
 * choice — with the knee held at 8° through stance the body's height is
 * fixed by how far the contact is from under the hip, and it is that
 * geometry, not taste, that gives the walk its bob (lowest at double
 * support, highest at mid-stance). Change the stride or the stance knee and
 * both tables have to be re-solved together.
 */
const waddle = {
	dur: 0.75,
	phases: {near: 0, far: 0.5},
	ch: {
		"leg.thigh": [
			[0, -31.5, "linear"],
			[8, -22.3, "linear"],
			[17, -12.5, "linear"],
			[25, -4.1, "linear"],
			[33, 4.4, "linear"],
			[42, 14.1, "linear"],
			[50, 23.2],
			[58, -6.9],
			[66, -23.5],
			[74, -41.6],
			[82, -51.7],
			[90, -47.9],
			[95, -40.2],
			[100, -31.5],
		],
		"leg.knee": [
			[0, 8.3, "linear"],
			[8, 8.2, "linear"],
			[17, 8.1, "linear"],
			[25, 8.1, "linear"],
			[33, 8.1, "linear"],
			[42, 8.2, "linear"],
			[50, 8.3],
			[58, 67.4],
			[66, 94.6],
			[74, 101.7],
			[82, 87.2],
			[90, 57.4],
			[95, 33.1],
			[100, 8.3],
		],
		"leg.foot": [
			[0, 23.2, "linear"],
			[8, 14.1, "linear"],
			[17, 4.4, "linear"],
			[25, -4.1, "linear"],
			[33, -12.5, "linear"],
			[42, -22.3, "linear"],
			[50, -31.5],
			[58, -38.5],
			[66, -57.1],
			[74, -56.1],
			[82, -39.5],
			[90, -13.4],
			[95, 5.1],
			[100, 23.2],
		],
		"arm.up": [
			[0, 30],
			[25, 0],
			[50, -30],
			[75, 0],
			[100, 30],
		],
		"arm.paw": [
			[0, 6],
			[50, -8],
			[100, 6],
		],
		lean: [
			[0, -6],
			[25, 0],
			[50, 6],
			[75, 0],
			[100, -6],
		],
		ty: [
			[0, 2.74, "linear"],
			[8, 1.26, "linear"],
			[17, 0.32, "linear"],
			[25, 0.06, "linear"],
			[33, 0.32, "linear"],
			[42, 1.26, "linear"],
			[50, 2.74, "linear"],
			[58, 1.26, "linear"],
			[67, 0.32, "linear"],
			[75, 0.06, "linear"],
			[83, 0.32, "linear"],
			[92, 1.26, "linear"],
			[100, 2.74, "linear"],
		],
		sx: [
			[0, 1],
			[100, 1],
		],
		sy: [
			[0, 1],
			[100, 1],
		],
		head: [
			[0, 3],
			[50, -3],
			[100, 3],
		],
		ear: [
			[0, -5],
			[50, 5],
			[100, -5],
		],
	},
};

function channels() {
	const ch = [];
	for (const side of ["near", "far"]) {
		const phase = waddle.phases[side];
		for (const c of ["thigh", "knee", "foot"]) {
			ch.push({name: `leg.${side}.${c}`, key: `leg.${c}`, phase});
		}

		for (const c of ["up", "paw"]) {
			ch.push({name: `arm.${side}.${c}`, key: `arm.${c}`, phase});
		}
	}

	for (const [c, rest] of [
		["lean", 0],
		["ty", 0],
		["sx", 1],
		["sy", 1],
		["head", 0],
		["ear", 0],
	]) {
		ch.push({name: c, key: c, rest});
	}

	return ch;
}

const stand = {
	"leg.near.thigh": -2.5,
	"leg.far.thigh": -2.5,
	"leg.near.knee": 5,
	"leg.far.knee": 5,
	"leg.near.foot": -2.5,
	"leg.far.foot": -2.5,
	"arm.near.up": 16,
	"arm.far.up": 16,
	"arm.near.paw": 0,
	"arm.far.paw": 0,
	lean: 0,
	ty: 0,
	sx: 1,
	sy: 1,
	head: 0,
	ear: 0,
};

/**
 * Sitting, and the wave. **The paw goes up while the bear is still standing,
 * and comes down after it stands again** — that ordering is forced, not
 * stylistic. Sitting, the near arm and the near leg leave the torso within a
 * few units of each other and lie almost parallel, so an arm sweeping from
 * "hanging" to "raised" merges with the leg and then tears free of it: a
 * pocket opens in one frame and `largest()` drops it. Measured at 8.5 % of
 * the near outline's length, and 30 fps only took it to 7.6 % — a topology
 * change, not a sampling artefact. Standing, the same sweep crosses a
 * vertical leg squarely and costs about 4 %, which is what the waddle's own
 * arm swing already pays twice a cycle.
 */
const sitting = {
	...stand,
	"leg.near.thigh": -80,
	"leg.far.thigh": -80,
	"leg.near.knee": 30,
	"leg.far.knee": 24,
	"leg.near.foot": 25,
	"leg.far.foot": 26,
	"arm.near.up": 50,
	"arm.far.up": 46,
	ty: 15,
	sx: 1.03,
	sy: 0.97,
	head: 2,
};

/** Standing, near paw up: the pose the raise and the lowering pass through. */
const saluting = {...stand, "arm.near.up": -120, "arm.near.paw": -16, head: -3};

/** Sitting with the paw up — the wobble swings it, and the still shows it. */
const waving = {...sitting, "arm.near.up": -120, "arm.near.paw": -16, head: -3};

// `sitting` itself never appears in the sequence — the visit goes
// stand → saluting → waving → saluting → stand — but it is the legs every
// sitting pose is built from, and the pose sheet's way of looking at them.
const poses = {stand, saluting, sitting, waving};

const wobbles = {
	wave: {"arm.near.up": [-120, 12, 2.2], "arm.near.paw": [-16, 16, 2.2], head: [-3, 3, 1.1]},
};

export const rig = {
	n: 280,
	emitStride: 3,
	nFar: 100,
	emitStrideFar: 3,
	fillet: 10,
	viewBox: {x: 19, y: 14, w: 70, h: 89},
	ground: 100,
	k: 2,
	// the far leg's five parts, then the far arm's three
	farGroups: (items) => [items.slice(0, 5), items.slice(5, 8)],
	root: {
		pivot: [50, 100],
		rot: "lean",
		ty: "ty",
		scale: ["sx", "sy"],
		children: [
			{
				pivot: [-50, -100],
				children: [
					leg("far", 48, 68),
					arm("far", 53, 59),
					{shapes: D.body},
					{
						pivot: [50, 52],
						rot: "head",
						shapes: D.head,
						marker: [21.5, -2.5],
						children: [{pivot: [0, -11], rot: "ear", shapes: D.ears}],
					},
					arm("near", 57, 59),
					leg("near", 52, 68),
				],
			},
		],
	},
	gaits: {waddle},
	channels,
	poses,
	wobbles,
	still: waving,
};

export default {
	name: "teddy",
	rig,
	colours: {near: "#c08552", far: "#ddc0a0"},
	budget: 120 * 1024,
	sequence: {
		first: 7,
		period: 64,
		stage: {aspect: 22},
		// The two gait seams are ramped, not stepped: a pinned gait next to a
		// pinned hold changes the ground speed by the whole 58.7 units/s in one
		// frame, which reads as the bear stopping dead and starting again from
		// nothing. Same fix the deer and the kitten use — the stop ramps across
		// the blend into `stand`, and a short `blendTo` ramps back up into the
		// waddle. A ramp's hold is scored on its mean, so the ramping segments
		// carry no hold and the still ones follow behind them.
		segments: [
			{gait: "waddle", cycles: 21, fps: 20, travel: 58.7},
			{pose: "stand", hold: 0, blend: 0.4, fps: 12, travel: [58.7, 0]},
			{pose: "stand", hold: 0.2, blend: 0, fps: 6, travel: 0},
			{pose: "saluting", hold: 0, blend: 0.55, fps: 24, travel: 0},
			{pose: "waving", hold: 0.4, blend: 0.5, fps: 12, travel: 0},
			{wobble: "wave", pose: "waving", secs: 1.8, fps: 12, travel: 0},
			{pose: "saluting", hold: 0, blend: 0.45, fps: 12, travel: 0},
			{pose: "stand", hold: 0, blend: 0.55, fps: 24, travel: 0},
			{pose: "stand", hold: 0.3, blend: 0, fps: 6, travel: 0},
			{blendTo: "waddle", secs: 0.3, fps: 12, travel: [0, 58.7]},
			{gait: "waddle", cycles: 26, fps: 20, travel: 58.7},
		],
	},
};
