/**
 * The ps theme's colours through the day and the year (docs/projects/ps-theme.md
 * §5.2). The mockup's tables, verbatim, and their interpolation. The scene paints
 * with them, and the chrome reads the four values grounds.ts's `publishedFor`
 * gives. Pure: mocha loads it and holds the contrast floors against it (§11).
 */
import {mix, mixOklab, shift} from "./colour";
import type {Moment, Season, Weather} from "./engine";

/** One stop of the canonical day. `t` is its canonical minute. */
export interface Stop {
	t: number;
	top: string;
	mid: string;
	hor: string;
	mount: string;
	far: string;
	hill2: string;
	hill1: string;
	grass: string;
	blade: string;
	felt: string;
	band: string;
	door: string;
	cloud: string;
	under: string;
	glow: string;
	gop: number;
	stars: number;
	milky: number;
	dark: number;
}

const COLOUR_KEYS = [
	"top",
	"mid",
	"hor",
	"mount",
	"far",
	"hill2",
	"hill1",
	"grass",
	"blade",
	"felt",
	"band",
	"door",
	"cloud",
	"under",
	"glow",
] as const;
const LEVEL_KEYS = ["gop", "stars", "milky", "dark"] as const;

/* prettier-ignore */
export const STOPS: readonly Stop[] = [
	{t: 0, top: "#070b1d", mid: "#0f1a3a", hor: "#1e2c55", mount: "#1a2440", far: "#1d2a3f", hill2: "#18253a", hill1: "#152033", grass: "#101b2b", blade: "#0c1624", felt: "#6e7086", band: "#4f4150", door: "#4a3434", cloud: "#28324f", under: "#28324f", glow: "#000000", gop: 0, stars: 1, milky: 0.62, dark: 1},
	{t: 300, top: "#0c1430", mid: "#1f2a55", hor: "#4a4a78", mount: "#2a3152", far: "#2c3550", hill2: "#283248", hill1: "#232c40", grass: "#1b2536", blade: "#162031", felt: "#7c7e92", band: "#5c4652", door: "#5a3b36", cloud: "#353f66", under: "#4b4a78", glow: "#6c5a8c", gop: 0.28, stars: 0.72, milky: 0.3, dark: 0.96},
	{t: 345, top: "#26315f", mid: "#6a5a8e", hor: "#ec9e86", mount: "#5a5378", far: "#6d6582", hill2: "#5f5f78", hill1: "#555a70", grass: "#444e60", blade: "#3a4456", felt: "#b8aeb0", band: "#8e5e5a", door: "#9a4a3a", cloud: "#8a7aa0", under: "#f0a58c", glow: "#ff9f7a", gop: 0.62, stars: 0.22, milky: 0, dark: 0.72},
	{t: 390, top: "#5d80c2", mid: "#f1b590", hor: "#ffd08c", mount: "#8f86a8", far: "#c8b49a", hill2: "#a9b07e", hill1: "#93a86a", grass: "#7f9a55", blade: "#6b8747", felt: "#f3e3cc", band: "#b9674f", door: "#c9582e", cloud: "#fff0de", under: "#ffb08a", glow: "#ffb070", gop: 0.88, stars: 0, milky: 0, dark: 0.28},
	{t: 450, top: "#7fb0e8", mid: "#c6def5", hor: "#ffe6bd", mount: "#9fb0cc", far: "#cfd6a4", hill2: "#a8c77e", hill1: "#93bd6a", grass: "#7fb05a", blade: "#6c9d4a", felt: "#f6ecdd", band: "#b8674e", door: "#cf5a2e", cloud: "#ffffff", under: "#ffe2c2", glow: "#ffd49a", gop: 0.34, stars: 0, milky: 0, dark: 0},
	{t: 600, top: "#4f9be8", mid: "#9ccaf5", hor: "#d8ecfb", mount: "#a9bdd8", far: "#c9dea2", hill2: "#9fcf78", hill1: "#86c262", grass: "#6fb350", blade: "#5c9e40", felt: "#f8f3ea", band: "#b5634b", door: "#cc5a2e", cloud: "#ffffff", under: "#eef4fb", glow: "#ffe8b8", gop: 0, stars: 0, milky: 0, dark: 0},
	{t: 780, top: "#3f8fe6", mid: "#8cc2f4", hor: "#d2e9fb", mount: "#a4b9d6", far: "#c6dc9c", hill2: "#99cc72", hill1: "#80bf5c", grass: "#69b04a", blade: "#579b3b", felt: "#f9f5ee", band: "#b5634b", door: "#cc5a2e", cloud: "#ffffff", under: "#eaf2fb", glow: "#ffe8b8", gop: 0, stars: 0, milky: 0, dark: 0},
	{t: 960, top: "#4c8fdc", mid: "#a0c8ef", hor: "#e8e6d8", mount: "#aab4cc", far: "#d2d69a", hill2: "#a6c56e", hill1: "#8fb85c", grass: "#7aa84c", blade: "#66933e", felt: "#f7efe0", band: "#b5604a", door: "#cc562c", cloud: "#ffffff", under: "#f6ecdc", glow: "#ffd9a0", gop: 0.14, stars: 0, milky: 0, dark: 0},
	{t: 1080, top: "#5a86cc", mid: "#e9c49a", hor: "#ffc478", mount: "#a795a8", far: "#e0c486", hill2: "#c2b862", hill1: "#b0a954", grass: "#9c9a48", blade: "#86843c", felt: "#fbe5c8", band: "#b8583e", door: "#d0522a", cloud: "#fff1dc", under: "#ffb77a", glow: "#ffae5c", gop: 0.62, stars: 0, milky: 0, dark: 0},
	{t: 1140, top: "#3c4f95", mid: "#e8896e", hor: "#ff9a55", mount: "#6f5a80", far: "#b0806a", hill2: "#8f7a58", hill1: "#7c6e50", grass: "#665e44", blade: "#544d38", felt: "#e9c2a8", band: "#9e4a3a", door: "#b34626", cloud: "#f7c0a6", under: "#ff8a5c", glow: "#ff7a45", gop: 0.96, stars: 0.05, milky: 0, dark: 0.24},
	{t: 1185, top: "#1f2a5e", mid: "#6a4a78", hor: "#d8755e", mount: "#3f3a5c", far: "#4f4658", hill2: "#433f52", hill1: "#3a384b", grass: "#2f3142", blade: "#282a3a", felt: "#9d8e9a", band: "#6e4a4a", door: "#6e3a30", cloud: "#6c5a80", under: "#c27060", glow: "#d0604a", gop: 0.56, stars: 0.45, milky: 0.1, dark: 0.7},
	{t: 1260, top: "#0a1128", mid: "#16214a", hor: "#2c3566", mount: "#1f2848", far: "#222d45", hill2: "#1d273d", hill1: "#182236", grass: "#121c2d", blade: "#0f1827", felt: "#707286", band: "#503f4c", door: "#4c3432", cloud: "#2a3456", under: "#2a3456", glow: "#000000", gop: 0, stars: 0.95, milky: 0.5, dark: 1},
	{t: 1440, top: "#070b1d", mid: "#0f1a3a", hor: "#1e2c55", mount: "#1a2440", far: "#1d2a3f", hill2: "#18253a", hill1: "#152033", grass: "#101b2b", blade: "#0c1624", felt: "#6e7086", band: "#4f4150", door: "#4a3434", cloud: "#28324f", under: "#28324f", glow: "#000000", gop: 0, stars: 1, milky: 0.62, dark: 1},
];

