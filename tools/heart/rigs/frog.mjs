// The <3 theme's frog (tools/heart/README.md). Facing right, ground y = 100.
//
// Rotation sign, which every angle depends on: paper.js rotates clockwise on
// screen for a positive angle (y points down), so a part drawn hanging
// straight down swings *backward* for a positive angle — the kitten's note.
// A hind leg hangs from the hip: the thigh's -166.8° at rest carries the knee
// up and *forward* off the rump, and the shank's -157.9° folds it down and
// back again to an ankle behind the belly.
//
// The hind legs move as one pair — one key per side, `hind.*` shared by the
// near and the far leg with 3 % of a cycle between them — which is the one
// thing that separates a frog from every quadruped in this cast.
//
// ── The redraw, and why the first frog was a blob ─────────────────────────
//
// The frog shipped in `04f1a13f` was three ellipses in a row with two eye
// discs on the front one and a folded leg tucked against it, and on the cast
// sheet it read as a lumpy green mass with a thin limb. It failed the way the
// **ladybug** failed an hour before it, and for the same reason: every near
// part is unioned into one outline and then filleted, so a body assembled out
// of tangent blobs loses every gentle change of direction and collapses
// toward an egg. What fixed the ladybug was **lobes with cliffs between
// them**, and that is what this rig is built to have: read back to front, the
// top line must be a sequence of named features with real valleys between
// them, not a curve.
//
// The numbers below are measured off the finished `sit`, after the fillet —
// `node tmp/prof.mjs` in the redraw's session printed the top line x by x, and
// `pose-sheet.mjs frog poses` is the picture of it. Keep them if anything here
// is retouched:
//
//   1. **The knee is the highest point of the animal, and there is sky under
//      it.** The top line peaks at **59.5 at x = 40** (the knee cap), falls to
//      a **notch floor of 74.2 at x = 50–54**, and rises again to the near
//      eye's **64.1 at x = 74**. So the haunch stands 14.7 clear of the notch
//      and 4.6 clear of the head, and the notch is ten units wide. That notch
//      is the single most characteristic thing a sitting frog has and it is
//      the whole reason for the layout: the hip (36, 85) sits at the *back* of
//      the body while the knee swings *forward* over it, so the haunch is a
//      lobe standing on the body's rear third with the back line dropping away
//      in front of it. Two other arrangements were drawn and both give the
//      blob back — a thigh standing vertically over the hip emerges level with
//      the back (no notch), and a thigh leaning back puts the haunch at the
//      rear extremity with nothing behind it, which reads as a lizard.
//   2. **Two eye bumps with a valley between them**: near (75, 72) r 8, far
//      (59.5, 75.8) r 6. Centres 15.9 apart against radii summing 14, so there
//      is a two-unit window of skull between them and the top line dips to
//      72.4 at x = 66 between the far eye's 69.8 and the near eye's 64.1.
//      Each overlaps the skull by five or six units, so neither can detach.
//      Drawn tangent (the old rig) they fill their own valley and read as one
//      dome; drawn *overlapping*, which was also tried, the far one becomes a
//      shoulder on the near one and the second eye is gone. Both bumps are
//      sub-pixel at the 24 px the animal renders at — they are there for the
//      still and for anyone looking closely.
//   3. **A blunt wedge of a snout, well below the eyes.** The head's top line
//      is 74.2 under the eye and its front is a near-vertical face at
//      x ≈ 87, so the outline *steps down* 64.1 → 78.1 across the eight units
//      from x = 78 to x = 86 instead of curving away, and the mouth line under
//      it runs straight back 28 units to x = 58. A frog's mouth is the longest
//      straight edge on the animal, and the eye sits only four units behind
//      the snout: a long muzzle with the eye in the middle of it was drawn
//      twice here and reads as a dog both times.
//   4. **The front legs prop the chest up.** The belly is 91 — nine clear of
//      the ground — the chin above it at 87.6, and one 14-unit arm reaches
//      down through that gap to the ground at (68.2, 99.9), so there is open
//      sky either side of it between the chin and the grass.
//
// **The hind foot hangs clear of the belly, and that is not cosmetic.** With
// the foot's top edge tucked *inside* the body outline (the obvious way to
// draw a frog resting on its feet) the two edges run parallel for twenty
// units, so the sliver between them is a closed hole in the union — dropped
// by `largest()` — and it opens and shuts as the body rises. The near
// outline's length jumped 15 % in one frame on the first frog, and 20 % on the
// first draft of this one: it is a topology change, not a sampling artefact,
// and no frame rate fixes it. The cure here is the hop's own stance keys
// (below) plus the standing clearance: the belly is 91 and the hind foot's top
// edge crosses under it at 92.6, and the gap only ever opens. Anything that
// lowers the body, thickens the foot or lifts the planted ankle has to re-run
// the union's child count across the cycle, not just the audit — a pocket that
// costs 20 % of the outline is a *second* child of the union, and that is the
// thing to count.

