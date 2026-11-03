/**
 * How readable a run of IRC-coloured text is, for judging what a reader of a
 * masked link's label can see (layout.ts, helpers/linkSafety.ts). The colours
 * are style.css's `.irc-fgN`/`.irc-bgN` defaults; a theme may redraw 0–15,
 * so a judgement here is about the colours the sender chose, not the page.
 */

import type {ParsedStyle} from "./parseStyle";

// The mIRC palette, 0–98, as style.css draws it.
const PALETTE = (
	"fff 000 001f3f 2ecc40 ff4136 85144b b10dc9 ff851b ffdc00 01ff70 39cccc 7fdbff " +
	"0074d9 f012be aaa ddd 470000 472100 474700 324700 004700 00472c 004747 002747 " +
	"000047 2e0047 470047 47002a 740000 743a00 747400 517400 007400 007449 007474 " +
	"004074 000074 4b0074 740074 740045 b50000 b56300 b5b500 7db500 00b500 00b571 " +
	"00b5b5 0063b5 0000b5 7500b5 b500b5 b5006b f00 ff8c00 ff0 b2ff00 0f0 00ffa0 0ff " +
	"008cff 00f a500ff f0f ff0098 ff5959 ffb459 ffff71 cfff60 6fff6f 65ffc9 6dffff " +
	"59b4ff 5959ff c459ff f6f ff59bc ff9c9c ffd39c ffff9c e2ff9c 9cff9c 9cffdb 9cffff " +
	"9cd3ff 9c9cff dc9cff ff9cff ff94d3 000 131313 282828 363636 4d4d4d 656565 818181 " +
	"9f9f9f bcbcbc e2e2e2 fff"
).split(" ");

/**
 * Below this WCAG contrast ratio a run is not read: a lying host drawn that
 * faint is not what the reader sees, and an honest one is not proof.
 */
export const READABLE_CONTRAST = 2;

function rgb(hex: string): [number, number, number] {
	const full = hex.length === 3 ? hex.replace(/./g, "$&$&") : hex;
	return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance(hex: string): number {
	const [r, g, b] = rgb(hex).map((v) => {
		const c = v / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

const code = (value: string | undefined) => {
	const index = value === undefined ? NaN : Number(value);
	return Number.isInteger(index) ? PALETTE[index] : undefined;
};

/**
 * How a run of text reads: `plain` (the theme's own colours), `readable` (a
 * foreground and background the sender set, far enough apart), `hidden` (a
 * pair too close to read) or `unknown` (one colour set: whether it reads
 * depends on the theme's other one).
 */
export function colourReading(
	style: Pick<ParsedStyle, "textColor" | "bgColor" | "hexColor" | "hexBgColor">
): "plain" | "readable" | "hidden" | "unknown" {
	const fg = style.hexColor ?? code(style.textColor);
	const bg = style.hexBgColor ?? code(style.bgColor);

	if (fg === undefined && bg === undefined) {
		return "plain";
	}

	if (fg === undefined || bg === undefined) {
		return "unknown";
	}

	return contrast(fg, bg) < READABLE_CONTRAST ? "hidden" : "readable";
}
