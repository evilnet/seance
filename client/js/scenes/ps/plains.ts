/**
 * The ps theme's plains (docs/projects/ps-theme.md §5.1, §5.3, §5.5): the land
 * with its river, the near grass along the foot of the window, the fireflies
 * in the far fields, the yurt with its smoke, the clouds, and the day's
 * weather. The approved mockup is the drawing
 * (docs/resources/themes/ps-plains/mockup.html): its land and yurt SVGs, its
 * blade and flower generator, its firefly generator, its smoke, its clouds
 * and its rain, snow and seed generators, ported with their geometry and
 * counts, `ps-` names, travel in cqw/cqh of the scene and small marks in rem,
 * and engine.ts's `rng` at the mockup's seeds in place of its LCG (so the
 * scatter differs from the mockup's; the drawing does not).
 *
 * Pure: strings in, strings out, the same every call. No colour lives here:
 * every fill is a class that ps.css paints from the palette's published
 * custom properties (scene.ts `sceneVars`). Nothing user-supplied is ever
 * written into this markup.
 */
import {rng, type Weather} from "./engine";
import {WEATHER} from "./palette";

/** Fireflies over the far fields: the mockup's 34. A phone gets half (scene.ts). */
export const FIREFLIES = 34;

/** A coordinate to two decimals, trailing zeros dropped: sub-pixel at any window size. */
const n = (v: number) => String(Number(v.toFixed(2)));

/* The land's outlines, the mockup's own. A hill's rim is its top edge alone;
 * the riverbed and the river are one shape (the water over the stones). */
const HILL2_EDGE =
	"M0,190 C120,170 260,160 400,172 C520,182 600,200 740,188 C880,176 1000,160 1200,176";
const HILL1_EDGE =
	"M0,250 C150,226 300,214 470,226 C620,236 740,258 900,246 C1030,236 1120,226 1200,232";
const RIVER =
	"M318,127 C350,132 370,138 350,146 C320,156 290,164 340,176 C400,190 500,196 530,214 C552,228 500,238 450,250 L530,250 C580,238 630,226 604,210 C578,194 470,186 414,172 C370,161 390,152 422,144 C446,137 406,131 350,127 Z";
const TO_FOOT = " L1200,400 L0,400 Z";
/** The grass band's top edge: the near grass the composer stands on (glass.ts). */
const GRASS_EDGE = "M0,300 C200,290 400,296 600,292 C800,288 1000,296 1200,290";

/** The land's share of the scene's height, from its foot (ps.css `#theme-scene .ps-land`, 56 %), on its 400-high viewBox. */
export const LAND_SHARE = 0.56;
const LAND_VIEW_HEIGHT = 400;

/**
 * The grass band's top edge at its lowest, as a share of the scene's height
 * from its top: below it the scene is near grass all the way across. A cubic
 * Bézier stays inside its control points' hull, so the largest y among them
 * bounds the edge from below, and the edge's own start (0,300) reaches it:
 * 300 of 400, so 0.86. A composer whose top rises above it may stand over
 * hill1 or the yurt somewhere along its width (glass.ts composerAboveGrass;
 * the cautious reading, the controller's ruling in fix round 2).
 */
export const GRASS_EDGE_LOWEST =
	1 -
	LAND_SHARE +
	(LAND_SHARE * Math.max(...[...GRASS_EDGE.matchAll(/,(-?[\d.]+)/g)].map((m) => Number(m[1])))) /
		LAND_VIEW_HEIGHT;

/** One tuft: two blades from one root, the mockup's `tuft`. */
function tuft(x: number, y: number, h: number, cls: string): string {
	return (
		`<path class="${cls}" d="M${n(x - 2)},${n(y)} q1,${n(-h * 0.6)} 2,${n(-h)} q1,${n(
			h * 0.5
		)} 2,${n(h)} z ` +
		`M${n(x + 1)},${n(y)} q2,${n(-h * 0.5)} 5,${n(-h * 0.8)} q-1,${n(h * 0.45)} -2,${n(
			h * 0.8
		)} z"/>`
	);
}

