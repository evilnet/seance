/**
 * The legibility model for words over the plains (docs/projects/ps-theme.md
 * §6, §7, §11), shared by the floors test (test/scenes/ps/legibility.ts) and
 * the palette generator (tools/ps/palette-blocks.ts).
 *
 * **The grounds (plan 3's rulings).** Everything the scene paints under the
 * words, as client/js/scenes/ps/grounds.ts lists it — the sky, the moon's disc
 * and the sun's core (the sun only above the horizon line), and the plains'
 * areas (the land, the river, the yurt and its glows, the door's pool, the
 * clouds, the smoke), each under the veil on a veiled day. The page decides
 * the words' treatment from the same list (the user's white sooner), so the
 * column's ink grounds are exactly the moments where the page uses ink.
 *
 * **The surfaces.** A word sits on one of two:
 * - `column`: the message column, straight on the scene, through its
 *   treatment's own layer (the halo by day; the shadow and outline while the
 *   light treatment, all day but where dark ink holds) at the strength
 *   measured in rendered pixels,
 *   ALPHA_HALO or ALPHA_SHADOW;
 * - `glass`: the chrome, the glass tint (GLASS) composited over the scene,
 *   with no layer under the text. The backdrop blur is left out: it only
 *   averages neighbouring grounds, so leaving it out is conservative. At the
 *   declared tint (glassGround) this is the night glass, and the day glass
 *   without the scene; with the scene by day, the luminous glass
 *   (dayGlassGrounds): each surface's own tint over a backdrop brightened as
 *   Chromium draws it (client/js/scenes/ps/glass.ts).
 *
 * **What is sampled.** Moments, not a continuum: SAMPLING lists the days, the
 * minute step and the weathers of the two sweeps (eachChecked). A floor this
 * model holds is held at those samples; nothing here measures between them.
 */
import {fontSizes, type FontSize} from "../../client/js/helpers/fontSize";
import {contrast, luminance, mix} from "../../client/js/scenes/ps/colour";
import {momentFor, WEATHERS, type Moment, type Weather} from "../../client/js/scenes/ps/engine";
import {
	CHROME_SURFACES,
	isBehind,
	throughCard,
	throughDayGlass,
	tintsOver,
	type GlassSurface,
} from "../../client/js/scenes/ps/glass";
import {
	ALPHA_HALO,
	INK,
	publishedFor,
	rimFor,
	sceneGrounds as paintedGrounds,
	SCHEDULE_STEP,
} from "../../client/js/scenes/ps/grounds";
import {GLASS_NIGHT_AT, paletteAt, stopsAt, type Palette} from "../../client/js/scenes/ps/palette";

/** The halo's strength and the day's ink live with the page's rule (grounds.ts); their record is kept here. */
export {ALPHA_HALO, INK};

