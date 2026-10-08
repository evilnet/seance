/**
 * The ps theme's birds (docs/projects/ps-theme.md §5.4): migrating skeins at
 * night and around sunset, and the steppe's own birds by day. The user's pick
 * (2026-09-25, from the live mockup tmp/ps-birds/index.html): **N2**, the
 * skeins catching a little of the moon's light, and by day **D1**, a buzzard
 * circling high, and **D2**, skylarks rising in spring and early summer — no
 * kestrel, no swallows. The mockup is the drawing: its `bird()`, its bodies,
 * poses and beat, its three skeins, its `smil()` and `sym()`, its buzzard and
 * its larks, and its timing (`applyBirds`), ported with their geometry and
 * numbers, `ps-` names, a flock's box and every bird sized in rem, and
 * engine.ts's `rng` in place of its LCG (so the scatter differs from the
 * mockup's; the drawing does not).
 *
 * Pure: strings and numbers in, strings and numbers out, the same every
 * call. No colour is painted here: the markup's fills are classes ps.css
 * paints from what scene.ts publishes (`birdsAt`, below). Nothing
 * user-supplied is ever written into this markup.
 */
import {mix} from "./colour";
import {rng, type Moment} from "./engine";
import {WEATHER, type Palette} from "./palette";

/** A number to two decimals, trailing zeros dropped. */
const n = (v: number) => String(Number(v.toFixed(2)));
/** A px length of the mockup's (at its 16 px rem) in rem. */
const rem = (px: number) => `${Number((px / 16).toFixed(4))}rem`;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
/** 0 before `a`, 1 after `b`, linear between. */
const ramp = (x: number, a: number, b: number) => clamp01((x - a) / (b - a));

/* ---- when they fly: the mockup's applyBirds ---- */

export interface Passage {
	/** How far into a passage the day is: 0 off it, 1 at its height. */
	amount: number;
	/** Deep winter (day 329 to day 50): a skein only on a rare cold-weather night. */
	winter: boolean;
	/** South-west from midsummer on (day 190), north-east before. */
	west: boolean;
}

/**
 * The passage: geese and cranes go north from late February to mid-May, and
 * south from September to late November.
 */
export function passageOf(doy: number): Passage {
	const spring = Math.min(ramp(doy, 51, 69), 1 - ramp(doy, 115, 135));
	const autumn = Math.min(ramp(doy, 244, 263), 1 - ramp(doy, 309, 329));
	return {amount: Math.max(spring, autumn), winter: doy >= 329 || doy < 51, west: doy >= 190};
}

/** The skylarks' song flights, March to July. */
export function larkSeason(doy: number): number {
	return Math.min(ramp(doy, 51, 69), 1 - ramp(doy, 201, 222));
}

export interface Birds {
	/** How many of the three skeins are on the wing (0–3): the first `skeins` of SKEINS. */
	skeins: number;
	/** The skeins' layer: 1 while they fly, 0 by day or with none tonight (none in rain or a storm). */
	skeinsOpacity: number;
	/** Flying south-west (ps.css mirrors the flocks under `ps-west`). */
	west: boolean;
	/** The skeins' alpha, on the whole of each bird. */
	alpha: number;
	/** The back (the belly gradient's top), the wings and the belly: the ink, moonlit by N2. */
	ink: string;
	wing: string;
	belly: string;
	/** The buzzard circles; the larks rise. There or not, never half there: ps.css fades them. */
	buzzard: boolean;
	larks: boolean;
	/** The day birds' ink. */
	dayInk: string;
}

/**
 * Which birds fly at one moment, and in what colours (the mockup's
 * `applyBirds`, N2's moonlight, the buzzard and the larks). The skeins: from
 * a little before sunset (canonical 1105, about 50 minutes before it) through
 * the night until first light (canonical 330). Fewer skeins, never fainter
 * ones: the passage's edges, and snow thins them to one; and one winter
 * night in four brings a skein on a cold-weather move. None flies in rain or
 * a storm (the user, 2026-09-26: "usually birds don't fly in rainstorms"),
 * so their layer leaves the render tree then (layers.ts). Their ink is slate
 * by day and near-black from sunset on; the moon's light on them is how much
 * of it is lit, while it is up and not behind cloud, once the sky is dark
 * enough. The buzzard rides the thermals from mid-morning to late afternoon;
 * the larks sing from first light to the evening, in season; neither flies
 * in rain, snow or storm.
 */
