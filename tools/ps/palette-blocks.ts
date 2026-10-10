/* eslint-disable no-console */
/**
 * The ps theme's generated colours (docs/projects/ps-theme.md §6, §7, §11):
 * two blocks in client/themes/ps.css, every colour in them solved so that it
 * clears its floor on the worst ground of its surface.
 * - `ps:message-palette`: every text colour the message column reads, in
 *   both treatments.
 * - `ps:glass-palette`: the glass tint's opacity, its soft ink, badge fill and
 *   text accent, and the chrome's two nick sweeps.
 *
 *   npx tsx tools/ps/palette-blocks.ts            print both blocks
 *   npx tsx tools/ps/palette-blocks.ts --write    write them into client/themes/ps.css
 *   npx tsx tools/ps/palette-blocks.ts --sweep=sky --out=<file>
 *                                                 another LIGHT_SWEEP, into a copy
 *
 * Run from the repository root; the dense sweep takes about a minute. The
 * grounds are tools/ps/legibility.ts's dense sweep, a superset of the sparse
 * one the floors test (test/scenes/ps/legibility.ts) holds the blocks to; the
 * test also recomputes every moment a block header names. Nothing here is
 * random, so a second --write changes nothing.
 *
 * **Solving.** One hue table (NICK_HUES) for every surface. A colour keeps its
 * OKLCH hue and chroma, and only its lightness is solved, to FLOOR (4.5:1 and
 * 0.1 of margin for rounding): dark text the lightest that clears the darkest
 * ground, light text the darkest that clears the brightest.
 *
 * **The pre-ruled fixes** (the plan's Global Constraints), when a spec colour
 * fails:
 * 1. The glass tint's opacity rises from the spec's in steps of 0.01, up to
 *    its cap, until the glass ink and soft ink hold 4.5:1.
 * 2. **Rule 2**: a secondary colour (the glass soft ink at the cap, the
 *    column's faint ink) moves in OKLCH lightness, keeping hue and chroma, by
 *    the smallest amount that clears its floor, at most 0.08.
 * 3. Anything beyond that throws: a primary ink failing, a move over 0.08, a
 *    cap reached with the ink still failing.
 *
 * **Rulings (controller, 2026-09-24):**
 * - The active-row marker is exempt from a 3:1 mark floor. It is a redundant
 *   cue: the active row also has the selected fill, and full ink where the
 *   other rows use soft. The spec accent stays #c2562b by day and #d9784a at
 *   night, unchanged.
 * - The badge is text on a fill. Its white numeral is held at 4.5:1 on
 *   --ps-g-badge, the accent solved darker where it must be. The fill itself
 *   has no mark floor.
 * - **The user chose the text accent** (2026-09-25, decision 1A: "i will
 *   accept your recommendations on these"). The spec accent reads 2.97:1 by
 *   day and 2.63:1 at night on the glass, short of the floor for text and
 *   for the marks that must read. The chrome writes and marks with
 *   --ps-g-accent-text instead: the accent's hue and chroma, its lightness
 *   solved like a nick's against the worst glass ground, held at 4.5:1 over
 *   every glass ground and on the solid panel. It is past rule 2's 0.08 on
 *   purpose, by the user's decision; the spec accent stays for the open row's
 *   marker, the caret, the focus glow and the tints.
 * - **The user chose LIGHT_SWEEP "names-large"** (2026-09-24, "names-large is
 *   easiest to read"). **Its guard:** below the default font-size step the
 *   names are not large text, so the block also writes the `sky` set there,
 *   under SMALL_STEPS_ROOT.
 */
