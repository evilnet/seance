import {hexRgb} from "../ps/colour";

/**
 * The sun's fire (spec §5.1 layer 5, "animated like a brilliant fire"): the
 * flame disc's gradient, bent by fractal noise whose frequency drifts on a 7 s
 * loop, then softened. It used to be an SVG filter (feTurbulence →
 * feDisplacementMap → feGaussianBlur, baseFrequency under SMIL), and WebKit
 * runs those primitives in software at device resolution every time the
 * filter changes: on an iPhone 16 that was 3.9 cores of the GPU process and
 * the page at 13 frames a second (2026-10-08; a still turbulence is cached,
 * but any animated attribute in the chain, or a baked noise image panned
 * under the displacement, re-runs it all). So the same arithmetic runs here,
 * once per frame of the loop at a fraction of the resolution, and a canvas
 * the scene scales up shows it: the filter's own noise (the spec's reference
 * turbulence, same seed and octaves), its displacement and its blur.
 *
 * What a frame holds is where each pixel samples the flame's gradient, not a
 * colour, so the hour's colours (the palette's flame and edge, which change
 * by the minute) are applied when a frame is painted, through a 256-entry
 * table. NG drives it itself (fireDriver): no stepper, a frame cache bounded at one loop.
 */

/** The filter this replaces, in the sun's own units (its viewBox is -100…100). */
export const FIRE = {
	seed: 7,
	octaves: 3,
	/** feDisplacementMap's scale. */
	scale: 26,
	/** feGaussianBlur's stdDeviation. */
	blur: 1.2,
	/** The flame disc's radius. */
	radius: 56,
	/** The filter region's half-width: x="-60%" width="220%" of the disc's box. */
	region: 56 * 2.2,
	/** One loop of the baseFrequency drift, in seconds, and its values (linear, evenly spaced). */
	loop: 7,
	frequencies: [
		[0.034, 0.052],
		[0.046, 0.036],
		[0.03, 0.06],
		[0.034, 0.052],
	] as ReadonlyArray<readonly [number, number]>,
};

/** Frames of the loop painted and kept a second: 7 s × 24 = 168 fields of FIRE_SIZE² bytes, about 4.3 MB. */
export const FIRE_FPS_NG = 24;

/** The canvas's side in pixels: about 1.5 sun units a pixel; next to the blur, as fine as Chrome draws the filter (tmp check: mean difference 1.2/255). */
export const FIRE_SIZE = 160;

// The reference turbulence of the Filter Effects spec (§ feTurbulence), which
// WebKit, Blink and Gecko all implement: a seeded lattice of gradients, a
// shuffled selector, Perlin's s-curve, octaves summed at halving amplitude.
const B_SIZE = 0x100;
const B_MASK = 0xff;
const PERLIN_N = 0x1000;
const RAND_M = 2147483647;
const RAND_A = 16807;
const RAND_Q = 127773;
const RAND_R = 2836;

function random(seed: number): number {
	let r = RAND_A * (seed % RAND_Q) - RAND_R * Math.floor(seed / RAND_Q);

	if (r <= 0) {
		r += RAND_M;
	}

	return r;
}

