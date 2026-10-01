// The <3 theme's kitten (tools/heart/README.md): the puppy's topology — the
// same leg chain, the same `leg()` helper, the same far-leg slicing, the same
// root tree — drawn as a cat. Facing right, ground y = 100.
//
// What is not the puppy's:
//
// * a smaller, rounder body and a round skull with a short muzzle;
// * one pointed ear on its own channel, rooted inside the skull, whose tip is
//   exactly the kind of convex vertex the concave-only fillet preserves;
// * a long tail in three tapered segments on three channels (`tail`, `tail2`,
//   `tail3`), hanging off a disc buried in the rump, carrying a standing
//   curve at rest and never touching the body or a hind leg;
// * a diagonal two-beat trot instead of the puppy's bound;
// * a pounce (crouch, wiggle, leap) and a sit-and-wash, and no turn — §6.4
//   says the kitten trots on the way it came.
//
// Rotation sign, since the tail depends on it: paper.js rotates clockwise on
// screen for a positive angle (y points down). Every tail segment is *drawn*
// hanging straight down, so a positive `tail*` swings it backward and up —
// `tail: 120` carries it up and back off the rump, `tail: 45` lays it low
// behind a stalking crouch. (The plan's tables had these negative, which
// swings the tail forward and lays segment one flat along the animal's own
// back.) A positive `ear` swings the ear tip forward; a positive `head`
// points the muzzle down.

import {P, Circle, Ellipse, scaled} from "../lib/outline.mjs";

const D = {};
// Smaller and rounder than the puppy's, the chest disc deep enough that the
// skull and the raised foreleg both have body to sit inside.
D.body = [Ellipse(50, 66, 21, 12), Circle(65, 68, 11)];
// pivot at the neck (66,57): the skull disc is buried in the chest.
D.head = [Circle(10, -4, 12), Ellipse(20, 2, 6, 5), Circle(25, 1, 2.4)];
// in head coordinates, pivot (6,-10) — the base sits 3–6 units inside the
// skull at both corners, so a flick never opens a notch at the root.
D.ear = P("M0,0 C-4,-7 -3,-15 2,-21 C7,-14 8,-6 6,0 Z");
// The tail: a disc buried in the rump and three tapered strips, one per
// channel, each capped by a disc wider than the strip that hangs off it.
// Three *strips*, not two — hanging the first strip off the `tail2` node at
// the root's own pivot (as the plan's tree does) leaves the `tail` channel
// turning nothing but a circle, which is rotation-invariant, and the tail 25
// units long against a 42-unit body. A cat's tail is as long as its body.
D.tailRoot = [
	Circle(0, 0, 5),
	P("M-3.4,0 C-3.8,5 -3.4,10 -3,14 L3,14 C3.4,10 3.8,5 3.4,0 Z"),
	Circle(0, 14, 3.3),
];
// Measured clearances over the whole sequence, so a later change can tell what
// it is spending: the outer two segments never come closer than 1.54 units to
// the body or 2.91 to the near hind leg, both during `wiggle`. The root segment
// runs far tighter — its base sits ~0.002 from the body every frame, which is
// the buried disc doing its job, and it passes ~0.009 from the hind leg's upper
// segment in 21 frames of `wiggle`. That last one is the number to watch: a
// touch there encloses a pocket between tail, leg and rump, and a pocket that
// opens and closes jumps the outline. There is no room for it — the near
// outline already sits at 4.68 % of the 5 % limit. Re-measure after touching
// `wiggle`, the hind leg or any tail rest angle.
D.tailSeg = [P("M-3,0 C-3.4,5 -3,10 -2.6,14 L2.6,14 C3,10 3.4,5 3,0 Z"), Circle(0, 14, 2.9)];
D.tailTip = [P("M-2.6,0 C-2.8,4 -2.4,8 -2,11 L2,11 C2.4,8 2.8,4 2.6,0 Z")];
D.fup = [P("M-5,-10 C-6,2 -5,8 -4,12 L4,12 C5,8 6,2 5,-10 Z"), Circle(0, 12, 4.4)];
D.hup = [P("M-7,-12 C-9,0 -7,8 -4,12 L4,12 C6,7 7,0 6,-12 Z"), Circle(0, 12, 4.6)];
D.low = [P("M-3,0 L-3,8 L3,8 L3,0 Z"), Circle(0, 8, 3.4)];
D.paw = [P("M-4,-1 C-5,3 -3,5 0,5 C3,5 6,3 5,-1 Z")];