export function birdsAt(m: Moment, p: Palette): Birds {
	const wx = WEATHER[m.weather];
	const wet = m.weather === "rain" || m.weather === "snow" || m.weather === "storm";
	const rainstorm = m.weather === "rain" || m.weather === "storm";
	const cm = m.canonical;

	const pass = passageOf(m.doy);
	const rareWinter = pass.winter && rng(m.dayNumber * 7919 + 13)() < 0.25;
	let count =
		pass.amount >= 0.66
			? 3
			: pass.amount >= 0.33
			? 2
			: pass.amount > 0.02
			? 1
			: rareWinter
			? 1
			: 0;

	if (rainstorm) {
		count = 0;
	} else if (wet) {
		count = Math.min(count, 1);
	}

	const flying = cm >= 1105 || cm < 330;

	const dk = clamp01(p.dark / 0.35);
	const ink = mix("#2c3242", "#15141f", dk);
	const moonUp = m.moon.up && m.phase.present;
	const L = (moonUp ? m.phase.illumination : 0) * (1 - wx.hide) * clamp01((p.dark - 0.45) / 0.35);

	const thermals = Math.min(ramp(cm, 480, 540), 1 - ramp(cm, 1000, 1060));
	const song = Math.min(ramp(cm, 330, 380), 1 - ramp(cm, 1060, 1110));

	return {
		skeins: count,
		skeinsOpacity: flying && count > 0 ? 1 : 0,
		west: pass.west,
		alpha: 0.74 + 0.14 * dk,
		ink: mix(ink, "#b9c4d8", 0.22 * L),
		wing: mix(ink, "#b9c4d8", 0.35 * L),
		belly: mix(ink, "#c6d0e2", 0.5 * L),
		buzzard: !wet && thermals >= 0.5,
		larks: !wet && larkSeason(m.doy) >= 0.5 && song >= 0.5,
		dayInk: mix("#3a3436", "#1b1a24", clamp01(p.dark / 0.5)),
	};
}

/* ---- the skeins: the mockup's bird() and its three skeins ---- */

type Kind = "goose" | "crane";
type Pose = "up" | "level" | "down" | "flex" | "glide";

/**
 * Side-on and heading right (a westward flock is mirrored whole): a body with
 * neck and head — a crane trails its legs — and a near and a far wing swept
 * through one stroke.
 */
const BODY: Record<Kind, string> = {
	goose:
		"M3.5,11.3 Q6,10.3 9,10.2 Q14,9.6 18.5,10 Q20.5,10.2 22,10.1 L27.4,9.8 Q28.6,9.2 29.6,9.5 L31.2,10.3 " +
		"L29.4,10.8 Q28.4,11 27.4,11 L22.6,11.4 Q21,12.8 17.5,13 Q12.5,13.3 8.5,12.4 Q6,11.9 3.5,11.3 Z",
	crane:
		"M5.5,11.2 Q8,10.3 10.5,10.3 Q14,9.8 17.5,10.2 Q20,10.4 22.5,9.9 L28.6,9.2 Q30.2,8.9 30.8,9.5 L32,9.9 " +
		"L30.6,10.1 Q29.6,10.3 28.8,10.2 L23,10.9 Q20.5,12.3 17.5,12.5 Q13.5,12.9 10,12.2 Q7.5,11.9 5.5,11.2 Z " +
		"M9.5,12.3 L0.4,12.9 L0.5,13.4 L9.6,12.8 Z",
};

/**
 * The wing through its stroke. The downstroke is the quicker half and lifts
 * the body; the upstroke comes back with the wrist bent; mid-stroke the wing
 * is edge-on and all but vanishes.
 */
