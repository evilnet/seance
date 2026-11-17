/**
 * The yurt's colour and light by the minute (docs/projects/ps-yurt.md §6, §9).
 * The room is painted through classes (yurt.ts `fill`): each colour here is a
 * `ps-yt-c-<name>` whose CSS mixes it warm by the golden hour and toward night
 * by the hour's shade, both custom properties the minute writes (`indoorVars`),
 * so the night needs no masks over the room; the windows and the crown read the
 * plains' own sky and land properties and are never shaded. The same mixing,
 * done here in numbers, gives the room's grounds for the legibility model and
 * the query's glass tints. Pure and Vue-free: mocha loads it directly.
 */
import {hexRgb, mixOklab, rgbHex} from "./colour";
import type {Moment} from "./engine";
import type {SceneGround} from "./grounds";
import {GLASS_NIGHT_AT, WEATHER, type Palette} from "./palette";

/**
 * Every colour the room is painted with, by name: the approved mockup's
 * table and the literals its pieces and small things paint
 * (docs/resources/themes/ps-yurt/mockup.html). Lit by day; the page shades
 * them by the minute.
 *
 * Six of the mockup's darkest colours are lighter, each only as far as the
 * floors need at today's glass caps (the user's choice, 2026-11-14:
 * "Lighten the darkest room colours"; docs/projects/ps-yurt.md §9 has the
 * table): the OKLCH lightness alone raised, chroma and hue kept —
 * ironShadow #18191d → #3d3e42 (+0.15), ironD #1c1d22 → #3c3d43 (+0.13),
 * monitor #1d212b → #383c47 (+0.11), ironMid #34363d → #3c3e45 (+0.03),
 * pipe #383a41 → #3b3d44 (+0.01), woodD #5a341c → #5d371f (+0.01).
 */
export const ROOM_COLOURS = {
	roofA: "#ecdcbc",
	roofB: "#d9bf95",
	wallA: "#f4e9d6",
	wallB: "#e4d0ae",
	lattice: "#b3653a",
	pole: "#c8602f",
	poleEdge: "#9e4a24",
	crown: "#a24f28",
	floorA: "#9c7049",
	floorB: "#c29466",
	board: "#86603d",
	band: "#a8473a",
	skirt: "#8e3a30",
	furn: "#c8602f",
	furnD: "#9a4724",
	furnL: "#d9773f",
	blue: "#2c5d86",
	blueD: "#24506f",
	green: "#3f7f5a",
	cream: "#f2dcb0",
	gold: "#d9a640",
	wood: "#7a4a2a",
	woodD: "#5d371f",
	woodL: "#9a6a42",
	woodRed: "#7a3a1c",
	rug: "#9e2f2a",
	rugB: "#e6c78f",
	rugP: "#24466e",
	curtain: "#a8473a",
	hearth: "#6d6a66",
	hearthL: "#807c77",
	iron: "#2c2d33",
	ironD: "#3c3d43",
	// The stove's firebox and its coal bed (plan 3), warm and as dark as §9's floors allow by day: about the
	// door's own iron, which plan 1 lightened to the sweep's limit; the hour's shade darkens them by night.
	firebox: "#4a3f41",
	coalBed: "#573730",
	ironLit: "#4a4c55",
	ironMid: "#3c3e45",
	ironShadow: "#3d3e42",
	ironL: "#45474f",
	ironTop: "#3a3c43",
	ironTopL: "#4a4c54",
	ironRing: "#5c5f68",
	collar: "#33353c",
	collarTop: "#3e4048",
	pipe: "#3b3d44",
	pipeBand: "#4d5059",
	doorEdge: "#5a5c64",
	handle: "#8a8d96",
	brassA: "#7a5a20",
	brassB: "#e3b85a",
	brassC: "#b98b34",
	brassD: "#6a4c1a",
	copper: "#b8693a",
	copperD: "#9a5530",
	potIron: "#4b4e57",
	potIronL: "#5a5d66",
	mattress: "#efe6d6",
	pillow: "#f7f0e2",
	pillowShade: "#e8dcc7",
	crease: "#d9ccb4",
	sheet: "#f3ece0",
	sheetSide: "#e9e0d0",
	quiltTop: "#457095",
	monitor: "#383c47",
	stand: "#2a2d36",
	keys: "#d9d6cf",
	screenDay: "#9fb4cc",
	boots: "#5a3a24",
	mirror: "#c9d6e2",
	photoSky: "#bcd3e6",
	photoHill: "#7c8fae",
	photoGrass: "#9cba7c",
	clay: "#b5562e",
	leaf: "#4f8a4a",
	chimney: "#fff2d6",
	china: "#f2ead9",
	chinaB: "#e4d8bf",
	plate: "#f1ead8",
	jarAmber: "#cfa86a",
	jarGreen: "#7fa86a",
	thermos: "#b83a34",
	tin: "#c9cdd4",
	tinL: "#e1e4e9",
	dough: "#efe6d4",
	doughL: "#fbf4e6",
	doughEdge: "#d8c6a6",
	log: "#8a5a32",
	logEnd: "#c89a6a",
	wicker: "#a8763f",
	wickerD: "#7a5028",
	white: "#ffffff",
	black: "#000000",
} as const;

