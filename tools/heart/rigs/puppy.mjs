// The <3 theme's puppy (tools/heart/README.md): the round design the user
// preferred. Facing right, ground y = 100; front pivot (68,76), hind (38,76).
// Shapes, the bound and the sit sequence are the mockup's, verbatim: bound
// in, skid, sit, look around and wag (hearts), shake, settle, stand and turn,
// crouch, bound back the way it came.

import {P, Circle, Ellipse, scaled} from "../lib/outline.mjs";

const D = {};
D.body = [Ellipse(50, 64, 24, 14), Circle(66, 67, 12)];
D.head = [Circle(10, -4, 14), Ellipse(24, 2, 8, 6), Circle(30, 1, 2.6)]; // pivot at the neck (68,55)
D.ear = P("M0,0 C-8,2 -10,16 -3,24 C3,22 5,10 4,2 Z"); // in head coordinates, pivot (4,-14)
D.tail = P("M0,0 C-6,-6 -8,-16 -2,-20 C0,-16 -1,-8 4,-4 Z"); // pivot (33,58)
D.fup = [P("M-5,-10 C-6,2 -5,8 -4,12 L4,12 C5,8 6,2 5,-10 Z"), Circle(0, 12, 4.4)];
D.hup = [P("M-7,-12 C-9,0 -7,8 -4,12 L4,12 C6,7 7,0 6,-12 Z"), Circle(0, 12, 4.6)];
D.low = [P("M-3,0 L-3,8 L3,8 L3,0 Z"), Circle(0, 8, 3.4)];
D.paw = [P("M-4,-1 C-5,3 -3,5 0,5 C3,5 6,3 5,-1 Z")];

function leg(kind, side, px, py) {
	const isF = kind === "front";
	const k = (c) => `${kind}.${side}.${c}`;
	const thin = side === "far" ? 0.85 : 1;
	const len = side === "far" ? 0.95 : 1;
	return {
		pivot: [px, py],
		rot: k("up"),
		layer: side,
		shapes: scaled(isF ? D.fup : D.hup, thin, len),
		children: [
			{
				pivot: [0, 12 * len],
				rot: k("low"),
				layer: side,
				shapes: scaled(D.low, thin, len),
				children: [
					{
						pivot: [0, 8 * len],
						rot: k("paw"),
						layer: side,
						shapes: scaled(D.paw, thin, len),
						marker: [5.5, 2],
						foot: [0, 5],
					},
				],
			},
		],
	};
}

const bound = {
	dur: 0.7,
	phases: {"front.near": 0, "front.far": 0.05, "hind.near": 0.5, "hind.far": 0.55},
	ch: {
		"front.up": [
			[0, -24, "linear"],
			[24, 14],
			[44, 26],
			[66, -6],
			[86, -30],
			[100, -24],
		],
		"front.low": [
			[0, 0],
			[24, 0],
			[50, 28],
			[74, 16],
			[92, -4],
			[100, 0],
		],
		"front.paw": [
			[0, 0],
			[30, 8],
			[60, -14],
			[100, 0],
		],
		"hind.up": [
			[0, -22, "linear"],
			[26, 20],
			[46, 34],
			[72, 4],
			[90, -22],
			[100, -22],
		],
		"hind.low": [
			[0, 2],
			[26, 2],
			[56, -18],
			[82, -4],
			[100, 2],
		],
		"hind.paw": [
			[0, 0],
			[30, 10],
			[60, -10],
			[100, 0],
		],
		ty: [
			[0, -1],
			[20, 0],
			[42, -7],
			[66, -14],
			[86, -6],
			[100, -1],
		],
		pitch: [
			[0, 7],
			[20, 2],
			[42, -9],
			[66, -4],
			[86, 5],
			[100, 7],
		],
		sx: [
			[0, 1.05],
			[20, 1.08],
			[42, 0.96],
			[66, 1.02],
			[86, 1],
			[100, 1.05],
		],
		sy: [
			[0, 0.95],
			[20, 0.92],
			[42, 1.05],
			[66, 0.99],
			[86, 1],
			[100, 0.95],
		],
		head: [
			[0, 4],
			[42, -8],
			[66, -3],
			[100, 4],
		],
		ear: [
			[0, -20],
			[42, 28],
			[70, 14],
			[100, -20],
		],
		tail: [
			[0, -15],
			[30, 15],
			[60, -18],
			[100, -15],
		],
	},
};

function channels() {
	const ch = [];
	for (const l of ["front.near", "front.far", "hind.near", "hind.far"]) {
		const kind = l.split(".")[0];
		for (const c of ["up", "low", "paw"]) {
			ch.push({name: `${l}.${c}`, key: `${kind}.${c}`, phase: bound.phases[l]});
		}
	}
	for (const [c, rest] of [
		["ty", 0],
		["pitch", 0],
		["sx", 1],
		["sy", 1],
		["head", 0],
		["ear", 0],
		["tail", 0],
	]) {
		ch.push({name: c, key: c, rest});
	}
	return ch;
}