const POSE: Record<Pose, string> = {
	up: "M16.5,10.1 Q17.2,3.6 8.4,0.3 Q10.6,3.6 10.4,6.4 Q10.4,8.8 11.5,10.4 Z",
	level: "M16.5,10.1 Q15.8,12.4 7,13.2 Q9.4,11.8 10.4,11.4 Q11.2,10.9 11.5,10.4 Z",
	down: "M16.5,10.1 Q17.6,15.6 10.2,19.6 Q11.6,16.6 11.4,14.2 Q11.2,12 11.5,10.4 Z",
	flex: "M16.5,10.1 Q15.6,7.6 7.2,8 Q9.4,8.6 10.2,9.2 Q11,9.8 11.5,10.4 Z",
	glide: "M16.5,10.1 Q16,11.6 6.4,12.2 Q9.2,11.3 10.4,11 Q11.2,10.7 11.5,10.4 Z",
};

const LIFT: Record<Pose, string> = {
	up: "0 .7",
	level: "0 0",
	down: "0 -.7",
	flex: "0 0",
	glide: "0 0",
};
const BEAT: ReadonlyArray<readonly [Pose, number]> = [
	["up", 0],
	["level", 0.3],
	["down", 0.56],
	["flex", 0.8],
];
const SPLINE = ".42 0 .58 1";

/**
 * One bird: `flaps` wingbeats of `period` seconds, then a glide of `glide`
 * beats' length (cranes glide between bursts), from `phase` of the way
 * through. Its own `<svg>`, so its SMIL has its own timeline, which the
 * scene's pause holds (scene.ts `motion`).
 */
function bird(kind: Kind, period: number, flaps: number, glide: number, phase: number): string {
	const keys: number[] = [];
	const poses: Pose[] = [];

	for (let k = 0; k < flaps; k++) {
		for (const [pose, at] of BEAT) {
			keys.push(k + at);
			poses.push(pose);
		}
	}

	if (glide) {
		keys.push(flaps + 0.35, flaps + glide - 0.3);
		poses.push("glide", "glide");
	}

	keys.push(flaps + glide);
	poses.push("up");
	const units = flaps + glide;
	const dur = (units * period).toFixed(2);
	const timing =
		`dur="${dur}s" begin="${(-phase * units * period).toFixed(
			2
		)}s" repeatCount="indefinite" calcMode="spline" ` +
		`keyTimes="${keys.map((k) => (k / units).toFixed(4)).join(";")}" keySplines="${Array(
			keys.length - 1
		)
			.fill(SPLINE)
			.join(";")}"`;
	const wing = `<animate attributeName="d" ${timing} values="${poses
		.map((q) => POSE[q])
		.join(";")}"/>`;
	return (
		`<svg viewBox="0 0 32 20" aria-hidden="true"><g>` +
		`<animateTransform attributeName="transform" type="translate" ${timing} values="${poses
			.map((q) => LIFT[q])
			.join(";")}"/>` +
		`<path class="ps-b-far" transform="translate(1.3 -.9)" d="${POSE.up}">${wing}</path>` +
		`<path class="ps-b-body" d="${BODY[kind]}"/>` +
		`<path class="ps-b-near" d="${POSE.up}">${wing}</path></g></svg>`
	);
}

export interface Skein {
	kind: Kind;
	shape: "v" | "line";
	/** Birds in it. */
	n: number;
	/** Height, % of the skeins' layer (the sky above the land). */
	y: number;
	/** The crossing's length and delay, in seconds. */
	d: number;
	dl: number;
	/** Scale and opacity: the far skein is small and pale. */
	s: number;
	o: number;
	/** A wingbeat, in seconds. */
	period: number;
}

/** A V of geese with uneven arms and a straggler, a slanting line of cranes, and a far skein. */
export const SKEINS: readonly Skein[] = [
	{kind: "goose", shape: "v", n: 13, y: 17, d: 42, dl: -8, s: 1, o: 1, period: 0.46},
	{kind: "crane", shape: "line", n: 8, y: 29, d: 52, dl: -30, s: 0.8, o: 0.82, period: 0.6},
	{kind: "goose", shape: "v", n: 17, y: 10, d: 64, dl: -47, s: 0.58, o: 0.55, period: 0.44},
];