/** A turbulence of one seed: `fractal(channel, x, y, fx, fy, octaves)` is the spec's fractalNoise sum before it is scaled to a colour. */
export function createTurbulence(seed: number) {
	let s = Math.round(seed);

	if (s <= 0) {
		s = -(s % (RAND_M - 1)) + 1;
	}

	if (s > RAND_M - 1) {
		s = RAND_M - 1;
	}

	const lattice = new Int32Array(B_SIZE + B_SIZE + 2);
	// Four channels × (B_SIZE + B_SIZE + 2) gradients × 2 components.
	const gradient = new Float64Array(4 * (B_SIZE + B_SIZE + 2) * 2);
	const g = (k: number, i: number) => (k * (B_SIZE + B_SIZE + 2) + i) * 2;

	for (let k = 0; k < 4; k++) {
		for (let i = 0; i < B_SIZE; i++) {
			lattice[i] = i;

			for (let j = 0; j < 2; j++) {
				s = random(s);
				gradient[g(k, i) + j] = ((s % (B_SIZE + B_SIZE)) - B_SIZE) / B_SIZE;
			}

			const x = gradient[g(k, i)];
			const y = gradient[g(k, i) + 1];
			const len = Math.sqrt(x * x + y * y);
			gradient[g(k, i)] = x / len;
			gradient[g(k, i) + 1] = y / len;
		}
	}

	for (let i = B_SIZE - 1; i > 0; i--) {
		const k = lattice[i];
		s = random(s);
		const j = s % B_SIZE;
		lattice[i] = lattice[j];
		lattice[j] = k;
	}

	for (let i = 0; i < B_SIZE + 2; i++) {
		lattice[B_SIZE + i] = lattice[i];

		for (let k = 0; k < 4; k++) {
			gradient[g(k, B_SIZE + i)] = gradient[g(k, i)];
			gradient[g(k, B_SIZE + i) + 1] = gradient[g(k, i) + 1];
		}
	}

	const noise2 = (k: number, vx: number, vy: number) => {
		let t = vx + PERLIN_N;
		const bx0 = Math.trunc(t) & B_MASK;
		const bx1 = (bx0 + 1) & B_MASK;
		const rx0 = t - Math.trunc(t);
		const rx1 = rx0 - 1;
		t = vy + PERLIN_N;
		const by0 = Math.trunc(t) & B_MASK;
		const by1 = (by0 + 1) & B_MASK;
		const ry0 = t - Math.trunc(t);
		const ry1 = ry0 - 1;
		const i = lattice[bx0];
		const j = lattice[bx1];
		const b00 = g(k, lattice[i + by0]);
		const b10 = g(k, lattice[j + by0]);
		const b01 = g(k, lattice[i + by1]);
		const b11 = g(k, lattice[j + by1]);
		const sx = rx0 * rx0 * (3 - 2 * rx0);
		const sy = ry0 * ry0 * (3 - 2 * ry0);
		let u = rx0 * gradient[b00] + ry0 * gradient[b00 + 1];
		let v = rx1 * gradient[b10] + ry0 * gradient[b10 + 1];
		const a = u + sx * (v - u);
		u = rx0 * gradient[b01] + ry1 * gradient[b01 + 1];
		v = rx1 * gradient[b11] + ry1 * gradient[b11 + 1];
		const b = u + sx * (v - u);
		return a + sy * (b - a);
	};

	return {
		noise2,
		fractal(k: number, x: number, y: number, fx: number, fy: number, octaves: number) {
			let sum = 0;
			let vx = x * fx;
			let vy = y * fy;
			let ratio = 1;

			for (let o = 0; o < octaves; o++) {
				sum += noise2(k, vx, vy) / ratio;
				vx *= 2;
				vy *= 2;
				ratio *= 2;
			}

			return sum;
		},
	};
}

/** The baseFrequency the SMIL drift gives at `t` seconds (linear between evenly spaced values, looping). */
export function frequencyAt(t: number): [number, number] {
	const values = FIRE.frequencies;
	const segments = values.length - 1;
	const p = ((((t / FIRE.loop) % 1) + 1) % 1) * segments;
	const i = Math.min(segments - 1, Math.floor(p));
	const u = p - i;
	return [
		values[i][0] + (values[i + 1][0] - values[i][0]) * u,
		values[i][1] + (values[i + 1][1] - values[i][1]) * u,
	];
}

/**
 * One frame of the fire: for each of `size`² pixels over the filter region,
 * where on the flame's gradient (0 the centre, 255 its rim and beyond) the
 * displaced, blurred disc samples. A fractalNoise channel is a colour, (sum + 1) / 2
 * clamped to 0…1, and the displacement moves by scale × (channel − ½), red
 * across and green down, as feDisplacementMap does.
 */
export function fireField(
	turbulence: ReturnType<typeof createTurbulence>,
	fx: number,
	fy: number,
	size = FIRE_SIZE
): Uint8Array {
	const {region, radius, scale, octaves, blur} = FIRE;
	const unit = (2 * region) / size; // sun units a pixel
	// Past this the displaced point is off the disc whatever the noise says.
	const reach = radius + (scale / 2) * Math.SQRT2 + 3 * blur;
	const field = new Float32Array(size * size).fill(1);

	for (let py = 0; py < size; py++) {
		const y = -region + (py + 0.5) * unit;

		for (let px = 0; px < size; px++) {
			const x = -region + (px + 0.5) * unit;

			if (x * x + y * y > reach * reach) {
				continue;
			}

			const r = Math.min(
				1,
				Math.max(0, (turbulence.fractal(0, x, y, fx, fy, octaves) + 1) / 2)
			);
			const gch = Math.min(
				1,
				Math.max(0, (turbulence.fractal(1, x, y, fx, fy, octaves) + 1) / 2)
			);
			const sx = x + scale * (r - 0.5);
			const sy = y + scale * (gch - 0.5);
			field[py * size + px] = Math.min(1, Math.sqrt(sx * sx + sy * sy) / radius);
		}
	}

	return quantize(gaussian(field, size, blur / unit));
}

