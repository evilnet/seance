// The <3 theme's ladybug (tools/heart/README.md): the cast's insect, and the
// rig that introduces the **ramp cycle** (README § The pipeline) — a gait
// played once whose root channel travels one way across the whole segment,
// which is how the flight climbs and descends. Facing right, ground y = 100.
//
// Drawn at the same unit scale as every other animal — 86 units of standing
// beetle in a 121 × 65 box — because `n`, `fillet` and the audit's outline
// rules are tuned for a body that size. Its tiny size on screen comes
// entirely from `--ps-ladybug-h` in the theme, not from the drawing.
//
// Rotation sign: paper.js rotates clockwise on screen for a positive angle
// (y points down), so a part drawn pointing forward (local +x) swings *up*
// for a negative angle. Every table below is written against that.
//
// ── What a side-on beetle is, and what it is not ─────────────────────────
//
// The first ladybug shipped here was a 54 × 38 dome on visible legs with two
// upright blades over it, and in the browser it read as **a rabbit** — the
// cast already has one, so that is a defect and not a weakness. A ladybug is
// recognised by its spots and its round plan view, and a silhouette has
// neither; from the side the default drawing of one is a featureless dome,
// and a dome on legs with two things sticking up is a mammal. Three levers
// carry the beetle instead, in this order:
//
//   1. **Wide and low, and the crest forward.** Standing, the silhouette
//      measures **36.0 tall on 85.9 long — a ratio of 0.42**, where the old
//      dome was 51 on 62, or 0.82. The dorsal line peaks a third of the way
//      back from the front and tapers to a blunt rear that all but touches
//      the ground, which is a beetle; a rabbit's high point is its rump, at
//      the back. The legs are short (9 + 12 against the old 12 + 14) and
//      about eleven units of each shows below the belly.
//   2. **Three descending lobes, elytra → pronotum → head.** Each ends in a
//      near-vertical cliff that the next one steps off, so the dorsal line
//      drops 68.4 → 74.3 at the elytra's front and 76.4 → 81.7 at the
//      pronotum's: two notches of about five and a half units, which survive
//      `fillet: 8` and are visible in the browser sheet. A rabbit has
//      neither — its body flows into its snout in one curve. Two short
//      antennae angle up and forward off the head.
//   3. **The wings go back, never up.** Opened they reach **22.7 units
//      behind the body at 32° above horizontal**, so a flying beetle is
//      dominated by wings that overhang behind it. Upright blades are ears;
//      that is exactly what went wrong the first time. The one moment they
//      *are* upright is the instant the sweep passes vertical, which nothing
//      holds — see constraint 1.
//   4. And a fourth that turned out to matter more than expected: **an
//      insect's leg is a zigzag where a mammal's is a column.** `KNEE` and
//      the splay of `CONTACT` away from `HIP` are chosen so the femur hangs
//      near vertical and the *shin* takes the angle, putting the knee three
//      or four units below the belly where it shows. Straightening the legs
//      alone took the silhouette back to reading as a pig.
//
// Three constraints hold the rig together:
//
//   1. **The wings vanish when folded.** Each is drawn lying *forward*
//      inside the body from a pivot near its rear and rotates up and back
//      out of it, so at `WING_FOLD` the near wing contributes nothing to the
//      union and the far wing — its own outline, painted before the near
//      one — lies wholly inside it (both measured at 0; see the rig's
//      report). Anything that moves a wing pivot, lengthens a blade or
//      lowers the body has to re-measure both.
//
//      **A rear pivot is forced, and so is the sweep through vertical.** A
//      blade hinged at the *front* can never reach past the back of the body
//      — its tip gets no further than `pivot.x − length` — so a wing that
//      overhangs the rear must hinge at the rear and lie forward when
//      folded, and every path from "forward" to "backward" goes over the
//      top. The box's height is that transit and nothing else: 41 units of
//      blade above a pivot at y = 81 puts the tip at y = 40.4, which is why
//      a 36-unit animal needs a box that starts at y = 38. The transit is a
//      waypoint (`lifting`), never a hold, so it lasts a couple of frames of
//      the opening blend and the wings finish shallow — which is the whole
//      point. The same geometry is why the blade is 41 rather than the
//      "longer than the body" a flying beetle really has: folded, it has to
//      fit inside a body that is 73 units long.
//   2. **The body stands 11 units off the ground, and that is not styling.**
//      A swinging foot has to clear `lib/travel.mjs`'s 6-unit plant
//      tolerance or the stance measurement reads the whole swing as planted;
//      it also has to stay clear of the belly, because a leg that leaves the
//      body and comes back to graze it encloses a pocket `largest()` drops
//      (the frog's foot, the teddy's arm). Usable lift is roughly
//      `clearance − 4`, and `LIFT` is 8: the probe measures 7.9 units of it
//      and the near feet clear the tolerance for 9 frames of 40.
//   3. **Each leg crosses the body's boundary exactly once.** The femur's
//      top is buried, and the knee tucks up into the belly at mid-swing
//      while the shin goes on out and down. No leg tucks under the body, in
//      flight included — the legs simply dangle in their standing splay and
//      ride up with it.

