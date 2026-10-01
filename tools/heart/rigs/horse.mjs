// The <3 theme's horse (tools/heart/README.md). Facing right, ground y = 200,
// withers y = 96; real ratios: legs ≈ 0.55 of height, body depth ≈ 0.45,
// head ≈ 0.4. Everything drawn here is what the mockups were approved with:
// a round rump (the back dips behind the withers, rises to the croup, then
// one arc down the buttock and under into the thigh), a soft mane, rounded
// ears, a tail that hangs from a disc buried in the rump and fans into
// strands, and a transverse gallop timed after Muybridge (LH strikes at 0,
// RH at 10 %, LF at 38 %, RF at 50 %; airborne and gathered from ~78 %).
// Negative = a hanging segment swings forward; a front knee folds back (+),
// a hind hock brings the hoof forward (−).

import {P, Circle, scaled} from "../lib/outline.mjs";

const H = {};
H.torso = (v) => {
	const a = v.arch;
	const s = v.stretch;
	const back = 101 - 4 * a + 2 * s;
	const belly = 147 - 8 * a + 2 * s;
	const flank = 149 - 7 * a;
	return P(
		`M148,96 C134,99 118,${back} 100,100 C92,99 86,97 80,97 C70,97 59,104 56,118 C54,134 64,${
			flank + 2
		} 84,${flank} C102,${belly + 1} 138,${belly + 1} 160,${
			belly - 3
		} C174,140 184,134 188,120 C190,110 184,102 170,98 C162,96 154,96 148,96 Z`
	);
};
// pivot (170,115): the neck's base is a chord of a disc buried in the chest
H.neck = [
	P("M-14,-7 C0,-21 10,-35 26,-47 C30,-54 41,-53 39,-41 C33,-33 24,-16 13,8 C4,5 -6,-1 -14,-7 Z"),
	Circle(0, 0, 17),
];
// pivots at the poll
H.mane = P(
	"M2,0 C-8,0 -20,8 -28,20 C-34,28 -36,36 -34,42 C-28,34 -22,30 -14,32 C-10,24 -4,14 4,8 Z"
);
H.head = P(
	"M0,-2 C6,-10 16,-8 20,0 C24,10 26,24 28,34 C28,40 22,42 16,40 C10,38 6,30 2,22 C-2,14 -4,6 0,-2 Z"
);
H.earNear = P("M5,0 C0,-8 0,-19 7,-28 C13,-19 13,-8 10,0 Z");
H.earFar = P("M-7,2 C-12,-5 -12,-16 -5,-25 C1,-16 1,-5 -2,2 Z");
// the tail head: a disc buried in the top of the rump, pivot (64,110); the
// hair narrow at the dock, fanning out, feathered into strands
H.dock = [Circle(0, 0, 7.5)];
H.hair = P(
	"M-4,-3 C-8,10 -11,24 -11,36 C-11,44 -10,50 -8,56 C-6,52 -5,48 -5,44 C-4,50 -2,56 0,60 C1,54 2,48 2,42 C4,46 6,50 8,52 C9,44 8,34 7,26 C6,16 5,8 4,-3 Z"
);
H.forearm = [P("M-6,-16 C-8,0 -7,15 -5,24 L5,24 C7,15 8,0 6,-16 Z"), Circle(0, 24, 5.6)];
H.fcannon = [P("M-4,0 C-4.5,8 -4,17 -3.5,24 L3.5,24 C4,17 4.5,8 4,0 Z"), Circle(0, 24, 4.3)];
H.gaskin = [P("M-8,-20 C-10,-2 -8,13 -5,22 L5,22 C8,13 9,-2 8,-20 Z"), Circle(-1.5, 22, 6.1)];
H.hcannon = [P("M-4,0 C-4.5,7 -4,14 -3.5,20 L3.5,20 C4,14 4.5,7 4,0 Z"), Circle(0, 20, 4.3)];
H.hoof = [P("M-3,0 L-4,5 L-5.5,8 L-6,13 L7,13 L6.5,8 L4,5 L3,0 Z")];