/**
 * How far each treatment moves the ground right around a word toward its own
 * colour, measured once in rendered pixels and used as min(0.6, measured), so
 * the measurement could only make the check stricter (docs/projects/ps-theme.md
 * §11):
 *
 *   node tools/browser-drive.mjs tools/ps/calibrate.mjs --chrome=… --out=<dir>
 *
 * against a production build. Headless Chromium drew swatches of 360 × 48 CSS
 * px at the default font-size step (html 20px), in the treatments computed off
 * a real message: the words' face at 500 ("The quick brown fox 0123") and the
 * names' at 700 ("Marigold Ősz"), both at 20px — Mulish and Fraunces until
 * plan 4, Source Sans 3 and Newsreader since — at device scale factor 1, 2
 * and 3. White with the
 * shadow was drawn over #ffb96f, #fdfaf0, #fffef6, #eef2f7, #9ccaf5 and
 * #69b04a; #1b2638 with the halo (#ebf5fd) over #9ccaf5, #69b04a and #ffc478
 * (over #eef2f7 the halo is too close to the ground to measure). The ring is
 * the pixels one CSS px out from the glyphs. At each ring pixel the strength
 * is the projection of its colour onto ground → treatment colour. Each swatch
 * gives the 10th percentile over its ring, and the lowest swatch counts.
 *
 * **2026-09-24, first pass (DPR 1 and 2 only, the shadow alone):**
 * halo 0.2175 (Mulish, DPR 1, over #ffc478), median 0.39; shadow 0.1099
 * (Mulish, DPR 2, over #fffef6), median 0.25. That shadow could not carry
 * white text over the brightest grounds (the moon's disc, the sun's low core,
 * a bright dawn/dusk horizon); shown three measured candidates, the user
 * chose "B" (https://claude.ai/artifact/TGGrXDMs2fxLrV9NekKMWJ): an eight-way
 * 1px outline at 78% black, drawn under the soft shadow (client/themes/ps.css,
 * the light treatment).
 *
 * **2026-09-24, second pass (DPR 1, 2 and 3, the shadow plus outline B):**
 * halo 0.2120 (Mulish, DPR 3, over #ffc478), median 0.40 — DPR 3 found a new,
 * slightly lower minimum for the halo too (the ink treatment did not change;
 * only the swept DPR range did); shadow 0.5457 (Mulish, DPR 1, over #fffef6),
 * median 0.87 — the outline more than quadruples the shadow's floor. Both
 * are written rounded down.
 *
 * **2026-09-25, third pass (real chat phrases, the controller's ruling).**
 * The sample sentence has no thin marks and overstated both treatments: α is
 * now the lowest over the phrases "it,", "ok", "yes", "tea's ready", "wind's
 * dropped" and "good night, plains", each in Mulish 500 and Fraunces 700,
 * DPR 1–3, over every ground (calibrate.mjs PHRASES; the samples are still
 * drawn, as the pipeline's control). Measured on today's B alone, the light
 * treatment read 0.4000 (Fraunces "it,", DPR 1, over a white daytime cloud
 * #ffffff), and white would have read 2.85:1 there. **The user took the
 * recommendation** (2026-09-25, "I take your recommendation on the rim under
 * white words"): a faint second ring under B, eight 2px offsets at 28% black
 * (client/themes/ps.css). With it: **the shadow 0.5882** (Fraunces "it,", DPR
 * 1, over #ffffff; the samples alone 0.7046). The halo on the same phrases
 * reads 0.1559 (Mulish "it,", DPR 3, over #ffc478; the samples alone 0.2119):
 * at that strength dark ink holds over the yurt's band and door at no hour
 * of any clear day. **The user chose "A"** (2026-09-25): record it, and let
 * the words be white all day wherever dark ink does not hold, which by this
 * measure is every day but a snowy one.
 *
 * **2026-09-26, fourth pass (the user's new faces, plan 4).** The same
 * phrases, grounds and DPRs, with the words in Source Sans 3 500 and the nick
 * in Newsreader 700 (the user's pick, "M1, N2"). Both treatments read
 * stronger than on Mulish and Fraunces: **the shadow 0.6039** (Newsreader
 * "ok", DPR 1, over the white daytime cloud #ffffff; it was 0.5882 on
 * Fraunces "it,"; the samples alone 0.7433), recorded at the model's cap,
 * 0.6; **the halo 0.1614** (0.16149, Source Sans 3 "it,", DPR 3, over
 * #ffc478 again; it was 0.1559; the samples alone 0.2225). The halo's rise
 * changes no day's treatment: dark ink still holds on snowy days alone, from
 * before 08:50 to after 15:45 on every one (it was 15:40). ALPHA_HALO =
 * min(0.6, 0.1614) lives in client/js/scenes/ps/grounds.ts, beside the rule
 * that runs on it.
 */
export const ALPHA_SHADOW = Math.min(0.6, 0.6039);
export const INK_FAINT = "#4c5a72";

/**
 * The other two shadow treatments of the Words over the plains setting
 * (docs/projects/ps-words.md §5), measured by the same twin method on
 * 2026-10-21 (tools/ps/calibrate.mjs, 9546 checks; the outline's two figures
 * reproduced as the control, 0.639 → 0.6 capped and 0.1614 exact):
 * - **the tinted rim** (one 1 px ring at 60 % in the hour's rim colour,
 *   --ps-rim, under the soft shadow in the same tint): 0.4164 toward the
 *   rim's colour, Source Sans 3 "it," at DPR 1 over the dusk amber #ffb96f;
 *   its ink is the outline's halo (ALPHA_HALO);
 * - **the soft glow** (four blurred black layers, no ring): 0.1372 toward
 *   black, "it," at DPR 3 over the white cloud; its ink aura (four layers
 *   of the halo's colour) 0.1503 toward the halo, "it," at DPR 1 over the
 *   sky #9ccaf5.
 * Neither re-solves a colour: the message palette is the outline's, and the
 * floors test holds every light colour wherever white holds 4.5 : 1 through
 * the treatment and pins the worst figure over the rest (the user's choice
 * of a softer look over a stricter floor).
 */
