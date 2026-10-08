/**
 * The ps theme's model of time (docs/projects/ps-theme.md §4). From a Date to
 * where the canonical day stands, which season and weather it is, and where the
 * sun and the moon are, with the moon's true phase. Pure arithmetic: no DOM, no
 * Vue, no store, so mocha loads it, and the palette (palette.ts) and the scene
 * (scene.ts) read one answer. Ported from the approved mockup
 * (docs/resources/themes/ps-plains/mockup.html), whose numbers it keeps.
 */

export type Season = "winter" | "spring" | "summer" | "autumn";
export type Weather = "clear" | "rain" | "storm" | "wind" | "snow" | "heat";

export const SEASONS: readonly Season[] = ["winter", "spring", "summer", "autumn"];
export const WEATHERS: readonly Weather[] = ["clear", "rain", "storm", "wind", "snow", "heat"];

/** Assumed latitude, degrees north: the theme does not know where the viewer is (spec §0). */
export const LATITUDE = 45;
/** Solar noon in local minutes: 12:30, allowing for daylight saving on average. */
export const SOLAR_NOON = 750;
/** The day every palette stop was tuned for: sunrise at 06:30, sunset at 19:15. */
export const CANON_RISE = 390;
export const CANON_SET = 1155;
/** Twilight before sunrise and after sunset, in minutes, kept at its true length. */
export const DAWN = 90;
export const DUSK = 105;
/** The arc the sun and the moon ride, as % of the scene's height from its top. */
export const HORIZON = 58;
export const PEAK = 10;
/** Within this many degrees of new there is no moon at all (spec §4). */
export const NEW_MOON_WINDOW = 9;

const RAD = Math.PI / 180;
const DAY_MS = 86400000;
const NIGHT_START = CANON_SET + DUSK; // 21:00 on the canonical day
const NIGHT_END = CANON_RISE - DAWN + 1440; // 05:00 the next canonical day

