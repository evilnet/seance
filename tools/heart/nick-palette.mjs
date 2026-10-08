// Prints the <3 theme's 32 nick colours: hues swept, in order, across the
// spec's biased ranges (§3.1: rose/coral, gold, teal, sky, lilac — not a
// uniform sweep round the wheel) at one oklch lightness (chroma 0.115, the
// handoff themes' value), every slot at ≥ 4.5:1 on the sky (#dbeeff) and on
// a highlighted row (#ffd6e6), so a nick reads on both. Lightness is
// lowered per slot until it clears the bar.
//
//   node tools/heart/nick-palette.mjs   → paste into client/themes/ps.css
const SKY = [0xdb, 0xee, 0xff];
const BLUSH = [0xff, 0xd6, 0xe6];
const CHROMA = 0.115;

// Hue ranges (start deg, end deg, slot count), swept in order and evenly
// spaced with both ends included; rose/coral wraps through 0/360.
const HUE_RANGES = [
	[330, 30, 11], // rose/coral
	[40, 60, 4], // gold
	[165, 195, 6], // teal
	[210, 240, 5], // sky
	[260, 300, 6], // lilac
];

function sweepHues() {
	const hues = [];
	for (const [start, end, slots] of HUE_RANGES) {
		const span = (end - start + 360) % 360 || 360;
		const step = span / (slots - 1);
		for (let i = 0; i < slots; i++) {
			hues.push((start + step * i) % 360);
		}
	}
	return hues;
}

const HUES = sweepHues();
const SLOTS = HUES.length;

function oklchToSrgb(L, C, hDeg) {
	const h = (hDeg * Math.PI) / 180;
	const a = C * Math.cos(h),
		b = C * Math.sin(h);
	const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
	const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
	const s_ = L - 0.0894841775 * a - 1.291485548 * b;
	const l = l_ ** 3,
		m = m_ ** 3,
		s = s_ ** 3;
	const lin = [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	];
	return lin.map((c) => {
		const x = Math.min(1, Math.max(0, c));
		const g = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
		return Math.round(g * 255);
	});
}
function luminance([r, g, b]) {
	const f = (v) => {
		const c = v / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a, b) {
	const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
	return (x + 0.05) / (y + 0.05);
}
const hex = ([r, g, b]) => "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");

for (let i = 0; i < SLOTS; i++) {
	const hue = HUES[i];
	let L = 0.56,
		rgb;
	do {
		rgb = oklchToSrgb(L, CHROMA, hue);
		L -= 0.005;
	} while (contrast(rgb, SKY) < 4.6 || contrast(rgb, BLUSH) < 4.6);
	console.log(`.user.color-${i + 1} { color: ${hex(rgb)}; }`);
}