import {P, Circle, Ellipse, scaled} from "../lib/outline.mjs";

const GROUND = 100;

// ── the parts ────────────────────────────────────────────────────────────
const D = {};
// The body: two lobes, 73 units long and 25 tall together. Drawing them as
// one smooth mass — the first thing tried here — reads as a pig, because a
// long unbroken back with a snout on the end is a mammal; what says beetle
// is the step between them, and the second step from the pronotum into the
// head (lever 2).
D.body = [
	// the elytra: rear tip low and blunt, crest a third back from its front,
	// front a near-vertical cliff for the pronotum to step off
	P(
		"M8,88.4 C8,80 13,70.8 25,67.4 C38,64 54,64.2 62,66.2 " +
			"C64.6,66.6 65.4,67.2 65.6,68.4 L66.2,84 " +
			"C64.4,87 58,88.8 48,89.2 C32,89.7 14,89.6 9.6,89.2 C8.4,89.1 8,89 8,88.4 Z"
	),
	// the pronotum: a smaller shield whose crest sits five units below the
	// elytra's front edge, so the dorsal line steps down into it — and whose
	// own front is a second cliff, for the head to step off in turn
	P(
		"M56,80 C56,77 61,74.8 68,74.2 C74.5,73.7 79.4,74.6 80.8,76.4 " +
			"L81.4,85 C79.8,87.2 74,88.7 66,89 C60,89.1 56,87.4 56,84 Z"
	),
];
// The head: a small lobe hung forward of the pronotum's cliff and below its
// top, so the dorsal line steps down 76.4 → 81.7 into it. It overlaps the
// pronotum by three units of x and about four of y — enough that the union
// is one piece at every pose (a head that only touches would be dropped by
// `largest()` and vanish), little enough that the notch survives the fillet.
D.head = [Ellipse(83.5, 85.6, 5.2, 4.2)];
// Femur (top buried in the body) and its knee cap; the cap is wider than the
// bar it caps and than the shin it carries, per the rig rules.
D.femur = [P("M-2,-4 C-2.3,0 -2,4.5 -1.75,9 L1.75,9 C2,4.5 2.3,0 2,-4 Z"), Circle(0, 9, 2.3)];
// Shin, ending in a rounded tarsus rather than a disc — a bug's foot is a
// point, and a foot cap here would be the widest thing under the belly at
// mid-swing, which is exactly what must not touch it.
D.shin = [
	P("M-1.7,0 C-1.85,4.5 -1.5,8 -1.2,12 C-0.4,12.7 0.4,12.7 1.2,12 C1.5,8 1.85,4.5 1.7,0 Z"),
];
// Both antennae on one node, as two thin prongs that diverge: drawn from
// inside the head so their roots can never detach from it. Short, as a
// ladybug's are, but not stubs — a stub reads as a horn, and a club on the
// end (tried) reads as a finger. Their length is bounded by the box, not by
// taste: they are the front-most thing the animal has.
D.ant = [
	P("M-1.4,1.2 C0.4,-1.6 2.6,-4.2 5.4,-6.8 L7,-5.2 C4.6,-2.8 2.8,-0.4 1.6,2 Z"),
	P("M-1,3 C1.6,0.8 4.8,-1 8.6,-2.2 L9.2,-0.2 C6,1 3.4,2.6 1.6,4.4 Z"),
];
// A wing: a 41-unit blade, 12 across at its widest, drawn lying **forward**
// along the body's own axis from a pivot near its rear, so that at
// `WING_FOLD` it is folded away inside. Opening rotates it *counter-
// clockwise* (negative) up over the back and down again behind the animal,
// finishing shallow and rearward. Broad near the root and tapered to a tip:
// a blade that is fattest in the middle reads as a tail, and the tip has to
// stay a tip through `fillet`. `wing()` scales it down for the far side.
D.wing = [
	P(
		"M0.6,-5 C4,-6.4 8,-6.6 12,-6 C18,-5.1 26,-3.4 33,-1.6 " +
			"C38,-0.3 41,0.7 41,1.3 C41,2 38.4,2.6 34,2.9 " +
			"C27,3.4 19,4.4 13,5.4 C8,6.2 3.6,6.2 0.7,5 " +
			"C-1.8,4 -1.9,-4 0.6,-5 Z"
	),
];