import {P, Circle, scaled} from "../lib/outline.mjs";

// ── the skeleton, in one place ───────────────────────────────────────────
// Every hind angle in this file was solved against these by inverse
// kinematics (hip → knee → ankle, knee-up branch) from a toe path, so a change
// to any of the five numbers invalidates every hind table. The limb is 65
// units against a 61-unit body, as a frog's is.
const HIP = [36, 85];
const HIP_FAR = [32, 85];
const SHOULDER = [66, 82];
const SHOULDER_FAR = [63, 80.5];
const THIGH = 19; // hip → knee
const SHANK = 32; // knee → ankle
const ARM = 14; // shoulder → wrist

const D = {};
// The trunk: one path, not a row of ellipses. Its crest is at the *rear*
// (73.2 at x ≈ 36, under the haunch) and the back line falls away forward to
// 76 at the shoulder, which is what turns the space in front of the haunch
// into a notch rather than a shoulder. The belly is 91, nine clear of the
// ground. A row of tangent ellipses cannot make either edge, and that is what
// the old rig was.
D.body = [
	P(
		"M26,86.6 C24,82 27,74.8 34,73.6 " +
			"C42,72.6 52,73.8 60,76.2 C65.4,77.8 69,80 70.6,82.6 " +
			"C72.2,85.6 71.4,89.2 68,89.8 " +
			"C56,91.4 34,91.4 30,89.8 C27.6,89 26.6,87.6 26,86.6 Z"
	),
];
// The head: a wedge overlapping the trunk from x = 54, 34 long and 13 deep,
// its top line flat at 74.2 under the eye and its front a blunt near-vertical
// face at x ≈ 87. The mouth line runs straight back 28 units to x = 58, and
// the chin (87.6) is above the belly (91), so the underside steps as well as
// the top.
D.head = [
	P(
		"M54,79.2 C58,75.8 64,74.4 72,74.2 " +
			"C79,74 84,75.8 86,78.6 " +
			"C87.6,80.8 87.4,84.4 85.4,85.8 " +
			"C83.2,87.2 74,87.6 64,87.6 L58,87.4 " +
			"C53,86.8 51.4,81.8 54,79.2 Z"
	),
];
// The eye bumps sit ON TOP of the skull and break its curve, with a two-unit
// window of skull between them (see 2 above). The near one is at the *front*
// of the head — four units behind the snout — because that is where a frog's
// eye is, and putting it in the middle of the skull makes a muzzle.
D.eyeNear = [Circle(75, 72, 8)];
D.eyeFar = [Circle(59.5, 75.8, 6)];
// Hind leg. The thigh is a haunch — wide where it is buried in the rump,
// tapering to a knee cap (r 7) that is wider than the 6-unit bar it caps and
// rounds the top of the lobe — then a slim shank down to the ankle and a long
// webbed foot flat on the ground.
//
// **A folded leg cannot zigzag in profile and it is a waste of rounds to try.**
// The knee is the apex and both the hip and the ankle hang below it, so
// whatever the fold, the thigh and the shank leave the knee within about 15°
// of each other and the union makes them one haunch — which is what a sitting
// frog's leg actually looks like. What the leg *can* contribute is three
// separate features, and it does: the knee lobe above the back, the heel as a
// blunt corner at (17, 91)–(17, 97) behind and below the rump, and the webbed
// foot lying forward from it along the ground to a toe at (38.4, 99.8).
D.thigh = [
	P("M-6.6,-2 C-7.6,3 -7.2,8 -6,14 L6,14 C8,8 9,3 8,-2 C4,-5.4 -2.6,-5.4 -6.6,-2 Z"),
	Circle(0, 19, 7),
];
D.shank = [P("M-4.6,0 C-5,10 -4.4,21 -3.4,32 L3.4,32 C4.4,21 5,10 4.6,0 Z"), Circle(0, 32, 4.6)];
// The webbed foot: 22 long, and deep enough (−1 … 6.6) that the toe's contact
// point sits 6 below the ankle. That depth is what lets the ankle ride at 92.9
// and still put the toe on the ground — and the ankle's height is exactly the
// daylight between the foot and the belly, which is the topology guard above.
D.hfoot = [P("M-4.2,-1 C-6,1.8 -4.2,6.6 0,6.6 C10,6.6 21,4.6 22,1.6 C22,-0.6 12,-1.4 3.5,-1.2 Z")];
// Front leg: one straight prop from a shoulder buried in the chest down
// through the nine-unit gap under the belly to the ground.
D.farm = [P("M-4,-4 C-4.8,2 -4.2,8 -3.4,14 L4,14 C4.8,8 5.2,2 4.4,-4 Z"), Circle(0, 14, 3.9)];
D.ffoot = [P("M-3.4,-1 C-5,2 -2.8,4.6 1,4.6 C5.4,4.6 8,2.6 7,-1 Z")];
// The tongue slides, it does not swing — see `tongueYaw` and the `out` pose.
// Drawn along its own -y, which the yaw turns into "backward along the body",
// so at rest it lies inside the head and the belly and the outline never
// knows it is there (measured: the union is bit-identical with it removed).
D.tongue = [P("M-2,0 C-2.6,-9 -2.6,-21 -1.4,-28 C0,-29.5 0,-29.5 1.4,-28 C2.6,-21 2.6,-9 2,0 Z")];