/** The land's colours: the season moves these (and only these) away from midsummer green. */
export const LAND = ["far", "hill2", "hill1", "grass", "blade", "mount"] as const;
export type Land = typeof LAND[number];

/** Midsummer noon: what every season is an offset from. */
export const REF: Record<Land, string> = {
	far: "#c6dc9c",
	hill2: "#99cc72",
	hill1: "#80bf5c",
	grass: "#69b04a",
	blade: "#579b3b",
	mount: "#a4b9d6",
};

/* prettier-ignore */
export const SEASON_LAND: Record<Season, Record<Land, string>> = {
	spring: {far: "#cde4a4", hill2: "#a2d67c", hill1: "#86ca62", grass: "#6fbe4e", blade: "#5aa83e", mount: "#a8bfdc"},
	summer: {far: "#d6d894", hill2: "#aec76a", hill1: "#99b85a", grass: "#86aa4a", blade: "#72963e", mount: "#aab8d2"},
	autumn: {far: "#e0c98c", hill2: "#cfae60", hill1: "#c2984c", grass: "#ad8842", blade: "#967036", mount: "#b0b0c8"},
	winter: {far: "#eef2f7", hill2: "#e5ebf3", hill1: "#dde5ef", grass: "#d6dfeb", blade: "#b9c6d6", mount: "#e6ecf6"},
};