/**
 * The land: mountains, the far plain with its shrubs, the river (or its dry
 * bed), two hills with their rims, tufts and trees, and the grass band, back
 * to front on the mockup's 1200 × 400 box, stretched to whatever box ps.css
 * gives it, with the river's sky gradient in its defs. The hills stretch
 * with the window; the round things on them (the shrubs, the bed's stones,
 * the two groves) are widened back about their own middles by the stretch's
 * squash (`--ps-land-unsquash`, scene.ts watchLand), so a narrow window does
 * not draw them as tall ellipses. (The heat haze that
 * bends the ground on hot days is the weather layer's: `weatherLayers`.)
 */
export function landSvg(): string {
	// One stream, as the mockup's: the shrubs, then the far tufts, then the near.
	const r = rng(777);
	let shrubs = "";

	for (let i = 0; i < 40; i++) {
		const x = r() * 1200;
		const y = 130 + r() * 10;
		const w = 3 + r() * 6;
		shrubs += `<ellipse class="ps-l-shrub" cx="${x.toFixed(0)}" cy="${y.toFixed(
			1
		)}" rx="${w.toFixed(1)}" ry="${(w * 0.45).toFixed(1)}"/>`;
	}

	let far = "";

	for (let i = 0; i < 160; i++) {
		const x = r() * 1200;
		const y = 200 + r() * 40;
		const h = 5 + r() * 5;
		far += tuft(x, y, h, "ps-l-tuft2");
	}

	let near = "";

	for (let i = 0; i < 240; i++) {
		const x = r() * 1200;
		const y = 250 + r() * 44;
		const h = 7 + r() * 8;
		near += tuft(x, y, h, r() > 0.75 ? "ps-l-tuft-lit" : "ps-l-tuft1");
	}

	return (
		`<svg class="ps-land" viewBox="0 0 1200 400" preserveAspectRatio="none" aria-hidden="true">` +
		`<defs>` +
		`<linearGradient id="ps-river-sky" x1="0" y1="0" x2="0" y2="1">` +
		`<stop offset="0" style="stop-color: var(--ps-river-sky-top)"/><stop offset="1" style="stop-color: var(--ps-river-sky-bottom)"/>` +
		`</linearGradient>` +
		`</defs>` +
		`<path class="ps-l-mount2" d="M0,86 C60,70 110,54 170,62 C230,70 260,40 330,44 C400,48 430,76 500,70 C580,62 620,30 700,36 C780,42 820,70 900,64 C980,58 1030,34 1100,42 C1150,48 1180,60 1200,62${TO_FOOT}"/>` +
		`<path class="ps-l-mount" d="M0,112 C80,96 140,84 220,92 C300,100 340,76 420,80 C500,84 560,104 640,98 C720,92 780,72 860,78 C940,84 1000,102 1080,96 C1140,92 1180,98 1200,100${TO_FOOT}"/>` +
		`<path class="ps-l-far" d="M0,128 C200,120 400,132 600,126 C800,120 1000,132 1200,126${TO_FOOT}"/>` +
		shrubs +
		`<path class="ps-l-riverbed" d="${RIVER}"/>` +
		`<g class="ps-l-bedstone"><ellipse cx="352" cy="150" rx="4" ry="1.6"/><ellipse cx="330" cy="167" rx="5" ry="2"/>` +
		`<ellipse cx="402" cy="186" rx="4.5" ry="1.8"/><ellipse cx="468" cy="199" rx="6" ry="2.2"/><ellipse cx="520" cy="222" rx="5" ry="2"/>` +
		`<ellipse cx="496" cy="238" rx="7" ry="2.6"/><ellipse cx="376" cy="178" rx="3" ry="1.3"/></g>` +
		`<path class="ps-l-river" d="${RIVER}" fill="url(#ps-river-sky)"/>` +
		`<path class="ps-l-river-hi" d="M350,146 C320,156 290,164 340,176 C400,190 500,196 530,214"/>` +
		`<path class="ps-l-hill2" d="${HILL2_EDGE}${TO_FOOT}"/>` +
		`<path class="ps-l-rim" d="${HILL2_EDGE}"/>` +
		far +
		`<g class="ps-l-grove"><ellipse class="ps-l-tree" cx="448" cy="160" rx="16" ry="12"/><ellipse class="ps-l-tree" cx="466" cy="163" rx="12" ry="10"/>` +
		`<ellipse class="ps-l-tree" cx="432" cy="166" rx="10" ry="8"/><rect class="ps-l-trunk" x="447" y="168" width="3" height="8"/></g>` +
		`<g class="ps-l-grove"><ellipse class="ps-l-tree" cx="1008" cy="168" rx="9" ry="7"/><rect class="ps-l-trunk" x="1007" y="173" width="2" height="6"/></g>` +
		`<path class="ps-l-hill1" d="${HILL1_EDGE}${TO_FOOT}"/>` +
		`<path class="ps-l-rim" d="${HILL1_EDGE}"/>` +
		near +
		`<path class="ps-l-grass" d="${GRASS_EDGE}${TO_FOOT}"/>` +
		`</svg>`
	);
}