/** A flock's box in the mockup's px: ps.css sizes it 12.5rem × 5.625rem; the birds sit in % of it. */
const FLOCK_W = 200;
const FLOCK_H = 90;

/**
 * The skeins' two-tone body: the back in shadow, the belly catching light
 * from below. The stops read the scene's custom properties, so the defs live
 * inside the scene; an svg of no size rather than `display: none`, which
 * stops a gradient painting.
 */
const DEFS =
	`<svg class="ps-bird-defs" width="0" height="0" aria-hidden="true" focusable="false"><defs>` +
	`<linearGradient id="ps-b-belly" x1="0" y1="0" x2="0" y2="1">` +
	`<stop offset=".3" style="stop-color: var(--ps-bird-ink)"/>` +
	`<stop offset="1" style="stop-color: var(--ps-bird-belly)"/>` +
	`</linearGradient></defs></svg>`;

/**
 * The skeins' layer: the belly gradient, then the three flocks, each
 * numbered (`--fi`, which ps.css holds against the published count), at its
 * height, on its own crossing; inside it the skein's scale and paleness, its
 * sway, and its birds, each drifting about its place (`--wx`/`--wy`, rem) and
 * beating its own wings. Seeded (the mockup drew the skeins from its
 * fireflies' stream, which cannot be reproduced; they have their own here).
 */
export function skeinsMarkup(): string {
	const r = rng(1105);

	return (
		DEFS +
		SKEINS.map((f, fi) => {
			let b = "";
			const ranks = [0, 0];

			for (let i = 0; i < f.n; i++) {
				let x: number;
				let y: number;

				if (f.shape === "v") {
					const arm = i === 0 ? -1 : r() < 0.42 ? 0 : 1;
					const rank = arm < 0 ? 0 : ++ranks[arm];
					x = 176 - rank * (13 + r() * 3.5);
					y = 42 + (arm ? 1 : -1) * rank * (5.8 + r() * 1.8) + (r() - 0.5) * 2.4;

					if (i === f.n - 1) {
						x -= 12;
					}
				} else {
					x = 176 - i * (16 + r() * 5);
					y = 26 + i * (5 + r() * 2.2) + Math.sin(i * 0.9) * 3;
				}

				const k = 0.94 + r() * 0.12;
				const cranes = f.kind === "crane";
				const flaps = cranes ? 3 + Math.floor(r() * 2) : 6 + Math.floor(r() * 4);
				const glide = cranes ? 1 + r() * 0.7 : r() < 0.3 ? 0.7 : 0;
				const wx = rem(Number((r() * 5 - 2.5).toFixed(1)));
				const wy = rem(Number((r() * 4 - 2).toFixed(1)));
				const wd = (4 + r() * 5).toFixed(1);
				const wdl = (-r() * 9).toFixed(1);
				const period = f.period * (0.92 + r() * 0.16);
				b +=
					`<span class="ps-bird" style="left:${n((x / FLOCK_W) * 100)}%;top:${n(
						(y / FLOCK_H) * 100
					)}%;width:${rem(17 * k)};height:${rem(10.6 * k)};` +
					`--wx:${wx};--wy:${wy};--wd:${wd}s;--wdl:${wdl}s">` +
					bird(f.kind, period, flaps, glide, r()) +
					`</span>`;
			}

			const sd = (11 + r() * 6).toFixed(1);
			const sdl = (-r() * 12).toFixed(1);
			return (
				`<div class="ps-flock" style="--fi:${fi};--fy:${f.y}%;--fd:${f.d}s;--fdl:${f.dl}s">` +
				`<div class="ps-skein" style="--fs:${f.s};--fo:${f.o}">` +
				`<div class="ps-skein-sway" style="--sd:${sd}s;--sdl:${sdl}s">${b}</div></div></div>`
			);
		}).join("")
	);
}

/* ---- the steppe's own birds, by day ---- */

