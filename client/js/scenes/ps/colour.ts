/**
 * #rrggbb arithmetic for the ps theme: the mockup's sRGB mixing, and WCAG
 * luminance and contrast for the legibility floors (docs/projects/ps-theme.md §11).
 * Pure; mocha loads it.
 */

export function hexRgb(hex: string): [number, number, number] {
	return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

const byte = (v: number) =>
	Math.max(0, Math.min(255, Math.round(v)))
		.toString(16)
		.padStart(2, "0");

export function rgbHex(r: number, g: number, b: number): string {
	return `#${byte(r)}${byte(g)}${byte(b)}`;
}

/** `b` mixed into `a` by `u` (0 is `a`, 1 is `b`), channel by channel in sRGB. */
export function mix(a: string, b: string, u: number): string {
	const [x, y] = [hexRgb(a), hexRgb(b)];
	return rgbHex(...(x.map((v, i) => v + (y[i] - v) * u) as [number, number, number]));
}

/** Move `c` by `to − from`, scaled by `amount`: the season's offset from midsummer, applied at any hour. */
export function shift(c: string, from: string, to: string, amount: number): string {
	const [a, f, t] = [hexRgb(c), hexRgb(from), hexRgb(to)];
	return rgbHex(...(a.map((v, i) => v + (t[i] - f[i]) * amount) as [number, number, number]));
}

/*
 * OKLab / OKLCH (Björn Ottosson): the mockup's `color-mix(in oklab, …)`
 * recipes (mixOklab, plan 3) and solving a colour's lightness at a fixed hue
 * (hexToOklch/oklchToHex, re-exported from tools/ps/oklch.ts) share this one
 * implementation of the forward and inverse matrices.
 */
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** sRGB hex to OKLab, Cartesian: lightness and the two opponent axes. */
function hexToOklab(hex: string): [number, number, number] {
	const [r, g, b] = hexRgb(hex).map((v) => toLinear(v / 255));
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	return [
		0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
	];
}

/** OKLab (Cartesian L, a, b) to unclamped linear sRGB. */
function oklabToLinearRgb(L: number, A: number, B: number): [number, number, number] {
	const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
	const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
	const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
	return [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	];
}

const clampGamma = (rgb: readonly number[]) =>
	rgbHex(
		...(rgb.map((c) => toGamma(Math.min(1, Math.max(0, c))) * 255) as [number, number, number])
	);

/** sRGB hex to OKLCH: lightness, chroma, hue in radians. */
export function hexToOklch(hex: string): [number, number, number] {
	const [L, A, B] = hexToOklab(hex);
	return [L, Math.hypot(A, B), Math.atan2(B, A)];
}

/** The colour at OKLCH (L, C, h radians), or null when it falls outside sRGB. */
export function oklchToHex(L: number, C: number, h: number): string | null {
	const rgb = oklabToLinearRgb(L, C * Math.cos(h), C * Math.sin(h));

	if (rgb.some((c) => c < -1e-4 || c > 1 + 1e-4)) {
		return null;
	}

	return clampGamma(rgb);
}

/**
 * `a` mixed with `b` in OKLab, gamut-clamped per channel the way Chromium's
 * `color-mix(in oklab, a weightA×100%, b)` renders these colours: weight 1 is
 * `a`, weight 0 is `b`.
 */
export function mixOklab(a: string, b: string, weightA: number): string {
	if (weightA >= 1) {
		return a;
	}

	if (weightA <= 0) {
		return b;
	}

	const [La, Aa, Ba] = hexToOklab(a);
	const [Lb, Ab, Bb] = hexToOklab(b);
	return clampGamma(
		oklabToLinearRgb(
			La * weightA + Lb * (1 - weightA),
			Aa * weightA + Ab * (1 - weightA),
			Ba * weightA + Bb * (1 - weightA)
		)
	);
}

/** WCAG relative luminance. */
export function luminance(hex: string): number {
	const [r, g, b] = hexRgb(hex).map((v) => {
		const c = v / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}