/** A leg: forearm/gaskin → cannon → hoof, the far side thinner and 5 % shorter. */
function leg(kind, side, px, py) {
	const isF = kind === "front";
	const k = (c) => `${kind}.${side}.${c}`;
	const thin = side === "far" ? 0.85 : 1;
	const len = side === "far" ? 0.95 : 1;
	return {
		pivot: [px, py],
		rot: k("up"),
		layer: side,
		shapes: scaled(isF ? H.forearm : H.gaskin, thin, len),
		children: [
			{
				pivot: [isF ? 0 : -1.5, (isF ? 24 : 22) * len],
				rot: k("can"),
				layer: side,
				shapes: scaled(isF ? H.fcannon : H.hcannon, thin, len),
				children: [
					{
						pivot: [0, (isF ? 24 : 20) * len],
						rot: k("hoof"),
						layer: side,
						shapes: scaled(H.hoof, thin, len),
						marker: [7, 13],
						foot: [0, 13],
					},
				],
			},
		],
	};
}

const gaits = {
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
				[0, 8],
				[24, 12],
				[48, 18],
				[70, 14],
				[86, 6],
				[100, 8],
			],
			head: [
				[0, 0],
				[48, -8],
				[86, 4],
				[100, 0],
			],
			tail: [
				[0, 72],
				[40, 86],
				[78, 64],
				[100, 72],
			],
			hair: [
				[0, -10],
				[30, 8],
				[55, -12],
				[80, 6],
				[100, -10],
			],
			mane: [
				[0, 0],
				[48, -6],
				[100, 0],
			],
		},
	},
	prance: {
		dur: 0.9,
		phases: {"hind.far": 0, "hind.near": 0.5, "front.far": 0.5, "front.near": 0},
		ch: {
			"hind.up": [
				[0, -16, "linear"],
				[38, 26, "out"],
				[54, 30],
				[76, -22],
				[92, -22],
				[100, -16],
			],
			"hind.can": [
				[0, 2],
				[38, 2],
				[62, -50],
				[84, -16],
				[100, 2],
			],
			"hind.hoof": [
				[0, 0],
				[38, 0],
				[62, 16],
				[92, -4],
				[100, 0],
			],
			"front.up": [
				[0, -20, "linear"],
				[38, 20, "out"],
				[54, 24],
				[72, -44],
				[90, -30],
				[100, -20],
			],
			"front.can": [
				[0, 0],
				[38, 0],
				[60, 72],
				[80, 40],
				[96, -2],
				[100, 0],
			],
			"front.hoof": [
				[0, 0],
				[38, 0],
				[62, 20],
				[92, -4],
				[100, 0],
			],
			ty: [
				[0, -1],
				[22, -7],
				[50, -1],
				[72, -7],
				[100, -1],
			],
			pitch: [
				[0, -3],
				[50, -3],
				[100, -3],
			],
			arch: [
				[0, 0.5],
				[100, 0.5],
			],
			stretch: [
				[0, 0],
				[100, 0],
			],
			neck: [
				[0, -18],
				[25, -14],
				[50, -19],
				[75, -14],
				[100, -18],
			],
			head: [
				[0, 12],
				[25, 9],
				[50, 13],
				[75, 9],
				[100, 12],
			],
			tail: [
				[0, 44],
				[50, 54],
				[100, 44],
			],
			hair: [
				[0, -6],
				[50, 8],
				[100, -6],
			],
			mane: [
				[0, 0],
				[50, -4],
				[100, 0],
			],
		},
	},
};

/** The channel list: leg channels take their phase from the gait, the rest are shared. */
function channels(gaitName = "gallop") {
	const gait = gaits[gaitName];
	const ch = [];
	for (const l of ["hind.far", "hind.near", "front.far", "front.near"]) {
		const kind = l.split(".")[0];
		for (const c of ["up", "can", "hoof"]) {
			ch.push({name: `${l}.${c}`, key: `${kind}.${c}`, phase: gait.phases[l]});
		}
	}
	for (const c of ["ty", "pitch", "arch", "stretch", "neck", "head", "tail", "hair", "mane"]) {
		ch.push({name: c, key: c});
	}
	return ch;
}