/** A seeded generator (mulberry32): the same seed gives the same sequence on every device. */
export function rng(seed: number): () => number {
	let a = seed >>> 0;

	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** The local calendar date as whole days since 1970-01-01: one weather per local day. */
export function localDayNumber(date: Date): number {
	return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS;
}

/** Day of the year of the local calendar date, 1 on 1 January. */
export function dayOfYear(date: Date): number {
	const year = date.getFullYear();
	return (Date.UTC(year, date.getMonth(), date.getDate()) - Date.UTC(year, 0, 0)) / DAY_MS;
}

/** Local minutes since midnight, the seconds as a fraction. */
export function minuteOfDay(date: Date): number {
	return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
}

/** Sunrise and sunset in local minutes at LATITUDE, on a day of the year. */
export function sunTimes(doy: number): {rise: number; set: number} {
	const decl = -23.44 * Math.cos((2 * Math.PI * (doy + 10)) / 365) * RAD;
	const cosH = -Math.tan(LATITUDE * RAD) * Math.tan(decl);
	const hourAngle = Math.acos(Math.max(-1, Math.min(1, cosH))) / RAD;
	const half = (hourAngle / 15) * 60;
	return {rise: SOLAR_NOON - half, set: SOLAR_NOON + half};
}

/**
 * Where a local minute falls on the canonical day. Dawn and dusk keep their true
 * lengths either side of the real sunrise and sunset, the day between stretches
 * to fit, and the night takes the rest, so the palette's stops stay pinned to
 * the real sunrise and sunset in every season.
 */
export function canonical(minute: number, rise: number, set: number): number {
	if (minute >= rise - DAWN && minute < rise) {
		return CANON_RISE - (rise - minute);
	}

	if (minute >= rise && minute <= set) {
		return CANON_RISE + ((minute - rise) / (set - rise)) * (CANON_SET - CANON_RISE);
	}

	if (minute > set && minute <= set + DUSK) {
		return CANON_SET + (minute - set);
	}

	const start = set + DUSK;
	const span = rise - DAWN + 1440 - start;
	const pos = ((minute - start + 1440) % 1440) / span;
	return (NIGHT_START + pos * (NIGHT_END - NIGHT_START)) % 1440;
}

export interface SeasonState {
	/** How much of each season it is; the four sum to 1. */
	weights: Record<Season, number>;
	/** The two seasons being blended, and how far from the first to the second (0–1). */
	from: Season;
	to: Season;
	u: number;
	/** The calendar season, by the solstices and equinoxes: what the weather is drawn from. */
	main: Season;
}

/** Each season in full at a cross-quarter day: 1 Feb, 1 May, 1 Aug, 1 Nov. */
const ANCHORS: ReadonlyArray<{doy: number; season: Season}> = [
	{doy: 32, season: "winter"},
	{doy: 121, season: "spring"},
	{doy: 213, season: "summer"},
	{doy: 305, season: "autumn"},
];

export function seasonOf(doy: number): SeasonState {
	let i = ANCHORS.length - 1;

	for (let j = 0; j < ANCHORS.length; j++) {
		if (doy >= ANCHORS[j].doy) {
			i = j;
		}
	}

	const a = ANCHORS[i];
	const b = ANCHORS[(i + 1) % ANCHORS.length];
	const span = (b.doy - a.doy + 365) % 365;
	const u = ((doy - a.doy + 365) % 365) / span;
	const weights: Record<Season, number> = {winter: 0, spring: 0, summer: 0, autumn: 0};
	weights[a.season] += 1 - u;
	weights[b.season] += u;
	const main: Season =
		doy < 79 || doy >= 355 ? "winter" : doy < 172 ? "spring" : doy < 265 ? "summer" : "autumn";
	return {weights, from: a.season, to: b.season, u, main};
}

/** The chance of each weather by season; whatever is left over is clear. */
export const WEATHER_ODDS: Record<Season, ReadonlyArray<readonly [Weather, number]>> = {
	spring: [
		["rain", 0.3],
		["wind", 0.12],
	],
	summer: [
		["heat", 0.45],
		["storm", 0.12],
	],
	autumn: [
		["wind", 0.38],
		["rain", 0.2],
	],
	winter: [
		["snow", 0.42],
		["wind", 0.12],
	],
};

/** The day's weather, drawn once per local calendar day from its number and the season's odds. */
export function weatherFor(dayNumber: number, season: Season): Weather {
	let x = rng(dayNumber * 7919 + 17)();

	for (const [weather, chance] of WEATHER_ODDS[season]) {
		if (x < chance) {
			return weather;
		}

		x -= chance;
	}

	return "clear";
}

/** A body on its arc: x and y as % of the scene box, altitude 0–1, and whether it is up. */
export interface Arc {
	x: number;
	y: number;
	alt: number;
	up: boolean;
}

export function sunAt(minute: number, rise: number, set: number): Arc {
	const u = (minute - rise) / (set - rise);
	const alt = Math.sin(Math.PI * Math.min(1.08, Math.max(-0.08, u)));
	return {x: 5 + 90 * u, y: HORIZON - alt * (HORIZON - PEAK), alt, up: u > -0.06 && u < 1.06};
}

/** The moon rides the same arc through the night, from a quarter-hour after sunset to sunrise. */
export function moonAt(minute: number, rise: number, set: number): Arc {
	const start = set + 15;
	const span = 1440 - start + rise;
	const u = ((minute - start + 1440) % 1440) / span;
	const alt = Math.sin(Math.PI * Math.min(1.06, Math.max(-0.06, u)));
	return {x: 5 + 90 * u, y: HORIZON - alt * (HORIZON - PEAK - 4), alt, up: u <= 1.04};
}

/**
 * The moon's elongation in degrees (0 new, 180 full): its ecliptic longitude
 * minus the sun's, with the six largest periodic terms. Accurate to minutes;
 * the mean synodic month drifts by up to a day (docs/projects/heart-theme.md §11.2b).
 */
export function elongation(epochDays: number): number {
	const T = (epochDays - 10957.5) / 36525;
	const Ms = (357.5291 + 35999.0503 * T) * RAD;
	const Ls = 280.4665 + 36000.7698 * T + 1.9146 * Math.sin(Ms) + 0.02 * Math.sin(2 * Ms);
	const Lm = 218.3165 + 481267.8813 * T;
	const Mm = (134.9634 + 477198.8676 * T) * RAD;
	const D = (297.8502 + 445267.1115 * T) * RAD;
	const F = (93.2721 + 483202.0175 * T) * RAD;
	const dL =
		6.2886 * Math.sin(Mm) +
		1.274 * Math.sin(2 * D - Mm) +
		0.6583 * Math.sin(2 * D) +
		0.2136 * Math.sin(2 * Mm) -
		0.1851 * Math.sin(Ms) -
		0.1143 * Math.sin(2 * F);
	return (((Lm + dL - Ls) % 360) + 360) % 360;
}

export interface MoonPhase {
	elongation: number;
	/** Lit fraction of the disc, 0–1. */
	illumination: number;
	waning: boolean;
	/** False within NEW_MOON_WINDOW of new: a new moon is no moon. */
	present: boolean;
}

export function moonPhase(epochDays: number): MoonPhase {
	const e = elongation(epochDays);
	return {
		elongation: e,
		illumination: (1 - Math.cos(e * RAD)) / 2,
		waning: e > 180,
		present: e >= NEW_MOON_WINDOW && e <= 360 - NEW_MOON_WINDOW,
	};
}

export interface Moment {
	/** Local minutes since midnight. */
	minute: number;
	doy: number;
	dayNumber: number;
	sunrise: number;
	sunset: number;
	canonical: number;
	season: SeasonState;
	weather: Weather;
	sun: Arc;
	moon: Arc;
	phase: MoonPhase;
}

export interface MomentInput {
	minute: number;
	doy: number;
	dayNumber: number;
	/** Days since the Unix epoch (UTC), for the moon. */
	epochDays: number;
	/** Force a weather instead of the day's own. */
	weather?: Weather;
}

export function momentFor(input: MomentInput): Moment {
	const {rise, set} = sunTimes(input.doy);
	const season = seasonOf(input.doy);
	return {
		minute: input.minute,
		doy: input.doy,
		dayNumber: input.dayNumber,
		sunrise: rise,
		sunset: set,
		canonical: canonical(input.minute, rise, set),
		season,
		weather: input.weather ?? weatherFor(input.dayNumber, season.main),
		sun: sunAt(input.minute, rise, set),
		moon: moonAt(input.minute, rise, set),
		phase: moonPhase(input.epochDays),
	};
}

export function momentAt(date: Date, weather?: Weather): Moment {
	return momentFor({
		minute: minuteOfDay(date),
		doy: dayOfYear(date),
		dayNumber: localDayNumber(date),
		epochDays: date.getTime() / DAY_MS,
		weather,
	});
}
