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

/** One bird's wingbeat: `flaps` beats of `period` seconds, then a glide of `glide` beats' length, from `phase` of the way through. */
export interface Wingbeat {
	period: number;
	flaps: number;
	glide: number;
	phase: number;
}

/**
 * The poses a bird passes through, in beats from the start of its cycle: the
 * stroke `flaps` times, then (cranes glide between bursts) into a glide,
 * held, and back up — the mockup's SMIL keyframes, eased with SPLINE.
 */
function wingKeys(w: Wingbeat): Array<[number, Pose]> {
	const keys: Array<[number, Pose]> = [];

	for (let k = 0; k < w.flaps; k++) {
		for (const [pose, at] of BEAT) {
			keys.push([k + at, pose]);
		}
	}

	if (w.glide) {
		keys.push([w.flaps + 0.35, "glide"], [w.flaps + w.glide - 0.3, "glide"]);
	}

	keys.push([w.flaps + w.glide, "up"]);
	return keys;
}

// SPLINE as CSS's cubic-bezier: x(t) solved for t by bisection, then y(t).
function eased(x: number): number {
	const [x1, y1, x2, y2] = SPLINE.split(" ").map(Number);
	const at = (a: number, b: number, t: number) =>
		3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
	let lo = 0;
	let hi = 1;

	for (let i = 0; i < 30; i++) {
		const mid = (lo + hi) / 2;

		if (at(x1, x2, mid) < x) {
			lo = mid;
		} else {
			hi = mid;
		}
	}

	return at(y1, y2, (lo + hi) / 2);
}

// The poses share one shape of path (M, three Qs, Z), so a pose between two
// is their numbers mixed, as SMIL interpolates a path's d.
function mixPath(a: string, b: string, u: number): string {
	const nb = b.match(/-?[\d.]+/g)!.map(Number);
	let i = 0;
	return a.replace(/-?[\d.]+/g, (v) =>
		String(Number((Number(v) + (nb[i++] - Number(v)) * u).toFixed(3)))
	);
}

function poseBetween(from: Pose, to: Pose, p: number) {
	const u = eased(p);
	const [fy, ty] = [from, to].map((q) => Number(LIFT[q].split(" ")[1]));
	return {d: mixPath(POSE[from], POSE[to], u), lift: fy + (ty - fy) * u};
}

/** Frames of the wing strip: a beat; the turn from the last flex into a glide; the glide; the climb back up. */
const BEAT_FRAMES = 16;
const INTO_GLIDE = 8;
const OUT_OF_GLIDE = 5;
export const WING_FRAMES = BEAT_FRAMES + INTO_GLIDE + 1 + OUT_OF_GLIDE;
const GLIDE_FRAME = BEAT_FRAMES + INTO_GLIDE;

/** The strip's frames, in order: where the wing is and how far the stroke lifts the body. */
export const WING_STRIP: ReadonlyArray<{d: string; lift: number}> = (() => {
	const frames: Array<{d: string; lift: number}> = [];
	const beat = [...BEAT, ["up", 1] as const];

	for (let i = 0; i < BEAT_FRAMES; i++) {
		const x = i / BEAT_FRAMES;
		const k = beat.findIndex(([, at], j) => x >= at && x < beat[j + 1][1]);
		const [from, a] = beat[k];
		const [to, b] = beat[k + 1];
		frames.push(poseBetween(from, to, (x - a) / (b - a)));
	}

	for (let i = 0; i < INTO_GLIDE; i++) {
		frames.push(poseBetween("flex", "glide", i / INTO_GLIDE));
	}

	frames.push(poseBetween("glide", "glide", 0));

	for (let i = 0; i < OUT_OF_GLIDE; i++) {
		frames.push(poseBetween("glide", "up", i / OUT_OF_GLIDE));
	}

	return frames;
})();

/**
 * The strip frame a bird shows at `t` seconds of the scene's clock: where
 * its cycle (begun `phase` of the way through, as the SMIL's negative begin
 * had it) puts it, to the nearest frame.
 */
export function wingFrame(w: Wingbeat, t: number): number {
	const units = w.flaps + w.glide;
	const dur = Number((units * w.period).toFixed(2));
	const begin = -Number((w.phase * units * w.period).toFixed(2));
	const u = (((((t - begin) / dur) % 1) + 1) % 1) * units;
	const lastFlex = w.flaps - 0.2;

	if (w.glide && u >= lastFlex) {
		if (u < w.flaps + 0.35) {
			const k = Math.round(((u - lastFlex) / 0.55) * INTO_GLIDE);
			return k >= INTO_GLIDE ? GLIDE_FRAME : BEAT_FRAMES + k;
		}

		if (u < units - 0.3) {
			return GLIDE_FRAME;
		}

		const k = Math.round(((u - (units - 0.3)) / 0.3) * OUT_OF_GLIDE);
		return k >= OUT_OF_GLIDE ? 0 : GLIDE_FRAME + 1 + k;
	}

	return Math.round((u - Math.floor(u)) * BEAT_FRAMES) % BEAT_FRAMES;
}