// ── the leg chain ────────────────────────────────────────────────────────
const L1 = 9; // hip → knee
const L2 = 12; // knee → tarsus (the contact point)
/** Near hips, rear to front; each is buried 4–5 units inside the body. */
const HIP = [
	[28, 84],
	[50, 84],
	[70, 84],
];
/** Far hips: 5 back and 2 up. Further back than the quadrupeds' 3, so the
 * six legs read as six spaced strokes rather than three thick pairs; the far
 * tripod is still 2 units high and 5 % short, so no far foot ever plants
 * below a near one. */
const FAR_HIP = [
	[23, 82],
	[45, 82],
	[65, 82],
];
/** Where each near foot's stance is centred — splayed back of the hips at
 * the rear and forward of it at the front, which is a beetle's sprawl and
 * also keeps every stance target inside the 20 units the two links reach. */
const CONTACT = [22, 45, 74];
const STRIDE = 11; // how far a planted foot tracks back, in units
/**
 * How high a swinging foot rises. It is bounded on both sides and there is
 * not much room between them: below 6 it is inside `lib/travel.mjs`'s plant
 * tolerance and the animal drags, and every unit of it costs outline. A
 * tripod puts all three near legs at full stretch twice a cycle and folds
 * two of them at the quarters, so the near outline's length swings by very
 * nearly `4 × LIFT` units, once per half-cycle. The shorter legs this redraw
 * uses made that much cheaper than it was: 8 units of lift over an 11-frame
 * cycle measures **3.58 %** of the near outline against the audit's 5 %,
 * where the old dome's 7.5 over 13 frames measured 4.55 %. The probe reads
 * 7.9 units of lift and the near feet clear the plant tolerance for 9 frames
 * of 40 — a little over a fifth of the cycle.
 */
const LIFT = 8;
/**
 * The knee's fold direction per leg. Each foot is splayed away from its own
 * hip — the rear pair back, the front pair forward — and the sign is chosen
 * so the femur hangs near vertical and the *shin* takes the angle: the knee
 * then sits three or four units below the belly, outside the body, and each
 * leg reads as a bent stick rather than a straight column. A mammal's leg is
 * a column; an insect's is a zigzag, and at this size that is most of what
 * the legs contribute.
 */