/** The flowers' colours, the mockup's five. */
const FLOWER_COLOURS = ["#f3c85a", "#f6f0e4", "#e79a7a", "#c9b0e6", "#f2a65a"];

/**
 * The near grass: one path of blades along the whole foot of the window, in a
 * group that sways (ps.css `ps-sway`), and fifty small flowers among them. On
 * the mockup's 1200 × 120 box, anchored to the bottom and sliced, so a narrow
 * window crops the sides rather than squashing the blades.
 */
export function nearGrass(): string {
	// One stream, as the mockup's: the blades, then the flowers.
	const r = rng(4242);
	let d = "";

	for (let x = -4; x < 1206; x += 3.2 + r() * 2.4) {
		const h = 26 + r() * 46;
		const lean = (r() - 0.5) * 16;
		const w = 1.6 + r() * 1.8;
		d +=
			`M${(x - w).toFixed(1)},120 Q${(x + lean * 0.4).toFixed(1)},${(120 - h * 0.55).toFixed(
				1
			)} ${(x + lean).toFixed(1)},${(120 - h).toFixed(1)} ` +
			`Q${(x + lean * 0.3 + w * 0.4).toFixed(1)},${(120 - h * 0.5).toFixed(1)} ${(
				x + w
			).toFixed(1)},120 Z `;
	}

	let flowers = "";

	for (let i = 0; i < 50; i++) {
		const fill = FLOWER_COLOURS[Math.floor(r() * 5)];
		const cx = (r() * 1200).toFixed(0);
		const cy = (70 + r() * 44).toFixed(0);
		const radius = (1.4 + r() * 1.4).toFixed(1);
		flowers += `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${fill}"/>`;
	}

	return (
		`<svg class="ps-blades" viewBox="0 0 1200 120" preserveAspectRatio="xMidYMax slice" aria-hidden="true">` +
		`<g class="ps-sway"><path d="${d.trim()}"/></g>${flowers}</svg>`
	);
}

/** A px drift of the mockup's (at its 16 px rem) in rem. */
const rem = (px: string) => `${Number(px) / 16}rem`;

/**
 * `count` fireflies for the far fields, each with its own place, drift and
 * blink (ps.css `ps-ffdrift`, `ps-ffblink`); the mockup's px drift in rem.
 * Seeded, so the phone's half are the first half of the window's.
 */
export function fireflies(count: number): string {
	const r = rng(31337);
	let out = "";

	for (let i = 0; i < count; i++) {
		const left = (r() * 100).toFixed(1);
		const top = (r() * 100).toFixed(1);
		const d = (5 + r() * 6).toFixed(1);
		const dl = (-r() * 6).toFixed(1);
		const dx = rem((r() * 60 - 30).toFixed(0));
		const dy = rem((r() * 26 - 13).toFixed(0));
		const b = (2.6 + r() * 3.2).toFixed(1);
		const bl = (-r() * 5).toFixed(1);
		out += `<i style="left:${left}%;top:${top}%;--d:${d}s;--dl:${dl}s;--dx:${dx};--dy:${dy};--b:${b}s;--bl:${bl}s"></i>`;
	}

	return out;
}

/** A point on a quadratic curve whose control point sits midway across, so x runs linearly with t. */
function onCurve(y0: number, y1: number, y2: number, t: number): number {
	return (1 - t) ** 2 * y0 + 2 * t * (1 - t) * y1 + t * t * y2;
}

