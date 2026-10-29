// How your own messages are told apart from everyone else's (Settings →
// Appearance → Your own messages). style.css greys own text to the muted
// colour, as TheLounge did; on iOS with the system's "Increase Contrast"
// off that grey all but disappears against a dark theme, while the same
// pixels read fine on Android and a desk. The value is applied as a
// `data-own-messages` attribute on <html> (settings.ts) and the three looks
// live entirely in style.css (`html[data-own-messages=…]`), so no theme file
// changes and a theme that bands its own rows keeps its band under the
// default. Vue-free: test/helpers/ownMessages.ts. The labels are pot keys,
// translated in Appearance.vue.

export const ownMessageStyles = ["muted", "band", "plain"] as const;

export type OwnMessageStyle = typeof ownMessageStyles[number];

export const defaultOwnMessageStyle: OwnMessageStyle = "muted";

/** A stored setting can be anything (stale key, hand-edited localStorage);
 * anything that is not one of the three means the default. */
export function normalizeOwnMessageStyle(value: unknown): OwnMessageStyle {
	return ownMessageStyles.includes(value as OwnMessageStyle)
		? (value as OwnMessageStyle)
		: defaultOwnMessageStyle;
}