// A separable Gaussian over the field. The gradient ends transparent at its
// rim, so softening where the disc samples is, to the eye, softening the disc.
function gaussian(field: Float32Array, size: number, sigma: number): Float32Array {
	const reach = Math.ceil(sigma * 3);
	const kernel = new Float32Array(reach * 2 + 1);
	let total = 0;

	for (let i = -reach; i <= reach; i++) {
		total += kernel[i + reach] = Math.exp(-(i * i) / (2 * sigma * sigma));
	}

	kernel.forEach((w, i) => (kernel[i] = w / total));

	const pass = (from: Float32Array, dx: number, dy: number) => {
		const to = new Float32Array(size * size);

		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) {
				let sum = 0;

				for (let i = -reach; i <= reach; i++) {
					const sx = Math.min(size - 1, Math.max(0, x + i * dx));
					const sy = Math.min(size - 1, Math.max(0, y + i * dy));
					sum += from[sy * size + sx] * kernel[i + reach];
				}

				to[y * size + x] = sum;
			}
		}

		return to;
	};

	return pass(pass(field, 1, 0), 0, 1);
}

function quantize(field: Float32Array): Uint8Array {
	const out = new Uint8Array(field.length);

	for (let i = 0; i < field.length; i++) {
		out[i] = Math.round(field[i] * 255);
	}

	return out;
}

/**
 * The flame gradient as 256 RGBA pixels (little-endian 32-bit words, as an
 * ImageData's buffer reads them): the flame colour opaque at the centre, at
 * 0.8 by 0.6, the edge colour transparent at the rim — the SVG's stops,
 * interpolated unpremultiplied as SVG gradients are.
 */
export function fireColours(flame: string, edge: string): Uint32Array {
	const stops: Array<[number, [number, number, number], number]> = [
		[0, hexRgb(flame), 1],
		[0.6, hexRgb(flame), 0.8],
		[1, hexRgb(edge), 0],
	];
	const lut = new Uint32Array(256);

	for (let i = 0; i < 256; i++) {
		const t = i / 255;
		const k = t <= 0.6 ? 0 : 1;
		const [t0, c0, a0] = stops[k];
		const [t1, c1, a1] = stops[k + 1];
		const u = (t - t0) / (t1 - t0);
		const ch = (j: number) => Math.round(c0[j] + (c1[j] - c0[j]) * u);
		const a = Math.round((a0 + (a1 - a0) * u) * 255);
		lut[i] = ((a << 24) | (ch(2) << 16) | (ch(1) << 8) | ch(0)) >>> 0;
	}

	return lut;
}

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type SpriteCanvas = HTMLCanvasElement | OffscreenCanvas;

/**
 * The sprite the fire draws from: one cell of FIRE_SIZE² per frame of the loop, stacked down,
 * 160 × 26,880 pixels, about 17 MB. Null where neither canvas exists (the old path).
 */
function makeSprite(): SpriteCanvas | null {
	const height = FIRE_SIZE * Math.round(FIRE.loop * FIRE_FPS_NG);

	if (typeof OffscreenCanvas !== "undefined") {
		return new OffscreenCanvas(FIRE_SIZE, height);
	}

	if (typeof document === "undefined") {
		return null;
	}

	const canvas = document.createElement("canvas");
	canvas.width = FIRE_SIZE;
	canvas.height = height;
	return canvas;
}

/**
 * The fire's frame loop: at most FIRE_FPS_NG paints a second from a cache of
 * one loop's frames (computed the first time each is needed). It wakes once per
 * frame of its own on a timer, not on every refresh of the screen: a frame request
 * per vsync cost a desktop at 120 Hz about 15 % of a core for 24 paints. `stop()`
 * cancels the pending frame request, so a stopped fire asks the browser for
 * nothing; `start()` resumes the loop where it left off. A new pair of
 * colours paints the current frame at once, running or not, so a fire that
 * is held still still shows.
 *
 * Each frame is coloured once per pair of colours into its cell of a sprite and
 * drawn from there after (spec §10.3: mapping 25,600 pixels through the table on
 * every paint was the sun's page work on the iPhone). A new pair of colours, or
 * destroy, empties the sprite; a `sprite` that gives null keeps the old path,
 * the table and `putImageData` on every paint.
 */
