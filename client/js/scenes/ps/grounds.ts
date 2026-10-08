/**
 * What the words over the plains are held over, and which treatment they take
 * (docs/projects/ps-theme.md §7, §11; plan 3's rulings). Pure and Vue-free:
 * the scene runs it once a day to publish `data-ps-text`, and the legibility
 * model (tools/ps/legibility.ts), the palette generator and the floors test
 * import the same list and the same rule, so what the page decides and what
 * the tools check cannot drift apart.
 *
 * **The grounds** are every area the scene paints at one moment (the rulings
 * table): the sky; the moon's disc and the sun's core at the opacity the scene
 * draws them (the disc whatever the moon's phase; the sun only while it stands
 * above the horizon line, since the land hides it below); the land bands, the
 * trees, the riverbed and the river; the yurt's felt, roof, band, door and
 * their glows; the pool of light before the door; the clouds; the smoke. On a
 * veiled day every one of them is taken under the veil, which covers the whole
 * scene (the controller's ruling, 2026-09-25). Small marks (tufts, shrubs,
 * trunks, stones, the band's marks, the crown, the pipe, the woodpile), lines
 * (the rims, ropes, ribs, the river's glint), stars, particles, fireflies,
 * birds and the lightning flash are not grounds.
 *
 * **The treatment** (the user's "white sooner", 2026-09-25): the words take
 * the light treatment whenever dark ink (INK at 4.5 : 1) or the faint ink it
 * keeps clear (INK_FAINT_HELD at 3 : 1), through the halo, would fall under
 * its floor over any ground of the moment; TEXT_LIGHT_AT stays the other
 * trigger. The decision is made once per day on the dense sweep's 5-minute
 * grid (inkWindow): ink from the first sample from which it holds through to
 * solar noon, until the first sample after noon where it fails, so the words
 * change at most once before noon and once after.
 */
import {luminance, mix} from "./colour";
import {momentFor, SOLAR_NOON, type Moment, type Weather} from "./engine";
import {
	GLASS_NIGHT_AT,
	levelsAt,
	paletteAt,
	stopsAt,
	TEXT_LIGHT_AT,
	WEATHER,
	type Palette,
} from "./palette";

/** The day's ink. */
export const INK = "#1b2638";
/** The faint ink the rule keeps clear at 3 : 1: the spec's #4c5a72 moved under rule 2 (spec §7). */
export const INK_FAINT_HELD = "#38455c";

/**
 * How far the halo moves the ground right around a dark word toward its own
 * colour, measured in rendered pixels on real chat phrases and used as
 * min(0.6, measured): tools/ps/legibility.ts keeps the measurements' record
 * (last taken 2026-09-26, on Source Sans 3 and Newsreader). At this strength
 * dark ink holds over the yurt's band and door at no hour of a clear day, so
 * the words are white all day but on snowy days (the user's pick "A",
 * 2026-09-25).
 */
export const ALPHA_HALO = Math.min(0.6, 0.1614);

/** The grid the day's treatment is decided on: the generator's dense sweep's step, so every dense sample is a decision point. */
export const SCHEDULE_STEP = 5;

export type Text = "ink" | "light";

export interface SceneGround {
	/** The painted area: stable across moments ("skyTop", "band", "moon #fdfaf0 over skyTop"). */
	area: string;
	/** The area and its colour at this moment, for headers and failure messages (a body's with its opacity and the sky under it). */
	name: string;
	hex: string;
	body: "sky" | "land" | "moon" | "sun";
	/** A body counted while under the horizon line: the moon only. */
	below: boolean;
}

/** The plains' areas (the rulings table), by the names sceneGrounds gives them; the smoke's are added while it shows. */
export const AREAS = [
	"mount",
	"mount2",
	"far",
	"hill2",
	"hill1",
	"grass",
	"blade",
	"tree",
	"riverbed",
	"river top",
	"river bottom",
	"felt shade",
	"felt",
	"felt glow",
	"door glow",
	"roof top",
	"roof bottom",
	"crown glow",
	"band",
	"door",
	"pool on hill1",
	"pool on grass",
	"cloud",
	"cloud underside",
] as const;

/** The two lightest stops of the moon's disc and of the sun's core (scene.ts, MOON and SUN). */
const MOON_DISC = ["#fdfaf0", "#ece5cf"];
const SUN_CORE = ["#fffef6", "#fff3c2"];

