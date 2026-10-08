// The <3 theme's dolphin (tools/heart/README.md): the last animal of the
// cast, the only one cast in the far slot alone, and the only one whose
// route needs scenery of its own — it leaps in arcs through a pond that the
// rig paints in front of itself. Facing right, water line y = 82.
//
// ── Four decisions hold this rig together ────────────────────────────────
//
//  1. **Every part is on the near layer bar one, and `variants: ["far"]`
//     picks the *tint*, not the layer.** `lib/outline.mjs` always unites
//     `bins.near` into the last outline and only groups `bins.far` when a
//     rig puts something there; `lib/build.mjs` then writes `farLayers` by
//     painting *every* layer in the far tint. So a distance-only animal is
//     an ordinary rig whose four files are cut to two, not a rig with no
//     near layer — there is no such thing.
//
//  2. **The leap is a cyclic gait, not a ramp cycle.** The bird's climb and
//     the ladybug's `flyUp` need `once: true` because their `ty` travels one
//     way and never comes back; an arc *returns to its own start height* by
//     definition. Every channel here is periodic — `ty`, `pitch`, the fluke
//     beat and both pectorals all close on their frame-0 value — so the gait
//     repeats, and `cycles: 4` costs the same stored frames as `cycles: 1`.
//     A ramp would have cost four times the bytes for the same animation.
//
//  3. **The arc is ballistic and the attitude follows its own tangent.**
//     `ty` is a raised cosine — flat at the bottom (the deep swim), a
//     parabola around the apex (the leap) — and `pitch` is
//     `atan2(dty/dt, speed)` of that very curve, so the dolphin always
//     points where it is going: nose up out of the water, level at the
//     apex, nose down on re-entry, level again at depth. Nothing is hand
//     drawn, so nothing can be sign-mirrored, and `pitch(0) === pitch(100)`
//     (both zero, at the bottom of the cycle) is what makes the cycle close.
//     Writing the arc the other way round — a parabola across the *whole*
//     cycle — puts the steepest, opposite attitudes on the two sides of the
//     wrap and flips 100° in one frame interval.
//
//  4. **The dolphin has no feet, so the stance measurement cannot work.**
//     `lib/travel.mjs` reads planted feet and there are none, so it measures
//     zero for every frame; `travel` is therefore pinned on every segment
//     and the audit prints "stance measured 0 units/s" beside it. That is
//     correct for this rig, not a defect. `ground` below is the water line,
//     which nothing reads for the same reason.
//
// ── The pond ─────────────────────────────────────────────────────────────
//
// Painted as `decor` (`lib/svg.mjs`): a sibling of the group that travels
// and fades, so it neither moves nor fades and is simply part of the two
// scenes that cast the dolphin. It has to be there — the far route's
// baseline sits at 0.295 × --strip and the tallest mid hill in any scene is
// 0.27, so nothing in the meadow can hide a dolphin at the bottom of its
// arc, and a fifteenth background layer would touch the eight lists that
// assert the meadow has fourteen.
//
// It is **wider than the stage on purpose**. A stage-exact ellipse tapers at
// its ends, and the dolphin starts flush with the stage's left edge and
// leaves by the right: measured, an ellipse of rx = stage/2 puts its top
// edge 18 units below the water line at the stage's own edge, which is a
// submerged dolphin in plain sight. At rx = 2 × stage the top edge is within
// 1.9 units of level across the whole stage and both ends are off it, so the
// pond reads as water rather than as a lens with visible ends.
//
// Its fill is a fixed pale blue rather than anything derived from
// `--ps-hill-hue`: the hue varies by scene and a hue-matched pond would
// read as another hill.
//
// ── Reading as a dolphin ─────────────────────────────────────────────────
//
// Three things carry it and everything else is decoration: the **dorsal
// fin** (back-swept, 17 units above a 24-unit-deep back), the **two-lobed
// fluke** with a notch deep enough to survive the fillet, and a **fusiform
// body with a melon and a short beak**. Lose any one and the silhouette is a
// fish, a whale or a slug.