/** One SMIL animation from [value, second] keys, eased between them; the last key closes the loop on the first value. */
function smil(
	tag: string,
	attrs: string,
	keys: ReadonlyArray<readonly [string, number]>,
	begin: number
): string {
	const dur = keys[keys.length - 1][1];
	return (
		`<${tag} ${attrs} dur="${dur.toFixed(3)}s" begin="${(-begin).toFixed(
			2
		)}s" repeatCount="indefinite" calcMode="spline" ` +
		`keyTimes="${keys.map((k) => Math.min(1, k[1] / dur).toFixed(4)).join(";")}" ` +
		`keySplines="${Array(keys.length - 1)
			.fill(SPLINE)
			.join(";")}" values="${keys.map((k) => k[0]).join(";")}"/>`
	);
}

type Segment =
	| readonly ["M" | "L", number, number]
	| readonly ["Q", number, number, number, number];

/** A planform symmetric about the body's axis: the right half from the bill to the tail tip, mirrored back for the left. */
function sym(half: readonly Segment[]): string {
	const pts: Array<[number, number]> = [[half[0][1], half[0][2]]];
	let d = `M${half[0][1]},${half[0][2]}`;

	for (const g of half.slice(1)) {
		if (g[0] === "Q") {
			d += ` Q${g[1]},${g[2]} ${g[3]},${g[4]}`;
			pts.push([g[3], g[4]]);
		} else {
			d += ` L${g[1]},${g[2]}`;
			pts.push([g[1], g[2]]);
		}
	}

	for (let i = half.length - 1; i >= 1; i--) {
		const g = half[i];
		const [px, py] = pts[i - 1];
		d += g[0] === "Q" ? ` Q${g[1]},${-g[2]} ${px},${-py}` : ` L${px},${-py}`;
	}

	return d + " Z";
}

/**
 * D1, the buzzard, seen from below: broad wings with five fingered
 * primaries, a short tail fanned in the turn.
 */
const BUZZ = sym([
	["M", 11.5, 0],
	["Q", 11.2, 1.7, 8.6, 2.2],
	["Q", 6.2, 2.5, 5.6, 3.4],
	["Q", 6.4, 8.4, 7.3, 12.8],
	["Q", 6.9, 18.2, 4.7, 23.8],
	["L", 3.7, 26.2],
	["L", 3.1, 29.4],
	["L", 2.0, 27.5],
	["L", 1.0, 30.3],
	["L", -0.2, 28.2],
	["L", -1.5, 30.3],
	["L", -2.4, 27.9],
	["L", -3.8, 29.6],
	["L", -4.4, 27.1],
	["L", -5.9, 28.0],
	["L", -6.1, 25.7],
	["Q", -9.4, 21, -9.8, 15.2],
	["Q", -10.1, 9.6, -7.8, 5.2],
	["Q", -7.3, 4.2, -8.4, 3.7],
	["L", -16.2, 5.6],
	["Q", -18.6, 3.2, -18.8, 0],
]);

/** The buzzard's circle, on a level plane (squashed by the angle it is seen from, in the markup). */
const LOOP =
	"M44,0 C44,26 24,46 -2,46 C-28,46 -46,24 -46,-2 C-46,-26 -24,-44 2,-44 C26,-44 44,-24 44,0 Z";

/**
 * It circles on a level plane, so the drawing turns with its heading and the
 * whole circle is squashed by the angle it is seen from: side-on its wings
 * foreshorten to a bar, head-on they are the full span. A few slow
 * wingbeats (the span shortening as the wings lift) every other turn.
 */
function buzzard(): string {
	const flap = smil(
		"animateTransform",
		'attributeName="transform" type="scale"',
		[
			["1 1", 0],
			["1 .62", 0.32],
			["1 .88", 0.64],
			["1 .62", 0.96],
			["1 .88", 1.28],
			["1 .66", 1.6],
			["1 1", 1.95],
			["1 1", 52],
		],
		9
	);
	return (
		`<div class="ps-buzzard"><svg viewBox="-65 -35 130 70" aria-hidden="true"><g transform="scale(1 .5)"><g>` +
		`<animateMotion dur="26s" begin="-4s" repeatCount="indefinite" rotate="auto" path="${LOOP}"/>` +
		`<g transform="scale(.64)"><g>${flap}<path d="${BUZZ}"/></g></g></g></g></svg></div>`
	);
}