/** Finer and shorter than the puppy's; the far side thinner again and 5 % shorter. */
const THIN = 0.9;
const LONG = 0.9;
function leg(kind, side, px, py) {
	const isF = kind === "front";
	const k = (c) => `${kind}.${side}.${c}`;
	const thin = side === "far" ? THIN * 0.85 : THIN;
	const len = side === "far" ? LONG * 0.95 : LONG;
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
						marker: [5.5 * thin, 2 * len],
						foot: [0, 5 * len],
					},
				],
			},
		],
	};
}

// A diagonal two-beat trot: the near fore and far hind swing together, then
// the far fore and near hind half a cycle later.
const trot = {
	dur: 0.42,
	phases: {"front.near": 0, "hind.far": 0.02, "front.far": 0.5, "hind.near": 0.52},
	ch: {
		// Stance runs 0–54 % of the cycle, the paw tracking back at a near
		// constant rate (hence the linear easing through it); the swing folds
		// the lower leg to carry the paw forward clear of the ground. The fold
		// peaks at 77 %, exactly where `up` passes vertical — the deer's
		// lesson: a fold that peaks early straightens again before the leg
		// swings under the body, and the paw drags.
		"front.up": [
			[0, -31, "linear"],
			[27, 0, "linear"],
			[54, 31, "out"],
			[77, 0],
			[92, -22],
			[100, -31],
		],
		"front.low": [
			[0, 3],
			[27, 0],
			[54, 10],
			[66, 74],
			[80, 92],
			[92, 34],
			[100, 3],
		],
		"front.paw": [
			[0, 0],
			[54, 0],
			[77, -14],
			[92, -2],
			[100, 0],
		],
		"hind.up": [
			[0, -29, "linear"],
			[27, 2, "linear"],
			[54, 33, "out"],
			[77, 0],
			[92, -20],
			[100, -29],
		],
		"hind.low": [
			[0, 3],
			[27, 0],
			[54, -10],
			[66, -76],
			[80, -94],
			[92, -36],
			[100, 3],
		],
		"hind.paw": [
			[0, 0],
			[54, 0],
			[77, 22],
			[92, 3],
			[100, 0],
		],
		// Twice a cycle: the body rides highest over each diagonal pair's
		// mid-stance and drops where the legs are at full reach.
		ty: [
			[0, 2],
			[27, -2],
			[50, 2],
			[77, -2],
			[100, 2],
		],
		pitch: [
			[0, 0],
			[100, 0],
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
			[0, 0],
			[100, 0],
		],
		ear: [
			[0, -4],
			[50, 2],
			[100, -4],
		],
		tail: [
			[0, 118],
			[50, 124],
			[100, 118],
		],
		tail2: [
			[0, 28],
			[50, 34],
			[100, 28],
		],
		tail3: [
			[0, 22],
			[50, 30],
			[100, 22],
		],
	},
};

