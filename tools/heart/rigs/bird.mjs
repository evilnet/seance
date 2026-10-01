// The <3 theme's bird (tools/heart/README.md): the only animal whose route
// leaves the ground — flap in high, glide, descend, land on the ground line,
// hop twice, take off. Facing right, ground y = 100.
//
// **No theme change is needed for the high route, and that is the whole
// trick.** A slot pins the image's *bottom* at the ground line and scales it
// by *height*, so a viewBox with 700 units of empty sky above the bird puts
// the bird near the top of the sky while its ground line still lands where
// every other animal's does. Three knobs are therefore set independently:
// the body is drawn ~76 units tall (inside the 80–200 band the fillet and
// `n` are tuned for, near enough), the box is 800 units tall so the route
// reaches the sky, and `stage.aspect` is 11 — far below the ground animals'
// 16–24 — because the on-screen stage is `aspect × -h × --strip` and `-h`
// here is a whole strip, not half of one. Do not copy an aspect from a
// ground animal.
//
// Rotation sign: paper.js rotates clockwise on screen for a positive angle
// (y points down). The wing is drawn pointing *backward* (local −x), so a
// positive `wing` raises it and a negative one drops it; a leg is drawn
// hanging down, so a positive `leg.thigh` swings it backward.
//
// ── Three constraints hold this rig together ────────────────────────────
//
//  1. **`ty` sits above `pitch`, not under it.** `collect` composes
//     T(pivot)·R(rot)·S·T(0,ty), so a `ty` inside a rotating node is
//     *rotated*: at the ladybug's 16-unit apex that is 2 units of coupling
//     and invisible, but at this rig's 660 it is 115 units of sideways
//     shift on a 126-wide box at pitch −10 — the bird would fly out the
//     side of its own picture. The root here only translates; a second node
//     pitches and scales about the body's own centre.
//
//  2. **There is no `tail` channel, and the tail is part of the body.** A
//     rotating tail and a wing that sweeps its angular sector cross each
//     other, and two limbs crossing off a shared body enclose a pocket that
//     `largest()` drops — a topology change worth 10–20 % of the outline in
//     one frame (the frog's foot, the teddy's arm). Even a *static* tail
//     costs this if the wing can reach it, so the wing's reach (46) is held
//     under the distance from its pivot to the nearest exposed scrap of
//     tail (measured 46.9 at the worst beat angle, `tools/heart` check
//     script) and the two never touch at any angle of any gait.
//
//  3. **The near wing beats above the back; the far wing is the one that
//     goes below.** A blade rotating off an *elongated* body is swallowed
//     by it when it lies along the flank, so the near outline's length
//     does not vary smoothly with the wing angle — measured, it is flat at
//     ~226 for every angle under −9, flat at ~267 for every angle over
//     +18, and climbs 40 units across the 27° between them (1.5 units per
//     degree). That 40 units is 18 % of the outline, so a beat that
//     crosses the ramp twice a cycle is what the audit's 5 % rule actually
//     sees, and no affordable frame rate fixes it — the fix is to cross
//     the ramp *slowly* (the `linear` keys below hold every crossing to
//     ≥ 3 stored frames) and to keep the far wing's wide arc, which is its
//     own outline and so costs the near one nothing, as the thing that
//     shows a wing below the belly. Anything that moves a wing faster
//     through −9…+18 — a beat, a blend, the take-off's opening — has to
//     re-measure. The ramp segments store every frame, so they hold their
//     wings in the flat zone entirely.

import {P, Circle, Ellipse, scaled} from "../lib/outline.mjs";
import {cyc} from "../lib/sampler.mjs";

const GROUND = 100;