/** The yurt's fixed warm colours (plains.ts yurtSvg) and the roof's snow (ps.css). */
const INNER_GLOW = "#ffd48c";
const DOOR_GLOW = "#ffcf7a";
const CROWN_GLOW = "#ffd08a";
const POOL = "#ffc47a";
const ROOF_SNOW = "#f5f8fc";

/**
 * The opacity the scene draws the moon and the sun at (scene.ts sceneVars
 * writes these): the moon while it is up and present, by the dark and the
 * weather's cloud; the sun while it is up, by the weather's cloud.
 */
export function bodyOpacity(m: Moment, p: Palette): {moon: number; sun: number} {
	const hide = WEATHER[m.weather].hide;
	return {
		moon: m.moon.up && m.phase.present ? Math.min(1, p.dark * 1.25) * (1 - hide * 0.85) : 0,
		sun: m.sun.up ? 1 - hide : 0,
	};
}

/** The smoke's colour as the page paints it: `rgb(r g b / 55%)` (palette.ts). */
function smokeRgb(smoke: string): {hex: string; alpha: number} {
	const [r, g, b, a] = (smoke.match(/[\d.]+/g) ?? []).map(Number);
	const byte = (v: number) => Math.round(v).toString(16).padStart(2, "0");
	return {hex: `#${byte(r)}${byte(g)}${byte(b)}`, alpha: a / 100};
}

/** Whether a ground is the moon's disc or the sun's core. */
const isBodyGround = (g: SceneGround) => g.body === "moon" || g.body === "sun";

/** Every ground the scene paints at one moment (see the module's comment). */
export function sceneGrounds(m: Moment, p: Palette): SceneGround[] {
	const l = levelsAt(m, p);
	const out: SceneGround[] = [];
	const add = (
		area: string,
		hex: string,
		body: SceneGround["body"] = "land",
		below = false,
		name = area
	) => out.push({area, name, hex, body, below});

	for (const band of ["skyTop", "skyMid", "skyHorizon"] as const) {
		add(band, p[band], "sky");
	}

	// The disc counts whatever the moon's phase, as a present moon; the page rounds both opacities.
	const bodies = bodyOpacity({...m, phase: {...m.phase, present: true}}, p);
	const moonOp = Number(bodies.moon.toFixed(3));
	const sunOp = Number(bodies.sun.toFixed(2));

	if (moonOp > 0) {
		for (const stop of MOON_DISC) {
			for (const band of ["skyTop", "skyMid"] as const) {
				const below = m.moon.alt < 0;
				add(
					`moon ${stop} over ${band}`,
					mix(p[band], stop, moonOp),
					"moon",
					below,
					`moon ${stop} at ${moonOp.toFixed(2)} over ${band} ${p[band]}${
						below ? " (under the horizon)" : ""
					}`
				);
			}
		}
	}

	if (sunOp > 0 && m.sun.alt >= 0) {
		for (const stop of SUN_CORE) {
			for (const band of ["skyMid", "skyHorizon"] as const) {
				add(
					`sun ${stop} over ${band}`,
					mix(p[band], stop, sunOp),
					"sun",
					false,
					`sun ${stop} at ${sunOp.toFixed(2)} over ${band} ${p[band]}`
				);
			}
		}
	}

	for (const k of [
		"mount",
		"mount2",
		"far",
		"hill2",
		"hill1",
		"grass",
		"blade",
		"tree",
		"riverbed",
	] as const) {
		add(k, p[k]);
	}

	// The river is its sky's gradient over the bed, at the season's water.
	add("river top", mix(p.riverbed, p.riverSkyTop, l.water));
	add("river bottom", mix(p.riverbed, p.riverSkyBottom, l.water));

	// The yurt: the wall's two stops, and at night its inner glow and the door's.
	const glow = p.nightGlow;
	add("felt shade", p.feltShade);
	add("felt", p.felt);
	add("felt glow", mix(p.felt, INNER_GLOW, 0.62 * glow));
	add("door glow", mix(p.felt, DOOR_GLOW, glow));
	const roofTop = mix(p.roofTop, ROOF_SNOW, l.snowcap);
	add("roof top", roofTop);
	add("roof bottom", mix(p.roofBottom, ROOF_SNOW, l.snowcap));
	add("crown glow", mix(roofTop, CROWN_GLOW, 0.95 * glow));
	add("band", p.band);
	add("door", p.door);

	// The door's pool on the ground before it, at the night glow (none by day).
	for (const under of ["hill1", "grass"] as const) {
		add(`pool on ${under}`, mix(p[under], POOL, 0.78 * glow));
	}

	add("cloud", p.cloud);
	add("cloud underside", p.cloudUnder);

	// The smoke at its puffs' peak (0.9) over what stands behind the pipe.
	if (p.smokeOpacity > 0) {
		const smoke = smokeRgb(p.smoke);

		for (const k of ["far", "mount", "mount2", "skyHorizon"] as const) {
			add(`smoke over ${k}`, mix(p[k], smoke.hex, smoke.alpha * 0.9 * p.smokeOpacity));
		}
	}

	const veiled =
		l.veil > 0
			? out.map((g) => ({
					...g,
					hex: mix(g.hex, l.veilColour, l.veil),
					name: `${g.name} under the veil`,
			  }))
			: out;
	// A body's name already carries its colours; every other area's takes its own.
	return veiled.map((g) => (isBodyGround(g) ? g : {...g, name: `${g.name} ${g.hex}`}));
}