function channels() {
	const ch = [];
	for (const l of ["front.near", "front.far", "hind.near", "hind.far"]) {
		const kind = l.split(".")[0];
		for (const c of ["up", "low", "paw"]) {
			ch.push({name: `${l}.${c}`, key: `${kind}.${c}`, phase: trot.phases[l]});
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
		["tail2", 0],
		["tail3", 0],
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

// The haunches folded under, the forelegs propped straight: `sit` is also the
// still, since a sitting cat is the one silhouette nothing else in the cast
// could be.
const sit = {
	...legs(34, 6, -56, 50),
	"hind.near.paw": 40,
	"hind.far.paw": 40,
	ty: 2,
	pitch: -40,
	sx: 1,
	sy: 1,
	head: 22,
	ear: -2,
	tail: 206,
	tail2: 25,
	tail3: 25,
};

const poses = {
	stand: {
		...legs(0, 0, 0, 0),
		ty: 0,
		pitch: 0,
		sx: 1,
		sy: 1,
		head: 0,
		ear: -6,
		tail: 120,
		tail2: 30,
		tail3: 25,
	},
	// Stalking: shoulders and haunches folded, the back arched, the ears
	// flattened back and the tail laid low behind with the tip hooked up.
	crouch: {
		...legs(-25, 45, 8, -44),
		ty: 2,
		pitch: 4,
		sx: 1.04,
		sy: 0.94,
		head: 6,
		ear: -14,
		tail: 55,
		tail2: 85,
		tail3: 70,
	},
	// Mid-pounce: fore legs reaching, hind legs trailing, the tail streaming
	// back and up as a counterweight.
	leap: {
		...legs(-84, 26, 66, -50),
		// the far pair trails the near pair, so four legs read rather than two
		// clubs: paired exactly, a near and a far leg merge into one shape.
		"front.far.up": -44,
		"front.far.low": 30,
		"hind.far.up": 44,
		"hind.far.low": -22,
		"front.near.paw": -20,
		ty: -6,
		pitch: -10,
		sx: 1.05,
		sy: 0.98,
		head: -14,
		ear: 14,
		tail: 158,
		tail2: 40,
		tail3: 35,
	},
	sit,
	// The step the wash is reached through, and it is not decoration: a
	// forepaw raised to the face merges with the head, and a union with a
	// merged arm encloses the pocket between arm, chest and jaw — which the
	// outer boundary drops, so the near outline's length *falls* by the
	// pocket's perimeter in the single frame contact is made. Straight from
	// `sit` that step was 8.9 %, against a 5 % limit. Here the paw enters
	// exactly at the notch where the chest disc and the skull disc cross,
	// with the whole forelimb still buried in the chest: the pocket is born
	// with no perimeter at all, and then grows smoothly as the paw slides
	// forward along the jaw into `wash`. Both blends pass through it.
	//
	// The chin goes up on the way (`head: -2`, against the sit's 22): the
	// muzzle is what the rising paw would otherwise brush, and a graze with
	// the arm still fully extended is exactly the expensive contact. Head 8
	// measured an 8.2 % step; -2 measures 3.9 %.
	reach: {
		...sit,
		"front.near.up": -200,
		"front.near.low": 30,
		head: -2,
		ear: 4,
	},
	// The near forepaw up at the muzzle, the head levelled to bring the mouth
	// to it; the far forepaw stays propped on the ground, which is what a
	// washing cat actually does. The arm itself cannot read as a lifted limb
	// (the pocket it encloses with chest and jaw is dropped with the rest of
	// the union's holes), so the pose is built as a paw-shaped bump at the
	// muzzle instead, which is as close to the spec's "paw over ear" as a
	// 22.5-unit foreleg gets: the skull's top is 31 units from the shoulder.
	wash: {
		...sit,
		"front.near.up": -125,
		"front.near.low": 44,
		"front.near.paw": -18,
		head: 20,
		ear: 6,
	},
};

const wobbles = {
	// The hindquarters wiggle before the pounce: the whole body bobs, the
	// haunches load and unload, the low tail lashes.
	wiggle: {
		ty: [2, 2.5, 5],
		tail: [55, 14, 4],
		"hind.near.up": [8, 5, 5],
		"hind.far.up": [8, 5, 5],
	},
	// Washing: the paw works over the muzzle while the head follows it and
	// the ear twitches under it.
	washing: {
		"front.near.up": [-125, 4, 3],
		"front.near.low": [44, 6, 3],
		"front.near.paw": [-18, 10, 3],
		head: [20, 4, 3],
		ear: [6, 10, 3],
	},
};

export const rig = {
	n: 384,
	emitStride: 3,
	nFar: 120,
	emitStrideFar: 3,
	fillet: 12,
	viewBox: {x: 5, y: 17, w: 94, h: 91},
	ground: 100,
	k: 2,
	// the far hind leg's five parts, then the far front leg's five
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
					leg("hind", "far", 35.5, 75.6),
					leg("front", "far", 65.5, 75.6),
					{
						pivot: [36, 62],
						rot: "tail",
						shapes: D.tailRoot,
						children: [
							{
								pivot: [0, 14],
								rot: "tail2",
								shapes: D.tailSeg,
								children: [{pivot: [0, 14], rot: "tail3", shapes: D.tailTip}],
							},
						],
					},
					{shapes: D.body},
					{
						pivot: [66, 57],
						rot: "head",
						shapes: D.head,
						marker: [27.4, 1],
						children: [{pivot: [6, -10], rot: "ear", shapes: [D.ear]}],
					},
					leg("hind", "near", 37, 78.5),
					leg("front", "near", 68, 78.5),
				],
			},
		],
	},
	gaits: {trot},
	channels,
	poses,
	wobbles,
	still: sit,
};