export function fireDriver(
	canvas: HTMLCanvasElement,
	after: (fn: (ms: number) => void, delay: number) => number = (fn, delay) =>
		window.setTimeout(() => fn(performance.now()), delay),
	cancel: (id: number) => void = (id) => window.clearTimeout(id),
	sprite: () => SpriteCanvas | null = makeSprite
) {
	const ctx = canvas.getContext("2d");
	const turbulence = createTurbulence(FIRE.seed);
	const frames = new Map<number, Uint8Array>();
	const count = Math.round(FIRE.loop * FIRE_FPS_NG);
	const image = ctx?.createImageData(FIRE_SIZE, FIRE_SIZE);
	const pixels = image ? new Uint32Array(image.data.buffer) : null;
	const filled = new Set<number>(); // the sprite's cells holding the current colours
	let spriteCanvas: SpriteCanvas | null | undefined; // undefined: not made yet
	let spriteCtx: Context2D | null = null;
	let lut: Uint32Array | null = null;
	let colours = "";
	let time = 0;
	let shown = -1;
	let pending: number | null = null;
	let base: number | null = null; // the frame clock, in s, at fire time 0

	if (ctx) {
		ctx.globalCompositeOperation = "copy"; // a cell replaces the whole canvas: no clearRect
	}

	const paint = (force: boolean) => {
		const index = Math.floor(time * FIRE_FPS_NG) % count;

		if (!ctx || !image || !pixels || !lut || (!force && index === shown)) {
			return;
		}

		if (spriteCanvas === undefined) {
			spriteCanvas = sprite();
			// A canvas with no 2D context (or a stand-in with no getContext) is no sprite: the old path.
			spriteCtx =
				typeof spriteCanvas?.getContext === "function"
					? (spriteCanvas.getContext("2d") as Context2D | null) ?? null
					: null;
		}

		if (!spriteCtx || !filled.has(index)) {
			let field = frames.get(index);

			if (!field) {
				field = fireField(turbulence, ...frequencyAt(index / FIRE_FPS_NG));
				frames.set(index, field);
			}

			for (let i = 0; i < field.length; i++) {
				pixels[i] = lut[field[i]];
			}

			if (!spriteCtx) {
				ctx.putImageData(image, 0, 0);
				shown = index;
				return;
			}

			spriteCtx.putImageData(image, 0, index * FIRE_SIZE);
			filled.add(index);
		}

		ctx.drawImage(
			spriteCanvas as SpriteCanvas,
			0,
			index * FIRE_SIZE,
			FIRE_SIZE,
			FIRE_SIZE,
			0,
			0,
			FIRE_SIZE,
			FIRE_SIZE
		);
		shown = index;
	};

	const tick = (ms: number) => {
		if (base === null) {
			base = ms / 1000 - time;
		}

		time = ms / 1000 - base;
		paint(false);
		// Wake at the next frame's start; at least 1 ms, so a timer that fires early never spins.
		const next = (Math.floor(time * FIRE_FPS_NG) + 1) / FIRE_FPS_NG;
		pending = after(tick, Math.max(1, (next - time) * 1000));
	};

	const stop = () => {
		if (pending !== null) {
			cancel(pending);
			pending = null;
		}
	};

	return {
		start() {
			if (pending === null) {
				base = null;
				pending = after(tick, 0);
			}
		},
		stop,
		setColours(flame: string, edge: string) {
			if (flame + edge === colours) {
				return;
			}

			colours = flame + edge;
			lut = fireColours(flame, edge);
			filled.clear();
			paint(true);
		},
		destroy() {
			stop();
			frames.clear();
			filled.clear();
			// Drop the sprite and the colours: nothing is drawn until a new pair arrives.
			spriteCanvas = undefined;
			spriteCtx = null;
			lut = null;
			colours = "";
		},
		/** For tests: the frames held. */
		get cachedFrames() {
			return frames.size;
		},
		/** For tests: the sprite's cells filled for the current colours. */
		get spriteFrames() {
			return filled.size;
		},
	};
}

/**
 * Classic's sun markup with its filter fire taken out and the canvas put in its place, between the
 * bloom and the core (perf-band's shape: the bloom's svg, the canvas, the core's svg). Gradients are
 * document-global, so the core's `url(#ps-s-core)` still finds its defs in the first svg.
 */
export function ngSun(markup: string): string {
	return markup
		.replace(/<filter id="ps-s-fire"[\s\S]*?<\/filter>\n?/, "")
		.replace(
			/<g filter="url\(#ps-s-fire\)"><circle r="56" fill="url\(#ps-s-flame\)"\/><\/g>/,
			`</svg><canvas class="ps-fire" width="${FIRE_SIZE}" height="${FIRE_SIZE}"></canvas><svg viewBox="-100 -100 200 200">`
		);
}