/** What each weather does to the scene (the mockup's WX). */
export interface WeatherLook {
	dim: number;
	dimc: string;
	grey: number;
	hide: number;
	rain: number;
	snow: number;
	wind: number;
	sway: number;
	storm: number;
	heat: number;
}

/* prettier-ignore */
export const WEATHER: Record<Weather, WeatherLook> = {
	clear: {dim: 0, dimc: "#5a6478", grey: 0, hide: 0, rain: 0, snow: 0, wind: 0, sway: 2.2, storm: 0, heat: 0},
	rain: {dim: 0.28, dimc: "#4f5a70", grey: 0.62, hide: 0.65, rain: 0.9, snow: 0, wind: 0.3, sway: 3.4, storm: 0, heat: 0},
	storm: {dim: 0.46, dimc: "#2f3648", grey: 0.86, hide: 0.92, rain: 1, snow: 0, wind: 0.6, sway: 5.2, storm: 1, heat: 0},
	wind: {dim: 0, dimc: "#5a6478", grey: 0.1, hide: 0, rain: 0, snow: 0, wind: 1, sway: 6.5, storm: 0, heat: 0},
	snow: {dim: 0.16, dimc: "#b8c2d4", grey: 0.5, hide: 0.55, rain: 0, snow: 0.95, wind: 0.15, sway: 2.2, storm: 0, heat: 0},
	heat: {dim: 0, dimc: "#5a6478", grey: 0, hide: 0, rain: 0, snow: 0, wind: 0, sway: 1.4, storm: 0, heat: 1},
};

/** The words turn light once it is darker than this (spec §7); grounds.ts's white-sooner rule is the other trigger. */
export const TEXT_LIGHT_AT = 0.05;
/** The glass turns to night once it is darker than this (spec §6). */
export const GLASS_NIGHT_AT = 0.5;

/** The stops either side of a canonical minute, mixed linearly. */
export function stopsAt(canon: number): Stop {
	let i = 0;

	while (i < STOPS.length - 2 && canon >= STOPS[i + 1].t) {
		i++;
	}

	const a = STOPS[i];
	const b = STOPS[i + 1];
	const u = Math.min(1, Math.max(0, (canon - a.t) / (b.t - a.t)));
	const out = {t: canon} as Stop;

	for (const k of COLOUR_KEYS) {
		out[k] = mix(a[k], b[k], u);
	}

	for (const k of LEVEL_KEYS) {
		out[k] = a[k] + (b[k] - a[k]) * u;
	}

	return out;
}