export type RoomColour = keyof typeof ROOM_COLOURS;

/** What is never shaded: the fire's stops and flames, the glow under them, the lamp's flame, the screen at night. */
export const ROOM_LIT: readonly string[] = [
	"#fff6c0",
	"#ffb347",
	"#e2582a",
	"#9c2f1a",
	"#fff6c4",
	"#ffcf6a",
	"#ffe7a0",
	"#a9c6ff",
];

/**
 * The firebox at night (plan 3): a dark that fades in over the firebox's room colour once the night glass
 * is up (the `cavity` level), never shaded; the sweep sees it at that strength.
 */
export const FIREBOX_BURNING = "#120d10";

/** What the shade mixes toward, and what the golden hour mixes toward. */
export const ROOM_NIGHT = "#0b0f24";
export const ROOM_WARM = "#ff9a50";

/** The fire's and the lamp's glows (a screen blend over the room; room.ts's glow gradients). */
const FIRE_GLOW = "#ffa040";
const LAMP_GLOW = "#ffd08a";

export interface IndoorLevels {
	/** How far toward night the room is shaded. */
	shade: number;
	/** How far its colours are warmed: by the golden hour, and by the stove at night. */
	warm: number;
	/** The golden hour's light through the windows and on the floor: clear weather only, never at night. */
	golden: number;
	/** The stove's glow: the burn's, a little stronger in a storm. */
	fire: number;
	/** How far the stove burns: the plains' own chimney smoke (palette.ts smokeOpacity), dusk to dawn (§16). */
	burn: number;
	/**
	 * How dark the firebox is behind the flames: none while the day glass is up (palette.ts GLASS_NIGHT_AT),
	 * where §9's floors bind it, then with the dark, full by 0.9, about where the burn is (plan 3's review).
	 */
	cavity: number;
	/** The lamp on the chests: on at night, in a storm and in an overcast golden hour. */
	lamp: number;
	/** The sun through the crown, and its pool on the floor. */
	beam: number;
	/** The sun's disc low in the back window. */
	sun: number;
	/** The computer's screen glowing at night. */
	screen: number;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function indoorLevels(m: Moment, p: Palette): IndoorLevels {
	const wx = WEATHER[m.weather];
	const clear = wx.hide === 0;
	return {
		shade: 0.74 * p.dark + 0.55 * wx.dim * (1 - p.dark),
		warm: 0.2 * p.glowOpacity * (1 - p.dark) + 0.3 * p.dark,
		golden: clear ? 0.2 * p.glowOpacity * (1 - p.dark) : 0,
		fire: Math.min(1, p.smokeOpacity * (0.8 + 0.18 * wx.storm)),
		burn: p.smokeOpacity,
		cavity: p.dark > GLASS_NIGHT_AT ? Math.min(1, (p.dark - GLASS_NIGHT_AT) / 0.4) : 0,
		lamp: Math.max(
			clamp01((p.dark - 0.3) / 0.3),
			wx.storm,
			wx.hide > 0 && p.glowOpacity > 0.5 ? 1 : 0
		),
		beam: clear && m.sun.up ? clamp01(m.sun.alt * 1.6) : 0,
		sun: clear && m.sun.up && m.sun.alt >= 0 && m.sun.alt < 0.2 ? 1 - m.sun.alt / 0.2 : 0,
		screen: p.dark,
	};
}

/** A room colour as the page paints it at these levels: warmed, then shaded (roomCss's two color-mix). */
export function shadeRoom(hex: string, l: Pick<IndoorLevels, "shade" | "warm">): string {
	return mixOklab(mixOklab(hex, ROOM_WARM, 1 - l.warm), ROOM_NIGHT, 1 - l.shade);
}

/** The levels as the custom properties the room's CSS reads, written on the scene's root each minute. */
export function indoorVars(m: Moment, p: Palette): Record<string, string> {
	const l = indoorLevels(m, p);
	return Object.fromEntries(
		(Object.keys(l) as Array<keyof IndoorLevels>).map((k) => [`--ps-in-${k}`, l[k].toFixed(3)])
	);
}

/** The colour the room's CSS gives `hex` from the minute's levels. */
const mixed = (hex: string) =>
	`color-mix(in oklab, color-mix(in oklab, ${hex}, ${ROOM_WARM} calc(var(--ps-in-warm) * 100%)), ${ROOM_NIGHT} calc(var(--ps-in-shade) * 100%))`;

/**
 * The room's stylesheet: a fill, a stroke and a gradient stop for every colour, the faces' shades,
 * and the light by its levels. A stroke keeps its own property (--s), so one shape can carry a
 * fill colour and a stroke colour at once.
 */
export function roomCss(): string {
	const colours = (Object.entries(ROOM_COLOURS) as Array<[RoomColour, string]>)
		.map(
			([k, hex]) =>
				`.ps-yt-c-${k} { --c: ${mixed(hex)}; fill: var(--c); }\n` +
				`.ps-yt-s-${k} { --s: ${mixed(hex)}; stroke: var(--s); }`
		)
		.join("\n");
	return (
		colours +
		"\n.ps-yt-stop { stop-color: var(--c); }" +
		"\n.ps-yt-f-side, .ps-yt-f-left, .ps-yt-f-right { fill: color-mix(in oklab, var(--c), #000 16%); }" +
		"\n.ps-yt-f-top { fill: color-mix(in oklab, var(--c), #fff 14%); }" +
		"\n.ps-yt-f-bottom { fill: color-mix(in oklab, var(--c), #000 28%); }" +
		"\n.ps-yt-beam, .ps-yt-pool-sun { opacity: var(--ps-in-beam); }" +
		"\n.ps-yt-golden { opacity: var(--ps-in-golden); }" +
		"\n.ps-yt-glow-fire { opacity: var(--ps-in-fire); }" +
		"\n.ps-yt-burn { opacity: var(--ps-in-burn); }" +
		"\n.ps-yt-cavity { opacity: var(--ps-in-cavity); }" +
		"\n.ps-yt-glow-lamp { opacity: var(--ps-in-lamp); }" +
		"\n.ps-yt-glow-screen { opacity: var(--ps-in-screen); }" +
		"\n.ps-yt-window-sun { opacity: var(--ps-in-sun); }" +
		"\n.ps-yt-star { opacity: var(--ps-stars); }" +
		"\n.ps-yt-moon { opacity: var(--ps-moon-op); }"
	);
}

/** The roof's colour at the minute: the canvas and the iOS status bar in a private conversation (spec §10). */
export function roofColourAt(m: Moment, p: Palette): string {
	return shadeRoom(ROOM_COLOURS.roofA, indoorLevels(m, p));
}

/**
 * The room's grounds (spec §9, grounds.ts's rule): every fill that can stand
 * behind a line of text. Lines and small marks are not grounds: the lattice,
 * the poles, the crown's ribs, the boards, knobs, finials, the brass bands,
 * the small ornaments and every small thing on a shelf or a table.
 */
export const ROOM_GROUNDS: readonly RoomColour[] = [
	"wallA",
	"wallB",
	"roofA",
	"roofB",
	"crown",
	"floorA",
	"floorB",
	"rug",
	"rugB",
	"rugP",
	"hearth",
	"hearthL",
	"ironD",
	"firebox",
	"coalBed",
	"ironLit",
	"ironMid",
	"ironShadow",
	"ironTop",
	"pipe",
	"pole",
	"furn",
	"furnL",
	"furnD",
	"blue",
	"cream",
	"gold",
	"wood",
	"woodL",
	"woodD",
	"curtain",
	"band",
	"skirt",
	"mattress",
	"pillow",
	"quiltTop",
	"monitor",
];

/** The grounds the header covers: the roof, the crown and the sky through it. */
const TOP: readonly RoomColour[] = ["roofA", "roofB", "crown"];

/** The stove's own colours: room.ts draws the stove again over its glow, so the glows never light them. */
const STOVE: readonly RoomColour[] = [
	"ironD",
	"firebox",
	"coalBed",
	"ironLit",
	"ironMid",
	"ironShadow",
	"ironTop",
	"pipe",
];

/**
 * The grounds the fire's glow and the lamp's reach (a screen blend over the walls, the floor and
 * everything standing): every ground below the roof but the stove's. The lamp's reach is smaller;
 * taking the same list checks more than it lights.
 */
const UNDER_GLOW: readonly RoomColour[] = ROOM_GROUNDS.filter(
	(k) => !TOP.includes(k) && !STOVE.includes(k)
);

/** A screen blend of `light` at `alpha` over `base`, per sRGB channel. */
function screen(base: string, light: string, alpha: number): string {
	const a = hexRgb(base);
	const b = hexRgb(light);
	const ch = (i: number) => 255 * (1 - (1 - a[i] / 255) * (1 - (alpha * b[i]) / 255));
	return rgbHex(ch(0), ch(1), ch(2));
}

/** `top` painted at `alpha` over `base`, per sRGB channel. */
function over(base: string, top: string, alpha: number): string {
	const a = hexRgb(base);
	const b = hexRgb(top);
	const ch = (i: number) => a[i] + (b[i] - a[i]) * alpha;
	return rgbHex(ch(0), ch(1), ch(2));
}

export function indoorGrounds(m: Moment, p: Palette): SceneGround[] {
	const l = indoorLevels(m, p);
	const out: SceneGround[] = [];
	const add = (area: string, hex: string, zone: "top" | "middle") =>
		out.push({area, name: `${area} ${hex}`, hex, body: "land", below: false, zone});

	for (const key of ROOM_GROUNDS) {
		add(`room ${key}`, shadeRoom(ROOM_COLOURS[key], l), TOP.includes(key) ? "top" : "middle");
	}

	if (l.cavity > 0) {
		add(
			"room firebox burning",
			over(shadeRoom(ROOM_COLOURS.firebox, l), FIREBOX_BURNING, l.cavity),
			"middle"
		);
	}

	// The windows' panes and the crown's sky: the plains' own colours, never shaded.
	for (const [name, hex] of [
		["skyTop", p.skyTop],
		["skyMid", p.skyMid],
		["skyHorizon", p.skyHorizon],
		["mount2", p.mount2],
		["mount", p.mount],
		["far", p.far],
		["hill2", p.hill2],
		["cloud", p.cloud],
	] as const) {
		add(`room pane ${name}`, hex, "middle");
	}

	add("room crown sky", mixOklab(p.skyTop, p.skyMid, 0.65), "top");

	if (l.fire > 0) {
		for (const key of UNDER_GLOW) {
			add(
				`room ${key} under the fire`,
				screen(shadeRoom(ROOM_COLOURS[key], l), FIRE_GLOW, 0.85 * l.fire),
				"middle"
			);
		}
	}

	if (l.lamp > 0) {
		for (const key of UNDER_GLOW) {
			add(
				`room ${key} under the lamp`,
				screen(shadeRoom(ROOM_COLOURS[key], l), LAMP_GLOW, 0.8 * l.lamp),
				"middle"
			);
		}
	}

	return out;
}