/**
 * The patterned band's 16 marks. The band runs 38 → 202 under the roof's
 * edge; what shows of it is the strip between that edge (`M24,101 Q120,86
 * 216,101`) and the band's foot (`M38,107 Q120,99 202,107`). The marks are
 * spread evenly across the band, symmetric about the yurt's middle (x = 120),
 * and each sits halfway down the strip at its own centre. (The mockup's
 * `bandMarks` stepped from x = 44 by 10.2 and took each mark's height off a
 * sine at its left point: the row stood 3.5 units right of centre, its last
 * mark past the band's end, tilted, and up against the roof — the user saw
 * them "offset", 2026-10-08.)
 */
export const BAND_MARKS = 16;
const BAND_FROM = 38;
const BAND_TO = 202;

export function bandMarkCentres(): Array<{x: number; y: number}> {
	const step = (BAND_TO - BAND_FROM) / BAND_MARKS;
	return Array.from({length: BAND_MARKS}, (_, i) => {
		const x = BAND_FROM + step * (i + 0.5);
		const roof = onCurve(101, 86, 101, (x - 24) / 192);
		const top = onCurve(98, 90, 98, (x - BAND_FROM) / (BAND_TO - BAND_FROM));
		const foot = onCurve(107, 99, 107, (x - BAND_FROM) / (BAND_TO - BAND_FROM));
		return {x, y: (Math.max(roof, top) + foot) / 2};
	});
}

function bandMarks(): string {
	return bandMarkCentres()
		.map(({x, y}) => `<path d="M${n(x - 3)},${n(y)} l3,-2.4 l3,2.4 l-3,2.4 Z"/>`)
		.join("");
}

/** The wall's outline: the felt, and over it the inner glow at night. */
const WALL = "M38,150 L38,98 Q120,90 202,98 L202,150 Q120,158 38,150 Z";

/**
 * The yurt (docs/projects/ps-theme.md §5.3): felt walls and roof with a rope
 * band and ribs, the patterned band, the carved door, the crown ring and its
 * stove pipe, stones and a woodpile beside it, and the pool at the door. On
 * the mockup's 240 × 170 box; ps.css sizes it on the ground band and scene.ts
 * decides where it stands. The `ps-y-lit` parts glow at night, and the door's
 * light falls as a soft pool on the ground before it (`ps-y-pool`), only at
 * night: the user's pick over the mockup's cone down a worn path, and the
 * path itself is not drawn, by day or at night (2026-09-25); `ps-y-snow` is
 * the winter roof. The warm glows and the shadow are the mockup's fixed
 * colours; every other part is a class that ps.css paints from the palette.
 */
