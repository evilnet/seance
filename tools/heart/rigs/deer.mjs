// The <3 theme's deer (tools/heart/README.md). The horse's topology — the
// same leg chain, the same `leg()` helper, the same channel list, the same
// far-leg slicing — drawn as a deer: facing right, ground y = 200, withers
// y = 96, but shallower through the barrel (the belly and flank lines sit
// 8 units higher than the horse's and the rump's outer arc is pulled in),
// finer in the legs, longer and thinner in the neck, no mane at all, a head
// scaled down with a short muzzle, big upright ears (the near one on its own
// channel, so it can flick), and a short flag of a tail on the horse's dock.
//
// The tail channel rests at 58°, not 0: straight down would bury the flag in
// the rump. 58° carries it back and down, the way a deer carries it at rest;
// the bound flags it up past 150°.
//
// It walks — a four-beat lateral walk, LH, LF, RH, RF, one foot leaving the
// ground at a time — for most of its visit, grazes, looks up with an ear
// flick, and bounds off in the horse's gallop.
//
// Negative = a hanging segment swings forward; a front knee folds back (+),
// a hind hock brings the hoof forward (−).

import {P, Circle, scaled} from "../lib/outline.mjs";

const H = {};
H.torso = (v) => {
	const a = v.arch;
	const s = v.stretch;
	const back = 101 - 4 * a + 2 * s;
	const belly = 139 - 8 * a + 2 * s;
	const flank = 141 - 7 * a;
	return P(
		`M148,96 C134,99 118,${back} 100,100 C92,99 86,97 80,97 C73,97 64,104 61,118 C59,132 68,${
			flank + 2
		} 86,${flank} C104,${belly + 1} 138,${belly + 1} 160,${belly - 3} C176,${belly - 4} 186,${
			belly - 11
		} 190,118 C192,109 185,102 170,98 C162,96 154,96 148,96 Z`
	);
};
// pivot (170,115): the neck's base is a chord of a disc buried in the chest.
// 63 units along its axis against the horse's 55, and 3 units narrower.
H.neck = [
	P("M-13,-6 C-2,-21 11,-39 25,-59 C29,-65 40,-61 35,-53 C29,-43 21,-18 12,7 C3,4 -6,0 -13,-6 Z"),
	Circle(0, 0, 17),
];
// the head hangs off the neck's tip (30,-56); no mane. A short wedge with a
// narrow muzzle — the horse's is half as long again and blunt at the end,
// which is most of what made the first draft read as a pony.
H.head = P(
	"M0,-2 C5,-9 13,-7 15,0 C17,7 19,16 20,23 C20,27 16,28 12,26 C8,24 5,19 2,14 C-2,9 -3,4 0,-2 Z"
);
// Broad, leaf-shaped and blunt-tipped — a narrow spike reads as a horn — and
// splayed, the near one carried forward and the far one back, so two ears read
// rather than one blob. Both are rooted inside the skull's disc. The near one
// hangs off its own node at (7,0) in head coordinates so it can flick without
// the head moving, and its path is written about that pivot; the far one is
// drawn straight into the head's group.
H.earNear = P("M-4,1 C-8,-9 -3,-22 7,-29 C11,-31 14,-28 13,-24 C12,-15 9,-6 5,0 Z");
H.earFar = P("M-6,2 C-15,-6 -18,-18 -12,-27 C-9,-31 -5,-29 -4,-25 C-2,-15 -2,-7 0,1 Z");
// The tail head: a disc buried in the top of the rump, pivot (69,113), deep
// enough that the disc barely breaks the contour. The flag is 27 units and
// blunt at the end, which is what it takes to read as a tail rather than a
// spike at the theme's size. Its channel rests at 58° — back and down, clear
// of the rump's own contour, which is what it takes to be seen at all: at 45°
// it lay along that contour and vanished into it, and near 90° it read as a
// prong. The bound flags it up past 150°, the one moment a deer's tail is the
// loudest thing on it.
H.dock = [Circle(0, 0, 8)];
H.hair = P("M-6,-3 C-12,4 -13,13 -11,21 C-9,25 -4,25 -1,21 C3,15 6,7 6,0 C6,-2 6,-3 5,-3 Z");
H.forearm = [P("M-6,-16 C-8,0 -7,15 -5,24 L5,24 C7,15 8,0 6,-16 Z"), Circle(0, 24, 5.6)];
H.fcannon = [P("M-4,0 C-4.5,8 -4,17 -3.5,24 L3.5,24 C4,17 4.5,8 4,0 Z"), Circle(0, 24, 4.3)];
H.gaskin = [P("M-8,-20 C-10,-2 -8,13 -5,22 L5,22 C8,13 9,-2 8,-20 Z"), Circle(-1.5, 22, 6.1)];
H.hcannon = [P("M-4,0 C-4.5,7 -4,14 -3.5,20 L3.5,20 C4,14 4.5,7 4,0 Z"), Circle(0, 20, 4.3)];
H.hoof = [P("M-3,0 L-4,5 L-5.5,8 L-6,13 L7,13 L6.5,8 L4,5 L3,0 Z")];

