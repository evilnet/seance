import {hexRgb} from "./colour";
import type {StepSvg} from "./stepper";

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
 * table. No DOM: the scene hands in the canvas's pixel sink, so mocha drives it.
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

/** Frames of the loop kept (the scene's own SCENE_FPS: 168 for the 7 s). */
export const FIRE_FPS = 24;

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

/** Where the fire paints: a size² RGBA sink the scene backs with its canvas. */
export interface FireCanvas {
	readonly size: number;
	/** The pixels to fill, as 32-bit words. */
	readonly pixels: Uint32Array;
	/** Show what `pixels` holds now. */
	commit(): void;
}

/**
 * The fire as one of the stepper's clocks (it takes the place of the sun's
 * SMIL, so it is stepped, held and handed to native playback the same way):
 * a time set paints the loop's frame for it, computed the first time it is
 * needed and kept, so after one loop the fire costs a table lookup a pixel.
 */
export function createFire(
	canvas: FireCanvas,
	deps: {
		/** Native playback: call fn on the next frame with its time in ms; returns a cancel. */
		frame(fn: (ms: number) => void): () => void;
	}
): StepSvg & {setColours(flame: string, edge: string): void; readonly cachedFrames: number} {
	const turbulence = createTurbulence(FIRE.seed);
	const frames = new Map<number, Uint8Array>();
	const count = Math.round(FIRE.loop * FIRE_FPS);
	let lut: Uint32Array | null = null;
	let colours = "";
	let time = 0;
	let shown = -1;
	let cancel: (() => void) | null = null;
	let base: number | null = null; // native playback: the frame clock, in s, at fire time 0

	const paint = (force: boolean) => {
		const index = ((Math.floor(time * FIRE_FPS) % count) + count) % count;

		if (!lut || (!force && index === shown)) {
			return;
		}

		let field = frames.get(index);

		if (!field) {
			field = fireField(turbulence, ...frequencyAt(index / FIRE_FPS), canvas.size);
			frames.set(index, field);
		}

		const {pixels} = canvas;

		for (let i = 0; i < field.length; i++) {
			pixels[i] = lut[field[i]];
		}

		canvas.commit();
		shown = index;
	};

	const tick = (ms: number) => {
		if (base === null) {
			base = ms / 1000 - time;
		}

		time = ms / 1000 - base;
		paint(false);
		cancel = deps.frame(tick);
	};

	return {
		get cachedFrames() {
			return frames.size;
		},
		setColours(flame, edge) {
			if (flame + edge === colours) {
				return;
			}

			colours = flame + edge;
			lut = fireColours(flame, edge);
			paint(true);
		},
		animationsPaused: () => cancel === null,
		pauseAnimations() {
			cancel?.();
			cancel = null;
		},
		unpauseAnimations() {
			if (cancel) {
				return;
			}

			base = null;
			cancel = deps.frame(tick);
		},
		getCurrentTime: () => time,
		setCurrentTime(seconds) {
			time = seconds;
			paint(false);
		},
	};
}