import {P, Circle, scaled} from "../lib/outline.mjs";

/** The water line, in rig units. The pond's top edge, and the height the
 * arcs are written against. */
const WATER = 76;
/** The rig's box: the arc's apex to a little below the water line. The
 * bottom 20 units are pond; a submerged dolphin sits below the box and the
 * viewBox clips it, so depth costs nothing. */
const BOX = {x: 0, y: -6, w: 130, h: 102};
/** `sequence.stage.aspect`, kept here because the pond's path is built from
 * the stage width, which `lib/build.mjs` computes as aspect × viewBox.h. */
const ASPECT = 14;
const STAGE_W = ASPECT * BOX.h;

// ── the parts ──────────────────────────────────────────────────────────────
const D = {};
/**
 * The body, in one static union: the barrel with the melon drawn into it, a
 * short blunt beak rooted deep inside the head, and the dorsal fin. None of
 * it moves — one rigid outline whose length cannot change between frames —
 * which is what leaves the whole 5 % budget to the three parts that do.
 *
 * **The melon is part of the barrel's own path and not a disc laid over it**,
 * and that is not tidiness. A circle whose centre sits above the beak's axis
 * leaves its own front point sticking out over the beak's root: measured,
 * the two shapes separate about half a unit before the circle ends, and the
 * union carries a nub above a slit there for every frame of the visit. Drawn
 * into the path, the forehead is a dome that falls to a face, and the crease
 * where the face meets the beak is a single vertex the fillet can round.
 *
 * The proportions are a bottlenose's, because they are the read: the girth
 * two fifths back from the nose at 19 % of the length, the forehead 7 units
 * clear of the back, and a beak 12 units long and 6 deep at its base. The
 * first draft's was 22 long and tapered to a point, and the silhouette read
 * as a pike.
 */
D.body = [
	P(
		"M40,46 C48,42 60,38.4 74,36.6 C82,35.2 88,34.2 93,32.4 " +
			"C99,29 105,28.4 109,31.8 C111,33.8 111.5,36.6 111.5,40 " +
			"C111.5,44 111.5,49 111,52.5 C110,55 107,56.5 102,57.2 " +
			"C92,58.4 82,58 74,56.6 C60,54.4 48,50.2 40,46 Z"
	),
	// the beak: rooted at x = 100, a dozen units of it clear of the face
	P(
		"M100,42 C106,42.8 112,43.6 116,44.2 C118.6,44.6 119.8,45.2 119.8,46.9 " +
			"C119.8,48.6 118.6,49.2 116,49.6 C112,50.2 106,51 100,51.8 Z"
	),
	// the dorsal fin: falcate, its tip raked back past its own base, both
	// feet of it 4–5 units inside the back
	P("M84,39 C81,31.5 75,23.5 64,19 C67,24.5 69.5,31 70.5,40.5 Z"),
];
/**
 * The tail: the peduncle and the fluke on one node, pivoting at (62, 46) —
 * inside the barrel, where it is 15 units deep and the root's 10 are
 * swallowed. Drawn pointing backwards (local −x), so a positive `fluke`
 * lifts it (paper.js turns clockwise for a positive angle with y down).
 *
 * **The junction with the barrel is the one place a rotating part meets a
 * static one.** The barrel tapers to a point at x = 40, well behind the
 * pivot, and the stock is the wider of the two from about x = 56 back, so
 * the stock swallows the barrel's tail at every angle of the beat.
 *
 * The lobes rake back 35 units for 14 of span and the notch is 12 deep on a
 * 34-unit chord. A fluke's notch is shallow: the first draft cut one 22 deep
 * between two straight lobes, and the tail read as a two-pronged fork.
 */