/**
 * A leg: forearm/gaskin → cannon → hoof, finer and longer than the horse's
 * (`THIN`/`LONG`), the far side thinner again and 5 % shorter. The foot and
 * its marker scale with the leg, so the contact point stays on the hoof.
 */
const THIN = 0.78;
const LONG = 1.08;
function leg(kind, side, px, py) {
	const isF = kind === "front";
	const k = (c) => `${kind}.${side}.${c}`;
	const thin = side === "far" ? THIN * 0.85 : THIN;
	const len = side === "far" ? LONG * 0.95 : LONG;
	return {
		pivot: [px, py],
		rot: k("up"),
		layer: side,
		shapes: scaled(isF ? H.forearm : H.gaskin, thin, len),
		children: [
			{
				pivot: [(isF ? 0 : -1.5) * thin, (isF ? 24 : 22) * len],
				rot: k("can"),
				layer: side,
				shapes: scaled(isF ? H.fcannon : H.hcannon, thin, len),
				children: [
					{
						pivot: [0, (isF ? 24 : 20) * len],
						rot: k("hoof"),
						layer: side,
						shapes: scaled(H.hoof, thin, len),
						marker: [7 * thin, 13 * len],
						foot: [0, 13 * len],
					},
				],
			},
		],
	};
}

const gaits = {
	// A four-beat lateral walk: LH, LF, RH, RF, a quarter cycle apart, each
	// foot down for a little over half the cycle. The deer's own gait — it
	// walks for most of the visit and only bounds off at the end.
	walk: {
		dur: 1.2,
		phases: {"hind.far": 0, "front.far": 0.25, "hind.near": 0.5, "front.near": 0.75},
		ch: {
			// stance runs 0–60 % of the cycle, the hoof tracking back at a near
			// constant rate (hence the linear easing through it); the swing
			// folds the cannon to carry the hoof forward over the ground
			"hind.up": [
				[0, -30, "linear"],
				[30, -2, "linear"],
				[60, 28, "out"],
				[78, 16],
				[92, -22],
				[100, -30],
			],
			// The hock's deepest fold has to land where the leg passes vertical
			// — 84 %, where `hind.up` crosses 0 — and not before it. At its
			// first timing (76 %) the leg was straight again by the time it swung
			// under the body, and the hoof cleared the ground by 7 units: a drag,
			// not a step.
			"hind.can": [
				[0, -4],
				[30, -2],
				[62, -10],
				[84, -54],
				[95, -16],
				[100, -4],
			],
			"hind.hoof": [
				[0, 2],
				[30, 0],
				[62, -2],
				[84, 24],
				[95, 6],
				[100, 2],
			],
			"front.up": [
				[0, -32, "linear"],
				[30, -4, "linear"],
				[60, 26, "out"],
				[76, 6],
				[90, -24],
				[100, -32],
			],
			"front.can": [
				[0, 2],
				[30, 2],
				[60, 6],
				[76, 48],
				[90, 8],
				[100, 2],
			],
			"front.hoof": [
				[0, 0],
				[30, 0],
				[60, -2],
				[76, 14],
				[92, 0],
				[100, 0],
			],
			ty: [
				[0, 0],
				[25, -1.5],
				[50, 0],
				[75, -1.5],
				[100, 0],
			],
			pitch: [
				[0, -1],
				[100, -1],
			],
			arch: [
				[0, 0.3],
				[100, 0.3],
			],
			stretch: [
				[0, 0],
				[100, 0],
			],
			neck: [
				[0, -16],
				[50, -13],
				[100, -16],
			],
			head: [
				[0, -14],
				[50, -11],
				[100, -14],
			],
			tail: [
				[0, 55],
				[50, 63],
				[100, 55],
			],
			hair: [
				[0, -4],
				[50, 5],
				[100, -4],
			],
		},
	},
	// The bound off: the horse's transverse gallop, with the flag up.
	gallop: {
		dur: 0.72,
		phases: {"hind.far": 0, "hind.near": 0.1, "front.far": 0.38, "front.near": 0.5},
		ch: {
			"hind.up": [
				[0, -30, "linear"],
				[28, 32, "out"],
				[42, 40],
				[66, 6],
				[86, -34],
				[100, -30],
			],
			"hind.can": [
				[0, 2],
				[28, -4],
				[50, -44],
				[74, -34],
				[92, 4],
				[100, 2],
			],
			"hind.hoof": [
				[0, 0],
				[28, 0],
				[52, 10],
				[90, -4],
				[100, 0],
			],
			"front.up": [
				[0, -36, "linear"],
				[28, 24, "out"],
				[44, 32],
				[66, 2],
				[88, -42],
				[100, -36],
			],
			"front.can": [
				[0, 0],
				[28, 0],
				[52, 58],
				[74, 36],
				[92, -6],
				[100, 0],
			],
			"front.hoof": [
				[0, 0],
				[28, 0],
				[52, 14],
				[90, -4],
				[100, 0],
			],
			ty: [
				[0, -2],
				[20, 0],
				[42, -3],
				[62, -1],
				[84, -12],
				[100, -2],
			],
			pitch: [
				[0, -5],
				[18, -6],
				[42, 2],
				[60, 5],
				[82, -2],
				[100, -5],
			],
			arch: [
				[0, 0.7],
				[20, 0.2],
				[45, 0],
				[65, 0.1],
				[86, 1],
				[100, 0.7],
			],
			stretch: [
				[0, 0],
				[22, 0.4],
				[46, 1],
				[66, 0.4],
				[86, 0],
				[100, 0],
			],
			neck: [
				[0, -10],
				[24, -6],
				[48, 2],
				[70, -2],
				[86, -12],
				[100, -10],
			],
			head: [
				[0, -24],
				[48, -32],
				[86, -18],
				[100, -24],
			],
			tail: [
				[0, 152],
				[40, 166],
				[78, 144],
				[100, 152],
			],
			hair: [
				[0, -10],
				[30, 8],
				[55, -12],
				[80, 6],
				[100, -10],
			],
		},
	},
};