/**
 * D2, skylarks, side-on and facing into the wind: fluttering up out of the
 * grass, hanging high up, then down in steps on raised, still wings, and the
 * last stretch dropped with the wings closed. ps.css moves them and says
 * which of the three wing sets shows; the flutter itself never stops.
 */
const LARK = {
	body:
		"M3.4,6.7 Q4.2,5.1 6.2,4.9 Q6.6,4.1 7.3,4.3 Q7.4,5 8.4,5.4 Q10.8,6.4 13,7.4 L17.4,8 L17.1,9.8 L13.2,9.2 " +
		"Q10.8,9.6 8.6,9.1 Q6.2,8.5 4.9,7.6 Q4,7.3 3.4,6.7 Z",
	up: "M8.6,6.8 Q9.4,2.4 12.6,0.6 Q12.4,3.6 11.6,6.6 Q10.1,7.4 8.6,6.8 Z",
	down: "M8.6,6.8 Q10.8,9.8 12.4,13 Q13.2,10.2 12,7.9 Q10.2,7.5 8.6,6.8 Z",
	half: "M8.6,6.8 Q10.6,4.4 14.2,3.6 Q13,5.6 12,7.4 Q10.2,7.5 8.6,6.8 Z",
	chute: "M8.6,6.8 Q8.8,2.6 11,0.8 Q11.8,3.8 11.6,6.8 Q10.1,7.4 8.6,6.8 Z",
	closed: "M8.6,6.8 Q11,5.9 14.4,7.3 Q12.6,8 11,8 Q9.6,7.8 8.6,6.8 Z",
};

/** One lark at `left` % across, on a song flight of `ld` seconds from `ldl`; its flutter drawn from `r`. */
function lark(r: () => number, left: number, ld: number, ldl: number): string {
	const per = 0.14 + r() * 0.03;
	const keys: Array<[string, number]> = [];
	let t = 0;

	for (let k = 0, beats = 7 + Math.floor(r() * 4); k < beats; k++) {
		keys.push([LARK.up, t], [LARK.down, t + per * 0.5]);
		t += per;
	}

	keys.push([LARK.half, t + 0.08]);
	t += 0.3 + r() * 0.2;
	keys.push([LARK.half, t]);
	t += 0.08;
	keys.push([LARK.up, t]);
	const a = smil("animate", 'attributeName="d"', keys, r() * t);
	return (
		`<div class="ps-lark" style="left:${left}%;--ld:${ld}s;--ldl:${ldl}s"><div class="ps-lark-track"><div class="ps-lark-bird">` +
		`<svg viewBox="0 0 20 14" aria-hidden="true">` +
		`<g class="ps-lark-fl"><path class="ps-b-far" transform="translate(.9 -.6)" d="${LARK.up}">${a}</path></g>` +
		`<g class="ps-lark-ch"><path class="ps-b-far" transform="translate(.9 -.6)" d="${LARK.chute}"/></g>` +
		`<path d="${LARK.body}"/>` +
		`<g class="ps-lark-fl"><path d="${LARK.up}">${a}</path></g><g class="ps-lark-ch"><path d="${LARK.chute}"/></g>` +
		`<g class="ps-lark-cl"><path d="${LARK.closed}"/></g></svg></div></div></div>`
	);
}

/**
 * The steppe's own birds (the user's D1 and D2): the buzzard, then three
 * larks at 30, 47 and 66 % across on their own song flights. Each is shown
 * by its own published switch (`--ps-buzzard-op`, `--ps-lark-op`). Seeded, at
 * the mockup's seed for them.
 */
export function dayBirdsMarkup(): string {
	const r = rng(2718);
	return buzzard() + lark(r, 30, 66, -3) + lark(r, 47, 72, -31) + lark(r, 66, 78, -55);
}