/** Hip (thigh → shank → webbed foot); the far leg thinner, shorter and set back. */
function hindLeg(side, px, py) {
	const k = (c) => `hind.${side}.${c}`;
	const thin = side === "far" ? 0.85 : 1;
	const len = side === "far" ? 0.95 : 1;
	return {
		pivot: [px, py],
		rot: k("thigh"),
		layer: side,
		shapes: scaled(D.thigh, thin, len),
		children: [
			{
				pivot: [0, THIGH * len],
				rot: k("shank"),
				layer: side,
				shapes: scaled(D.shank, thin, len),
				children: [
					{
						pivot: [0, SHANK * len],
						rot: k("foot"),
						layer: side,
						shapes: scaled(D.hfoot, thin, len),
						marker: [22 * thin, 1.6],
						// the toe, not the heel: the push-off rolls the frog
						// onto its toes and the toe is the last thing in contact
						foot: [17 * thin, 6 * len],
					},
				],
			},
		],
	};
}

/** Shoulder (arm → hand), two levels rather than the hind leg's three. */
function frontLeg(side, px, py) {
	const k = (c) => `front.${side}.${c}`;
	const thin = side === "far" ? 0.85 : 1;
	const len = side === "far" ? 0.95 : 1;
	return {
		pivot: [px, py],
		rot: k("arm"),
		layer: side,
		shapes: scaled(D.farm, thin, len),
		children: [
			{
				pivot: [0, ARM * len],
				rot: k("foot"),
				layer: side,
				shapes: scaled(D.ffoot, thin, len),
				marker: [7 * thin, 0],
				foot: [1 * thin, 4 * len],
			},
		],
	};
}