/**
 * The rest value of a channel that is not at zero: the tail's flag is short
 * enough that 0° buries it in the rump, so its rest carries it back clear of
 * the body and every pose and gait works around that.
 */
const REST = {tail: 58};

/** The channel list: leg channels take their phase from the gait, the rest are shared. */
function channels(gaitName = "walk") {
	const gait = gaits[gaitName];
	const ch = [];
	for (const l of ["hind.far", "hind.near", "front.far", "front.near"]) {
		const kind = l.split(".")[0];
		for (const c of ["up", "can", "hoof"]) {
			ch.push({name: `${l}.${c}`, key: `${kind}.${c}`, phase: gait.phases[l]});
		}
	}
	for (const c of ["ty", "pitch", "arch", "stretch", "neck", "head", "tail", "hair", "ear"]) {
		ch.push({name: c, key: c, rest: REST[c] ?? 0});
	}
	return ch;
}

// The graze is the one pose the numbers have to be solved for rather than
// eyeballed: the neck swings down and forward (+108°) and the head counter-
// rotates (−78°) so the muzzle hangs vertically and lands on the ground line
// *ahead* of the near fore hoof — between the forelegs it would enclose a
// pocket, and a pocket that opens and closes across the blend is exactly
// what makes the near outline's length jump. The forelegs splay a little.
const poses = {
	stand: {neck: -12, head: -18},
	graze: {
		neck: 116,
		head: -86,
		ty: 0,
		arch: 0.1,
		tail: 46,
		"front.near.up": -10,
		"front.far.up": 6,
	},
	alert: {neck: -18, head: -26, ty: 0, arch: 0.4, tail: 70},
};

// The flick is the near ear's own channel rather than a head shake: the ears
// are what say "deer" in this silhouette, and swinging the whole head instead
// carries the muzzle across a third of the body, which reads as the deer
// looking about rather than as an ear. The head keeps a slow, small drift
// under it so the animal is not frozen while the ear works.
const wobbles = {
	earflick: {ear: [2, 15, 2.2], head: [-26, 2.5, 0.9]},
};