/** The daytime halo: the horizon of the hour, lifted 55 % toward white. */
export function haloFor(p: Palette): string {
	return mix(p.skyHorizon, "#ffffff", 0.55);
}

/**
 * The lowest luminance a ground may have, through the halo, for both INK at
 * 4.5 : 1 and INK_FAINT_HELD at 3 : 1: both are darker than any such ground,
 * so each holds exactly when the ground is at least this light.
 */
const LEAST =
	Math.max(4.5 * (luminance(INK) + 0.05), 3 * (luminance(INK_FAINT_HELD) + 0.05)) - 0.05;

/** Whether dark ink and its faint ink clear their floors through the halo over every ground of the moment. */
export function inkHolds(m: Moment, p: Palette): boolean {
	const halo = haloFor(p);
	return sceneGrounds(m, p).every((g) => luminance(mix(g.hex, halo, ALPHA_HALO)) >= LEAST);
}

/** A sample of the day's schedule: ink holds, and it is light enough for ink at all. */
function inkAt(minute: number, doy: number, weather: Weather): boolean {
	// dayNumber only draws the weather, which is given; the moon's phase does not enter the grounds.
	const m = momentFor({minute, doy, dayNumber: doy, epochDays: 0, weather});

	if (stopsAt(m.canonical).dark > TEXT_LIGHT_AT) {
		return false;
	}

	return inkHolds(m, paletteAt(m));
}

/** One day's window per (day of year, weather): at most 366 × 6 ever, one a day in the page. */
const windows = new Map<string, {from: number; to: number}>();

/**
 * The day's ink window [from, to), in local minutes on SCHEDULE_STEP's grid.
 * Ink from the first sample from which it holds through to solar noon (never
 * before it holds), until the first sample from noon on where it fails; a
 * morning that never reaches ink leaves the whole day light (from === to).
 * The words therefore change at most once before noon and once after.
 */
export function inkWindow(doy: number, weather: Weather): {from: number; to: number} {
	const key = `${doy} ${weather}`;
	const hit = windows.get(key);

	if (hit) {
		return hit;
	}

	let from = SOLAR_NOON;

	for (let t = SOLAR_NOON - SCHEDULE_STEP; t >= 0 && inkAt(t, doy, weather); t -= SCHEDULE_STEP) {
		from = t;
	}

	let to = from;

	if (from < SOLAR_NOON) {
		to = SOLAR_NOON;

		while (to < 1440 && inkAt(to, doy, weather)) {
			to += SCHEDULE_STEP;
		}
	}

	const out = {from, to};
	windows.set(key, out);
	return out;
}

/** The words' treatment at one moment: light while it is darker than TEXT_LIGHT_AT, and outside the day's ink window. */
export function treatmentFor(m: Moment, p: Pick<Palette, "dark">): Text {
	if (p.dark > TEXT_LIGHT_AT) {
		return "light";
	}

	const w = inkWindow(m.doy, m.weather);
	return m.minute >= w.from && m.minute < w.to ? "ink" : "light";
}

/** What the chrome reads off `<html>` (spec §3): two states and two colours. */
export interface Published {
	/** The glass panels' palette. */
	light: "day" | "night";
	/** The words over the open scene: dark ink with a halo, or white with a shadow. */
	text: Text;
	/** The daytime text halo: the horizon of the hour, lifted 55 % toward white. */
	halo: string;
	/** The page canvas and the iOS status bar: the sky-top of the hour. */
	canvas: string;
}

export function publishedFor(p: Palette, m: Moment): Published {
	return {
		light: p.dark > GLASS_NIGHT_AT ? "night" : "day",
		text: treatmentFor(m, p),
		halo: haloFor(p),
		canvas: p.skyTop,
	};
}
