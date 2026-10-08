// The <3 theme's bunny (tools/heart/README.md). Facing right, ground y = 100.
// Verbatim from the mockup: a ball of a tail, long front legs that reach the
// ground in the hop, two ears on their own channels; hop in, sit up and
// twitch, drop and hop on.

import {P, Circle, scaled} from "../lib/outline.mjs";

const B = {};
B.body = [
	P("M28,76 C24,62 34,50 52,48 C68,46 84,54 86,68 C88,80 82,88 70,92 C56,96 34,92 28,76 Z"),
	Circle(26, 79, 8.5),
];
B.head = [
	P("M-8,-8 C-4,-20 12,-22 20,-14 C26,-8 28,2 22,8 C16,14 4,12 0,6 C-4,2 -8,-2 -8,-8 Z"),
	Circle(24, -2, 2.6),
]; // pivot (84,58)
B.earNear = P("M0,0 C-7,-12 -6,-30 2,-38 C8,-32 9,-14 5,0 Z");
B.earFar = P("M0,0 C-8,-10 -8,-28 0,-36 C6,-28 8,-12 4,0 Z");
B.shank = [P("M-7,-6 C-10,2 -8,10 -5,15 L5,15 C7,8 8,2 7,-6 Z"), Circle(0, 15, 5.6)];
B.foot = [P("M-5,-2 L-5,5 L14,7 C18,7 18,1 14,0 L4,-2 Z")];
B.arm = [P("M-4,-6 C-5,0 -4.5,5 -3.5,9 L3.5,9 C4.5,5 5,0 4,-6 Z"), Circle(0, 9, 3.9)];
B.fore = [P("M-3,0 L-2.8,8 L2.8,8 L3,0 Z"), Circle(0, 8, 3)];
B.paw = [P("M-3.5,-1 C-4.5,2 -2,4 1,4 C4,4 6.5,2 5.5,-1 Z")];

function arm(side, px, py) {
	const k = (c) => `arm.${side}.${c}`;
	const thin = side === "far" ? 0.85 : 1;
	const len = side === "far" ? 0.94 : 1;
	return {
		pivot: [px, py],
		rot: k("up"),
		layer: side,
		shapes: scaled(B.arm, thin, len),
		children: [
			{
				pivot: [0, 9 * len],
				rot: k("low"),
				layer: side,
				shapes: scaled(B.fore, thin, len),
				children: [
					{
						pivot: [0, 8 * len],
						layer: side,
						shapes: scaled(B.paw, thin, len),
						marker: [5, 2],
						foot: [1, 4],
					},
				],
			},
		],
	};
}

const hop = {
	dur: 0.8,
	phases: {},
	ch: {
		shank: [
			[0, 36],
			[22, -28],
			[46, -18],
			[70, 18],
			[100, 36],
		],
		foot: [
			[0, 0],
			[22, 36],
			[46, 26],
			[70, -8],
			[100, 0],
		],
		"arm.up": [
			[0, 8],
			[22, 42],
			[46, -12],
			[70, -32],
			[100, 8],
		],
		"arm.low": [
			[0, 0],
			[22, 46],
			[46, 34],
			[70, -4],
			[100, 0],
		],
		ty: [
			[0, 0],
			[22, -12],
			[46, -22],
			[70, -3],
			[100, 0],
		],
		pitch: [
			[0, 3],
			[22, -18],
			[46, -5],
			[70, 12],
			[100, 3],
		],
		sx: [
			[0, 1.07],
			[22, 0.95],
			[46, 1],
			[70, 1.04],
			[100, 1.07],
		],
		sy: [
			[0, 0.93],
			[22, 1.07],
			[46, 1],
			[70, 0.96],
			[100, 0.93],
		],
		head: [
			[0, 3],
			[22, -8],
			[46, -3],
			[70, 8],
			[100, 3],
		],
		ear: [
			[0, -16],
			[22, -60],
			[46, -44],
			[70, 16],
			[100, -16],
		],
		ear2: [
			[0, -26],
			[22, -70],
			[46, -54],
			[70, 6],
			[100, -26],
		],
	},
};

function channels() {
	const ch = [
		["shank", 0],
		["foot", 0],
		["ty", 0],
		["pitch", 0],
		["sx", 1],
		["sy", 1],
		["head", 0],
		["ear", 0],
		["ear2", -10],
	].map(([name, rest]) => ({name, key: name, rest}));
	for (const side of ["near", "far"]) {
		for (const c of ["up", "low"]) {
			ch.push({name: `arm.${side}.${c}`, key: `arm.${c}`, phase: side === "far" ? 0.04 : 0});
		}
	}
	return ch;
}

// The sit-up, rocked back onto the haunches. `ty: -13.5`, not 0: `pitch`
// turns the whole body about the root pivot (56, 100), which is *on* the
// ground at mid-body, so pitching 34° back swings the rear down through it —
// at ty 0 the planted hind feet measured y 109 and 111.2 against a ground of
// 100 and the tail ball's bottom 107.9, a bunny drawn ten units into the
// earth. The legs alone cannot fix that (the rump is body, not leg), so the
// body is lifted instead, which lands the near hind foot on 100.0, the far
// one 2.2 above it and the silhouette's lowest point on 100.4 — the sole of
// the flat foot, resting. `collect` composes T(pivot)·R(rot)·S·T(0,ty), so
// this `ty` is rotated with the pitch: it lifts 11.2 and carries the bunny
// 7.5 units back, which is what rocking onto the haunches does anyway. That
// backward slide is why the sit segment pins `travel: 0` (below).
const sit = {
	shank: 46,
	foot: -8,
	"arm.near.up": -52,
	"arm.far.up": -48,
	"arm.near.low": 60,
	"arm.far.low": 56,
	ty: -13.5,
	pitch: -34,
	sx: 1,
	sy: 1,
	head: 26,
	ear: -4,
	ear2: -14,
};
const poses = {
	sit,
	// the hop's starting pose, so the next hop starts without a jump
	crouch: {
		shank: 36,
		foot: 0,
		"arm.near.up": 8,
		"arm.far.up": 8,
		"arm.near.low": 0,
		"arm.far.low": 0,
		ty: 0,
		pitch: 3,
		sx: 1.07,
		sy: 0.93,
		head: 3,
		ear: -16,
		ear2: -26,
	},
};
const wobbles = {twitch: {head: [26, 3, 6], ear: [-4, 6, 1.2], ear2: [-14, 6, 1.2]}};