D.fluke = [
	Circle(0, 0, 4.5),
	P(
		"M12,-5.5 C4,-5.2 -6,-4.4 -16,-3.4 " +
			"C-24,-6.5 -36,-11 -47,-13.6 C-50.5,-14.4 -51.5,-12 -49,-9.5 " +
			"C-45,-6 -41,-3 -38,0 " +
			"C-41,3 -45,6 -49,9.5 C-51.5,12 -50.5,14.4 -47,13.6 " +
			"C-36,11 -24,6.5 -16,3.4 C-6,4.4 4,5.2 12,5.5 Z"
	),
];
/**
 * A pectoral fin: a 21-unit falcate blade swept down and back from a root
 * buried in the flank **just behind the head**, which is where a dolphin's
 * flippers are. Half-way down the body they read as legs — the first draft
 * hung a pair from the middle of the belly and the silhouette grew hind
 * limbs. Both edges of it descend steeply, so each crosses the belly line
 * exactly once and neither ever runs along it.
 */
D.pec = [
	P(
		"M6,-4 C8,0.5 6.5,4.5 2,8.5 C-3,13 -11,16.5 -15,15.5 " +
			"C-16,12.5 -10,8 -5,4 C-1,0.5 2.5,-4.5 6,-4 Z"
	),
];

/** Where the near pectoral hinges, inside the flank behind the head. */
const PEC = [98, 52];
/** The far one hinges 5 forward and 2 up, and is 10 % smaller. */
const PEC_FAR = [103, 50];
const FAR_SCALE = 0.9;
/** Where the tail bends. */
const TAIL = [62, 46];
/** The pitch pivot: the body's own middle, so an attitude change is a
 * rotation about the animal rather than about a corner of its box. */
const CENTRE = [78, 46];

// ── the arc ─────────────────────────────────────────────────────────────────────
const DEG = 180 / Math.PI;
/**
 * The steepest attitude the dolphin ever takes, and the reason it is capped
 * rather than taken raw. The tangent of a ballistic arc that has to reach
 * hiding depth is 53° for the leap and 58° for the quicker porpoise — which
 * is a dolphin standing on its tail, and it swings the fluke 6 units above
 * the top of the box. `PITCH_MAX * tanh(raw / PITCH_MAX)` keeps the
 * shallow-angle attitude honest (raw 18° comes out 16°) and saturates
 * smoothly, so the curve is still analytic and still closes on itself.
 */
const PITCH_MAX = 34;
/** One key every 2 % of the cycle: the curves below are analytic and the
 * table is only how they reach `cyc`, so the sampling is free. */
const STEP = 2;

const round = (x) => Math.round(x * 100) / 100;
const hold = (v) => [
	[0, v],
	[100, v],
];

/** `sin²(π (p − 50) / 100)`: 0 at the apex, 1 at both ends of the cycle. */
const swell = (p) => Math.sin((Math.PI * (p - 50)) / 100) ** 2;

/**
 * One arc as a table per channel. `ty` runs from `apex` at the top of the
 * cycle to `deep` at the bottom, shaped by `swell` — flat where the dolphin
 * is deep (so the attitude can reverse while the pond hides it) and
 * parabolic around the apex (so the airborne half is ballistic). `pitch` is
 * that curve's own tangent against the ground speed, capped by `PITCH_MAX`,
 * which is why the dolphin never enters the water at an angle it is not
 * travelling at. `beats` fluke strokes per cycle, hard at depth and nearly
 * still in the air; both pectorals sweep back as it drives and spread as it
 * flies, the far one twice as far as the near one — it is its own outline, a
 * rigid rotation whose length cannot change, so its sweep is free.
 */
