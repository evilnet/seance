/**
 * The stove's fire (docs/projects/ps-yurt.md §16; the user, 2026-11-21: "soft firelight, flowing"): three
 * layers of flame, red outside to white-hot within, each a loop of poses that fade into one another. A
 * pose is one flame silhouette in a flat space the door's opening is stretched over (60 wide, 54 tall,
 * the flames standing on the coals at 50), blurred once in its own svg. Every tongue's height, lean and
 * sway follow slow waves through the loop, so one pose differs only a little from the next and the fire
 * flows. The shapes and seeds are the approved mockup's (docs/resources/themes/ps-yurt/, the fire's
 * Artifact, version 4). Pure and DOM-free: mocha loads it directly.
 */
import {n} from "./yurt";

/** The flat space a pose is drawn in, the door's opening stretched over it, and where the flames stand. */
export const FLAME_SPACE = {width: 60, height: 54, base: 50} as const;

/** Poses in a layer's loop. */
export const FLAME_POSES = 6;

export interface FlameLayer {
	name: "outer" | "mid" | "inner";
	/** The span the layer's tongues stand across. */
	x0: number;
	x1: number;
	/** Tongues in the layer. */
	n: number;
	hMin: number;
	hMax: number;
	wMin: number;
	wMax: number;
	/** How far a tongue's tip leans, at most. */
	lean: number;
	/** The height of the body joining the tongues' feet. */
	body: number;
	/** The blur, in the space's units. */
	blur: number;
	/** The gradient from the foot up: [offset, colour, opacity?]. */
	stops: ReadonlyArray<readonly [string, string, string?]>;
	seed: number;
}

export const FLAME_LAYERS: readonly FlameLayer[] = [
	{
		name: "outer",
		x0: 6,
		x1: 54,
		n: 4,
		hMin: 22,
		hMax: 40,
		wMin: 7,
		wMax: 10,
		lean: 6,
		body: 16,
		blur: 1.7,
		stops: [
			["0", "#ff9a36"],
			[".45", "#ea5a26"],
			["1", "#a32a18", ".7"],
		],
		seed: 11,
	},
	{
		name: "mid",
		x0: 13,
		x1: 47,
		n: 3,
		hMin: 16,
		hMax: 30,
		wMin: 6,
		wMax: 8,
		lean: 4.5,
		body: 12,
		blur: 1.15,
		stops: [
			["0", "#ffe08a"],
			[".5", "#ffad3c"],
			["1", "#ff7a22", ".9"],
		],
		seed: 112,
	},
	{
		name: "inner",
		x0: 21,
		x1: 39,
		n: 2,
		hMin: 9,
		hMax: 18,
		wMin: 4.5,
		wMax: 6,
		lean: 3,
		body: 7,
		blur: 0.7,
		stops: [
			["0", "#fffbe6"],
			[".55", "#fff0b0"],
			["1", "#ffc84e"],
		],
		seed: 213,
	},
];

/** The white-hot core under the mid and inner flames, as the room draws it: [colour, opacity] stops. */
export const FLAME_CORE = {
	box: {x0: 14, y0: 39, x1: 46, y1: 53},
	stops: [
		["0", "#fffbe6", "1"],
		[".45", "#ffecaa", ".7"],
		["1", "#ffecaa", "0"],
	],
} as const;