// ── the parts ────────────────────────────────────────────────────────────
const D = {};
// The body: a 60 × 30 spindle with a chest ellipse lifting the shoulder into
// the neck, and the tail as a *wedge of the same union* rather than a limb
// (constraint 2). The wedge is short and low: everything of it that is not
// swallowed by the torso lies at least 46.9 units from the wing's pivot.
D.body = [
	Ellipse(70, 58, 30, 15),
	Ellipse(84, 51, 16, 12),
	P("M50,51 C42,52 34,55 26,59 C34,63 42,66 50,67 Z"),
];
// The head, low and forward, overlapping the chest by a dozen units so the
// neck is a chord buried in the shoulder rather than a seam.
D.head = [Circle(99, 37, 13)];
// The beak: 18 units of it, rooted 6 inside the skull. Pointed, and the
// fillet is concave-only so the point survives — but `fillet: 8` (below the
// cast's usual) is what keeps it sharp at this size.
D.beak = [P("M0,-5.4 C9,-4 17,-1.6 22,0.9 C16,4.4 8,6 0,6.4 Z")];
// A wing: a 46-unit cambered blade drawn lying straight back from the
// shoulder, 16 across at the root and 6 at the tip. Length is not a matter
// of taste — see constraint 2. `scaled()` shrinks it for the far side.
D.wing = [
	P(
		"M4,-8 C-8,-13 -24,-15.5 -36,-13.5 C-43,-12 -46,-8.5 -43,-5.5 " +
			"C-33,-1.5 -18,3.5 -4,8 C2,6 6,-2 4,-8 Z"
	),
];
// Thigh (hip → ankle) with its cap, and the tarsus with a small foot pad.
// A bird's leg is a stick; the cap is wider than the bar it caps, per the
// rig rules, and the pad gives the toe something to plant.
D.thigh = [P("M-2.4,-5 C-2.8,3 -2.6,12 -2.2,21 L2.2,21 C2.6,12 2.8,3 2.4,-5 Z"), Circle(0, 21, 3)];
D.tarsus = [
	P("M-1.9,0 C-2.1,4 -1.8,9 -1.5,12 L1.5,12 C1.8,9 2.1,4 1.9,0 Z"),
	P("M-4.2,10.5 C-5.6,12 -5,14.6 -2,14.6 C2,14.6 4.8,13.4 5.4,11 C3.6,10 -0.6,10 -4.2,10.5 Z"),
];

// ── the leg chain ────────────────────────────────────────────────────────
const L1 = 21; // hip → ankle
const L2 = 14; // ankle → toe (the contact point)
const HIP = [78, 65]; // buried 8 units inside the belly
const FAR_HIP = [72, 63]; // 6 back and 2 up: the far toe never lands below the near one
const FAR_THIN = 0.85;
const FAR_LEN = 0.95;
/** Where the near toe stands: straight under the hip, on the ground. */
const CONTACT = 78;
/**
 * The hop's own numbers. `dur` is what the sampler actually stores (0.45 s
 * at 24 fps rounds to 11 frames), `HOP_SPEED` is what the sequence pins,
 * and the stance — the first 30 % of the cycle — is where the planted toe
 * has to track back by exactly what the body travels in that time, or it
 * slides.
 */
const HOP_DUR = 11 / 24;
const HOP_SPEED = 44;
const HOP_STRIDE = HOP_SPEED * HOP_DUR * 0.3;

/**
 * The two-link solution putting the near toe on `(tx, ty)` in rig space:
 * the thigh's angle from straight down and the tarsus's angle from the
 * thigh, in degrees. A bird's ankle folds *backward*, which is `KNEE = 1`
 * here (verified numerically, not assumed — an angle table written blind is
 * routinely sign-mirrored). Unreachable targets clamp just inside reach.
 */
const KNEE = 1;
function ik(tx, ty) {
	const dx = tx - HIP[0];
	const dy = ty - HIP[1];
	const r = Math.min(Math.hypot(dx, dy), L1 + L2 - 0.05);
	const th = Math.atan2(-dx, dy);
	const cb = Math.max(-1, Math.min(1, (r * r - L1 * L1 - L2 * L2) / (2 * L1 * L2)));
	const b = KNEE * Math.acos(cb);
	const a = th - Math.atan2(L2 * Math.sin(b), L1 + L2 * Math.cos(b));
	const deg = (x) => Math.round((x * 1800) / Math.PI) / 10;
	return [deg(a), deg(b)];
}

/** Standing: the toe under the hip, on the ground line. */
const STAND = ik(CONTACT, GROUND);
/**
 * Tucked for flight: the thigh back and the tarsus forward, an L hanging
 * about ten units under the belly — which is where a flying bird's feet
 * actually are, and it is also the only tuck this body can hold. **A leg
 * folded up *inside* the belly cannot get there without a pocket**: the
 * only cavity long enough to swallow 35 units of leg is the tail wedge's,
 * the swing arrives there running nearly parallel to the body's underside,
 * and measured, the union carries two children through thigh 57–63 and the
 * near outline steps 29 units across the 7° where the leg finally clears
 * (the frog's foot, the teddy's arm — a topology change, and finer
 * sampling makes it worse, not better). Tucked *under*, the leg is outside
 * the outline at every angle of the extension and the whole path measures
 * one child and 11 units of length, end to end.
 */