export const rig = {
	n: 300,
	emitStride: 2,
	nFar: 120,
	emitStrideFar: 2,
	fillet: 12,
	// Contains the animal: nothing may be drawn outside its own box
	// (lib/build.mjs `boxOverflow`). The old {x: 0, y: 10, w: 120, h: 92}
	// cut 17 units off the top — the ears, through the sit-up that is the
	// whole point of this rig — 9.6 off the bottom and 9.7 off the right of
	// a hop. The sit's own burial is fixed in the pose above, not here; what
	// is left is a box that was simply too small. Extremes now reach
	// y -14.4…105.6 and x 3.3…129.7, so this clears them by 3 (above), 2.4
	// (below) and 3.3 (right). The theme's `--ps-bunny-h` is scaled by
	// 126/92 and `stage.aspect` by 92/126 to match, so the bunny is the same
	// size on screen and crosses the same distance.
	viewBox: {x: 0, y: -18, w: 133, h: 126},
	ground: 100,
	k: 2,
	// the far shank and foot (three parts), then the far arm (five)
	farGroups: (items) => [items.slice(0, 3), items.slice(3, 8)],
	root: {
		pivot: [56, 100],
		rot: "pitch",
		ty: "ty",
		scale: ["sx", "sy"],
		children: [
			{
				pivot: [-56, -100],
				children: [
					{
						pivot: [42, 76],
						rot: "shank",
						layer: "far",
						shapes: scaled(B.shank, 0.85, 0.92),
						children: [
							{
								pivot: [0, 13.8],
								rot: "foot",
								layer: "far",
								shapes: scaled(B.foot, 0.92, 0.92),
								marker: [18, 4],
								foot: [8, 7],
							},
						],
					},
					{
						pivot: [46, 80],
						rot: "shank",
						shapes: B.shank,
						children: [{pivot: [0, 15], rot: "foot", shapes: B.foot, foot: [8, 7]}],
					},
					arm("far", 76, 76),
					{shapes: B.body},
					arm("near", 80, 78),
					{
						pivot: [84, 58],
						rot: "head",
						shapes: B.head,
						marker: [26.6, -2],
						children: [
							{pivot: [0, -14], rot: "ear2", shapes: [B.earFar]},
							{pivot: [8, -14], rot: "ear", shapes: [B.earNear]},
						],
					},
				],
			},
		],
	},
	gaits: {hop},
	channels,
	poses,
	wobbles,
	still: sit,
};

export default {
	name: "bunny",
	rig,
	colours: {near: "#9b82dc", far: "#cbbfee"},
	budget: 160 * 1024,
	/**
	 * What `client/themes/ps.css` has to say about this animal — the half of
	 * the box coupling no audit can reach, checked by `test/themes/ps.ts`
	 * (tools/heart/README.md § The audit):
	 *
	 * - `height` is `--ps-bunny-h`, the on-screen height of the *box*, in
	 *   strips;
	 * - `box` is the `viewBox.h` it was picked against, so a box that grows
	 *   without its token growing by the same ratio fails there instead of
	 *   shipping an animal a different size;
	 * - `stageWidth` is `stage.aspect × viewBox.h`, which a box change must
	 *   leave alone — the aspect scales the other way — or the animal travels a
	 *   different distance.
	 */
	theme: {height: 0.6026, box: 126, stageWidth: 2208},
	// Hop in, sit up and twitch, drop and hop on. `travel: 160` (about 1.3
	// body lengths a hop) — 85 read as barely moving, about half a body
	// length per 0.8 s hop. Cycles retuned so the bunny sits up near the
	// middle of its 736-unit stage and clears the right edge; the audit's
	// exit rule decides the count.
	sequence: {
		first: 7,
		period: 50,
		// 17.5238, not 24: the stage is `aspect × viewBox.h` and the box grew
		// from 92 to 126 to hold the ears, so 17.5238 × 126 = 24 × 92 keeps
		// the crossing the same width in rig units and on screen.
		stage: {aspect: 17.5238},
		segments: [
			{gait: "hop", cycles: 9, fps: 24, travel: 160},
			// travel: 0 pins the sit-up for the same reason the drop below is
			// pinned: rocking back onto the haunches carries the body 7.5 units
			// backward (the pose's `ty`, rotated by its pitch), which the stance
			// measurement reads as real forward travel — a sitting bunny must
			// not move, and the hold-speed rule says so
			{pose: "sit", hold: 0.4, blend: 0.45, fps: 12, travel: 0},
			{wobble: "twitch", pose: "sit", secs: 1.4, fps: 12},
			// travel: 0 pins the drop: the crouch's arms reaching for the
			// ground read as ~5.3 units/s of stance drift (the hold-speed audit
			// rule's own catch — a static bunny must not travel)
			{pose: "crouch", hold: 0.1, blend: 0.4, fps: 12, travel: 0},
			{gait: "hop", cycles: 10, fps: 24, travel: 160},
		],
	},
};