const KNEE = [1, 1, -1];

/**
 * The two-link solution putting leg `i`'s tarsus on `(tx, ty)`: the femur's
 * angle from straight-down and the shin's angle from the femur, in degrees.
 * Every stance key in the crawl comes from here rather than from taste, so
 * the planted foot tracks back at exactly the rate the sequence pins and
 * never slips. Unreachable targets are clamped to just inside full reach.
 */
function ik(i, tx, ty) {
	const [px, py] = HIP[i];
	const dx = tx - px;
	const dy = ty - py;
	const r = Math.min(Math.hypot(dx, dy), L1 + L2 - 0.05);
	const th = Math.atan2(-dx, dy);
	const cb = Math.max(-1, Math.min(1, (r * r - L1 * L1 - L2 * L2) / (2 * L1 * L2)));
	const b = KNEE[i] * Math.acos(cb);
	const a = th - Math.atan2(L2 * Math.sin(b), L1 + L2 * Math.cos(b));
	const deg = (x) => Math.round((x * 1800) / Math.PI) / 10;
	return [deg(a), deg(b)];
}

/** Where leg `i`'s tarsus should be at cycle phase `p` (0–100). */
function contactAt(i, p) {
	const cx = CONTACT[i];
	if (p <= 50) {
		// Stance: straight back at a constant rate — this is the pinned speed.
		return [cx + STRIDE / 2 - (STRIDE * p) / 50, GROUND];
	}
	const u = (p - 50) / 50;
	const x = cx - STRIDE / 2 + STRIDE * (3 * u * u - 2 * u * u * u);
	return [x, GROUND - LIFT * Math.sin(Math.PI * u)];
}

/** Leg `i`'s two key tables, solved by `ik` — stance linear, swing eased. */
function legKeys(i) {
	const up = [];
	const shin = [];
	const at = (p, ease) => {
		const [tx, ty] = contactAt(i, p);
		const [a, b] = ik(i, tx, ty);
		up.push(ease ? [p, a, ease] : [p, a]);
		shin.push(ease ? [p, b, ease] : [p, b]);
	};
	for (let p = 0; p < 50; p += 5) at(p, "linear");
	for (const p of [50, 58, 66, 74, 82, 90, 100]) at(p);
	return {up, shin};
}

const LEGS = [0, 1, 2].map(legKeys);
/** The standing pose: the middle of stance, which is also where a hold sits. */
const STANDING = [0, 1, 2].map((i) => ik(i, ...contactAt(i, 25)));
const hold = (v) => [
	[0, v],
	[100, v],
];

/**
 * One leg: hip (femur → knee) → shin (tarsus). The shin carries both the
 * resample `marker` and the `foot` the travel is measured from.
 */
function leg(side, i) {
	const [px, py] = side === "far" ? FAR_HIP[i] : HIP[i];
	const thin = side === "far" ? 0.85 : 1;
	const len = side === "far" ? 0.95 : 1;
	const k = (c) => `leg.${side}.${i + 1}.${c}`;
	return {
		pivot: [px, py],
		rot: k("up"),
		layer: side,
		shapes: scaled(D.femur, thin, len),
		children: [
			{
				pivot: [0, L1 * len],
				rot: k("shin"),
				layer: side,
				shapes: scaled(D.shin, thin, len),
				marker: [0, L2 * len],
				foot: [0, L2 * len],
			},
		],
	};
}

/** Folded: the blade lying forward along the body's own axis, out of sight. */
const WING_FOLD = -13;
/** Open: back and 32° above horizontal, the tip 22.7 units past the rear of
 * the body. Shallower than this was tried first and the blade sat *below*
 * the elytra's crest, where it read as a tail rather than a wing. */