export function yurtSvg(): string {
	return (
		`<svg viewBox="0 0 240 170" aria-hidden="true">` +
		`<defs>` +
		`<linearGradient id="ps-y-wall" x1="0" x2="1"><stop offset="0" class="ps-y-felt-l"/><stop offset=".48" class="ps-y-felt-c"/><stop offset="1" class="ps-y-felt-l"/></linearGradient>` +
		`<linearGradient id="ps-y-roof" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="ps-y-roof-t"/><stop offset="1" class="ps-y-roof-b"/></linearGradient>` +
		`<radialGradient id="ps-y-inner" cx=".5" cy=".62" r=".6"><stop offset="0" stop-color="#ffd48c" stop-opacity=".62"/><stop offset=".6" stop-color="#ffb86a" stop-opacity=".2"/><stop offset="1" stop-color="#ffb86a" stop-opacity="0"/></radialGradient>` +
		`<radialGradient id="ps-y-pool" cx=".5" cy=".42" r=".58"><stop offset="0" stop-color="#ffc47a" stop-opacity=".78"/><stop offset=".55" stop-color="#ffb060" stop-opacity=".3"/><stop offset="1" stop-color="#ffb060" stop-opacity="0"/></radialGradient>` +
		`<radialGradient id="ps-y-crown-glow"><stop offset="0" stop-color="#ffd08a" stop-opacity=".95"/><stop offset="1" stop-color="#ff9f4a" stop-opacity="0"/></radialGradient>` +
		`<filter id="ps-y-blur" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="2.4"/></filter>` +
		`<filter id="ps-y-soft" x="-80%" y="-120%" width="260%" height="340%"><feGaussianBlur stdDeviation="5"/></filter>` +
		`</defs>` +
		`<ellipse cx="120" cy="152" rx="96" ry="7" fill="#000" opacity=".16"/>` +
		`<ellipse class="ps-y-pool" cx="120" cy="157" rx="58" ry="15" fill="url(#ps-y-pool)" filter="url(#ps-y-soft)"/>` +
		`<g class="ps-y-wood"><rect x="20" y="136" width="22" height="5" rx="2.5"/><rect x="22" y="131" width="19" height="5" rx="2.5"/><rect x="25" y="126" width="13" height="5" rx="2.5"/></g>` +
		`<g class="ps-y-stone"><ellipse cx="100" cy="160" rx="5" ry="2.2"/><ellipse cx="140" cy="164" rx="5.5" ry="2.4"/></g>` +
		`<path d="${WALL}" fill="url(#ps-y-wall)"/>` +
		`<path d="${WALL}" fill="url(#ps-y-inner)" class="ps-y-lit"/>` +
		`<g class="ps-y-rope" fill="none" stroke-width="1.3" opacity=".6">` +
		`<path d="M38,114 Q120,121 202,114"/><path d="M38,130 Q120,137 202,130"/><path d="M38,145 Q120,152 202,145"/>` +
		`</g>` +
		`<path class="ps-y-band" d="M38,98 Q120,90 202,98 L202,107 Q120,99 38,107 Z"/>` +
		`<g class="ps-y-band-mark">${bandMarks()}</g>` +
		`<path class="ps-y-roof" d="M24,101 Q120,86 216,101 L133,49 Q120,45 107,49 Z" fill="url(#ps-y-roof)"/>` +
		`<path class="ps-y-snow" d="M27,99 Q120,85 213,99 L201,91 Q170,78 132,55 Q120,50 108,55 Q70,78 39,91 Z"/>` +
		`<g class="ps-y-rib" stroke-width=".8" opacity=".55" fill="none">` +
		`<path d="M110,50 L44,99"/><path d="M114,49 L70,95"/><path d="M118,48 L97,92"/><path d="M122,48 L143,92"/><path d="M126,49 L170,95"/><path d="M130,50 L196,99"/>` +
		`</g>` +
		`<ellipse class="ps-y-crown" cx="120" cy="48" rx="14" ry="4.2"/>` +
		`<ellipse cx="120" cy="47" rx="16" ry="9" fill="url(#ps-y-crown-glow)" class="ps-y-lit" filter="url(#ps-y-blur)"/>` +
		`<rect class="ps-y-pipe" x="116.5" y="24" width="7" height="24" rx="1.2"/>` +
		`<rect class="ps-y-pipe" x="114.5" y="22" width="11" height="3" rx="1"/>` +
		`<path d="M103,151 L103,119 Q120,113 137,119 L137,151 Z" fill="#ffcf7a" class="ps-y-lit" filter="url(#ps-y-blur)"/>` +
		`<path class="ps-y-door" d="M104,151 L104,120 Q120,114.5 136,120 L136,151 Z"/>` +
		`<g class="ps-y-door-orn" fill="none" stroke-width="1.1" opacity=".85">` +
		`<path d="M108,148 L108,123 Q120,118.5 132,123 L132,148 Z"/><path d="M120,122 L120,146"/><path d="M113,134 Q116,130 120,134 Q124,138 127,134"/>` +
		`</g>` +
		`<path d="M104,151 L104,120 Q120,114.5 136,120 L136,151" fill="none" stroke="#ffd98f" stroke-width="1.4" class="ps-y-lit"/>` +
		`</svg>`
	);
}

/** The mockup's five puffs: each rise's length and delay (s), and its width in px at a 16 px rem. */
const PUFFS = [
	{d: 6.2, dl: 0, w: 9},
	{d: 7.1, dl: 1.5, w: 11},
	{d: 6.6, dl: 3, w: 8},
	{d: 7.6, dl: 4.4, w: 12},
	{d: 6.9, dl: 5.6, w: 9},
];