export const ALPHA_RIM = Math.min(0.6, 0.4164);
export const ALPHA_GLOW = Math.min(0.6, 0.1372);
export const ALPHA_GLOW_HALO = Math.min(0.6, 0.1503);

export type Surface = "column" | "glass";
/** The message column's treatment (data-ps-text). */
export type Text = "ink" | "light";
/** The glass's palette (data-ps-light). */
export type Light = "day" | "night";

/**
 * The glass (spec §6): its tint, the spec's opacity and the most the
 * generator may raise it to (Global Constraints, pre-ruled fix 1), the
 * spec-fixed colours drawn on it, and its solid surface (the opaque panels,
 * which draw the same colours).
 */
export const GLASS = {
	day: {
		tint: "#fffbf4",
		base: 0.62,
		cap: 0.78,
		ink: "#1f2a3d",
		soft: "#55627a",
		accent: "#c2562b",
		solid: "#fbf8f2",
	},
	night: {
		tint: "#0c1120",
		base: 0.58,
		cap: 0.74,
		ink: "#e9eef7",
		soft: "#a7b3c8",
		accent: "#d9784a",
		solid: "#121827",
	},
} as const;

/**
 * The surface family of the Words over the plains setting
 * (docs/projects/ps-words.md §4, §5: bubbles, glass, scrim): the words are
 * plain on a tint between them and the plains. The card's and the scrim's
 * tint is flat (no backdrop filter); the glass column's is the chrome's
 * float tint through the lift. The surface palette is solved at the
 * declared tints (the mock-up's 0.66 by day; 0.62 at night, raised toward
 * the cap only when a spec colour cannot hold within rule 2), over every
 * ground; the page then solves the day card tint per step at or under the
 * declared one (client/js/scenes/ps/glass.ts, the card surface).
 */
export const SURFACE = {
	day: {tint: GLASS.day.tint, base: 0.66, cap: 0.78, ink: GLASS.day.ink},
	night: {tint: GLASS.night.tint, base: 0.62, cap: 0.74, ink: GLASS.night.ink},
} as const;

/** The surface family's scope on <html>: no attribute (the default), or one of the three. */
export const WORDS_SURFACE =
	':is(:not([data-ps-words]), [data-ps-words="bubbles"], [data-ps-words="glass"], [data-ps-words="scrim"])';

/** The shadow family's scope on <html>: outline, rim and glow, the words carrying a text-shadow and keyed on the ink window. */
export const SHADOW_WORDS_ROOT =
	':root:is([data-ps-words="outline"], [data-ps-words="rim"], [data-ps-words="glow"])';

/** The surface block's day rule, and every surface nick rule's prefix by day. */
export const SURFACE_ROOT = `:root${WORDS_SURFACE} #chat .chat`;

/** The surface block's night rule, and every surface nick rule's prefix at night. */
export const SURFACE_NIGHT_ROOT = `:root[data-ps-light="night"]${WORDS_SURFACE} #chat .chat`;

/** A ground under a surface's flat tint at `alpha`. */
export function surfaceGround(ground: string, light: Light, alpha: number): string {
	return mix(ground, SURFACE[light].tint, alpha);
}

/**
 * A mention row's wash under the surface family (ps.css: `rgb(255 214 230 / …)`
 * by day, `rgb(40 20 48 / …)` at night, at the card's tint): the card's
 * second tint, darker than the paper by day, which the palette is solved
 * under and the page's card solve holds as well (glass.ts DAY_WASH).
 */
export const SURFACE_WASH: Record<Light, string> = {day: "#ffd6e6", night: "#281430"};

/** A ground under a mention's wash at `alpha`. */
export function surfaceWash(ground: string, light: Light, alpha: number): string {
	return mix(ground, SURFACE_WASH[light], alpha);
}