/** A frame's width in the sprite sheet, in the bird's units: its 32 and a gutter, so a frame never bleeds into the next. */
export const WING_CELL = 34;

/** The bird's window in its units: a frame shows this much of its cell. */
const FRAME_W = 32;
const FRAME_H = 20;

type Segment2 = readonly [string, ...number[]];

// A path's commands (M, L, Q, Z, absolute) as numbers.
function commands(d: string): Segment2[] {
	return [...d.matchAll(/([MLQZ])([^MLQZ]*)/g)].map(
		(m) => [m[1], ...(m[2].match(/-?[\d.]+/g) ?? []).map(Number)] as const
	);
}

/**
 * The vertical extent of a path's own geometry (its bounding box, as SVG's
 * objectBoundingBox has it, not its control points'): where the body's
 * gradient runs from and to.
 */
export function pathBoundsY(d: string): [number, number] {
	let lo = Infinity;
	let hi = -Infinity;
	let y0 = 0;

	const see = (y: number) => {
		lo = Math.min(lo, y);
		hi = Math.max(hi, y);
	};

	for (const [c, ...v] of commands(d)) {
		if (c === "M" || c === "L") {
			y0 = v[1];
			see(y0);
		} else if (c === "Q") {
			const [, y1, , y2] = v;
			const den = y0 - 2 * y1 + y2;
			const t = den === 0 ? -1 : (y0 - y1) / den;

			if (t > 0 && t < 1) {
				see((1 - t) ** 2 * y0 + 2 * (1 - t) * t * y1 + t * t * y2);
			}

			see(y2);
			y0 = y2;
		}
	}

	return [lo, hi];
}

/** What a 2D context needs to draw a sprite sheet: the subset of CanvasRenderingContext2D used. */
export interface SheetContext {
	setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
	createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradient;
	fill(path: Path2D): void;
	fillStyle: string | CanvasGradient | CanvasPattern;
	globalAlpha: number;
}

/**
 * Every pose of one kind of bird side by side, in the hour's colours, `unit`
 * device px to the bird's unit: the far wing in the wing colour at 0.55 and a
 * little up and behind, the body two-tone (the back in the ink, the belly
 * catching the light from below), the near wing over it — the mockup's bird,
 * drawn once per colour instead of morphed. The sheet is opaque; the bird's
 * alpha is applied as it is drawn, so a wing over the body never darkens twice.
 */
