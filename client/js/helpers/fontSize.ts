// The UI scale setting: an ordered scale of root font sizes. Everything in
// style.css is sized in rem, so a step grows the whole interface — messages,
// sidebar, header, buttons, menus — not just the text. The value is applied
// as a `data-font-size` attribute on <html> (settings.ts) and the sizes live
// entirely in style.css (`html[data-font-size=...] { font-size: N% }`, of the
// browser's default font size), so a theme or the custom stylesheet can
// override them. "large" is the browser default (16px unless the user changed
// it); "medium" is the 14px the client shipped with before the scale applied
// to the chrome too. Vue-free: test/helpers/fontSize.ts.

export const fontSizes = ["tiny", "small", "medium", "large", "xlarge", "huge"] as const;

export type FontSize = typeof fontSizes[number];

export const defaultFontSize: FontSize = "large";

// The steps' reader-facing labels ("Tiny"…"Huge") live in the pot and are
// translated at the render site (Settings/Appearance.vue): this module is
// Vue-free and the pot is the only source of English copy.

/** Each step as a percentage of the browser's default font size. The root
 * is set from style.css (`html[data-font-size=…]`), which must agree with
 * this table; Appearance.vue reads it to render its sample at a step that
 * is not applied yet. "medium" is normal; the ends are meant to be too
 * small and too large for most eyes. */
export const fontSizeScale: Record<FontSize, number> = {
	tiny: 62.5,
	small: 81.25,
	medium: 100,
	large: 125,
	xlarge: 162.5,
	huge: 212.5,
};

/** A stored setting can be anything (stale key, hand-edited localStorage);
 * anything that is not on the scale means the default. */
export function normalizeFontSize(value: unknown): FontSize {
	return fontSizes.includes(value as FontSize) ? (value as FontSize) : defaultFontSize;
}

/** The slider position of a value, on the same guarantee. */
export function fontSizeIndex(value: unknown): number {
	return fontSizes.indexOf(normalizeFontSize(value));
}
