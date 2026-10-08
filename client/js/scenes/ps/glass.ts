/**
 * The luminous day glass (plan 3 task 7b; the user's pick, 2026-09-25, from
 * five measured candidates): by day the glass's backdrop is brightened 1.3
 * before its tint goes over it, and each glass surface takes the lowest tint
 * that keeps every colour the chrome writes on it at its floor over whatever
 * can stand behind that surface at that moment, between TINT_FLOOR and
 * TINT_CAP. The night glass is not touched (its generated 0.74, no
 * brightness), and without the scene the glass keeps the generated
 * --ps-g-tint-a (0.78) with no brightness.
 *
 * Pure and Vue-free, on grounds.ts's one ground list: the scene publishes
 * glassVars' four values on <html> each tick, the legibility model
 * (tools/ps/legibility.ts) and the floors tests read the same tints, so what
 * the page shows and what the tests hold cannot drift apart.
 *
 * **The surfaces**, as the comparison page's model grouped them
 * (tmp/ps-glass/analyse.ts): the header sits over the sky's top, the clouds
 * and the bodies at the top of their arcs; the composer over the near grass
 * (and the door's pool on it); a docked sidebar or user list over every
 * ground but the yurt's, which stands in the message column; a user list laid
 * over a narrow window and the reaction chips over every ground. On the phone
 * layout the always-on glass (the header, the composer, the chips) reads none
 * of these: it has no backdrop filter and keeps the generated --ps-g-tint-a
 * (ps.css's phones section, the measured budget's fallback,
 * docs/projects/ps-theme.md §10). The open drawer and the user list laid over
 * the chat keep their glass there and read the float tint (§10.1, Task 8c).
 *
 * **The model** is the legibility model's (grounds as flat colours, the blur
 * left out) with the backdrop filter added as Chromium applies it:
 * brightness, then saturate, per channel on the sRGB values, clamped after
 * each (checked against headless Chromium's pixels within 1/255 on 49
 * patches, tmp/ps-glass/probe), then the tint mixed over it in sRGB.
 */
import {hexRgb, luminance, rgbHex} from "./colour";
import {momentFor, type Moment} from "./engine";
import {sceneGrounds, type SceneGround} from "./grounds";
import {paletteAt} from "./palette";
import {GRASS_EDGE_LOWEST} from "./plains";

export type GlassSurface = "header" | "composer" | "side" | "float";
export const GLASS_SURFACES: readonly GlassSurface[] = ["header", "composer", "side", "float"];

/** The day glass's tint (ps.css: rgb(255 251 244 / …)). */
export const DAY_TINT = "#fffbf4";

/**
 * The day backdrop filter's two colour stages, in ps.css's order:
 * `blur(0.625rem) brightness(1.3) saturate(1.12)`. The night glass has the
 * saturation alone.
 */
export const DAY_BRIGHTNESS = 1.3;
export const SATURATE = 1.12;

/** The range the day tint is kept in: the page's floor, and the generated --ps-g-tint-a (the fallback) as the cap. */
export const TINT_FLOOR = 0.4;
export const TINT_CAP = 0.78;

/** What the tint is solved to: each floor (text 4.5, marks 3) and the generator's 0.1 of margin. */
export const TEXT_SOLVE = 4.6;
export const MARK_SOLVE = 3.1;

/**
 * The lightest text the chrome writes on the day glass (--ps-g-soft: the
 * rows, the topic, the placeholder, a chip's count) and its lightest mark
 * (--event-join: the connected icon, the subscribed bell, the typing
 * pulse): every other colour on the day glass is darker than its own, so
 * these two bind (test/themes/ps.ts holds every colour in ps.css to it).
 */
export const DAY_GLASS_TEXT = "#4c5970";
export const DAY_GLASS_MARK = "#5a7b2d";

/** The lowest luminance a ground may have under the tint for both to clear their floors. */
const NEED = Math.max(
	TEXT_SOLVE * (luminance(DAY_GLASS_TEXT) + 0.05) - 0.05,
	MARK_SOLVE * (luminance(DAY_GLASS_MARK) + 0.05) - 0.05
);

/** The yurt's areas (grounds.ts): its felt, door, roof, crown, band and their glows, the pool before the door, the smoke. */
const YURT = /^(felt|door|roof|crown|band|pool|smoke)/;