// One gait. A frog's hop is a load, one explosive extension, a low arc and a
// folded landing. The hind pair moves together; the far side trails by 3 % of
// the cycle so the two legs never draw as one shape.
const hop = {
	dur: 1,
	phases: {near: 0, far: 0.03},
	ch: {
		// The cycle starts at the landing, which is also the `sit` pose, so a
		// hop begins and ends without a jump. 0-24 % is contact and 24-100 %
		// is flight: the leg snaps out behind, then folds and swings forward
		// to reach the next landing.
		//
		// **The contact keys are solved, not drawn, and that is what keeps the
		// union in one piece.** The toe is planted, so in the rig's own frame
		// it slides *back* at exactly the pinned 143 units/s — 11.44 units per
		// 8 % of the cycle — while the hip stays put; the three angles at 0, 8,
		// 16 and 24 are the two-link solution (knee-up branch) putting the
		// ankle where a foot flat on the ground with that toe puts it, with the
		// heel rolling up from 4° to 48°. The first draft of this rig had those
		// keys drawn by eye instead, the planted ankle rose 3.6 units in the
		// first tenth of a second, the foot's top edge met the belly, and the
		// channel between them closed into a pocket `largest()` drops: the near
		// outline lost 20 % in one frame and got it back three frames later.
		// A pose sheet cannot see that. `tmp`-side, the check is the union's
		// child count across the cycle — it must be 1 at every phase.
		//
		// **The flight is drawn by eye, and is bounded by the box.** A leg 51
		// units from hip to ankle thrown straight back off a hip at x = 36 puts
		// the trailing foot past x = -40, so the leg is held with the shank
		// still 45° off the thigh and the toes trailing down rather than back;
		// `boxOverflow` reports the margin that buys (4.7 units at 28 fps) and
		// the extension frame is the one that sets it.
		"hind.thigh": [
			[0, -166.8, "linear"],
			[8, -196.8, "linear"],
			[16, -205.2, "linear"],
			[24, -208.4, "out"],
			[30, -214],
			[38, -228],
			[50, -224],
			[62, -212],
			[75, -196],
			[88, -178],
			[100, -166.8],
		],
		"hind.shank": [
			[0, -157.9, "linear"],
			[8, -127.7, "linear"],
			[16, -106.6, "linear"],
			[24, -97.1, "out"],
			[30, -86],
			[38, -45],
			[50, -62],
			[62, -100],
			[75, -128],
			[88, -149],
			[100, -157.9],
		],
		"hind.foot": [
			[0, -31.3, "linear"],
			[8, -31.9, "linear"],
			[16, -22.6, "linear"],
			[24, 4.3, "out"],
			[30, 14],
			[38, 6],
			[50, 4],
			[62, -6],
			[75, -18],
			[88, -28],
			[100, -31.3],
		],
		// The hands are down at the landing and leave the ground early: a
		// frog's forelimbs take the landing and then tuck under the chest.
		"front.arm": [
			[0, -5],
			[8, 16],
			[24, 32],
			[40, 34],
			[62, 6],
			[78, -30],
			[92, -20],
			[100, -5],
		],
		"front.foot": [
			[0, 5],
			[8, -6],
			[24, -22],
			[40, -22],
			[62, -6],
			[78, 16],
			[92, 14],
			[100, 5],
		],
		ty: [
			[0, 0],
			[10, 1],
			[20, -8],
			[30, -20, "out"],
			[40, -22],
			[54, -22],
			[70, -21],
			[85, -9],
			[94, -1],
			[100, 0],
		],
		pitch: [
			[0, 0],
			[10, 3],
			[20, -8],
			[30, -15],
			[40, -13],
			[54, -4],
			[70, 5],
			[85, 8],
			[94, 4],
			[100, 0],
		],
		sx: [
			[0, 1],
			[10, 1.05],
			[30, 0.97],
			[45, 1],
			[92, 1.04],
			[100, 1],
		],
		sy: [
			[0, 1],
			[10, 0.95],
			[30, 1.04],
			[45, 1],
			[92, 0.96],
			[100, 1],
		],
	},
};