function arc({dur, speed, apex, deep, beats}) {
	const span = deep - apex;
	const ty = [];
	const pitch = [];
	const fluke = [];
	const pec = [];
	const pecFar = [];
	for (let p = 0; p <= 100; p += STEP) {
		const s = swell(p);
		ty.push([p, round(apex + span * s), "linear"]);
		// d(ty)/dp = span·π/100·sin(2π(p−50)/100); over d(t)/dp = dur/100 s
		const dtyDt = ((span * Math.PI) / 100) * Math.sin((2 * Math.PI * (p - 50)) / 100);
		const raw = Math.atan2((dtyDt * 100) / dur, speed) * DEG;
		pitch.push([p, round(PITCH_MAX * Math.tanh(raw / PITCH_MAX)), "linear"]);
		const amp = 5 + 17 * s;
		fluke.push([p, round(amp * Math.sin((2 * Math.PI * beats * (p - 50)) / 100)), "linear"]);
		pec.push([p, round(-8 + 20 * s), "linear"]);
		pecFar.push([p, round(-26 + 34 * s), "linear"]);
	}
	return {
		dur,
		ch: {ty, pitch, fluke, pec, pecFar, sx: hold(1), sy: hold(1)},
	};
}

/** The travel every segment pins, and the speed the pitch is derived
 * against — the two must agree or the attitude stops matching the path. */
const SPEED = 140;

/**
 * The big one: the whole animal clear of the water at the apex, and 100
 * units of arc under it. `deep` is measured, not chosen: it is the shallowest
 * depth at which the silhouette stays under the pond's own top edge (83.9 at
 * the stage's ends, where the ellipse has begun to taper) for the whole
 * stretch in which the attitude reverses from nose-down to nose-up.
 */
const leap = arc({dur: 1.7, speed: SPEED, apex: -8, deep: 92, beats: 3});
/** Porpoising: a low, quick arc that brings the back out and leaves the
 * pectorals in the water. It dives less far than the leap — its own `deep`,
 * because one depth shared with a cycle 0.6 s shorter is a steeper arc for
 * the smaller of the two, which is backwards. */
const porpoise = arc({dur: 1.1, speed: SPEED, apex: 14, deep: 84, beats: 2});

const gaits = {porpoise, leap};

function channels() {
	return [
		// far first, in the tree's own order
		{name: "pec.far", key: "pecFar", rest: 0},
		{name: "fluke", key: "fluke", rest: 0},
		{name: "pec.near", key: "pec", rest: 0},
		{name: "pitch", key: "pitch", rest: 0},
		{name: "ty", key: "ty", rest: 0},
		{name: "sx", key: "sx", rest: 1},
		{name: "sy", key: "sy", rest: 1},
	];
}

// ── poses ────────────────────────────────────────────────────────────────
/** The apex of the big leap: level, clear of the water, fins spread. */
const apex = {
	"pec.far": -22,
	fluke: -4,
	"pec.near": -5,
	pitch: 0,
	ty: -8,
	sx: 1,
	sy: 1,
};
/** Coming out: nose up, fluke still driving. */
const rising = {...apex, "pec.near": 2, "pec.far": -12, fluke: 14, pitch: -40, ty: 30};

/**
 * The still: just out of the water, nose up, fluke still low — the frame a
 * reduced-motion reader gets, and the one attitude that says "leaping"
 * rather than "swimming past". Held eight units clear of the still's own
 * pond, close enough that the two read as one picture.
 */
const leaping = {"pec.far": -24, fluke: 13, "pec.near": -6, pitch: -16, ty: 5, sx: 1, sy: 1};

const poses = {apex, rising, leaping};

// ── the pond ─────────────────────────────────────────────────────────────
/** An ellipse whose top edge is the water line at the middle of the stage.
 * `rx` is twice the stage, so within the stage the edge is level to 1.9
 * units and both ends of the ellipse are off it — see the header. */
const POND_RX = 2 * STAGE_W;
const POND_RY = 60;
const POND_CX = STAGE_W / 2;
const POND_CY = WATER + POND_RY;
const ellipse = (cx, cy, rx, ry) =>
	`M${cx - rx},${cy}A${rx},${ry} 0 1 1 ${cx + rx},${cy}A${rx},${ry} 0 1 1 ${cx - rx},${cy}Z`;

/**
 * The still's pond is its own shape, in the rig's box rather than on the
 * stage (`lib/svg.mjs` § stillSvg). `rx` is the whole box and `ry` reaches
 * well past its foot, so within the box the surface is the water line at the
 * middle easing three units lower at the edges — a pond, not the flat band a
 * cropped stage ellipse would give, and deep enough that it is water rather
 * than a smear under a floating animal.
 */