/**
 * The smoke from the yurt's crown at night: five puffs that rise, drift and
 * spread, each on its own clock (ps.css `ps-smoke-rise`), sized in rem. ps.css
 * stands the group on the pipe.
 */
export function smoke(): string {
	return PUFFS.map(
		(p) =>
			`<i style="--sd:${p.d}s;--sdl:${p.dl}s;width:${p.w / 16}rem;height:${p.w / 16}rem"></i>`
	).join("");
}

/**
 * The mockup's five clouds: width in its px (at its 1180 px window), height
 * as % of the scene, and the drift's length and delay in seconds.
 */
const CLOUDS = [
	{w: 170, y: 9, d: 230, dl: -40},
	{w: 104, y: 21, d: 280, dl: -160},
	{w: 210, y: 30, d: 320, dl: -100},
	{w: 80, y: 14, d: 200, dl: -70},
	{w: 130, y: 24, d: 260, dl: -215},
];

/** Each cloud's five blobs, as fractions of its box: left, top, width, height. */
const BLOBS = [
	[0, 0.45, 0.55, 0.55],
	[0.18, 0.12, 0.44, 0.8],
	[0.45, 0.2, 0.4, 0.72],
	[0.64, 0.42, 0.36, 0.56],
	[0.28, 0.5, 0.5, 0.5],
];

/** The mockup's window, which its px travel and sizes were drawn against. */
const WINDOW_W = 11.8; // px per cqw at its 1180 px width
const WINDOW_H = 7; // px per cqh at its 700 px height

/** A px length of the mockup's in cqw / cqh / rem (at its 16 px rem). */
const cqw = (px: number) => `${n(px / WINDOW_W)}cqw`;
const cqh = (px: number) => `${n(px / WINDOW_H)}cqh`;

/** A box's blobs, each [left, top, width, height] as fractions of it, in % of it. */
const blobs = (list: number[][]) =>
	list
		.map(
			([x, y, w, h]) =>
				`<i style="left:${n(x * 100)}%;top:${n(y * 100)}%;width:${n(w * 100)}%;height:${n(
					h * 100
				)}%"></i>`
		)
		.join("");

/**
 * One cloud of five blobs, sized in cqw of the scene at its own height and
 * drifting across it on its own clock (ps.css `ps-drift`); `--cp`, the
 * fraction of its loop its negative delay puts it at, is where reduced
 * motion rests it on the same path.
 */
const cloud = (c: {w: number; y: number; d: number; dl: number}) =>
	`<div class="ps-cloud" style="--cw:${cqw(c.w)};--cy:${c.y}%;--cd:${c.d}s;--cdl:${
		c.dl
	}s;--cp:${Number((-c.dl / c.d).toFixed(4))}">${blobs(BLOBS)}</div>`;

/**
 * The sky's clouds (spec §5.1), the mockup's five of five blobs each: sized
 * in cqw of the scene, placed at their own heights, each drifting across it
 * on its own clock (ps.css `ps-drift`, faster on a windy day); the blobs in %
 * of their cloud. Each carries `--cp`, the fraction of its loop its negative
 * delay puts it at, where reduced motion rests it on the same path (spread
 * across the sky, rather than all at the left edge). Their colours are the
 * palette's, which greys them by the weather. There in every weather, so
 * built once; rain and storms add their own (`weatherClouds`).
 */
export function clouds(): string {
	return CLOUDS.map(cloud).join("");
}

/**
 * Rain's four more clouds (the user, 2026-09-26: "rainstorms should be
 * cloudier"): bigger than any of the five (230 to 300 of the mockup's px
 * against its 80 to 210), sitting at 5 to 25 % of the height so they hang
 * lower, and slower. Their delays rest them, with the five, at nine places
 * across the sky (plains' test holds them apart), which is also where a
 * rainy day's page opens with them.
 */
const RAIN_CLOUDS = [
	{w: 280, y: 18, d: 360, dl: -50},
	{w: 300, y: 5, d: 340, dl: -170},
	{w: 250, y: 12, d: 300, dl: -214},
	{w: 230, y: 22, d: 290, dl: -265},
];