export const rig = {
	n: 540,
	emitStride: 3,
	nFar: 120,
	emitStrideFar: 3,
	fillet: 13,
	// Contains the animal: nothing may be drawn outside its own box
	// (lib/build.mjs `boxOverflow`). The old {x: 34, y: 6, w: 206, h: 196}
	// cut 2.2 units off the bottom and 15.8 off the right — a hoof, and the
	// muzzle through the graze, which reaches furthest forward of anything
	// this rig does. Extremes reach y 5.8…204.2 and x 37…255.8, so this
	// clears them by 3.8 (above), 3.8 (below), 3 (left) and 3.2 (right). The
	// theme's `--ps-deer-h` is scaled by 206/196 and `stage.aspect` by
	// 196/206 to match, so the deer is the same size on screen and crosses
	// the same distance.
	viewBox: {x: 34, y: 2, w: 225, h: 206},
	ground: 200,
	k: 1,
	// the far hind leg's five parts, then the far front leg's five
	farGroups: (items) => [items.slice(0, 5), items.slice(5, 10)],
	root: {
		pivot: [125, 130],
		rot: "pitch",
		ty: "ty",
		children: [
			{
				pivot: [-125, -130],
				children: [
					leg("hind", "far", 84, 139.6),
					leg("front", "far", 164, 133.4),
					{
						pivot: [69, 113],
						rot: "tail",
						shapes: H.dock,
						children: [{pivot: [0, 7], rot: "hair", shapes: [H.hair]}],
					},
					{shapes: [H.torso]},
					{
						pivot: [170, 115],
						rot: "neck",
						shapes: H.neck,
						children: [
							{
								pivot: [30, -56],
								rot: "head",
								shapes: [H.head, Circle(1, 4, 8), H.earFar],
								marker: [23, 30],
								children: [{pivot: [7, 0], rot: "ear", shapes: [H.earNear]}],
							},
						],
					},
					leg("hind", "near", 88, 141.6),
					leg("front", "near", 168, 135.1),
				],
			},
		],
	},
	gaits,
	channels,
	poses,
	wobbles,
	// standing: the stand pose, so reduced motion gets the carriage the walk
	// has rather than the rig's drawn nose-down rest angle
	still: poses.stand,
};

export default {
	name: "deer",
	rig,
	colours: {near: "#c98fb4", far: "#e8c9dd"},
	budget: 150 * 1024,
	/**
	 * What `client/themes/ps.css` has to say about this animal — the half of
	 * the box coupling no audit can reach, checked by `test/themes/ps.ts`
	 * (tools/heart/README.md § The audit):
	 *
	 * - `height` is `--ps-deer-h`, the on-screen height of the *box*, in
	 *   strips;
	 * - `box` is the `viewBox.h` it was picked against, so a box that grows
	 *   without its token growing by the same ratio fails there instead of
	 *   shipping an animal a different size;
	 * - `stageWidth` is `stage.aspect × viewBox.h`, which a box change must
	 *   leave alone — the aspect scales the other way — or the animal travels a
	 *   different distance.
	 */
	theme: {height: 0.5781, box: 206, stageWidth: 3136},
	// Walk in, stop, graze, look up with an ear flick, bound off. The walk
	// carries most of the visit — cycles are free in bytes (a gait stores one
	// cycle however many it runs), so the distance is bought with cycles and
	// not with speed.
	//
	// Every segment's travel is pinned, the walk's included, and 65 units/s is
	// the walk's own measured mean — 78 units a 1.2 s stride, about three
	// quarters of the shoulder height, which is what a deer's walking stride
	// is. The measurement is right on average and unusable frame by frame:
	// three frames of every twenty-two clamp to zero and the speed steps
	// 38 → 89 across every cycle boundary, so measuring it would stop the deer
	// dead for a moment eighteen times over and lurch it at every stride. The
	// cause is the clamp in tools/heart/lib/travel.mjs, the one that stops a
	// foot touching down mid-swing from reading as the body walking backward:
	// a four-beat walk hands the reference between feet twice a cycle, and
	// with the near feet at y ≈ 201 and the far at ≈ 196 both inside the
	// 6-unit plant tolerance, the hand-over goes to a foot of a different
	// length at a different phase, which reads as moving forward. No other rig
	// in the cast measures a gait either. The holds are pinned to 0 (a grazing
	// deer must not drift) and the two transitions ramp from and to the 65,
	// since the same clamp zeroes a blend's measured speed outright.
	//
	// The graze is split in two so its blend and its hold can carry different
	// frame rates: the blend needs frames for the head to swing down through,
	// the hold is one pose repeated and needs almost none, and every stored
	// frame costs bytes against the 150 KB row.
	sequence: {
		first: 5,
		period: 66,
		// 15.2233, not 16: the stage is `aspect × viewBox.h` and the box grew
		// from 196 to 206 to hold the animal, so 15.2233 × 206 = 16 × 196
		// keeps the crossing the same width in rig units and on screen.
		stage: {aspect: 15.2233},
		segments: [
			{gait: "walk", cycles: 18, fps: 18, travel: 65},
			{pose: "stand", hold: 0, blend: 0.5, fps: 10, travel: [65, 0]},
			{pose: "graze", hold: 0, blend: 0.9, fps: 10, travel: 0},
			{pose: "graze", hold: 2.2, blend: 0, fps: 2, travel: 0},
			{pose: "alert", hold: 0.2, blend: 0.5, fps: 10, travel: 0},
			{wobble: "earflick", pose: "alert", secs: 1.4, fps: 15, travel: 0},
			{blendTo: "gallop", secs: 0.4, fps: 12, travel: [0, 280]},
			{gait: "gallop", cycles: 9, fps: 24, travel: 280},
		],
	},
};