/**
 * What coloured text in the light treatment (every generated colour there:
 * nicks, the semantic colours, the code tokens) is held to over the moon's
 * disc and the sun's core. White and faint white are held over every ground
 * whatever this says. The three settings:
 * - `strict`: all of it solved to 4.6 and held at 4.5 over the sky and the
 *   bodies;
 * - `sky`: solved and held over the sky and the plains, not the bodies;
 * - `names-large`: the 32 nick colours solved to 3.1 and held at 3 over the
 *   sky and the bodies (bold Newsreader 700 at the large step is WCAG large
 *   text; at the medium step, 16px, it is not), everything else strict.
 * The generator and the floors test both read it.
 *
 * **The user chose `names-large`** (2026-09-24: "names-large is easiest to read").
 * **Its guard:** below the `large` font-size step the names are not large text, so there they take the `sky` set (smallStepSweep).
 */
export type LightSweep = "strict" | "sky" | "names-large";
export const LIGHT_SWEEP: LightSweep = "names-large";

/**
 * The font-size steps (client/js/helpers/fontSize.ts) where bold Newsreader
 * 700 nicks are WCAG large text: `large` sets them at 20px, 15pt bold, over
 * the 14pt bold line. Every step below it (tiny, small, medium — the
 * default), and an <html> that carries no step yet (the root at 100 %,
 * medium's size), sets them smaller. A matter of size, not of which step is
 * the default.
 */
export const LARGE_TEXT_STEPS: readonly FontSize[] = fontSizes.slice(fontSizes.indexOf("large"));

/** The set light nicks take where they are not large text, or null when the sweep does not lean on large text. */
export function smallStepSweep(sweep: LightSweep): LightSweep | null {
	return sweep === "names-large" ? "sky" : null;
}

/**
 * Where the small-step light nicks are written: the light treatment on an
 * <html> at no large-text step. The step test sits in :where(), which weighs
 * nothing, so these rules are exactly as specific as the light nick rules and
 * win by coming after them, while ps.css's action and notice nick rules,
 * after the block, still win over both.
 */
export const SMALL_STEPS_ROOT = `:root:where(:not(${LARGE_TEXT_STEPS.map(
	(step) => `[data-font-size="${step}"]`
).join(", ")}))[data-ps-text="light"] #chat .chat`;

/** The message column under the light treatment: the generated block's second rule, and every light nick rule's prefix. */
export const LIGHT_ROOT = ':root[data-ps-text="light"] #chat .chat';

/**
 * The message column's code boxes (code, pre, the monospace block, inline
 * monospace), which paint their own opaque surface, --ps-code-bg, rather than
 * the plains: by day :root's paper (#f4f9ff, what the box painted through
 * --composer-bg until now), in the light treatment (all day but where dark
 * ink holds, in practice snowy days) the night
 * glass's solid surface (spec §6). The --tok-* colours and --md-code-color
 * are held against this box, not the sky.
 */
export const CODE_BOX: Record<Text, string> = {ink: "#f4f9ff", light: "#121827"};

export interface SweepFloor {
	/** What the floors test holds. */
	floor: number;
	/** What the generator solves to: the floor and 0.1 of margin for rounding. */
	solveTo: number;
	/** Whether the moon's disc and the sun's core are among the grounds. */
	bodies: boolean;
}

export function lightSweepFloors(sweep: LightSweep): {nicks: SweepFloor; colours: SweepFloor} {
	const text = {floor: 4.5, solveTo: 4.6, bodies: sweep !== "sky"};
	return {
		nicks: sweep === "names-large" ? {floor: 3, solveTo: 3.1, bodies: true} : text,
		colours: text,
	};
}

/** The days checked: each season's anchor, the solstices and equinoxes, and 1 January. */
export const DOYS = [1, 32, 79, 121, 172, 213, 265, 305, 355];

export type Days = "sparse" | "dense";

/**
 * The two sweeps, both over all six weathers. `sparse` is mocha's: every 7th
 * day from day 1 plus DOYS, every 10 minutes. `dense` is the generator's:
 * every day of a 365-day year, every SCHEDULE_STEP (5) minutes — the grid the
 * page decides the words' treatment on, so every dense sample is a decision
 * point.
 */
export const SAMPLING: Record<Days, {days: number[]; step: number}> = {
	sparse: {
		days: [...new Set([...Array.from({length: 53}, (_, i) => 1 + 7 * i), ...DOYS])].sort(
			(a, b) => a - b
		),
		step: 10,
	},
	dense: {days: Array.from({length: 365}, (_, i) => i + 1), step: SCHEDULE_STEP},
};