export default {
	name: "kitten",
	rig,
	colours: {near: "#5aa9b8", far: "#b0d6dd"},
	budget: 150 * 1024,
	/**
	 * What `client/themes/ps.css` has to say about this animal — the half of
	 * the box coupling no audit can reach, checked by `test/themes/ps.ts`
	 * (tools/heart/README.md § The audit):
	 *
	 * - `height` is `--ps-kitten-h`, the on-screen height of the *box*, in
	 *   strips;
	 * - `box` is the `viewBox.h` it was picked against, so a box that grows
	 *   without its token growing by the same ratio fails there instead of
	 *   shipping an animal a different size;
	 * - `stageWidth` is `stage.aspect × viewBox.h`, which a box change must
	 *   leave alone — the aspect scales the other way — or the animal travels a
	 *   different distance.
	 */
	theme: {height: 0.44, box: 91, stageWidth: 2184},
	// Trot in, stalk, wiggle, pounce, land, sit, wash, stand and trot on the
	// same way. The pounce is the `leap` pose with a travel burst and the
	// landing ramping it back to zero; both are pure blends with `hold: 0`,
	// since the audit reads any segment with a hold or a wobble as a stop and
	// refuses one that applies 5 units/s or more.
	//
	// The trot applies 56 units/s and the stance measurement reads 91. The
	// measurement is the wrong one here: at the 6-unit plant tolerance a near
	// paw reads as planted for 77 % of the cycle, so it sums a slice of the
	// swing into the stance. The paw's backward excursion while it is really
	// in contact is 23-24 units a 0.42 s cycle, 55 to 58 units/s at plant
	// tolerances of 1.5, 3 and 6 alike, and that is also the ceiling: a
	// 22.5-unit leg swinging 31 degrees either way cannot stride further.
	// Distance is bought with cycles (38 in, 55 out), which are free in
	// bytes, and not with speed, which would skate the paws over half a
	// stride every step.
	sequence: {
		first: 8,
		period: 72,
		stage: {aspect: 24},
		segments: [
			{gait: "trot", cycles: 38, fps: 24, travel: 56},
			{pose: "crouch", hold: 0, blend: 0.3, fps: 12, travel: [56, 0]},
			{pose: "crouch", hold: 0.4, blend: 0, fps: 4, travel: 0},
			{wobble: "wiggle", pose: "crouch", secs: 1.0, fps: 10, travel: 0},
			{pose: "leap", hold: 0, blend: 0.32, fps: 20, travel: [0, 300]},
			{pose: "crouch", hold: 0, blend: 0.26, fps: 20, travel: [300, 0]},
			{pose: "sit", hold: 0, blend: 0.45, fps: 12, travel: 0},
			{pose: "sit", hold: 0.4, blend: 0, fps: 3, travel: 0},
			{pose: "reach", hold: 0, blend: 0.4, fps: 12, travel: 0},
			{pose: "wash", hold: 0, blend: 0.3, fps: 12, travel: 0},
			{wobble: "washing", pose: "wash", secs: 1.7, fps: 10, travel: 0},
			{pose: "reach", hold: 0, blend: 0.4, fps: 12, travel: 0},
			{pose: "sit", hold: 0, blend: 0.4, fps: 12, travel: 0},
			{pose: "sit", hold: 0.3, blend: 0, fps: 4, travel: 0},
			{pose: "stand", hold: 0.2, blend: 0.35, fps: 16, travel: 0},
			{gait: "trot", cycles: 55, fps: 24, travel: 56},
		],
	},
};