const legs = (fu, fl, hu, hl) => ({
	"front.near.up": fu,
	"front.far.up": fu,
	"front.near.low": fl,
	"front.far.low": fl,
	"hind.near.up": hu,
	"hind.far.up": hu,
	"hind.near.low": hl,
	"hind.far.low": hl,
});
const sit = {
	...legs(-8, 2, 74, -128),
	"hind.near.paw": 30,
	"hind.far.paw": 30,
	ty: 0,
	pitch: -30,
	sx: 1,
	sy: 1,
	head: 22,
	ear: 0,
	tail: 0,
};
const poses = {
	skid: {
		...legs(-36, 4, 16, -18),
		ty: 1,
		pitch: 10,
		sx: 1.04,
		sy: 0.97,
		head: -10,
		ear: 30,
		tail: 25,
	},
	sit,
	stand: {...legs(0, 0, 0, 0), ty: 0, pitch: 0, sx: 1, sy: 1, head: 0, ear: -8, tail: 8},
	crouch: {
		...legs(-26, 0, -30, 2),
		ty: -1,
		pitch: 7,
		sx: 1.05,
		sy: 0.95,
		head: 4,
		ear: -20,
		tail: -15,
	},
};
const wobbles = {
	look: {head: [22, 14, 0.5], ear: [4, 8, 0.5], tail: [0, 28, 3.5]},
	shake: {pitch: [-30, 4, 4.5], ear: [0, 40, 4.5], head: [22, 7, 4.5], tail: [0, 18, 4.5]},
};

export const rig = {
	n: 300,
	emitStride: 3,
	nFar: 120,
	emitStrideFar: 2,
	fillet: 12,
	// 27 units of sky above the puppy's old y = 20 top, for the hearts: the
	// glyph sits 26 units over the sitting head and rises 26 more, so a box
	// that stopped at the head clipped it away entirely (it left the box one
	// unit into a 1.4 s rise and was wholly outside by 0.46 s, still fully
	// opaque — the hearts had never been visible). `stage.aspect` and the
	// theme's `--ps-puppy-h` are scaled by 82/109 and 109/82 to match, so
	// the puppy is the same size on screen and crosses the same distance.
	//
	// The same arithmetic again, for the same reason at the other three
	// edges: {x: 0, w: 110, h: 109} still cut 2.9 units off the bottom and
	// 3.3 off the left of the bound. Extremes reach y 21.8…104.9 (the sky the
	// hearts need keeps the top far clear) and x -3.3…109.6, so this clears
	// them by 3.1 below, 3.7 left and 3.4 right; `h` 109 → 115 scales the
	// theme token by 115/109 and the aspect by 109/115 in turn.
	viewBox: {x: -7, y: -7, w: 120, h: 115},
	ground: 100,
	k: 2,
	farGroups: (items) => [items.slice(0, 5), items.slice(5, 10)],
	root: {
		pivot: [55, 100],
		rot: "pitch",
		ty: "ty",
		scale: ["sx", "sy"],
		children: [
			{
				pivot: [-55, -100],
				children: [
					leg("hind", "far", 35, 73),
					leg("front", "far", 67, 73),
					{pivot: [33, 58], rot: "tail", shapes: [D.tail]},
					{shapes: D.body},
					{
						pivot: [68, 55],
						rot: "head",
						shapes: D.head,
						marker: [32.6, 1],
						children: [{pivot: [4, -14], rot: "ear", shapes: [D.ear]}],
					},
					leg("hind", "near", 36, 76),
					leg("front", "near", 70, 76),
				],
			},
		],
	},
	gaits: {bound},
	channels,
	poses,
	wobbles,
	still: sit,
};

export default {
	name: "puppy",
	rig,
	colours: {near: "#e39a5a", far: "#f1cba6"},
	budget: 160 * 1024,
	/**
	 * What `client/themes/ps.css` has to say about this animal — the half of
	 * the box coupling no audit can reach, checked by `test/themes/ps.ts`
	 * (tools/heart/README.md § The audit):
	 *
	 * - `height` is `--ps-puppy-h`, the on-screen height of the *box*, in
	 *   strips;
	 * - `box` is the `viewBox.h` it was picked against, so a box that grows
	 *   without its token growing by the same ratio fails there instead of
	 *   shipping an animal a different size;
	 * - `stageWidth` is `stage.aspect × viewBox.h`, which a box change must
	 *   leave alone — the aspect scales the other way — or the animal travels a
	 *   different distance.
	 */
	theme: {height: 0.6172, box: 115, stageWidth: 1962},
	// Three hearts rise over the head while it looks around (rig units, above
	// the sitting head). `x`, `y` and `rise` are scaled by the rig's `k`
	// (lib/build.mjs) and `d` deliberately is not, so the glyph draws at half
	// the size its own coordinates imply: at full size it is as wide as the
	// muzzle and its apex reaches the top of the box. Small reads better and
	// costs no extra sky.
	hearts: {
		d: "M0,4 C0,0 4,-3 7,0 C10,3 7,8 0,13 C-7,8 -10,3 -7,0 C-4,-3 0,0 0,4 Z",
		x: 86,
		y: 22,
		rise: 26,
		times: [0.4, 2, 3.6],
	},
	sequence: {
		first: 14,
		period: 75,
		// 17.0609, not the small animals' original 24: the stage is
		// `aspect × viewBox.h` and the box grew from 82 to 109 for the hearts
		// and then to 115 to hold the bound, so 17.0609 × 115 = 18 × 109 ≈
		// 24 × 82 keeps the crossing the same width in rig units and on screen.
		stage: {aspect: 17.0609},
		segments: [
			{gait: "bound", cycles: 14, fps: 24, travel: 100},
			{pose: "skid", hold: 0.3, blend: 0.14, fps: 12},
			{pose: "sit", hold: 0.5, blend: 0.5, fps: 12},
			{wobble: "look", pose: "sit", secs: 1.8, fps: 12, hearts: true},
			{wobble: "shake", pose: "sit", secs: 0.8, fps: 24},
			{pose: "sit", hold: 0.5, blend: 0.25, fps: 12},
			{pose: "stand", hold: 0.2, blend: 0.4, fps: 12, turn: true},
			{pose: "crouch", hold: 0, blend: 0.2, fps: 12},
			{gait: "bound", cycles: 16, fps: 24, travel: 100},
		],
	},
};