/** One sampled moment. The moon's phase does not matter here (bodyGrounds), so epochDays is fixed. */
export function momentOf(doy: number, minute: number, weather: Weather): Moment {
	return momentFor({minute, doy, dayNumber: doy, epochDays: 20000, weather});
}

export type Body = "sky" | "land" | "moon" | "sun";

export interface Ground {
	hex: string;
	/** What paints it (grounds.ts's area, then the colour), for the headers and failure messages. */
	name: string;
	body: Body;
	/** The moon's disc counted while under the horizon line (the sun is not counted there: the land hides it). */
	below: boolean;
}

/** Whether a ground is one of the two bodies, the moon's disc or the sun's core (the small, bright ones the light sweep may leave out). */
export const isBody = (g: {body: Body}) => g.body === "moon" || g.body === "sun";

/** Everything the scene paints at one moment (client/js/scenes/ps/grounds.ts), named for the headers. */
export function sceneGrounds(m: Moment, p: Palette): Ground[] {
	return paintedGrounds(m, p).map((g) => ({
		hex: g.hex,
		name: g.name,
		body: g.body,
		below: g.below,
	}));
}

/** The sky's three bands at one moment. */
export function skyGrounds(m: Moment, p: Palette): Ground[] {
	return sceneGrounds(m, p).filter((g) => g.body === "sky");
}

/** The moon's disc (whatever its phase) and the sun's core (only above the horizon line), at the opacity the scene draws them. */
export function bodyGrounds(m: Moment, p: Palette): Ground[] {
	return sceneGrounds(m, p).filter(isBody);
}

export function effectiveGround(ground: string, text: Text, halo: string): string {
	return text === "ink" ? mix(ground, halo, ALPHA_HALO) : mix(ground, "#000000", ALPHA_SHADOW);
}

export function glassGround(ground: string, light: Light, alpha: number): string {
	return mix(ground, GLASS[light].tint, alpha);
}

/** Whether white holds 4.5 : 1 over an effective ground: the line between held and pinned for the rim and the glow. */
export function whiteHolds(hex: string): boolean {
	return contrast("#ffffff", hex) >= 4.5;
}

/**
 * Every ground a surface meets at one moment, composited: through the
 * treatment in force for the column, under the glass at `alpha` (the spec's
 * opacity when left out) for the glass.
 */
export function surfaceGrounds(
	surface: "column",
	m: Moment,
	p: Palette
): {state: Text; grounds: Ground[]};
export function surfaceGrounds(
	surface: "glass",
	m: Moment,
	p: Palette,
	alpha?: number
): {state: Light; grounds: Ground[]};

export function surfaceGrounds(
	surface: Surface,
	m: Moment,
	p: Palette,
	alpha?: number
): {state: Text | Light; grounds: Ground[]} {
	return onSurface(surface, sceneGrounds(m, p), m, p, alpha);
}

/** The one path from the scene's grounds to a surface's, which surfaceGrounds and groundsAt share. */
function onSurface(
	surface: Surface,
	scene: Ground[],
	m: Moment,
	p: Palette,
	alpha?: number
): {state: Text | Light; grounds: Ground[]} {
	return surface === "column" ? throughTreatment(scene, m, p) : underTint(scene, m, p, alpha);
}

function throughTreatment(
	scene: Ground[],
	m: Moment,
	p: Palette
): {state: Text; grounds: Ground[]} {
	const {text, halo} = publishedFor(p, m);
	return {
		state: text,
		grounds: scene.map((g) => ({...g, hex: effectiveGround(g.hex, text, halo)})),
	};
}

function underTint(
	scene: Ground[],
	m: Moment,
	p: Palette,
	alpha?: number
): {state: Light; grounds: Ground[]} {
	const {light} = publishedFor(p, m);
	const a = alpha ?? GLASS[light].base;
	return {state: light, grounds: scene.map((g) => ({...g, hex: glassGround(g.hex, light, a)}))};
}

/**
 * Visit every sampled moment of a sweep (SAMPLING[days]: its days, every
 * `step` minutes, all six weathers), with its palette and a `doy D M min W`
 * label the headers pin by. The grounds a moment holds are groundsAt's: the
 * scene's (sceneGrounds), through the column's treatment and, untinted, for
 * the glass.
 */