const WING_OPEN = -148;
/** The far blade is 28 % shorter, hinges further forward and sits ten
 * degrees higher, so the pair is told apart by length and attitude and not
 * by tint — `ladybug-far.svg` paints every layer alike, and that is exactly
 * where a matched pair of prongs read as a rabbit last time. Both point
 * *backward*, which is what keeps them off the ear register whatever their
 * separation. */
const FAR_FOLD = -13;
const FAR_OPEN = -138;

/**
 * One wing on its own channel, hinged near the rear of the body and lying
 * forward inside it when folded (constraint 1).
 */
function wing(side) {
	const far = side === "far";
	const scale = far ? 0.72 : 1;
	return {
		pivot: far ? [30, 80] : [22, 81],
		rot: `wing.${side}`,
		layer: side,
		shapes: scaled(D.wing, scale, scale),
		marker: [42 * scale, 1.2 * scale],
	};
}

// ── the gaits ────────────────────────────────────────────────────────────
/**
 * Two alternating tripods: near 1 and 3 with far 2 move together, near 2
 * with far 1 and 3 against them. Every gait carries the same table, so
 * `channels()` resolves the same phases whichever one is playing.
 */
const TRIPOD = {"near.1": 0, "near.2": 0.5, "near.3": 0, "far.1": 0.5, "far.2": 0, "far.3": 0.5};

/**
 * The crawl. Half a cycle of stance per leg, so at every instant at least
 * one near tarsus is on the ground sliding back at `STRIDE / (dur / 2)` —
 * 44 units/s, which is what the sequence pins. The far tripod is raised 2
 * units and 5 % shorter, so it never plants below a near foot and never wins
 * `stanceTravel`'s "lowest planted foot": the measurement only ever reads
 * the IK'd near legs.
 */
const crawl = {
	dur: 0.5,
	phases: TRIPOD,
	ch: {
		"leg.1.up": LEGS[0].up,
		"leg.1.shin": LEGS[0].shin,
		"leg.2.up": LEGS[1].up,
		"leg.2.shin": LEGS[1].shin,
		"leg.3.up": LEGS[2].up,
		"leg.3.shin": LEGS[2].shin,
		"wing.near": hold(WING_FOLD),
		"wing.far": hold(FAR_FOLD),
		ant: [
			[0, -5],
			[50, 5],
			[100, -5],
		],
		// flat: `ty` moves the root, so a body bob lifts the planted feet too
		// and the IK's "the contact never slips" stops being exactly true.
		// The legs are the animation; a 0.8-unit bob was 0.2 px on screen.
		ty: hold(0),
		pitch: hold(0),
		sx: hold(1),
		sy: hold(1),
	},
};

/**
 * The wingbeat, shared by all three flight gaits: one beat per cycle,
 * written as a full cycle so `flyLevel` can repeat it and the two ramped
 * gaits can hold two of them. It stays between −134° and −162°, so the blade
 * is entirely behind the body throughout and the outline's length changes by
 * little more than rigid rotation — 0.33 % per stored frame, the cheapest
 * thing in the rig. Only the two blends that open and fold the wings ever
 * pull a blade back through the body's surface, and those are the segments
 * that keep their frame rate.
 */
const beat = (base) => [
	[base + 0, -148],
	[base + 25, -134],
	[base + 50, -148],
	[base + 75, -162],
	[base + 100, -148],
];
/**
 * The same beat `n` times inside one cycle, for the two ramped gaits. Two
 * beats in a 0.5 s cycle is 4 Hz — five stored frames a beat at the 20 fps
 * the flight runs at, which is as few as a sweep this wide can be drawn with
 * before it strobes.
 */
const beats = (n) => {
	const keys = [];
	for (let c = 0; c < n; c++) {
		for (const [p, v] of beat(0)) {
			if (c && p === 0) continue;
			keys.push([Math.round(((p + 100 * c) / n) * 100) / 100, v]);
		}
	}
	return keys;
};
const beats2 = beats(2);
/**
 * The far wing's own beat: a shorter blade held a little higher than the
 * near one with a sixth of its amplitude. Two blades that beat *together*
 * are a matched pair; one sweeping and one nearly still is a flying insect.
 * It is a separate outline, so its own sweep costs the near outline nothing.
 */