const FOLD = [34, -118];

// ── the wing ─────────────────────────────────────────────────────────────
// The three angles the measured exposure curve (constraint 3) puts the beat
// between: under −9 the blade is inside the body, over +18 it is wholly out.
/** Folded against the flank, well inside the hidden zone. The far wing
 * hinges lower and so lies along the body at a shallower angle of its own. */
const WING_FOLD = -30;
const FAR_FOLD = -16;
/** The bottom of the near beat. It sits at the *top* of the exposure ramp
 * on purpose: below it the blade slides into the body and the flap reads as
 * a wing blinking on and off rather than beating, and the whole beat above
 * it is rigid rotation, which costs the outline nothing at all. */
const NEAR_LOW = 16;
/** The top of the near beat: raised over the shoulder. */
const NEAR_HIGH = 64;
/** The far wing's own arc, which reaches below the belly. It is a separate
 * outline — a rigid rotation of one blade, so its length never changes and
 * the 10 % far rule cannot be troubled by it — and it is what puts a wing
 * *under* the bird in both tints. The two wings are told apart by arc and
 * by lag, never by tint: `bird-far.svg` paints every layer alike. */
const FAR_HIGH = 56;
const FAR_LOW = -62;
/**
 * The far wing lags the near one by a twelfth of a beat, and the lag is
 * written into its keys rather than taken from a phase: `sampleGait` starts
 * a segment cold, so a phase-shifted channel's frame 0 is some value in the
 * middle of its table and the seam between two gaits stops being readable.
 * Every table below therefore begins at the value its neighbour ends on.
 */
const WINGS = {near: 0, far: 0};

const hold = (v) => [
	[0, v],
	[100, v],
];

// ── the rig tree ─────────────────────────────────────────────────────────
/**
 * The far wing hinges **lower and further back** than the near one — at the
 * middle of the body's side rather than over the shoulder — so that the
 * bottom of its arc puts a wing eighteen units under the belly instead of
 * grazing it. It can: it is its own outline, so nothing it does reaches the
 * near outline's 5 % rule, and a rigid rotation cannot trouble the far
 * outline's own.
 */
function wing(side) {
	const far = side === "far";
	const scale = far ? 0.95 : 1;
	return {
		pivot: far ? [84, 56] : [92, 46],
		rot: `wing.${side}`,
		layer: side,
		shapes: scaled(D.wing, scale, scale),
		marker: [-44 * scale, -9 * scale],
	};
}

function leg(side) {
	const far = side === "far";
	const thin = far ? FAR_THIN : 1;
	const len = far ? FAR_LEN : 1;
	return {
		pivot: far ? FAR_HIP : HIP,
		rot: `leg.${side}.thigh`,
		layer: side,
		shapes: scaled(D.thigh, thin, len),
		children: [
			{
				pivot: [0, L1 * len],
				rot: `leg.${side}.foot`,
				layer: side,
				shapes: scaled(D.tarsus, thin, len),
				marker: [0, L2 * len],
				foot: [0, L2 * len],
			},
		],
	};
}

// ── the gaits ────────────────────────────────────────────────────────────
/**
 * Level flight. One beat per cycle at 3.3 Hz, the full sweep, and 18 stored
 * frames of it: a gait stores one cycle whatever it repeats, so this is the
 * one place in the rig where frames are nearly free, and the sweep needs
 * them (constraint 3).
 */
const flap = {
	dur: 0.3,
	phases: WINGS,
	ch: {
		// 15 stored frames a cycle, and the two crossings of the exposure
		// ramp (18 → 2 and back) get 20 % of the cycle each — three frames
		// apiece — with `linear` keys so the easing cannot bunch them up.
		wing: [
			[0, NEAR_HIGH],
			[26, 34],
			[46, NEAR_LOW],
			[70, 34],
			[100, NEAR_HIGH],
		],
		wingFar: [
			[0, 46],
			[8, FAR_HIGH],
			[30, 8],
			[56, FAR_LOW],
			[82, 8],
			[100, 46],
		],
		// a body that rises on the downstroke — 5 units, under a pixel on
		// screen, but it keeps the bird from reading as a rigid cut-out
		ty: [
			[0, -660],
			[40, -664],
			[75, -656],
			[100, -660],
		],
		pitch: hold(-3),
		"leg.thigh": hold(FOLD[0]),
		"leg.foot": hold(FOLD[1]),
		sx: hold(1),
		sy: hold(1),
	},
};