export function eachChecked(
	visit: (m: Moment, p: Palette, where: string) => void,
	days: Days
): void {
	const {days: list, step} = SAMPLING[days];

	for (const doy of list) {
		for (let minute = 0; minute < 1440; minute += step) {
			for (const weather of WEATHERS) {
				const m = momentOf(doy, minute, weather);
				visit(m, paletteAt(m), `doy ${doy} ${minute} min ${weather}`);
			}
		}
	}
}

export interface CheckedGround extends Ground {
	lum: number;
	/** The moment, as `doy D M min W`. */
	where: string;
}

export interface Checked {
	/** Effective grounds, through the treatment in force. */
	column: Record<Text, CheckedGround[]>;
	/** Scene grounds before the tint, which the generator solves the opacity of and the test reads from ps.css. */
	glass: Record<Light, CheckedGround[]>;
}

/**
 * One moment's grounds for both surfaces, by surfaceGrounds' own path (the
 * scene's grounds computed once): the column's through its treatment, the
 * glass's under the tint at opacity 0, i.e. the scene's own colours, which the
 * generator and the floors test tint at the opacity they solve or read.
 */
export function groundsAt(m: Moment, p: Palette, where: string): Checked {
	const scene = sceneGrounds(m, p);
	const column = onSurface("column", scene, m, p);
	const glass = onSurface("glass", scene, m, p, 0);
	const out: Checked = {column: {ink: [], light: []}, glass: {day: [], night: []}};
	const checked = (g: Ground) => ({...g, lum: luminance(g.hex), where});
	out.column[column.state as Text] = column.grounds.map(checked);
	out.glass[glass.state as Light] = glass.grounds.map(checked);
	return out;
}

const PIN = /doy (\d+) (\d+) min ([a-z]+)/g;

/**
 * The moments `text` names as `doy D M min W`, each once: fed the generated
 * blocks' headers, their worst grounds and the Review Focus pins, which the
 * dense sweep found and the sparse one may step over.
 */
export function pinnedMoments(text: string): string[] {
	return [...new Set([...text.matchAll(PIN)].map((m) => m[0]))];
}

/** The moment a `doy D M min W` label names. */
export function momentAt(where: string): Moment {
	const [, doy, minute, weather] = new RegExp(PIN.source).exec(where) ?? [];

	if (!(WEATHERS as readonly string[]).includes(weather)) {
		throw new Error(`a header pins an unknown weather: ${where}`);
	}

	return momentOf(Number(doy), Number(minute), weather as Weather);
}

/** `checked`'s grounds and every moment `text` pins (pinnedMoments), in a new set. */
export function withPinned(checked: Checked, text: string): Checked {
	const out: Checked = {
		column: {ink: [...checked.column.ink], light: [...checked.column.light]},
		glass: {day: [...checked.glass.day], night: [...checked.glass.night]},
	};

	for (const where of pinnedMoments(text)) {
		const m = momentAt(where);
		const at = groundsAt(m, paletteAt(m), where);
		out.column.ink.push(...at.column.ink);
		out.column.light.push(...at.column.light);
		out.glass.day.push(...at.glass.day);
		out.glass.night.push(...at.glass.night);
	}

	return out;
}

const cache: Partial<Record<Days, Checked>> = {};

/**
 * Every distinct ground of a sweep (the same colour from the same kind of
 * ground kept once, at the first moment that meets it): the sparse sweep is
 * about 50,000 moments, the dense one about 630,000.
 */
export function checkedGrounds(days: Days): Checked {
	const hit = cache[days];

	if (hit) {
		return hit;
	}

	const out: Checked = {column: {ink: [], light: []}, glass: {day: [], night: []}};
	const seen = new Set<string>();
	eachChecked((m, p, where) => {
		const at = groundsAt(m, p, where);

		for (const [surface, states] of Object.entries(at) as Array<
			[keyof Checked, Record<string, CheckedGround[]>]
		>) {
			for (const [state, grounds] of Object.entries(states)) {
				for (const g of grounds) {
					const key = `${surface} ${state} ${g.hex} ${g.body} ${g.below}`;

					if (!seen.has(key)) {
						seen.add(key);
						(out[surface] as Record<string, CheckedGround[]>)[state].push(g);
					}
				}
			}
		}
	}, days);
	cache[days] = out;
	return out;
}