function channels() {
	const ch = [];
	for (const side of ["near", "far"]) {
		const phase = hop.phases[side];
		for (const c of ["thigh", "shank", "foot"]) {
			ch.push({name: `hind.${side}.${c}`, key: `hind.${c}`, phase});
		}

		for (const c of ["arm", "foot"]) {
			ch.push({name: `front.${side}.${c}`, key: `front.${c}`, phase});
		}
	}

	for (const [c, rest] of [
		["ty", 0],
		["pitch", 0],
		["sx", 1],
		["sy", 1],
		["tongue", 0],
		["tongueYaw", -90],
	]) {
		ch.push({name: c, key: c, rest});
	}

	return ch;
}

/**
 * A pose table written once per pair — `hind.thigh` rather than both
 * `hind.near.thigh` and `hind.far.thigh`. A **pose** may be keyed either way
 * (`samplePose` falls back to the channel's key), but a **wobble**'s pose may
 * not: `sampleWobble` reads `pose[ch.name]` alone, so a pose reached by a
 * wobble segment carrying only the pair key would drop every leg to 0 and
 * splay the frog flat. Every pose here is expanded, so both are safe.
 */
const both = (o) =>
	Object.fromEntries(
		Object.entries(o).flatMap(([k, v]) =>
			k.startsWith("hind.") || k.startsWith("front.")
				? [
						[k.replace(".", ".near."), v],
						[k.replace(".", ".far."), v],
				  ]
				: [[k, v]]
		)
	);

/**
 * The sit, and the hop's own frame 0 so a hop starts and ends without a jump —
 * they have to stay numerically identical, and on the same branch of the
 * circle: the segment after a hop *blends* from the gait's closing frame to
 * this pose, so writing the shank as +202.1 here and -157.9 there (the same
 * angle) would spin the leg a whole turn on every landing.
 *
 * The three hind angles are one solution, not three tastes: the thigh's
 * -166.8° puts the knee at (40.3, 66.5) — 4 forward and 18.5 up from the hip,
 * which is what puts the haunch over the body's rear rather than behind it —
 * the shank's -157.9° drops the ankle to (21.9, 92.9), and the foot's -31.3°
 * lays the webbed foot along the ground at 4° so the toe touches at
 * (38.4, 99.8) and the heel stands clear at x = 17. Move the hip or either
 * length and all three move with it.
 */
const sit = both({
	"hind.thigh": -166.8,
	"hind.shank": -157.9,
	"hind.foot": -31.3,
	"front.arm": -5,
	"front.foot": 5,
	ty: 0,
	pitch: 0,
	sx: 1,
	sy: 1,
	tongue: 0,
	tongueYaw: -90,
});

const poses = {
	sit,
	// The tongue out. `tongue` is a *slide*, not a swing: the tongue is drawn
	// lying backward inside the body, and `tongueYaw` (a constant -90) turns
	// its own +y into "forward", so the channel translates it out through the
	// mouth and back again. A swing cannot do this — a 29-unit tongue rotating
	// from tucked (back) to out (forward) points straight down halfway, which
	// is a spike through the belly and the grass on every frame of every
	// blend, whichever way round it goes. A slide has no bad intermediate
	// state: the tongue grows out of the mouth, and the outline's length grows
	// smoothly with it.
	out: {...sit, tongue: 20},
};

// Breathing: the flanks and throat work while the frog sits. `sy` alone, which
// is why there is no `throat` channel and no throat disc — fewer parts, fewer
// union risks (the plan's own preference).
const wobbles = {
	breathe: {sy: [1, 0.035, 1.5], ty: [0, 0.6, 1.5]},
};