const farBeat = [
	[0, FAR_OPEN],
	[25, FAR_OPEN - 6],
	[50, FAR_OPEN],
	[75, FAR_OPEN + 6],
	[100, FAR_OPEN],
];

/** The legs dangle in their standing splay through every flight gait. */
const dangle = {
	"leg.1.up": hold(STANDING[0][0]),
	"leg.1.shin": hold(STANDING[0][1]),
	"leg.2.up": hold(STANDING[1][0]),
	"leg.2.shin": hold(STANDING[1][1]),
	"leg.3.up": hold(STANDING[2][0]),
	"leg.3.shin": hold(STANDING[2][1]),
	ant: hold(-4),
	sx: hold(1),
	sy: hold(1),
};

/** How far the flight climbs above the ground line. The box holds this. */
const APEX = 16;

/**
 * **The ramp cycles.** `flyUp` and `flyDown` are played `cycles: 1, once:
 * true`: their `dur` holds two wingbeats while `ty` and `pitch` travel one
 * way across the whole segment. `once` is what makes that legal — a gait's
 * clip normally closes on its own frame 0 so a repeat is seamless, which for
 * a ramp would replay the climb backwards in the clip's last frame interval
 * (and no audit would see it, since a translate does not change the
 * outline's length). `flyLevel` is an ordinary cyclic gait: `ty` is flat, so
 * it repeats, and the flight's length is bought there rather than in stored
 * frames.
 */
const flyUp = {
	dur: 0.5,
	phases: TRIPOD,
	ch: {
		...dangle,
		"wing.near": beats2,
		"wing.far": farBeat,
		// **A ramp finishes on the last frame the sampler stores, not at phase
		// 100.** `sampleGait` stores phases 0…(n−1)/n — 0…90 for the ten frames
		// 0.5 s at 20 fps rounds to — while `once` closes the clip on the
		// phase-1 pose, so a key written at 100 leaves the clip's closing frame
		// a whole frame-interval past the pose the *next* segment blends from.
		// Here that is harmless (`flyLevel` starts cold at `-APEX` whatever this
		// does); on `flyDown` it was a 0.9-unit pop at the moment of landing,
		// and on the bird 17 units of altitude.
		ty: [
			[0, 0, "linear"],
			[90, -APEX, "linear"],
			[100, -APEX],
		],
		pitch: [
			[0, 0, "linear"],
			[90, -7, "linear"],
			[100, -7],
		],
	},
};

const flyLevel = {
	dur: 0.25,
	phases: TRIPOD,
	ch: {
		...dangle,
		"wing.near": beat(0),
		"wing.far": farBeat,
		ty: hold(-APEX),
		pitch: hold(-7),
	},
};

const flyDown = {
	dur: 0.5,
	phases: TRIPOD,
	ch: {
		...dangle,
		"wing.near": beats2,
		"wing.far": farBeat,
		// ends on the last stored frame (phase 90 of ten), as `flyUp`'s does —
		// this is the seam that needs it: the `landed` blend that follows starts
		// from the last *stored* pose, so a ramp written to 100 leaves the
		// animal 0.9 units in the air at the moment it touches down
		ty: [
			[0, -APEX, "linear"],
			[90, 0, "linear"],
			[100, 0],
		],
		pitch: [
			[0, -7, "linear"],
			[90, 4, "linear"],
			[100, 4],
		],
	},
};

const gaits = {crawl, flyUp, flyLevel, flyDown};

/**
 * Every gait shares `TRIPOD`, but the argument is still honoured (and
 * defaulted) so the list's order and names are identical in every call —
 * `samplePoses` asks per gait, and the still and every pose ask with none.
 */