/** The storm deck's height, in % of the scene's (ps.css `.ps-deck`). */
export const DECK_HEIGHT = 34;

/** Rain's lighter deck's height, in % of the scene's (ps.css `.ps-deck.ps-deck-rain`). */
export const RAIN_DECK_HEIGHT = 22;

/**
 * Rain's billows' depth against the storm's: shallower, so the lighter deck's
 * foot is flatter and every billow hangs within its shallower band on the
 * mockup's window and a 16:9 desktop (plains' test holds it).
 */
const RAIN_DEPTH = 0.8;

/** The share of the deck's height its band covers from the top (ps.css `.ps-deck`'s background size). */
export const DECK_BAND = 58;

/**
 * The deck's billows along the foot of its band: left and width as fractions
 * of the deck, whose width is the scene's, and depth, each one's height over
 * its width. A billow's height is tied to its width, both following the
 * scene's width, and its centre sits on the band's lower edge, so every
 * window's shape draws the same wide ellipses and the band stays closed: at
 * the edge each billow is its whole width, and each overlaps the next (plains'
 * test measures it). Sized in % of the deck on both axes, as they were first,
 * a billow was a tall drip on a portrait phone, 78 × 143 px at 390 × 844.
 */
const DECK_BILLOWS = [
	[-0.04, 0.2, 0.5],
	[0.1, 0.22, 0.46],
	[0.26, 0.19, 0.5],
	[0.39, 0.24, 0.47],
	[0.57, 0.2, 0.5],
	[0.71, 0.21, 0.48],
	[0.86, 0.2, 0.5],
];

/** The deck's billows: left and width in % of the deck, top and height in cqw of the scene's width, each centred on the band's edge; `scale` their depth. */
const billows = (list: number[][], scale = 1) =>
	list
		.map(([x, w, depth]) => {
			const lift = Number(((w * 100 * depth * scale) / 2).toFixed(2));
			return `<i style="left:${n(x * 100)}%;top:calc(${DECK_BAND}% - ${n(lift)}cqw);width:${n(
				w * 100
			)}%;height:${n(lift * 2)}cqw"></i>`;
		})
		.join("");

/**
 * The day's own clouds, over and above the five (spec §5.1 layer 6), built
 * with the weather layer and rebuilt when the day's weather changes
 * (scene.ts), so a clear day's page holds none of them. Rain and storms get
 * four more, bigger and lower (RAIN_CLOUDS); behind them first, a storm lays
 * a low overcast deck across the top of the sky, a band of cloud a third of
 * the way down whose foot is a row of billows, still, and rain a lighter one,
 * a shallower band with flatter billows (the user: "yes to the rain deck").
 * Everything is
 * drawn in the palette's cloud colours, greyed by the weather, as the five
 * are. Nothing in any other weather.
 */
export function weatherClouds(weather: Weather): string {
	const wx = WEATHER[weather];
	let out = "";

	if (wx.storm > 0) {
		out += `<div class="ps-deck">${billows(DECK_BILLOWS)}</div>`;
	} else if (wx.rain > 0) {
		out += `<div class="ps-deck ps-deck-rain">${billows(DECK_BILLOWS, RAIN_DEPTH)}</div>`;
	}

	if (wx.rain > 0) {
		out += RAIN_CLOUDS.map(cloud).join("");
	}

	return out;
}

/** The mockup's particle counts; a phone gets half. */
const RAIN_DROPS = 130;
const SNOWFLAKES = 120;
const SEEDS = 26;

/** `count` rain drops, each falling on its own clock (ps.css `ps-drop`). */
function rain(count: number): string {
	const r = rng(1301);
	let out = "";

	for (let i = 0; i < count; i++) {
		const left = (r() * 110).toFixed(1);
		const d = (0.55 + r() * 0.35).toFixed(2);
		const dl = (-r() * 1.2).toFixed(2);
		const opacity = (0.4 + r() * 0.6).toFixed(2);
		out += `<i style="left:${left}%;--rd:${d}s;--rdl:${dl}s;opacity:${opacity}"></i>`;
	}

	return `<div class="ps-rain">${out}</div>`;
}