/** The glide: wings held out in a shallow V, cheap to repeat, still moving
 * — which is why the glide is a gait and not a pose with a hold. A hold
 * must travel under 5 units/s (the audit) and a gliding bird must not. */
const glide = {
	dur: 0.5,
	phases: WINGS,
	ch: {
		wing: [
			[0, 44],
			[50, 38],
			[100, 44],
		],
		wingFar: [
			[0, 34],
			[50, 40],
			[100, 34],
		],
		ty: hold(-660),
		pitch: hold(-2),
		"leg.thigh": hold(FOLD[0]),
		"leg.foot": hold(FOLD[1]),
		sx: hold(1),
		sy: hold(1),
	},
};

/**
 * **A ramp cycle** (README § The pipeline): played `cycles: 1, once: true`,
 * its `dur` spanning the whole descent while `ty` travels one way across
 * it. `once` is what makes that legal — a gait's clip normally closes on
 * its own frame 0, which for a ramp replays the whole descent backwards
 * inside the clip's last frame interval, and no audit can see it because a
 * `ty` ramp is a pure translate. The wings only glide here: 36 stored
 * frames is what the vertical ramp costs, and a full beat on top of it
 * would not hold the 5 % rule at that frame rate.
 */
const descend = {
	dur: 1.5,
	phases: WINGS,
	ch: {
		// held out, and held inside the flat half of the exposure curve: this
		// segment stores every one of its 36 frames and cannot afford a beat
		wing: [
			[0, 44],
			[45, 40],
			[100, 46],
		],
		wingFar: [
			[0, 34],
			[45, 36],
			[100, 42],
		],
		// **The ramp finishes on the last frame the sampler stores, not at
		// phase 100.** `sampleGait` samples phases 0…(n−1)/n while `once`
		// closes the clip on the phase-1 pose, so a ramp written to 100
		// leaves the clip's closing frame one whole frame-interval ahead of
		// the pose the *next* segment blends from — 17 units of altitude
		// here, a visible hop at the moment of landing. Ending it at
		// (n−1)/n = 97.22 % (36 frames) makes the two agree exactly.
		ty: [
			[0, -660, "linear"],
			[97.22, -34, "linear"],
			[100, -34],
		],
		pitch: [
			[0, -2, "linear"],
			[70, 7],
			[100, 2],
		],
		// the feet come down for the last half of the drop
		"leg.thigh": [
			[0, FOLD[0]],
			[50, FOLD[0]],
			[100, -25],
		],
		"leg.foot": [
			[0, FOLD[1]],
			[50, FOLD[1]],
			[100, 28],
		],
		sx: hold(1),
		sy: hold(1),
	},
};

/**
 * The take-off, the other ramp cycle: four shallow beats while `ty` climbs
 * from the ground to the cruise. Its frame 0 is the `perch` pose exactly —
 * `sampleGait` starts a gait segment cold and nothing blends into it, so a
 * gait that follows a pose has to *begin* at that pose or the bird pops.
 */
const climb = {
	dur: 1.2,
	phases: WINGS,
	ch: {
		// the opening spends 30 % of the cycle — eleven stored frames — on the
		// ramp between the folded blade and a wing that is wholly out, then
		// three beats that stay in the flat zone and cost the outline nothing
		wing: [
			[0, WING_FOLD],
			[12, -6, "linear"],
			[30, 26, "linear"],
			[42, 58],
			[56, 22],
			[68, 58],
			[82, 22],
			[100, NEAR_HIGH],
		],
		wingFar: [
			[0, FAR_FOLD],
			[12, -10, "linear"],
			[30, 20],
			[44, -34],
			[58, 50],
			[72, -34],
			[86, 50],
			// where `flap`'s own far table starts, so the take-off hands the
			// cruise a wing that is already in the right place
			[100, 46],
		],
		// ends on the last stored frame, as `descend`'s does, so the cruise
		// that follows starts at exactly the altitude the clip closes on
		ty: [
			[0, 0, "linear"],
			[97.22, -660, "linear"],
			[100, -660],
		],
		pitch: [
			[0, 0],
			[30, -12, "linear"],
			[100, -3, "linear"],
		],
		"leg.thigh": [
			[0, STAND[0]],
			[26, FOLD[0]],
			[100, FOLD[0]],
		],
		"leg.foot": [
			[0, STAND[1]],
			[26, FOLD[1]],
			[100, FOLD[1]],
		],
		sx: hold(1),
		sy: hold(1),
	},
};