function channels(gaitName = "crawl") {
	const phases = gaits[gaitName]?.phases ?? TRIPOD;
	const ch = [];
	for (const side of ["far", "near"]) {
		for (const i of [1, 2, 3]) {
			for (const c of ["up", "shin"]) {
				ch.push({
					name: `leg.${side}.${i}.${c}`,
					key: `leg.${i}.${c}`,
					phase: phases[`${side}.${i}`],
				});
			}
		}
	}
	ch.push({name: "wing.near", key: "wing.near", phase: 0});
	ch.push({name: "wing.far", key: "wing.far", phase: 0});
	for (const [c, rest] of [
		["ant", 0],
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
const legsAt = (p) =>
	Object.fromEntries(
		["far", "near"].flatMap((side) =>
			[0, 1, 2].flatMap((i) => {
				const [a, b] = ik(i, ...contactAt(i, p));
				return [
					[`leg.${side}.${i + 1}.up`, a],
					[`leg.${side}.${i + 1}.shin`, b],
				];
			})
		)
	);

/** Standing on all six, wings folded away: the ladybug as a plain beetle. */
const walk = {
	...legsAt(25),
	"wing.near": WING_FOLD,
	"wing.far": FAR_FOLD,
	ant: -4,
	ty: 0,
	pitch: 0,
	sx: 1,
	sy: 1,
};

/**
 * Half-open, the waypoint that splits the opening blend in two. Everything
 * expensive happens between `walk` and here — the blades leaving the body,
 * which is where the near outline's length actually moves — and everything
 * from here to `opened` is rigid rotation of a blade that is already wholly
 * outside, so the second half can be blended twice as fast for half the
 * frames. It is also the top of the sweep: a wing hinged at the rear and
 * folded forward has to pass through vertical to get behind the animal, and
 * this is the pose that says how tall the box must be.
 */
const lifting = {...walk, "wing.near": -86, "wing.far": -80, pitch: -2, ant: -8};

/** Wings out, still on the ground — the pose the flight starts from. */
const opened = {...walk, "wing.near": WING_OPEN, "wing.far": FAR_OPEN, pitch: -4, ant: -10};

/** Down again, wings still out; they fold on the way back to `walk`. */
const landed = {...opened, pitch: 2, ty: 0};

const poses = {walk, lifting, opened, landed};

export const rig = {
	n: 300,
	emitStride: 3,
	// Nine emitted points per far outline, the coarsest in the cast, and the
	// place this rig pays for having four of them: a far leg is a bent stick
	// three or four pixels long at the theme's size and a far wing about ten,
	// while every point of every far outline costs bytes on all the stored
	// frames. `nFar` stays high — it is what the fillet runs on, and it costs
	// nothing — and only the emitted stride is coarse.
	nFar: 90,
	emitStrideFar: 10,
	// 8, below the rest of the cast: the antennae, the shins and the neck
	// notch are exactly the features a stronger fillet rounds away.
	fillet: 8,
	// 65 units tall for 36 units of standing beetle: the sky above it is the
	// wing's transit through vertical (constraint 1) and the flight's 16-unit
	// apex, and nothing else. 121 wide, because the open wings overhang 22.7
	// units behind a body that is already 86 long with its head. Measured
	// over all 580 sampled frames the animal occupies x −21.7..94.7,
	// y 40.4..102.5 — about two units of margin on every side.
	viewBox: {x: -24, y: 38, w: 121, h: 65},
	ground: GROUND,
	// 1, not the small animals' 2: `k` is the integer grid the outlines are
	// rounded onto, and the ladybug is the smallest thing in the cast on
	// screen — one rig unit of its box is about a third of a pixel at the
	// theme's size.
	k: 1,
	// the far wing, then each far leg's three parts (femur, knee cap, shin)
	farGroups: (items) => [
		items.slice(0, 1),
		items.slice(1, 4),
		items.slice(4, 7),
		items.slice(7, 10),
	],
	root: {
		pivot: [45, GROUND],
		rot: "pitch",
		ty: "ty",
		scale: ["sx", "sy"],
		children: [
			{
				pivot: [-45, -GROUND],
				children: [
					wing("far"),
					leg("far", 0),
					leg("far", 1),
					leg("far", 2),
					{shapes: D.body},
					{shapes: D.head, marker: [88.7, 85.6]},
					{pivot: [84.8, 83.4], rot: "ant", shapes: D.ant},
					wing("near"),
					leg("near", 0),
					leg("near", 1),
					leg("near", 2),
				],
			},
		],
	},
	gaits,
	channels,
	poses,
	// `walk`, not `opened`: the still is what a reduced-motion reader gets,
	// and the crawling beetle — long, low, six legs, head and antennae — is
	// the read this rig is built around. The old rig chose the open pose
	// because a folded ladybug was a featureless dome; this body is not.
	still: walk,
};

export default {
	name: "ladybug",
	rig,
	colours: {near: "#d4574e", far: "#eaa9a3"},
	budget: 100 * 1024,
	/**
	 * What `client/themes/ps.css` has to say about this animal — the half of
	 * the box coupling no audit can reach, checked by `test/themes/ps.ts`
	 * (tools/heart/README.md § The audit):
	 *
	 * - `height` is `--ps-ladybug-h`, the on-screen height of the *box*, in
	 *   strips;
	 * - `box` is the `viewBox.h` it was picked against, so a box that grows
	 *   without its token growing by the same ratio fails there instead of
	 *   shipping an animal a different size;
	 * - `stageWidth` is `stage.aspect × viewBox.h`, which a box change must
	 *   leave alone — the aspect scales the other way — or the animal travels a
	 *   different distance.
	 */
	theme: {height: 0.19, box: 65, stageWidth: 1170},
	sequence: {
		first: 6,
		period: 44,
		stage: {aspect: 18},
		// Distance is bought with crawl cycles, which are free in bytes (a
		// gait stores one cycle whatever it repeats) — the flight covers only
		// about 300 of the units the visit has to cross. Both gait seams are
		// ramped rather than stepped, the teddy's fix: a crawl pinned at 44
		// next to a hold pinned at 0 changes the ground speed by the whole 44
		// in one frame. Every hold runs at 5–6 fps because a hold's frames are
		// byte-identical copies of one pose; the blend that pulls the blades
		// out of the body is the expensive one and keeps its frame rate.
		segments: [
			{gait: "crawl", cycles: 16, fps: 22, travel: 44},
			{pose: "walk", hold: 0, blend: 0.25, fps: 12, travel: [44, 0]},
			{pose: "walk", hold: 0.3, blend: 0, fps: 5, travel: 0},
			{pose: "lifting", hold: 0, blend: 0.5, fps: 26, travel: 0},
			{pose: "opened", hold: 0, blend: 0.26, fps: 12, travel: 0},
			{pose: "opened", hold: 0.2, blend: 0, fps: 5, travel: 0},
			{gait: "flyUp", cycles: 1, once: true, fps: 20, travel: [0, 150]},
			{gait: "flyLevel", cycles: 6, fps: 20, travel: 150},
			{gait: "flyDown", cycles: 1, once: true, fps: 20, travel: [150, 0]},
			{pose: "landed", hold: 0, blend: 0.25, fps: 12, travel: 0},
			{pose: "landed", hold: 0.3, blend: 0, fps: 5, travel: 0},
			{pose: "lifting", hold: 0, blend: 0.26, fps: 12, travel: 0},
			{pose: "walk", hold: 0, blend: 0.5, fps: 26, travel: 0},
			{pose: "walk", hold: 0.15, blend: 0, fps: 6, travel: 0},
			{blendTo: "crawl", secs: 0.3, fps: 8, travel: [0, 44]},
			{gait: "crawl", cycles: 28, fps: 22, travel: 44},
		],
	},
};