/** The mockup's generator: a linear congruential sequence in [0, 1), the same on every device. */
function lcg(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

/** One tongue: a flame with a bulging foot, a pinched waist and a curling, pointed tip. */
function tongue(cx: number, base: number, w: number, h: number, lean: number): string {
	const p = (x: number, y: number) => `${n(x)} ${n(y)}`;
	return (
		`M${p(cx - w, base)}` +
		`C${p(cx - w * 1.15, base - h * 0.15)} ${p(
			cx - w * 0.85 + lean * 0.1,
			base - h * 0.38
		)} ${p(cx - w * 0.55 + lean * 0.25, base - h * 0.5)}` +
		`C${p(cx - w * 0.25 + lean * 0.45, base - h * 0.66)} ${p(
			cx + lean * 0.75 - w * 0.1,
			base - h * 0.86
		)} ${p(cx + lean, base - h)}` +
		`C${p(cx + lean * 0.6 + w * 0.3, base - h * 0.78)} ${p(
			cx + w * 0.55 + lean * 0.3,
			base - h * 0.62
		)} ${p(cx + w * 0.6 + lean * 0.2, base - h * 0.45)}` +
		`C${p(cx + w * 0.95, base - h * 0.3)} ${p(cx + w * 1.15, base - h * 0.12)} ${p(
			cx + w,
			base
		)}` +
		`Q${p(cx, base + w * 0.3)} ${p(cx - w, base)}Z`
	);
}

const cache = new Map<string, readonly string[]>();

/** A layer's poses, one path each: the tongues keep their places; heights, leans, sway and forks follow waves. */
export function flamePoses(layer: FlameLayer): readonly string[] {
	const hit = cache.get(layer.name);

	if (hit) {
		return hit;
	}

	const r0 = lcg(layer.seed);
	const base = FLAME_SPACE.base;
	const spots = Array.from({length: layer.n}, (_, i) => {
		const t = layer.n === 1 ? 0.5 : i / (layer.n - 1);
		const edge = 1 - Math.abs(t - 0.5) * 2;
		const cx = layer.x0 + (layer.x1 - layer.x0) * t + (r0() - 0.5) * 3;
		const w = layer.wMin + (layer.wMax - layer.wMin) * (0.4 + 0.6 * edge) * (0.85 + r0() * 0.3);
		const h = layer.hMin + (layer.hMax - layer.hMin) * (0.55 + 0.45 * edge);
		const ph = [r0(), r0(), r0(), r0(), r0()].map((v) => v * Math.PI * 2);
		return {cx, w, h, ph};
	});
	const poses = Array.from({length: FLAME_POSES}, (_, p) => {
		const th = (Math.PI * 2 * p) / FLAME_POSES;
		const {x0, x1, body} = layer;
		let d = `M${x0} ${base}C${x0} ${n(base - body * 1.25)} ${x1} ${n(
			base - body * 1.25
		)} ${x1} ${base}Z`;

		for (const s of spots) {
			const h =
				s.h * (0.86 + 0.2 * Math.sin(th + s.ph[0]) + 0.07 * Math.sin(2 * th + s.ph[1]));
			const lean = layer.lean * Math.sin(th + s.ph[2]);
			const cx = s.cx + 1.3 * Math.sin(th + s.ph[3]);
			d += tongue(cx, base, s.w, h, lean);
			const fork = Math.sin(th + s.ph[4]);

			if (fork > 0.15) {
				const side = lean < 0 ? 1 : -1;
				d += tongue(
					cx + side * s.w * 0.55,
					base - h * 0.4,
					s.w * 0.4 * fork,
					h * 0.35 * fork,
					side * 2.5
				);
			}
		}

		return d;
	});
	cache.set(layer.name, poses);
	return poses;
}

/** A pose's defs and path, blurred and filled with its layer's gradient; `id` prefixes its ids. */
export function flameShape(layer: FlameLayer, pose: number, id: string): string {
	const stops = layer.stops
		.map(
			([o, c, op]) =>
				`<stop offset="${o}" stop-color="${c}"${op ? ` stop-opacity="${op}"` : ""}/>`
		)
		.join("");
	return (
		`<defs><linearGradient id="${id}-g" x1="0" y1="1" x2="0" y2="0">${stops}</linearGradient>` +
		`<filter id="${id}-b" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${layer.blur}"/></filter></defs>` +
		`<path d="${flamePoses(layer)[pose]}" fill="url(#${id}-g)" filter="url(#${id}-b)"/>`
	);
}

/** A pose in its own svg, stretched over its box. */
export function flameSvg(layer: FlameLayer, pose: number, id: string): string {
	const {width, height} = FLAME_SPACE;
	return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">${flameShape(
		layer,
		pose,
		id
	)}</svg>`;
}