const STILL_POND_RY = 26;

/** A pale water blue, fixed rather than hue-matched: see the header. */
const WATER_FILL = "#c3e2f5";

export const rig = {
	n: 240,
	// 2, not the cast's usual 3: the fluke's notch is 16 units of a ~330-unit
	// perimeter, and at 80 emitted points it gets three of them and closes up.
	emitStride: 2,
	nFar: 90,
	emitStrideFar: 6,
	// 9: the notch and the dorsal's leading edge both want room, and neither
	// is as fine as the bird's beak.
	fillet: 6,
	viewBox: BOX,
	// The water line. Nothing reads it: no part carries a `foot`, so the
	// stance measurement has nothing to measure and every segment pins its
	// own travel.
	ground: WATER,
	k: 2,
	// one far group: the far pectoral, a rigid rotation of a single blade,
	// so its own outline's length cannot change at all
	farGroups: (items) => [items],
	root: {
		// `ty` alone on the root and the pitch a node below it: `collect`
		// composes T(pivot)·R(rot)·S·T(0, ty), so a `ty` under a rotation is
		// rotated with it — 100 units of arc at 50° would be 77 units of
		// sideways shift on a 136-wide box (README § Rules a rig must keep).
		ty: "ty",
		children: [
			{
				pivot: CENTRE,
				rot: "pitch",
				scale: ["sx", "sy"],
				children: [
					{
						pivot: [-CENTRE[0], -CENTRE[1]],
						children: [
							{
								pivot: PEC_FAR,
								rot: "pec.far",
								layer: "far",
								shapes: scaled(D.pec, FAR_SCALE, FAR_SCALE),
								marker: [-15 * FAR_SCALE, 15.5 * FAR_SCALE],
							},
							{pivot: TAIL, rot: "fluke", shapes: D.fluke},
							// the beak's tip: the one point of the outline that
							// says which way the dolphin is pointing
							{shapes: D.body, marker: [119.8, 46.9]},
							{pivot: PEC, rot: "pec.near", shapes: D.pec},
						],
					},
				],
			},
		],
	},
	gaits,
	channels,
	poses,
	// out of the water and nose up, over a pond of its own — see `stillDecor`
	still: leaping,
};

export default {
	name: "dolphin",
	rig,
	colours: {far: "#8fb0c6"},
	budget: 120 * 1024,
	// the far tint and its still: two files, not four
	variants: ["far"],
	decor: [{d: ellipse(POND_CX, POND_CY, POND_RX, POND_RY), fill: WATER_FILL}],
	/**
	 * The still's own pond, in the rig's box rather than on the stage. The
	 * stage-authored `decor` above cannot be reused: a still's viewBox is the
	 * rig box, so a pond 2304 units wide would crop to a flat band. Without
	 * one a reduced-motion reader gets a dolphin at the top of an empty box,
	 * which is a fish in the sky. This is a lens the width of the box: the
	 * water line at its middle, the box's own foot at both ends.
	 */
	stillDecor: [
		{
			d: ellipse(BOX.w / 2, WATER + STILL_POND_RY, BOX.w, STILL_POND_RY),
			fill: WATER_FILL,
		},
	],
	sequence: {
		first: 13,
		period: 60,
		stage: {aspect: ASPECT},
		// Four low arcs and then two big leaps: two clips, two gaits, and
		// every extra cycle free in bytes (a gait stores one cycle whatever
		// it repeats). The distance is what the audit's exit rule needs —
		// travel + viewBox.w ≥ aspect × viewBox.h — and both segments pin the
		// same speed, since a step at the seam would change the ground speed
		// in one frame and the pitch is derived against this number.
		segments: [
			{gait: "porpoise", cycles: 6, fps: 24, travel: SPEED},
			{gait: "leap", cycles: 3, fps: 24, travel: SPEED},
		],
	},
};