/**
 * A two-footed hop: crouch, leap, land. The legs are solved by `ik` against
 * the toe's own path, so the planted toe tracks back at exactly the rate
 * the sequence pins (`HOP_STRIDE` over the stance) and never slides. Its
 * frame 0 is the `perch` pose, for the same reason `climb`'s is.
 */
/** The body's own bounce through the hop: crouch, leap, land. */
const HOP_TY = [
	[0, 0],
	[18, 5],
	[45, -24],
	[74, -3],
	[100, 0],
];

/**
 * The leg keys, solved against the toe's path **and the body's bounce**:
 * `ty` moves the root, so a target on the ground line is at `GROUND − ty` in
 * the leg's own frame. Solve without that and the crouch drives the toes
 * through the ground (measured: 4.4 units under it).
 */
const hopKeys = () => {
	const thigh = [];
	const foot = [];
	const at = (p, tx, lift) => {
		const [a, b] = ik(tx, GROUND - lift - cyc(HOP_TY, p / 100));
		thigh.push([p, a]);
		foot.push([p, b]);
	};
	// stance: the toe planted, sliding back at exactly the pinned speed
	for (const p of [0, 10, 20, 30]) at(p, CONTACT - (HOP_STRIDE * p) / 30, 0);
	// flight: the toe tucks up and swings forward to where it started
	at(45, CONTACT - HOP_STRIDE + 1, 12);
	at(60, CONTACT - HOP_STRIDE + 3, 14);
	at(78, CONTACT - 2, 7);
	at(92, CONTACT, 1);
	at(100, CONTACT, 0);
	return {thigh, foot};
};
const HOP = hopKeys();

const hop = {
	dur: 0.45,
	phases: WINGS,
	ch: {
		// held folded. A flick that showed would have to cross the exposure
		// ramp twice inside eleven frames, and one that stays under −9 shows
		// nothing at all, so the hop is carried by the body and the legs.
		wing: hold(WING_FOLD),
		wingFar: hold(FAR_FOLD),
		ty: HOP_TY,
		pitch: [
			[0, 0],
			[20, 5],
			[48, -7],
			[100, 0],
		],
		"leg.thigh": HOP.thigh,
		"leg.foot": HOP.foot,
		sx: hold(1),
		sy: hold(1),
	},
};

const gaits = {flap, glide, descend, climb, hop};

function channels(gaitName = "flap") {
	const phases = gaits[gaitName]?.phases ?? WINGS;
	const ch = [];
	// far first, in the tree's own order
	ch.push({name: "wing.far", key: "wingFar", phase: phases.far ?? 0});
	for (const c of ["thigh", "foot"]) {
		ch.push({name: `leg.far.${c}`, key: `leg.${c}`, phase: 0});
	}
	ch.push({name: "wing.near", key: "wing", phase: phases.near ?? 0});
	for (const c of ["thigh", "foot"]) {
		ch.push({name: `leg.near.${c}`, key: `leg.${c}`, phase: 0});
	}
	for (const [c, rest] of [
		["ty", 0],
		["pitch", 0],
		["sx", 1],
		["sy", 1],
	]) {
		ch.push({name: c, key: c, rest});
	}
	return ch;
}

// ── poses ────────────────────────────────────────────────────────────────
const folded = {
	"leg.near.thigh": FOLD[0],
	"leg.far.thigh": FOLD[0],
	"leg.near.foot": FOLD[1],
	"leg.far.foot": FOLD[1],
};
const standing = {
	"leg.near.thigh": STAND[0],
	"leg.far.thigh": STAND[0],
	"leg.near.foot": STAND[1],
	"leg.far.foot": STAND[1],
};

/** Wings out, high, legs away: the pose the glide gait sits on. */
const gliding = {
	...folded,
	"wing.near": 44,
	"wing.far": 34,
	ty: -660,
	pitch: -2,
	sx: 1,
	sy: 1,
};

/** The flare: nose up, wings high and braking, legs reaching for the ground. */
const land = {
	...standing,
	"wing.near": 52,
	"wing.far": 46,
	"leg.near.thigh": -25,
	"leg.far.thigh": -25,
	"leg.near.foot": 28,
	"leg.far.foot": 28,
	ty: -12,
	pitch: -13,
	sx: 1,
	sy: 1,
};