/** Everything the scene paints with, at one moment. */
export interface Palette {
	skyTop: string;
	skyMid: string;
	skyHorizon: string;
	mount: string;
	far: string;
	hill2: string;
	hill1: string;
	grass: string;
	blade: string;
	felt: string;
	band: string;
	door: string;
	cloud: string;
	cloudUnder: string;
	glow: string;
	glowOpacity: number;
	stars: number;
	milky: number;
	dark: number;
	/** 0 by day, rising to 1 in full night: the yurt's inner light (plan 3). */
	nightGlow: number;
	smokeOpacity: number;
	smoke: string;
	sunMid: string;
	sunEdge: string;
	sunFlame: string;
	sunBloom: string;
	/** Derived land and yurt colours (plan 3, docs/resources/themes/ps-plains/mockup.html lines 75–122), each ported verbatim from the mockup's `color-mix(in oklab, …)`. */
	mount2: string;
	tree: string;
	trunk: string;
	shrub: string;
	tuft2: string;
	tuft1: string;
	tuftLit: string;
	riverbed: string;
	bedstone: string;
	riverHi: string;
	/** The river's own gradient stops: skyHorizon → skyMid. */
	riverSkyTop: string;
	riverSkyBottom: string;
	feltShade: string;
	roofTop: string;
	roofBottom: string;
	roofStroke: string;
	bandMark: string;
	rope: string;
	rib: string;
	doorOrn: string;
	crown: string;
	pipe: string;
	stone: string;
	wood: string;
}

export function paletteAt(m: Moment): Palette {
	const s = stopsAt(m.canonical);
	const wx = WEATHER[m.weather];
	const day = 1 - s.dark;
	const {from, to, u, weights} = m.season;
	const land = {} as Record<Land, string>;

	// The season, as an offset from midsummer green applied at every hour, strongest by day.
	for (const k of LAND) {
		const target = mix(SEASON_LAND[from][k], SEASON_LAND[to][k], u);
		land[k] = shift(s[k], REF[k], target, 0.35 + 0.65 * day);
	}

	// Snow on the ground goes blue-grey at night.
	if (weights.winter > 0) {
		const k = weights.winter * s.dark * 0.55;

		for (const g of ["far", "hill2", "hill1", "grass"] as const) {
			land[g] = mix(land[g], "#3c4a6a", k);
		}
	}

	const nightGlow = Math.max(0, (s.dark - 0.38) / 0.62);
	const lift = 1 - s.dark;
	const heat = 1 - Math.max(0, m.sun.alt);

	// The land and yurt colours the mockup mixed in CSS (lines 75–122), ported verbatim.
	const mount2 = mixOklab(land.mount, land.far, 0.72);
	const tree = mixOklab(land.hill2, "#1f3a24", 0.55);
	const trunk = mixOklab(land.hill2, "#3a2a1c", 0.4);
	const shrub = mixOklab(land.far, "#28402c", 0.55);
	const tuft2 = mixOklab(land.hill2, land.blade, 0.72);
	const tuft1 = mixOklab(land.hill1, land.blade, 0.7);
	const tuftLit = mixOklab(land.hill1, "#fff6c8", 0.7);
	const riverbed = mixOklab(land.hill1, "#dcc9a0", 0.42);
	const bedstone = mixOklab(land.hill1, "#a99c80", 0.3);
	const riverHi = mixOklab(s.hor, "#ffffff", 0.6);
	const feltShade = mixOklab(s.felt, "#3a3040", 0.8);
	const roofTop = mixOklab(s.felt, "#ffffff", 0.92);
	const roofBottom = mixOklab(s.felt, "#4a3c3c", 0.78);
	const roofStroke = mixOklab(s.felt, "#5a4a3e", 0.55);
	const bandMark = mixOklab(s.band, "#f3e3c6", 0.45);
	const rope = mixOklab(s.felt, "#5a4636", 0.55);
	const rib = mixOklab(s.felt, "#6a5a4a", 0.72);
	const doorOrn = mixOklab(s.door, "#f3c66a", 0.35);
	const crown = mixOklab(s.felt, "#5a4a3e", 0.6);
	const pipe = mixOklab(s.felt, "#4d4640", 0.3);
	const stone = mixOklab(land.grass, "#a8a39a", 0.45);
	const wood = mixOklab(land.hill1, "#7a5638", 0.3);

	return {
		skyTop: s.top,
		skyMid: s.mid,
		skyHorizon: s.hor,
		...land,
		felt: s.felt,
		band: s.band,
		door: s.door,
		cloud: mix(s.cloud, s.dark > 0.5 ? "#262c3c" : "#9aa2b2", wx.grey),
		cloudUnder: mix(s.under, s.dark > 0.5 ? "#1c2130" : "#7c8494", wx.grey),
		glow: s.glow,
		glowOpacity: s.gop * (1 - wx.hide * 0.8),
		stars: s.stars,
		milky: s.milky,
		dark: s.dark,
		nightGlow,
		smokeOpacity: Math.min(1, nightGlow * 1.2),
		smoke: `rgb(${Math.round(150 + 60 * lift)} ${Math.round(155 + 55 * lift)} ${Math.round(
			172 + 40 * lift
		)} / 55%)`,
		sunMid: mix("#ffe07a", "#ff9c3e", heat),
		sunEdge: mix("#ffb23c", "#ff5424", heat),
		sunFlame: mix("#ffcf5a", "#ff6e2c", heat),
		sunBloom: mix("#fff2b8", "#ff9a5a", heat),
		mount2,
		tree,
		trunk,
		shrub,
		tuft2,
		tuft1,
		tuftLit,
		riverbed,
		bedstone,
		riverHi,
		riverSkyTop: s.hor,
		riverSkyBottom: s.mid,
		feltShade,
		roofTop,
		roofBottom,
		roofStroke,
		bandMark,
		rope,
		rib,
		doorOrn,
		crown,
		pipe,
		stone,
		wood,
	};
}