export const rig = {
	n: 600,
	emitStride: 2,
	nFar: 120,
	emitStrideFar: 2,
	fillet: 14,
	// Contains the animal: nothing may be drawn outside its own box
	// (lib/build.mjs `boxOverflow`). The old {x: 0, y: 30, w: 230, h: 172}
	// cut 5.7 units off the top, 2.5 off the bottom, 3.6 off the left and
	// 8.2 off the right — ear tips, a hoof and the muzzle at full stretch.
	// Extremes reach y 24.3…204.5 and x -3.6…238.2, so this clears them by
	// 3.3, 3.5, 3.4 and 2.8. The theme's `--ps-horse-h` is scaled by
	// 187/172 and `stage.aspect` by 172/187 to match, so the horse is the
	// same size on screen and crosses the same distance.
	viewBox: {x: -7, y: 21, w: 248, h: 187},
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
					leg("hind", "far", 84, 144),
					leg("front", "far", 164, 138),
					{
						pivot: [64, 110],
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
							{pivot: [31, -47], rot: "mane", shapes: [H.mane]},
							{
								pivot: [33, -45],
								rot: "head",
								shapes: [H.head, Circle(1, 4, 8.5), H.earNear, H.earFar],
								marker: [28, 37],
							},
						],
					},
					leg("hind", "near", 88, 146),
					leg("front", "near", 168, 140),
				],
			},
		],
	},
	gaits,
	channels,
	poses: {},
	wobbles: {},
	// standing: every channel at rest
	still: {},
};

export default {
	name: "horse",
	rig,
	colours: {near: "#d97a9c", far: "#ecbccb"},
	budget: 200 * 1024,
	/**
	 * What `client/themes/ps.css` has to say about this animal — the half of
	 * the box coupling no audit can reach, checked by `test/themes/ps.ts`
	 * (tools/heart/README.md § The audit):
	 *
	 * - `height` is `--ps-horse-h`, the on-screen height of the *box*, in
	 *   strips;
	 * - `box` is the `viewBox.h` it was picked against, so a box that grows
	 *   without its token growing by the same ratio fails there instead of
	 *   shipping an animal a different size;
	 * - `stageWidth` is `stage.aspect × viewBox.h`, which a box change must
	 *   leave alone — the aspect scales the other way — or the animal travels a
	 *   different distance.
	 */
	theme: {height: 0.7176, box: 187, stageWidth: 2752},
	// Gallop in, collect into a prance, prance, gallop off. The stage is
	// 2752 units (~1850 px at the theme's size) so the visit
	// crosses the whole channel rather than a slice of it: the gallop-in
	// covers about the stage's near-middle, the prance holds near there, the
	// gallop-out clears the far edge. See docs/projects/heart-theme.md's
	// plan-2 block for the decision record.
	//
	// `travel` is fixed per segment rather than measured: the clamp
	// (tools/heart/lib/travel.mjs) that stops the plant-detection from
	// reading a mid-swing touch-down as backward motion also zeroes the two
	// blend segments (their planted hoof swings forward relative to the
	// body throughout), which froze the horse for 0.3 s at every gait
	// switch. Ramping `travel: [280, 70]`/`[70, 280]` across each blend
	// instead keeps the horse moving at every frame; the gallop's measured
	// stance speed is ~280 units/s (about one body length a stride, because
	// that is what the approved rig's leg swing covers — the feet stay
	// locked) and the prance's is ~68 (kept as the constant 70 applied
	// speed; the measurement stays printed beside it).
	sequence: {
		first: 2,
		period: 60,
		// 14.7166, not 16: the stage is `aspect × viewBox.h` and the box grew
		// from 172 to 187 to hold the animal, so 14.7166 × 187 = 16 × 172
		// keeps the crossing the same width in rig units and on screen.
		stage: {aspect: 14.7166},
		segments: [
			{gait: "gallop", cycles: 6, fps: 30, travel: 280},
			{blendTo: "prance", secs: 0.3, fps: 15, travel: [280, 70]},
			{gait: "prance", cycles: 13, fps: 30, travel: 70},
			{blendTo: "gallop", secs: 0.3, fps: 15, travel: [70, 280]},
			{gait: "gallop", cycles: 4, fps: 30, travel: 280},
		],
	},
};