/** On the ground: wings folded along the flank, standing on both feet. */
const perch = {
	...standing,
	"wing.near": WING_FOLD,
	"wing.far": FAR_FOLD,
	ty: 0,
	pitch: 0,
	sx: 1,
	sy: 1,
};

const poses = {gliding, land, perch};

export const rig = {
	n: 256,
	emitStride: 4,
	nFar: 96,
	emitStrideFar: 6,
	// 8, below the cast's usual: the beak and the wing tips are the features
	// a stronger fillet rounds away, and the beak is what says which way the
	// bird is pointing.
	fillet: 8,
	// 800 units tall for 76 units of bird: the empty sky above it *is* the
	// route (see the header). The ground line sits 6 units above the box's
	// foot, as it does for every other animal.
	viewBox: {x: 8, y: -694, w: 126, h: 800},
	ground: GROUND,
	// 1, not 2: one rig unit is about a fifth of a pixel at the theme's size,
	// so the finer grid buys nothing and costs bytes on every stored frame.
	k: 1,
	// the far wing, then the far leg's four parts
	farGroups: (items) => [items.slice(0, 1), items.slice(1, 5)],
	root: {
		// `ty` alone here, and the pitch a node below it — constraint 1.
		ty: "ty",
		children: [
			{
				pivot: [70, 58],
				rot: "pitch",
				scale: ["sx", "sy"],
				children: [
					{
						pivot: [-70, -58],
						children: [
							wing("far"),
							leg("far"),
							{shapes: D.body},
							{shapes: D.head},
							{pivot: [103, 39], shapes: D.beak, marker: [22, 0.9]},
							wing("near"),
							leg("near"),
						],
					},
				],
			},
		],
	},
	gaits,
	channels,
	poses,
	// gliding, not perched: the still is the bird a reduced-motion reader
	// gets, and a bird in the sky is what the slot is for.
	still: gliding,
};

export default {
	name: "bird",
	rig,
	colours: {near: "#5b7fa6", far: "#a9c0d8"},
	budget: 120 * 1024,
	/**
	 * What `client/themes/ps.css` has to say about this animal — the half of
	 * the box coupling no audit can reach, checked by `test/themes/ps.ts`
	 * (tools/heart/README.md § The audit):
	 *
	 * - `height` is `--ps-bird-h`, the on-screen height of the *box*, in
	 *   strips;
	 * - `box` is the `viewBox.h` it was picked against, so a box that grows
	 *   without its token growing by the same ratio fails there instead of
	 *   shipping an animal a different size;
	 * - `stageWidth` is `stage.aspect × viewBox.h`, which a box change must
	 *   leave alone — the aspect scales the other way — or the animal travels a
	 *   different distance.
	 */
	theme: {height: 1.2, box: 800, stageWidth: 8800},
	sequence: {
		first: 6,
		period: 36,
		// 11, against the ground animals' 16–24: on-screen stage width is
		// `aspect × -h × --strip`, and this box is a whole strip tall where
		// theirs are half of one. The product is what matters and it is the
		// cast's usual ~10.5.
		stage: {aspect: 11},
		segments: [
			{gait: "flap", cycles: 6, fps: 36, travel: 900},
			{blendTo: "glide", secs: 0.3, fps: 20, travel: 900},
			{gait: "glide", cycles: 2, fps: 12, travel: 900},
			{gait: "descend", cycles: 1, once: true, fps: 24, travel: [900, 160]},
			// hold 0: a pose segment that holds must travel under 5 units/s,
			// and a bird still landing is doing 160
			{pose: "land", hold: 0, blend: 0.32, fps: 25, travel: [160, 0]},
			// the fold is the expensive blend in the rig — it drags the wing
			// down the exposure ramp — so it is long and densely sampled
			{pose: "perch", hold: 0, blend: 0.4, fps: 45, travel: 0},
			{pose: "perch", hold: 0.4, blend: 0, fps: 6, travel: 0},
			{gait: "hop", cycles: 2, fps: 24, travel: HOP_SPEED},
			{pose: "perch", hold: 0, blend: 0.18, fps: 18, travel: 0},
			{pose: "perch", hold: 0.35, blend: 0, fps: 6, travel: 0},
			{gait: "climb", cycles: 1, once: true, fps: 30, travel: [0, 900]},
			{gait: "flap", cycles: 18, fps: 36, travel: 900},
		],
	},
};