/** Whether a ground can stand behind a surface (the page's model's grouping). */
export function isBehind(surface: GlassSurface, g: SceneGround): boolean {
	switch (surface) {
		case "header":
			return (
				g.area === "skyTop" ||
				g.area.startsWith("cloud") ||
				((g.body === "moon" || g.body === "sun") && !g.below)
			);
		case "composer":
			return g.area === "grass" || g.area === "blade" || g.area === "pool on grass";
		case "side":
			return !YURT.test(g.area);
		case "float":
			return true;
	}
}

/*
 * The solver works on bytes rather than hex strings: the same arithmetic as
 * mix() then luminance() (colour.ts), with the same rounding and a table for
 * the sRGB decoding, and no closures in its loops. It runs once per step in
 * the page, and once per sampled moment in the floors tests.
 */
const unit = (v: number) => Math.min(1, Math.max(0, v));
const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
const DECODED = Array.from({length: 256}, (_, v) => {
	const c = v / 255;
	return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
const TINT_RGB = hexRgb(DAY_TINT);
/** saturate(SATURATE)'s matrix (Filter Effects §9.5), by rows. */
const SAT = [
	[0.213 + 0.787 * SATURATE, 0.715 - 0.715 * SATURATE, 0.072 - 0.072 * SATURATE],
	[0.213 - 0.213 * SATURATE, 0.715 + 0.285 * SATURATE, 0.072 - 0.072 * SATURATE],
	[0.213 - 0.213 * SATURATE, 0.715 - 0.715 * SATURATE, 0.072 + 0.928 * SATURATE],
];

/** A ground's sRGB bytes as the day's backdrop filter draws it: brightness, then saturate, clamped after each. */
function filteredRgb(hex: string): [number, number, number] {
	const r = unit((parseInt(hex.slice(1, 3), 16) / 255) * DAY_BRIGHTNESS);
	const g = unit((parseInt(hex.slice(3, 5), 16) / 255) * DAY_BRIGHTNESS);
	const b = unit((parseInt(hex.slice(5, 7), 16) / 255) * DAY_BRIGHTNESS);
	return [
		byte(unit(SAT[0][0] * r + SAT[0][1] * g + SAT[0][2] * b) * 255),
		byte(unit(SAT[1][0] * r + SAT[1][1] * g + SAT[1][2] * b) * 255),
		byte(unit(SAT[2][0] * r + SAT[2][1] * g + SAT[2][2] * b) * 255),
	];
}

/** A ground as the day's backdrop filter draws it. */
export function backdropFiltered(hex: string): string {
	return rgbHex(...filteredRgb(hex));
}

/** A ground seen through the day glass at tint `alpha`: filtered, then the tint over it, as mix() does. */
export function throughDayGlass(ground: string, alpha: number): string {
	const f = filteredRgb(ground);
	return rgbHex(
		f[0] + (TINT_RGB[0] - f[0]) * alpha,
		f[1] + (TINT_RGB[1] - f[1]) * alpha,
		f[2] + (TINT_RGB[2] - f[2]) * alpha
	);
}

/** The luminance of filtered bytes under the tint at `alpha`: luminance(mix(…, DAY_TINT, alpha)). */
function luminanceUnder(f: readonly number[], alpha: number): number {
	return (
		0.2126 * DECODED[byte(f[0] + (TINT_RGB[0] - f[0]) * alpha)] +
		0.7152 * DECODED[byte(f[1] + (TINT_RGB[1] - f[1]) * alpha)] +
		0.0722 * DECODED[byte(f[2] + (TINT_RGB[2] - f[2]) * alpha)]
	);
}

/** Whether every filtered ground clears NEED under the tint at `hundredths` / 100. */
function clears(filtered: ReadonlyArray<readonly number[]>, hundredths: number): boolean {
	const alpha = hundredths / 100;

	for (const f of filtered) {
		if (luminanceUnder(f, alpha) < NEED) {
			return false;
		}
	}

	return true;
}

/** The lowest tint on a 0.01 grid at which every filtered ground clears NEED, kept within [TINT_FLOOR, TINT_CAP]. */
function solve(filtered: ReadonlyArray<readonly number[]>): number {
	const lo = Math.round(TINT_FLOOR * 100);
	const hi = Math.round(TINT_CAP * 100);

	if (clears(filtered, lo)) {
		return lo / 100;
	}

	if (!clears(filtered, hi)) {
		return hi / 100;
	}

	// clears(lo) is false and clears(hi) true: the lowest that clears lies in (lo, hi].
	let [a, b] = [lo, hi];

	while (b - a > 1) {
		const mid = (a + b) >> 1;
		[a, b] = clears(filtered, mid) ? [a, mid] : [mid, b];
	}

	return b / 100;
}

/** The lowest tint, on a 0.01 grid, at which every ground clears NEED, kept within [TINT_FLOOR, TINT_CAP]. */
export function lowestTint(grounds: readonly string[]): number {
	return solve([...new Set(grounds)].map(filteredRgb));
}

/** Each surface's lowest tint that holds over the grounds given (one moment's, or several moments' together). */
export function tintsOver(grounds: readonly SceneGround[]): Record<GlassSurface, number> {
	const filtered = new Map<string, readonly number[]>();

	for (const g of grounds) {
		if (!filtered.has(g.hex)) {
			filtered.set(g.hex, filteredRgb(g.hex));
		}
	}

	const out = {} as Record<GlassSurface, number>;

	for (const s of GLASS_SURFACES) {
		const behind = new Set(grounds.filter((g) => isBehind(s, g)).map((g) => g.hex));
		out[s] = solve([...behind].map((hex) => filtered.get(hex)!));
	}

	return out;
}

/** Each surface's lowest tint that holds over the grounds of every moment given. */
export function surfaceTints(moments: readonly Moment[]): Record<GlassSurface, number> {
	return tintsOver(moments.flatMap((m) => sceneGrounds(m, paletteAt(m))));
}

/** The step the tints are solved and cached on: they change at most every TINT_STEP minutes. */
export const TINT_STEP = 5;

/** A few steps, for a page that goes back and forth across a boundary; a new day's replace them. */
const cache = new Map<string, Record<GlassSurface, number>>();
const CACHE_SIZE = 4;

/**
 * The day tints for a moment's step: over each minute of it and the next
 * step's first, so a tint also holds through the ease into the next one.
 * The grounds depend on the day of the year, the minute and the weather only.
 */
export function dayTints(
	m: Pick<Moment, "doy" | "minute" | "weather">
): Record<GlassSurface, number> {
	const start = Math.floor(m.minute / TINT_STEP) * TINT_STEP;
	const key = `${m.doy} ${m.weather} ${start}`;
	const hit = cache.get(key);

	if (hit) {
		return hit;
	}

	const minutes = Array.from({length: TINT_STEP + 1}, (_, i) => start + i);
	const out = surfaceTints(
		minutes.map((minute) =>
			momentFor({minute, doy: m.doy, dayNumber: m.doy, epochDays: 0, weather: m.weather})
		)
	);

	if (cache.size >= CACHE_SIZE) {
		cache.delete(cache.keys().next().value as string);
	}

	cache.set(key, out);
	return out;
}

/**
 * Whether the composer's top edge stands above the grass band's edge at its
 * lowest (plains.ts GRASS_EDGE_LOWEST) on the scene's box: a reply bar and a
 * longer draft on a short window, a large font step, or a touch keyboard that
 * lifts it mid-scene (#viewport follows the visible band, the scene the
 * layout viewport). Its own grounds, the near grass, then no longer cover
 * everything behind it — hill1, the yurt, the sky — so the scene marks it
 * (`ps-form-tall`) and ps.css gives it the float tint, which holds over every
 * ground (the controller's rulings, fix rounds 1 and 2). Exactly on the edge
 * is still on the grass.
 */
export function composerAboveGrass(
	form: {top: number},
	scene: {top: number; height: number},
	grassEdge = GRASS_EDGE_LOWEST
): boolean {
	return form.top < scene.top + scene.height * grassEdge;
}

/** The custom properties the scene publishes the tints as, one per surface (ps.css reads them). */
export const GLASS_TINT_VARS: readonly string[] = GLASS_SURFACES.map((s) => `--ps-g-tint-${s}`);

/**
 * What the scene writes on <html> for the glass: by day the four surfaces'
 * tints, which ps.css's glass reads; at night null, to take them off (the
 * night glass keeps its generated tint).
 */
export function glassVars(
	m: Pick<Moment, "doy" | "minute" | "weather">,
	light: "day" | "night"
): Record<string, string | null> {
	const tints = light === "day" ? dayTints(m) : null;
	return Object.fromEntries(
		GLASS_SURFACES.map((s, i) => [GLASS_TINT_VARS[i], tints ? tints[s].toFixed(2) : null])
	);
}