export const rig = {
	n: 258,
	emitStride: 3,
	nFar: 100,
	emitStrideFar: 3,
	// 10 rather than the puppy's 12: the eye bumps, the notch under the knee
	// and the webbed toes are exactly the features a stronger fillet rounds
	// away, and this rig is nothing without them.
	fillet: 10,
	// The box is 137 wide for 70 units of sitting frog because the hop throws
	// the leg back to x = -26 (see the gait). It is 74 tall, unchanged by the
	// redraw, which is the only reason the `theme` block below did not have to
	// move — height is the coupled dimension, width is free.
	viewBox: {x: -31, y: 31, w: 137, h: 74},
	ground: 100,
	k: 2,
	// the far hind leg's five parts, then the far front leg's three
	farGroups: (items) => [items.slice(0, 5), items.slice(5, 8)],
	root: {
		pivot: [50, 100],
		rot: "pitch",
		ty: "ty",
		scale: ["sx", "sy"],
		children: [
			{
				pivot: [-50, -100],
				children: [
					hindLeg("far", ...HIP_FAR),
					frontLeg("far", ...SHOULDER_FAR),
					{shapes: D.body},
					{shapes: D.head},
					{pivot: [81, 82.5], rot: "tongueYaw", ty: "tongue", shapes: D.tongue},
					{shapes: D.eyeNear, marker: [75, 64]},
					{shapes: D.eyeFar},
					hindLeg("near", ...HIP),
					frontLeg("near", ...SHOULDER),
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
	name: "frog",
	rig,
	colours: {near: "#7fb069", far: "#b9d6a8"},
	budget: 100 * 1024,
	/**
	 * What `client/themes/ps.css` has to say about this animal — the half of
	 * the box coupling no audit can reach, checked by `test/themes/ps.ts`
	 * (tools/heart/README.md § The audit):
	 *
	 * - `height` is `--ps-frog-h`, the on-screen height of the *box*, in
	 *   strips;
	 * - `box` is the `viewBox.h` it was picked against, so a box that grows
	 *   without its token growing by the same ratio fails there instead of
	 *   shipping an animal a different size;
	 * - `stageWidth` is `stage.aspect × viewBox.h`, which a box change must
	 *   leave alone — the aspect scales the other way — or the animal travels a
	 *   different distance.
	 *
	 * The redraw grew the box **sideways only** — 114 → 137 units wide, to hold
	 * the trailing leg of a limb 8 % longer than the old one — and `viewBox.h`
	 * is untouched at 74, which is why none of the three numbers here moved.
	 * `background-size` is `auto <height>`, so a wider box changes nothing on
	 * screen but the framing of the reduced-motion still.
	 */
	theme: {height: 0.3, box: 74, stageWidth: 1776},
	sequence: {
		first: 11,
		period: 58,
		stage: {aspect: 24},
		segments: [
			{pose: "sit", hold: 0.75, blend: 0, fps: 8, travel: 0},
			{wobble: "breathe", pose: "sit", secs: 1.2, fps: 8, travel: 0},
			// 28 fps, not the 20 the first frog hopped at: the leg leaves the
			// haunch and straightens over about a third of the cycle, which
			// moves 40 units of near outline, and 20 fps spends 6.5 % of the
			// outline on the widest of those frames against the audit's 5 %.
			// Frames are the only lever there — the speed is pinned by the
			// travel — and eight more of them cost 12 KB of the 100 KB row,
			// which is why `n` came down from 280 to 258 to pay for them.
			{gait: "hop", cycles: 5, fps: 28, travel: 143},
			{pose: "sit", hold: 0.5, blend: 0.3, fps: 10, travel: 0},
			// The flick: the tongue slides 20 units out and back. 30 fps is not
			// smoothness for its own sake — the tongue emerging adds twice its own
			// extension to the near outline's length every frame, and the audit's
			// limit is 5 % of it, so how fast the tongue may travel is bounded by
			// the frame rate it travels at. The holds either side are cheap frames
			// at 8-10 fps instead.
			{pose: "out", hold: 0, blend: 0.3, fps: 30, travel: 0},
			{pose: "out", hold: 0.1, blend: 0, fps: 10, travel: 0},
			{pose: "sit", hold: 0, blend: 0.3, fps: 30, travel: 0},
			{pose: "sit", hold: 0.4, blend: 0, fps: 8, travel: 0},
			{gait: "hop", cycles: 9, fps: 28, travel: 143},
		],
	},
};