export function drawSheet(
	ctx: SheetContext,
	path: (d: string) => Path2D,
	kind: Kind,
	look: {ink: string; wing: string; belly: string},
	unit: number
): void {
	const body = path(BODY[kind]);
	const [top, bottom] = pathBoundsY(BODY[kind]);

	WING_STRIP.forEach((f, i) => {
		const x = i * WING_CELL * unit;
		const wing = path(f.d);
		ctx.setTransform(unit, 0, 0, unit, x + 1.3 * unit, (f.lift - 0.9) * unit);
		ctx.globalAlpha = 0.55;
		ctx.fillStyle = look.wing;
		ctx.fill(wing);
		ctx.setTransform(unit, 0, 0, unit, x, f.lift * unit);
		ctx.globalAlpha = 1;
		const g = ctx.createLinearGradient(0, top, 0, bottom);
		g.addColorStop(0.3, look.ink);
		g.addColorStop(1, look.belly);
		ctx.fillStyle = g;
		ctx.fill(body);
		ctx.fillStyle = look.wing;
		ctx.fill(wing);
	});

	ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** The sheet's size in device px for `unit` device px to the bird's unit. */
export const sheetSize = (unit: number) => ({
	width: Math.ceil(WING_FRAMES * WING_CELL * unit),
	height: Math.ceil(FRAME_H * unit),
});

/** One bird of a skein, in the mockup's px of its flock's 200 × 90 box. */
export interface SkeinBird {
	/** Its window: top-left, width and height. */
	x: number;
	y: number;
	w: number;
	h: number;
	/** How far it drifts about its place (px), over `wd` seconds and back, from `wdl` seconds in. */
	wx: number;
	wy: number;
	wd: number;
	wdl: number;
	beat: Wingbeat;
}

export interface SkeinPlan {
	kind: Kind;
	birds: SkeinBird[];
	/** The flock's canvas: the box its birds can reach, in the mockup's px of the flock's box. */
	box: {x: number; y: number; w: number; h: number};
	/** The sway's period and delay, as CSS times. */
	sd: string;
	sdl: string;
}

/**
 * A bird's drift at `t` seconds: CSS's `ease-in-out alternate` from its place
 * to (wx, wy) and back, as the old per-bird animation had it.
 */
export function driftAt(b: SkeinBird, t: number): [number, number] {
	const lt = (t - b.wdl) / b.wd;
	const k = Math.floor(lt);
	const p = lt - k;
	const e = eased(k % 2 === 0 ? p : 1 - p);
	return [b.wx * e, b.wy * e];
}

/** What a flock's 2D context needs: the subset of CanvasRenderingContext2D used each step. */
export interface FlockContext {
	clearRect(x: number, y: number, w: number, h: number): void;
	drawImage(
		image: CanvasImageSource,
		sx: number,
		sy: number,
		sw: number,
		sh: number,
		dx: number,
		dy: number,
		dw: number,
		dh: number
	): void;
	globalAlpha: number;
}

/**
 * One flock at `t` seconds: its canvas cleared, then each bird's frame
 * (`wingFrame`) copied from the sheet to its place, drifted, `scale` device
 * px to the mockup's px.
 */
export function drawFlock(
	ctx: FlockContext,
	size: {width: number; height: number},
	plan: SkeinPlan,
	sheet: {image: CanvasImageSource; unit: number},
	t: number,
	scale: number,
	alpha: number
): void {
	ctx.clearRect(0, 0, size.width, size.height);
	ctx.globalAlpha = alpha;
	const u = sheet.unit;

	for (const b of plan.birds) {
		const f = wingFrame(b.beat, t);
		const [dx, dy] = driftAt(b, t);
		ctx.drawImage(
			sheet.image,
			f * WING_CELL * u,
			0,
			FRAME_W * u,
			FRAME_H * u,
			(b.x + dx - plan.box.x) * scale,
			(b.y + dy - plan.box.y) * scale,
			b.w * scale,
			b.h * scale
		);
	}
}

/** A flock's canvas and how big its backing is, read from its attributes (no layout). */
export interface FlockSurface {
	plan: SkeinPlan;
	ctx: FlockContext;
	size(): {width: number; height: number};
}

export interface SkeinLook {
	ink: string;
	wing: string;
	belly: string;
	alpha: number;
}

/**
 * The skeins as one of the stepper's clocks (stepped, held and handed to
 * native playback like the SMIL it replaces): a time set redraws each flock
 * that flies tonight (the first `count`) on its own canvas — one layer a
 * flock, nothing for the page to restyle or repaint. The sheets are drawn by
 * `deps.sheet` for a kind, a look and a unit, again only when one changes.
 */
/** How often a free-running skein clock repaints its canvases: the old scene rate. */
export const BIRDS_FPS = 24;
const PAINT_STEP = 1 / BIRDS_FPS;
// Half a 60 Hz frame: a paint due between two frames is taken at the nearer one.
const PAINT_SLACK = 1 / 120;

export function createSkeinFlocks(
	flocks: FlockSurface[],
	deps: {
		frame(fn: (ms: number) => void): () => void;
		sheet(kind: Kind, look: SkeinLook, unit: number): CanvasImageSource;
	}
) {
	let time = 0;
	let count = flocks.length;
	let look: SkeinLook | null = null;
	let cancel: (() => void) | null = null;
	let base: number | null = null;
	const sheets = new Map<string, {key: string; image: CanvasImageSource; unit: number}>();
	// The widest bird, in the mockup's px: the sheet is drawn for it, so it is only ever scaled down.
	const widest = Math.max(...flocks.flatMap((f) => f.plan.birds.map((b) => b.w)));

	const sheetFor = (kind: Kind, scale: number) => {
		const unit = Number(((widest * scale) / FRAME_W).toFixed(3));
		const key = `${look!.ink}${look!.wing}${look!.belly}${unit}`;
		const had = sheets.get(kind);

		if (had?.key === key) {
			return had;
		}

		const made = {key, image: deps.sheet(kind, look!, unit), unit};
		sheets.set(kind, made);
		return made;
	};

	const paint = () => {
		if (!look) {
			return;
		}

		flocks.forEach((f, i) => {
			const size = f.size();

			if (i >= count || !size.width || !size.height) {
				return;
			}

			const scale = size.width / f.plan.box.w;
			drawFlock(f.ctx, size, f.plan, sheetFor(f.plan.kind, scale), time, scale, look!.alpha);
		});
	};

	// Free-running (the 60 setting), the clock follows every frame but paints
	// at most BIRDS_FPS times a second: the wingbeat is a handful of sheet
	// frames and the drift a few px, and a canvas upload a frame was the
	// birds' whole cost; the flight and the sway stay CSS at the screen's rate.
	let due = 0;

	const tick = (ms: number) => {
		if (base === null) {
			base = ms / 1000 - time;
		}

		time = ms / 1000 - base;

		if (time + PAINT_SLACK >= due) {
			paint();
			due = due + PAINT_STEP > time ? due + PAINT_STEP : time + PAINT_STEP;
		}

		cancel = deps.frame(tick);
	};

	return {
		animationsPaused: () => cancel === null,
		pauseAnimations() {
			cancel?.();
			cancel = null;
		},
		unpauseAnimations() {
			if (cancel) {
				return;
			}

			base = null;
			due = 0;
			cancel = deps.frame(tick);
		},
		getCurrentTime: () => time,
		setCurrentTime(seconds: number) {
			time = seconds;
			paint();
		},
		/** The hour's colours and alpha; redraws at once when they change. */
		setLook(next: SkeinLook) {
			if (look && JSON.stringify(look) === JSON.stringify(next)) {
				return;
			}

			look = next;
			paint();
		},
		/** How many of the flocks fly (the published skein count). */
		setCount(flying: number) {
			count = flying;
		},
		/** A canvas was resized: draw again where the clock stands. */
		redraw: paint,
	};
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
 * The three skeins' birds: each at its place in the line, drifting about it
 * and beating its own wings. Seeded (the mockup drew the skeins from its
 * fireflies' stream, which cannot be reproduced; they have their own here).
 */
export function skeinPlans(): SkeinPlan[] {
	const r = rng(1105);

	return SKEINS.map((f) => {
		const birds: SkeinBird[] = [];
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
			const wx = Number((r() * 5 - 2.5).toFixed(1));
			const wy = Number((r() * 4 - 2).toFixed(1));
			const wd = Number((4 + r() * 5).toFixed(1));
			const wdl = Number((-r() * 9).toFixed(1));
			const period = f.period * (0.92 + r() * 0.16);
			birds.push({
				x: Number(x.toFixed(2)),
				y: Number(y.toFixed(2)),
				w: 17 * k,
				h: 10.6 * k,
				wx,
				wy,
				wd,
				wdl,
				beat: {period, flaps, glide, phase: r()},
			});
		}

		// The box every bird can reach, drift and all, a pixel to spare.
		const x0 = Math.floor(Math.min(...birds.map((b) => b.x + Math.min(0, b.wx))) - 1);
		const y0 = Math.floor(Math.min(...birds.map((b) => b.y + Math.min(0, b.wy))) - 1);
		const x1 = Math.ceil(Math.max(...birds.map((b) => b.x + b.w + Math.max(0, b.wx))) + 1);
		const y1 = Math.ceil(Math.max(...birds.map((b) => b.y + b.h + Math.max(0, b.wy))) + 1);
		const sd = (11 + r() * 6).toFixed(1);
		const sdl = (-r() * 12).toFixed(1);
		return {kind: f.kind, birds, box: {x: x0, y: y0, w: x1 - x0, h: y1 - y0}, sd, sdl};
	});
}

/**
 * The skeins' layer: the three flocks, each numbered (`--fi`, which ps.css
 * holds against the published count), at its height, on its own crossing;
 * inside it the skein's scale and paleness, its sway, and one canvas holding
 * its birds (`createSkeinFlocks` draws them), sized to the box they reach in
 * % of the flock's.
 */
export function skeinsMarkup(): string {
	const pc = (v: number, of: number) => `${n((v / of) * 100)}%`;
	return skeinPlans()
		.map((p, fi) => {
			const f = SKEINS[fi];
			const {x, y, w, h} = p.box;
			return (
				`<div class="ps-flock" style="--fi:${fi};--fy:${f.y}%;--fd:${f.d}s;--fdl:${f.dl}s">` +
				`<div class="ps-skein" style="--fs:${f.s};--fo:${f.o}">` +
				`<div class="ps-skein-sway" style="--sd:${p.sd}s;--sdl:${p.sdl}s">` +
				`<canvas class="ps-flock-birds" data-flock="${fi}" style="left:${pc(
					x,
					FLOCK_W
				)};top:${pc(y, FLOCK_H)};width:${pc(w, FLOCK_W)};height:${pc(
					h,
					FLOCK_H
				)}"></canvas></div></div></div>`
			);
		})
		.join("");
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