import {readFileSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {contrast, luminance, mix} from "../../client/js/scenes/ps/colour";
import {SOLAR_NOON} from "../../client/js/scenes/ps/engine";
import {publishedFor} from "../../client/js/scenes/ps/grounds";
import {paletteAt} from "../../client/js/scenes/ps/palette";
import {
	ALPHA_HALO,
	ALPHA_SHADOW,
	checkedGrounds,
	CODE_BOX,
	GLASS,
	glassGround,
	INK,
	INK_FAINT,
	isBody,
	LIGHT_ROOT,
	LIGHT_SWEEP,
	lightSweepFloors,
	momentOf,
	SAMPLING,
	type Checked,
	type CheckedGround,
	type Light,
	type LightSweep,
	smallStepSweep,
	SMALL_STEPS_ROOT,
	type Text,
} from "./legibility";
import {hexToOklch, oklchToHex} from "./oklch";

export const CSS_PATH = resolve("client/themes/ps.css");
const MESSAGE = {
	start: "/* ps:message-palette:start",
	end: "/* ps:message-palette:end */",
};
const GLASS_MARKERS = {start: "/* ps:glass-palette:start", end: "/* ps:glass-palette:end */"};
/** Where the message block goes the first time: the end of the scene section. */
const FIRST_ANCHOR = "/* ---- animals ---- */";

/**
 * The moments the floors test pins by name (Review Focus 1 and the words'
 * rule): a stormy noon, the golden hour, a clear noon and a snowy noon.
 */
const PINS = [
	"the stormy noon doy 121 750 min storm",
	"the golden hour doy 295 1010 min clear",
	"a clear noon doy 172 750 min clear",
	"a snowy noon doy 32 750 min snow",
];

/** 4.5:1 and 0.1 of margin, so rounding to a hex byte never lands under the floor. */
const FLOOR = 4.6;
const TEXT = 4.5;
const FAINT = 3;
const RULE_TWO_MAX = 0.08;
const ITERATIONS = 40;
const RAD = Math.PI / 180;

/**
 * The nick hues (OKLCH degrees): warm-leaning like the mockup's four (rust, teal, violet, ochre),
 * fourteen in the warm band 0–104°, eighteen across the rest. One table for every surface.
 */
/* prettier-ignore */
export const NICK_HUES = [
	0, 8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 88, 96, 104,
	118, 132, 146, 160, 174, 188, 202, 216, 230, 244, 258, 272, 286, 300, 314, 328, 342, 352,
];
export const NICK_CHROMA = 0.11;
const NICK_LIGHTNESS = 0.6;

/**
 * The message column's semantic tokens, by the base each is solved from.
 * coffee.css maps TheLounge's names onto these (--link-color: var(--chat-accent)
 * and so on) on :root, where they resolve once; so every alias the message
 * column reads is restated here by name, or it would keep :root's colour.
 */
const SEMANTIC: Array<{names: string[]; base: string}> = [
	{names: ["--chat-fg-muted", "--body-color-muted", "--date-marker-color"], base: "#536a8e"},
	{
		names: [
			"--chat-accent",
			"--link-color",
			"--unread-marker-color",
			"--highlight-border-color",
			"--button-color",
			"--action-color",
		],
		base: GLASS.day.accent,
	},
	{names: ["--event-join", "--channel-typing-color"], base: "#1f7354"},
	{names: ["--event-quit"], base: "#b8362a"},
	{names: ["--notice-color"], base: "#0e7676"},
	{names: ["--nick-default", "--channel-activity-color"], base: "#2160c8"},
];

/** The spec's own colours (§7), never solved (faint ink only under rule 2): the floors test holds them as written. */
const FIXED: Record<Text, Record<string, string>> = {
	ink: {"--chat-fg": INK, "--body-color": INK, "--md-code-color": INK},
	light: {
		"--chat-fg": "#ffffff",
		"--body-color": "#ffffff",
		"--md-code-color": "#ffffff",
		"--chat-fg-faint": "rgb(255 255 255 / 80%)",
	},
};

/** The nick bases: the hue table at one lightness, chroma pulled in where sRGB cannot hold it. */
export function nickBases(): string[] {
	return NICK_HUES.map((h) => at(NICK_LIGHTNESS, NICK_CHROMA, h * RAD));
}

/**
 * The code highlighter's tokens, solved in both treatments against the code
 * box they are drawn in (CODE_BOX, written as --ps-code-bg), never the plains:
 * the box is opaque. Their bases are plan 1's :root values, fixed here like
 * SEMANTIC's: ps.css's tokens section now holds the chrome's own code colours
 * (creama.css's by day, coffee.css's at night, for code outside the column),
 * which are not the column's.
 */
const CODE: Array<{names: string[]; base: string}> = [
	{names: ["--tok-comment"], base: "#6b7fa0"},
	{names: ["--tok-keyword"], base: "#b9376b"},
	{names: ["--tok-string"], base: "#1f7354"},
	{names: ["--tok-number"], base: "#2160c8"},
	{names: ["--tok-function"], base: "#6f4fc9"},
	{names: ["--tok-operator"], base: "#b9376b"},
	{names: ["--tok-punctuation"], base: "#4d6187"},
	{names: ["--tok-tag"], base: "#1f7354"},
	{names: ["--tok-attr"], base: "#7040c8"},
];

/** The colour at OKLCH lightness L, pulling chroma in until it fits sRGB. */
function at(L: number, C: number, h: number): string {
	for (let c = C; ; c *= 0.92) {
		const hex = oklchToHex(L, c < 1e-6 ? 0 : c, h);

		if (hex) {
			return hex;
		}
	}
}

/** `base` at the lightness that just clears `floor` on `ground`, darker (ink) or lighter (light) than it. */
export function solve(base: string, text: Text, ground: string, floor = FLOOR): string {
	const [, C, h] = hexToOklch(base);
	const passes = (L: number) => contrast(at(L, C, h), ground) >= floor;
	// For ink the search keeps `lo` passing (black always does); for light, `hi` (white always does).
	let [lo, hi] = [0, 1];

	for (let i = 0; i < ITERATIONS; i++) {
		const mid = (lo + hi) / 2;

		if (passes(mid) === (text === "ink")) {
			lo = mid;
		} else {
			hi = mid;
		}
	}

	const hex = at(text === "ink" ? lo : hi, C, h);

	if (contrast(hex, ground) < floor) {
		throw new Error(
			`${base} solved to ${hex}, ${contrast(hex, ground).toFixed(2)}:1 on ${ground}`
		);
	}

	return hex;
}

/** The lowest contrast `colour` meets over `grounds`, and where. */
export function lowest(
	colour: string,
	grounds: CheckedGround[]
): {ratio: number; ground: CheckedGround} {
	const lc = luminance(colour);
	let best = {ratio: Infinity, ground: grounds[0]};

	for (const g of grounds) {
		const ratio = (Math.max(lc, g.lum) + 0.05) / (Math.min(lc, g.lum) + 0.05);

		if (ratio < best.ratio) {
			best = {ratio, ground: g};
		}
	}

	return best;
}

/** The worst ground for text darker (ink) or lighter (light) than every ground: the darkest or the brightest. */
function worstFor(text: Text, grounds: CheckedGround[]): CheckedGround {
	if (grounds.length === 0) {
		throw new Error("no grounds to solve against");
	}

	return grounds.reduce((a, b) => ((text === "ink" ? b.lum < a.lum : b.lum > a.lum) ? b : a));
}

/** The first `n` grounds, worst first. */
function worstFive(text: Text, grounds: CheckedGround[], n = 5): CheckedGround[] {
	return [...grounds]
		.sort((a, b) => (text === "ink" ? a.lum - b.lum : b.lum - a.lum))
		.slice(0, n);
}

export interface Move {
	was: string;
	now: string;
	/**
	 * The OKLCH lightness change, signed, as written: `now`'s against `was`'s,
	 * not the solver's step (rounding to hex lands a little past the step).
	 */
	dL: number;
	ratio: number;
	ground: CheckedGround;
}

/**
 * Rule 2: `colour` moved darker (ink) or lighter (light) in OKLCH lightness,
 * hue and chroma kept, by the smallest step (of 0.0001) that clears `floor`
 * over `grounds`. Throws when the step passes RULE_TWO_MAX; the move it
 * reports is the written colour's (Move.dL).
 */
export function ruleTwo(
	colour: string,
	text: Text,
	grounds: CheckedGround[],
	floor: number,
	what: string
): Move {
	const was = lowest(colour, grounds);

	if (was.ratio >= floor) {
		return {was: colour, now: colour, dL: 0, ratio: was.ratio, ground: was.ground};
	}

	const [L, C, h] = hexToOklch(colour);
	const sign = text === "ink" ? -1 : 1;

	for (let i = 1; i <= RULE_TWO_MAX * 10000; i++) {
		const hex = at(L + sign * (i / 10000), C, h);
		const now = lowest(hex, grounds);

		if (now.ratio >= floor) {
			return {
				was: colour,
				now: hex,
				dL: hexToOklch(hex)[0] - L,
				ratio: now.ratio,
				ground: now.ground,
			};
		}
	}

	throw new Error(
		`rule 3: ${what} ${colour} is ${was.ratio.toFixed(3)}:1 at ${was.ground.where}, ${
			was.ground.name
		} (${was.ground.hex}), and needs more than ${RULE_TWO_MAX} OKLCH L to clear ${floor}`
	);
}

/** Throws unless `colour` holds `floor` over every ground: a spec colour no rule may move (rule 3). */
function hold(colour: string, grounds: CheckedGround[], floor: number, what: string): void {
	const w = lowest(colour, grounds);

	if (w.ratio < floor) {
		throw new Error(
			`rule 3: ${what} ${colour} is ${w.ratio.toFixed(3)}:1 (floor ${floor}) at ${
				w.ground.where
			}, ${w.ground.name} (${w.ground.hex})`
		);
	}
}

export interface Options {
	sweep: LightSweep;
	/** Which grounds count; everything by default. */
	keep: (g: CheckedGround) => boolean;
}

export interface GlassSolved {
	alpha: number;
	soft: Move;
	badge: {was: string; now: string; ratio: number};
	/** The text accent; `ratio` is its lowest on the glass, `solid` its ratio on the solid panel. */
	accentText: Move & {solid: number};
	nicks: string[];
	/** The worst five grounds under the glass at `alpha`, worst first. */
	worst: CheckedGround[];
}

export interface Solved {
	sweep: LightSweep;
	column: {
		worst: Record<Text, CheckedGround[]>;
		/** The grounds coloured light text was solved against: the nicks', and the other colours'. */
		lightNicks: CheckedGround;
		lightColours: CheckedGround;
		faint: Move;
		ink: Record<string, string>;
		light: Record<string, string>;
		nicks: Record<Text, string[]>;
		/** The light nicks below the default font-size step (smallStepSweep), and what they were solved against; null when the sweep needs none. */
		small: {sweep: LightSweep; nicks: string[]; against: CheckedGround} | null;
	};
	glass: Record<Light, GlassSolved>;
	pins: {dusk: {where: string; dark: number}; moon: CheckedGround};
}

/** Every name in `list` at its base's solved colour. */
function solveAll(
	list: Array<{names: string[]; base: string}>,
	text: Text,
	ground: string,
	floor = FLOOR
): Record<string, string> {
	const out: Record<string, string> = {};

	for (const {names, base} of list) {
		const hex = solve(base, text, ground, floor);

		for (const name of names) {
			out[name] = hex;
		}
	}

	return out;
}

/** The ground under the glass, with its luminance, at `alpha`. */
function underGlass(raw: CheckedGround[], light: Light, alpha: number): CheckedGround[] {
	return raw.map((g) => {
		const hex = glassGround(g.hex, light, alpha);
		return {...g, hex, lum: luminance(hex)};
	});
}

function solveGlass(light: Light, raw: CheckedGround[]): GlassSolved {
	const spec = GLASS[light];
	const text: Text = light === "day" ? "ink" : "light";
	let alpha = spec.cap;

	for (let k = Math.round(spec.base * 100); k <= Math.round(spec.cap * 100); k++) {
		const grounds = underGlass(raw, light, k / 100);

		if (lowest(spec.ink, grounds).ratio >= TEXT && lowest(spec.soft, grounds).ratio >= TEXT) {
			alpha = k / 100;
			break;
		}
	}

	const grounds = underGlass(raw, light, alpha);
	hold(spec.ink, grounds, TEXT, `${light} glass ink at opacity ${alpha}`);
	const soft = ruleTwo(spec.soft, text, grounds, TEXT, `${light} glass soft ink at its cap`);
	const worst = worstFor(text, grounds);
	const nicks = nickBases().map((base) => solve(base, text, worst.hex));

	for (const [i, hex] of nicks.entries()) {
		hold(hex, grounds, TEXT, `${light} glass nick ${i + 1}`);
	}

	const badge =
		contrast(spec.accent, "#ffffff") >= FLOOR
			? spec.accent
			: solve(spec.accent, "ink", "#ffffff");

	// The text accent (the user's decision 1A): the accent solved as a nick is.
	const accent = solve(spec.accent, text, worst.hex);
	hold(accent, grounds, TEXT, `${light} glass text accent`);
	const onSolid = contrast(accent, spec.solid);

	if (onSolid < TEXT) {
		throw new Error(
			`rule 3: the ${light} text accent ${accent} is ${onSolid.toFixed(3)}:1 on the solid ${
				spec.solid
			}`
		);
	}

	const onGlass = lowest(accent, grounds);
	return {
		alpha,
		soft,
		badge: {was: spec.accent, now: badge, ratio: contrast(badge, "#ffffff")},
		accentText: {
			was: spec.accent,
			now: accent,
			dL: hexToOklch(accent)[0] - hexToOklch(spec.accent)[0],
			ratio: onGlass.ratio,
			ground: onGlass.ground,
			solid: onSolid,
		},
		nicks,
		worst: worstFive(text, grounds),
	};
}

/**
 * The darkest evening moment still under day glass (darkness ≤ GLASS_NIGHT_AT,
 * after solar noon) in the dense sweep: late dusk, just before the chrome
 * turns to night; the first, if several tie. Mornings are left out: the dawn
 * twin of the same darkness is not what Review Focus 1 pins.
 */
function duskPin(): {where: string; dark: number} {
	let best = {where: "", dark: -1};
	const {days, step} = SAMPLING.dense;
	const noon = Math.ceil(SOLAR_NOON / step) * step;

	// Darkness is the canonical stop's own and does not depend on the weather.
	for (const doy of days) {
		for (let minute = noon; minute < 1440; minute += step) {
			const m = momentOf(doy, minute, "clear");
			const p = paletteAt(m);

			if (publishedFor(p, m).light === "day" && p.dark > best.dark) {
				best = {where: `doy ${doy} ${minute} min clear`, dark: p.dark};
			}
		}
	}

	return best;
}

/** Solve both blocks against the dense sweep. */
export function solvePalettes(options: Partial<Options> = {}): Solved {
	const sweep = options.sweep ?? LIGHT_SWEEP;
	const keep = options.keep ?? (() => true);
	const all = checkedGrounds("dense");
	const g: Checked = {
		column: {ink: all.column.ink.filter(keep), light: all.column.light.filter(keep)},
		glass: {day: all.glass.day.filter(keep), night: all.glass.night.filter(keep)},
	};
	const floors = lightSweepFloors(sweep);
	const lightFor = (bodies: boolean) =>
		bodies ? g.column.light : g.column.light.filter((x) => !isBody(x));

	// The spec's own colours, which no rule moves.
	hold(INK, g.column.ink, TEXT, "message ink");
	hold("#ffffff", g.column.light, TEXT, "white message text");
	const faintWhite = lowestFaintWhite(g.column.light);

	if (faintWhite.ratio < FAINT) {
		throw new Error(
			`rule 3: faint white is ${faintWhite.ratio.toFixed(3)}:1 at ${faintWhite.ground.where}`
		);
	}

	// A code block's own text, on its box.
	for (const [text, ink] of [
		["ink", FIXED.ink["--md-code-color"]],
		["light", FIXED.light["--md-code-color"]],
	] as const) {
		if (contrast(ink, CODE_BOX[text]) < TEXT) {
			throw new Error(
				`rule 3: ${text} --md-code-color ${ink} fails on the code box ${CODE_BOX[text]}`
			);
		}
	}

	const inkWorst = worstFor("ink", g.column.ink);
	const lightNicks = worstFor("light", lightFor(floors.nicks.bodies));
	const lightColours = worstFor("light", lightFor(floors.colours.bodies));
	const faint = ruleTwo(INK_FAINT, "ink", g.column.ink, FAINT, "faint message ink");
	const ink = {
		...FIXED.ink,
		"--chat-fg-faint": faint.now,
		"--ps-code-bg": CODE_BOX.ink,
		...solveAll(SEMANTIC, "ink", inkWorst.hex),
		...solveAll(CODE, "ink", CODE_BOX.ink),
	};
	const light = {
		...FIXED.light,
		"--ps-code-bg": CODE_BOX.light,
		...solveAll(SEMANTIC, "light", lightColours.hex, floors.colours.solveTo),
		...solveAll(CODE, "light", CODE_BOX.light),
	};
	const bases = nickBases();
	const nicks = {
		ink: bases.map((b) => solve(b, "ink", inkWorst.hex)),
		light: bases.map((b) => solve(b, "light", lightNicks.hex, floors.nicks.solveTo)),
	};
	const moon = worstFor(
		"light",
		g.glass.night.filter((x) => x.body === "moon")
	);
	const smallSweep = smallStepSweep(sweep);
	let small: Solved["column"]["small"] = null;

	if (smallSweep) {
		const rule = lightSweepFloors(smallSweep).nicks;
		const against = worstFor("light", lightFor(rule.bodies));
		small = {
			sweep: smallSweep,
			nicks: bases.map((b) => solve(b, "light", against.hex, rule.solveTo)),
			against,
		};
	}

	return {
		sweep,
		column: {
			worst: {ink: worstFive("ink", g.column.ink), light: worstFive("light", g.column.light)},
			lightNicks,
			lightColours,
			faint,
			ink,
			light,
			nicks,
			small,
		},
		glass: {day: solveGlass("day", g.glass.day), night: solveGlass("night", g.glass.night)},
		pins: {dusk: duskPin(), moon},
	};
}

/** Faint white (white at 80 % over its own ground) against that ground, at its worst. */
function lowestFaintWhite(grounds: CheckedGround[]): {ratio: number; ground: CheckedGround} {
	let best = {ratio: Infinity, ground: grounds[0]};

	for (const g of grounds) {
		const ratio = contrast(mix(g.hex, "#ffffff", 0.8), g.hex);

		if (ratio < best.ratio) {
			best = {ratio, ground: g};
		}
	}

	return best;
}

const declarations = (values: Record<string, string>) =>
	Object.entries(values).map(([name, value]) => `\t${name}: ${value};`);

const groundLine = (g: CheckedGround) => ` *   ${g.hex}  ${g.where}  ${g.name}`;
const signed = (d: number) => `${d < 0 ? "−" : "+"}${Math.abs(d).toFixed(4)}`;
/** A rule-2 move (or a colour that held) as header lines. */
const moveLines = (what: string, m: Move) =>
	m.dL === 0
		? [` * ${what}: ${m.was} holds (${m.ratio.toFixed(2)}:1 at worst).`]
		: [
				` * ${what}, rule 2: ${m.was} → ${m.now}, OKLCH L ${signed(m.dL)};`,
				` *   ${m.ratio.toFixed(2)}:1 on ${m.ground.hex} at ${m.ground.where}.`,
		  ];

const SWEEP_TEXT: Record<LightSweep, string> = {
	strict: "every coloured light colour over the sky and the bodies",
	sky: "coloured light colours over the sky and the plains, not the bodies; white and faint white over the bodies too",
	"names-large":
		"the nicks at 3.1 (large text) over the sky and the bodies; every other colour at 4.6",
};

/** The message column's block, markers included. */
export function messageBlock(s: Solved): string {
	const c = s.column;
	const lightRoot = LIGHT_ROOT;
	const floors = lightSweepFloors(s.sweep);

	return [
		`${MESSAGE.start} — generated by`,
		" * `npx tsx tools/ps/palette-blocks.ts --write`; edit the generator, not",
		" * this block. Each colour clears its floor (4.5:1; faint ink 3:1; the light",
		" * nicks as the light sweep below says) on every ground its treatment meets in",
		" * the dense sweep (every day, every 5 minutes, all six weathers): the sky, the",
		" * moon's disc and the sun's core (above the horizon line), and the plains'",
		" * areas (client/js/scenes/ps/grounds.ts), under the veil on a veiled day,",
		` * through the halo at α ${ALPHA_HALO} where the words are ink or the shadow and`,
		` * outline at α ${ALPHA_SHADOW} where they are light (docs/projects/ps-theme.md §11).`,
		" * The words are ink only where ink holds (the user's white sooner): the ink",
		" * colours are solved over those moments alone. Generated colours are solved",
		" * to 4.6.",
		...PINS.map((p) => ` * Pinned for the floors test: ${p}.`),
		` * Light sweep "${s.sweep}" (tools/ps/legibility.ts LIGHT_SWEEP${
			s.sweep === "names-large" ? ", the user's choice, 2026-09-24" : ""
		}):`,
		` * ${SWEEP_TEXT[s.sweep]}.`,
		...(c.small
			? [
					" * Its guard: below the default font-size step the names are not large",
					` * text, so there they take the "${c.small.sweep}" set (the last 32 rules),`,
					` * solved to ${lightSweepFloors(c.small.sweep).nicks.solveTo} against:`,
					groundLine(c.small.against),
			  ]
			: []),
		" * The worst grounds by day, darkest first, through the halo:",
		...c.worst.ink.map(groundLine),
		" * The worst in the light treatment (at any hour: dark ink holds only on",
		" * snowy days), brightest first, through the shadow:",
		...c.worst.light.map(groundLine),
		...(c.lightColours === c.lightNicks && floors.nicks.solveTo === floors.colours.solveTo
			? [
					` * Coloured light text is solved to ${floors.colours.solveTo} against:`,
					groundLine(c.lightNicks),
			  ]
			: [
					` * The light nicks are solved to ${floors.nicks.solveTo} against:`,
					groundLine(c.lightNicks),
					` * the other coloured light colours to ${floors.colours.solveTo} against:`,
					groundLine(c.lightColours),
			  ]),
		...moveLines("Faint ink", c.faint),
		" * Code boxes paint --ps-code-bg, opaque (ps.css, after the block): the --tok-*",
		` * colours are solved against it, ${CODE_BOX.ink} by day and ${CODE_BOX.light} otherwise.`,
		" * Six-digit hex throughout: the floors test reads every colour in that form. */",
		"/* stylelint-disable color-hex-length */",
		"#chat .chat {",
		...declarations(c.ink),
		"",
		"\tcolor: var(--chat-fg);",
		"}",
		"",
		`${lightRoot} {`,
		...declarations(c.light),
		"}",
		"",
		...c.nicks.ink.map((hex, i) => `#chat .chat .user.color-${i + 1} { color: ${hex}; }`),
		"",
		...c.nicks.light.map((hex, i) => `${lightRoot} .user.color-${i + 1} { color: ${hex}; }`),
		...(c.small
			? [
					"",
					"/* stylelint-disable max-line-length -- one line per nick like the rest; the step test is long */",
					...c.small.nicks.map(
						(hex, i) => `${SMALL_STEPS_ROOT} .user.color-${i + 1} { color: ${hex}; }`
					),
					"/* stylelint-enable max-line-length */",
			  ]
			: []),
		"/* stylelint-enable color-hex-length */",
		"",
		MESSAGE.end,
	].join("\n");
}

/** The glass block, markers included. */
export function glassBlock(s: Solved): string {
	const state = (light: Light) => {
		const x = s.glass[light];
		const spec = GLASS[light];
		return [
			` *   ${light}: opacity ${x.alpha} (spec ${spec.base}, cap ${spec.cap})`,
			x.soft.dL === 0
				? ` *     soft ${x.soft.was} holds`
				: ` *     soft ${x.soft.was} → ${x.soft.now} (rule 2, OKLCH L ${signed(
						x.soft.dL
				  )})`,
			` *     badge ${
				x.badge.was === x.badge.now ? x.badge.now : `${x.badge.was} → ${x.badge.now}`
			} (white on it ${x.badge.ratio.toFixed(2)}:1)`,
			` *     text accent ${x.accentText.was} → ${x.accentText.now} (OKLCH L ${signed(
				x.accentText.dL
			)}; ${x.accentText.ratio.toFixed(2)}:1 on the glass, ${x.accentText.solid.toFixed(
				2
			)}:1 on the solid)`,
		];
	};

	return [
		`${GLASS_MARKERS.start} — generated by`,
		" * `npx tsx tools/ps/palette-blocks.ts --write`; edit the generator, not",
		" * this block. The glass (docs/projects/ps-theme.md §6): its tint's opacity,",
		" * raised from the spec's toward its cap until the glass ink and soft ink",
		" * hold 4.5:1 on every ground behind it in the dense sweep (the sky, the",
		" * plains and the bodies, the tint over them, the blur left out); the soft ink,",
		" * moved under rule 2 where the cap was not enough; the badge's fill, the",
		" * accent solved so its white numeral holds 4.5:1; the text accent, the",
		" * accent's hue and chroma solved like a nick for the chrome's links, button",
		" * labels and the marks that must read, held on the glass and the solid (the",
		" * user's decision, 2026-09-25); and the chrome's two nick sweeps, solved to",
		" * 4.6 (the message column's own nick rules, in the block above, are more",
		" * specific and win inside the column). The active-row marker keeps the spec",
		" * accent and has no 3:1 floor (ruling 2026-09-24: a redundant cue beside",
		" * the selected fill and the full ink).",
		...state("day"),
		...state("night"),
		" * Pinned for the floors test (plan 2's Review Focus 1 and 2):",
		` *   dusk: ${s.pins.dusk.where}, darkness ${s.pins.dusk.dark.toFixed(5)}:`,
		" *     the darkest moment still under day glass;",
		` *   moon: ${s.pins.moon.where}, the brightest disc behind night glass:`,
		` *     ${s.pins.moon.name}.`,
		" * The worst grounds under day glass, darkest first, at its opacity:",
		...s.glass.day.worst.map(groundLine),
		" * The worst under night glass, brightest first:",
		...s.glass.night.worst.map(groundLine),
		" * Six-digit hex throughout: the floors test reads every colour in that form. */",
		"/* stylelint-disable color-hex-length, no-duplicate-selectors */",
		":root {",
		`\t--ps-g-tint-a: ${s.glass.day.alpha};`,
		`\t--ps-g-soft: ${s.glass.day.soft.now};`,
		`\t--ps-g-badge: ${s.glass.day.badge.now};`,
		`\t--ps-g-accent-text: ${s.glass.day.accentText.now};`,
		"}",
		"",
		':root[data-ps-light="night"] {',
		`\t--ps-g-tint-a: ${s.glass.night.alpha};`,
		`\t--ps-g-soft: ${s.glass.night.soft.now};`,
		`\t--ps-g-badge: ${s.glass.night.badge.now};`,
		`\t--ps-g-accent-text: ${s.glass.night.accentText.now};`,
		"}",
		"",
		...s.glass.day.nicks.map((hex, i) => `.user.color-${i + 1} { color: ${hex}; }`),
		"",
		...s.glass.night.nicks.map(
			(hex, i) => `:root[data-ps-light="night"] .user.color-${i + 1} { color: ${hex}; }`
		),
		"/* stylelint-enable color-hex-length, no-duplicate-selectors */",
		"",
		GLASS_MARKERS.end,
	].join("\n");
}

/** `css` with a block in place: replacing the old one, or at `anchor` (before or after it) the first time. */
function withBlock(
	css: string,
	block: string,
	markers: {start: string; end: string},
	anchor: {text: string; after: boolean}
): string {
	const start = css.indexOf(markers.start);

	if (start >= 0) {
		const end = css.indexOf(markers.end, start);

		if (end < 0) {
			throw new Error(`ps.css has ${markers.start} but not its end marker`);
		}

		return css.slice(0, start) + block + css.slice(end + markers.end.length);
	}

	const anchorAt = css.indexOf(anchor.text);

	if (anchorAt < 0) {
		throw new Error(`ps.css has neither ${markers.start} nor ${anchor.text}`);
	}

	const cut = anchor.after ? anchorAt + anchor.text.length : anchorAt;
	const [before, after] = [css.slice(0, cut), css.slice(cut)];
	return anchor.after ? `${before}\n\n${block}${after}` : `${before}${block}\n\n${after}`;
}

/** ps.css with both blocks in place: the message block at the end of the scene section, the glass block after it. */
export function withBlocks(css: string, s: Solved): string {
	const next = withBlock(css, messageBlock(s), MESSAGE, {text: FIRST_ANCHOR, after: false});
	return withBlock(next, glassBlock(s), GLASS_MARKERS, {text: MESSAGE.end, after: true});
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const arg = (name: string) =>
		process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
	const sweep = arg("sweep") as LightSweep | undefined;
	const out = arg("out");

	if (sweep && !["strict", "sky", "names-large"].includes(sweep)) {
		throw new Error(`--sweep must be strict, sky or names-large, not ${sweep}`);
	}

	if (sweep && sweep !== LIGHT_SWEEP && process.argv.includes("--write")) {
		throw new Error(
			"--write keeps LIGHT_SWEEP (the floors test reads it); write another sweep with --out"
		);
	}

	const css = readFileSync(CSS_PATH, "utf8");
	const solved = solvePalettes({sweep});
	const next = withBlocks(css, solved);

	if (out) {
		writeFileSync(out, next);
		console.log(`${out}: written (light sweep ${solved.sweep})`);
	} else if (process.argv.includes("--write")) {
		writeFileSync(CSS_PATH, next);
		console.log(
			next === css ? "ps.css: the blocks are already current" : "ps.css: blocks written"
		);
	} else {
		console.log(`${messageBlock(solved)}\n\n${glassBlock(solved)}`);
	}
}