/**
 * Every level the plains draw with, at one moment (plan 3, the mockup's
 * `apply()` lines 1055–1071). `hot`, `windy` and `storm` are booleans the
 * scene turns into classes; nothing here is written to a custom property
 * under those names. The birds' timing and colours are birds.ts's
 * (`birdsAt`, the approved birds mockup's `applyBirds`).
 */
export interface Levels {
	/** The river: dry in high summer, full the rest of the year. */
	water: number;
	flowers: number;
	snowcap: number;
	fireflies: number;
	wind: number;
	/** The grass blades' sway, in degrees. */
	sway: number;
	heat: number;
	hot: boolean;
	windy: boolean;
	storm: boolean;
	/** The weather's dim over the scene, and its colour. */
	veil: number;
	veilColour: string;
	/** How lit the near tufts are: brightest by day. */
	tuftLit: number;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function levelsAt(m: Moment, p: Palette): Levels {
	const wx = WEATHER[m.weather];
	const {spring, summer, autumn, winter} = m.season.weights;
	const dark = p.dark;
	const day = 1 - dark;
	const rainOrSnowOrStorm = wx.rain > 0 || wx.snow > 0 || wx.storm > 0;

	return {
		water: clamp01(1 - 1.35 * summer),
		flowers: Math.min(1, spring + 0.55 * summer),
		snowcap: Math.max(winter > 0.5 ? (winter - 0.4) / 0.6 : 0, m.weather === "snow" ? 0.9 : 0),
		fireflies:
			(summer + 0.45 * spring) *
			clamp01((dark - 0.25) / 0.4) *
			(m.canonical > 1100 || m.canonical < 120 ? 1 : 0.35) *
			(rainOrSnowOrStorm ? 0 : 1),
		wind: wx.wind * (1 - 0.6 * dark) * (autumn + 0.6 * summer + 0.8 * spring),
		sway: wx.sway,
		heat: (wx.heat * Math.max(0, day - 0.7)) / 0.3,
		hot: wx.heat > 0 && dark < 0.1,
		windy: wx.wind > 0.5,
		storm: wx.storm > 0,
		veil: wx.dim,
		veilColour: wx.dimc,
		tuftLit: Math.max(0, 0.5 - 0.45 * dark),
	};
}