/** `count` snowflakes, each sized in rem and drifting sideways in cqw as it falls (ps.css `ps-flake`). */
function snow(count: number): string {
	const r = rng(1201);
	let out = "";

	for (let i = 0; i < count; i++) {
		const left = (r() * 105).toFixed(1);
		const size = Number((2 + r() * 3.4).toFixed(1)) / 16;
		const d = (7 + r() * 7).toFixed(1);
		const dl = (-r() * 14).toFixed(1);
		const fx = cqw(Number((r() * 80 - 50).toFixed(0)));
		const opacity = (0.5 + r() * 0.5).toFixed(2);
		out += `<i style="left:${left}%;--fs:${size}rem;--fd:${d}s;--fdl:${dl}s;--fx:${fx};opacity:${opacity}"></i>`;
	}

	return `<div class="ps-snow">${out}</div>`;
}

/** `count` seeds blown across on the wind, each at its own height, rising or sinking in cqh (ps.css `ps-seed`). */
function seeds(count: number): string {
	const r = rng(2601);
	let out = "";

	for (let i = 0; i < count; i++) {
		const y = (r() * 100).toFixed(0);
		const d = (3.5 + r() * 3).toFixed(1);
		const dl = (-r() * 6).toFixed(1);
		const sy = cqh(Number((r() * 60 - 30).toFixed(0)));
		out += `<i style="--y:${y}%;--sd:${d}s;--sdl:${dl}s;--sy:${sy}"></i>`;
	}

	return `<div class="ps-seeds">${out}</div>`;
}

/**
 * The heat haze (spec §5.5, the mockup's final values: a 0.007 × 0.05
 * turbulence, displacement 2, a 9 s cycle), alone in an svg of no size — not
 * `display: none`, where a reference to the filter may not resolve. ps.css
 * applies it to the ground group, and only by day (`ps-hot`).
 */
const HEAT_HAZE =
	`<svg class="ps-heat-haze" width="0" height="0" aria-hidden="true" focusable="false">` +
	`<filter id="ps-heat" x="0" y="-5%" width="100%" height="110%">` +
	`<feTurbulence type="turbulence" baseFrequency="0.007 0.05" numOctaves="2" seed="4" result="h">` +
	`<animate attributeName="baseFrequency" dur="9s" repeatCount="indefinite" values="0.007 0.05;0.009 0.038;0.007 0.05"/>` +
	`</feTurbulence>` +
	`<feDisplacementMap in="SourceGraphic" in2="h" scale="2" xChannelSelector="R" yChannelSelector="G"/>` +
	`</filter>` +
	`</svg>`;

/**
 * What the day's weather shows over the scene (spec §5.1 layer 10, §10: only
 * the weather that is happening exists in the page), from the weather's own
 * levels (palette.ts `WEATHER`): seeds whenever it has wind — a windy day, and
 * the lesser winds of rain, storm and snow, the mockup's, shown at
 * --ps-wind-op; rain drops in rain and storm, and the storm's lightning;
 * snowflakes in snow; the heat band and the haze on a hot day; nothing on a
 * clear day. (The veil is the scene's own layer, there in every weather at
 * the weather's level.) A phone (the phone layout) gets half the particles.
 * Seeded, one stream per
 * kind, so the phone's half are the first half of the window's; the mockup
 * drew all three from the one stream its birds had used, which cannot be
 * reproduced without them, so the scatter differs from the mockup's and the
 * drawing does not. The scene rebuilds this when the weather changes
 * (scene.ts `weatherChanged`).
 */
export function weatherLayers(weather: Weather, phone: boolean): string {
	const wx = WEATHER[weather];
	const part = (count: number) => (phone ? count / 2 : count);
	// Back to front, as the mockup's: seeds, rain, snow, the flash; then the heat's.
	let out = "";

	if (wx.wind > 0) {
		out += seeds(part(SEEDS));
	}

	if (wx.rain > 0) {
		out += rain(part(RAIN_DROPS));
	}

	if (wx.snow > 0) {
		out += snow(part(SNOWFLAKES));
	}

	if (wx.storm > 0) {
		out += `<div class="ps-flash"></div>`;
	}

	if (wx.heat > 0) {
		out += `<div class="ps-heatband"></div>` + HEAT_HAZE;
	}

	return out;
}