/**
 * Every ground of a sweep through the tinted rim or the soft glow, in the
 * words' state asked for: the light words through the rim's layer in the
 * hour's rim colour (rimFor) at ALPHA_RIM, or the glow's black at
 * ALPHA_GLOW; the ink words through the glow's aura at ALPHA_GLOW_HALO (the
 * rim's ink is the outline's halo: not sampled again). The same colour from
 * the same kind of ground is kept once, at the first moment that meets it.
 */
export function shadowGrounds(words: "rim" | "glow", text: Text, days: Days): CheckedGround[] {
	const out: CheckedGround[] = [];
	const seen = new Set<string>();
	eachChecked((m, p, where) => {
		const published = publishedFor(p, m);

		if (published.text !== text) {
			return;
		}

		const layer = text === "ink" ? published.halo : words === "rim" ? rimFor(p) : "#000000";
		const alpha = text === "ink" ? ALPHA_GLOW_HALO : words === "rim" ? ALPHA_RIM : ALPHA_GLOW;

		for (const g of sceneGrounds(m, p)) {
			const hex = mix(g.hex, layer, alpha);
			const key = `${hex} ${g.body} ${g.below}`;

			if (!seen.has(key)) {
				seen.add(key);
				out.push({...g, hex, lum: luminance(hex), where});
			}
		}
	}, days);
	return out;
}

export interface DayGlassGround extends CheckedGround {
	/** The glass surface it was seen through, and that surface's tint at the moment. */
	surface: GlassSurface;
	tint: number;
	/** The scene's ground before the tint (the card's and the scrim's far edge are re-tinted from it). */
	raw: string;
}

const dayGlassCache = new Map<string, DayGlassGround[]>();

/**
 * The day glass as the page draws it (the user's luminous glass,
 * client/js/scenes/ps/glass.ts): at every moment of a sweep, and every moment
 * `pinned` names, that is under day glass, each surface's grounds through the
 * day backdrop filter at the tint that surface takes over that minute's own
 * grounds — the lowest the page could show then: the tint it publishes is
 * solved over the minute's whole step, so it is never lower — one per
 * colour, at the first moment that meets it. The sparse sweep's day half is
 * about 27,000 moments.
 */
export function dayGlassGrounds(
	days: Days,
	pinned = "",
	surfaces: readonly GlassSurface[] = CHROME_SURFACES
): DayGlassGround[] {
	const key = `${days}\n${pinned}\n${surfaces.join(" ")}`;
	const hit = dayGlassCache.get(key);

	if (hit) {
		return hit;
	}

	const out: DayGlassGround[] = [];
	const seen = new Set<string>();

	const visit = (m: Moment, where: string) => {
		// The palette's darkness is its stop's (palette.ts): night moments are left before the palette is made.
		if (stopsAt(m.canonical).dark > GLASS_NIGHT_AT) {
			return;
		}

		const grounds = paintedGrounds(m, paletteAt(m));
		const tints = tintsOver(grounds);

		for (const surface of surfaces) {
			const tint = tints[surface];

			for (const g of grounds) {
				if (!isBehind(surface, g)) {
					continue;
				}

				// The card is flat (no backdrop filter): the tint straight over the
				// ground, and a mention's wash over it as well (the card's second tint).
				const seenAt: Array<[string, string]> =
					surface === "card"
						? [
								[throughCard(g.hex, tint), g.name],
								[
									throughCard(g.hex, tint, SURFACE_WASH.day),
									`${g.name} under a mention`,
								],
						  ]
						: [[throughDayGlass(g.hex, tint), g.name]];

				for (const [hex, name] of seenAt) {
					const seenKey = `${surface === "card" ? "card " : ""}${hex}`;

					if (!seen.has(seenKey)) {
						seen.add(seenKey);
						out.push({
							hex,
							name,
							body: g.body,
							below: g.below,
							lum: luminance(hex),
							where: `${where}, the ${surface} at ${tint.toFixed(2)}`,
							surface,
							tint,
							raw: g.hex,
						});
					}
				}
			}
		}
	};

	const {days: list, step} = SAMPLING[days];

	for (const doy of list) {
		for (let minute = 0; minute < 1440; minute += step) {
			for (const weather of WEATHERS) {
				visit(momentOf(doy, minute, weather), `doy ${doy} ${minute} min ${weather}`);
			}
		}
	}

	for (const where of pinnedMoments(pinned)) {
		visit(momentAt(where), where);
	}

	dayGlassCache.set(key, out);
	return out;
}
