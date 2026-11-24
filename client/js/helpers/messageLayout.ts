// How a conversation's messages are laid out (Settings → Appearance →
// Message layout): "lines", the IRC log every theme has drawn so far, or
// "bubbles", each sender's run of lines as a stack of bubbles beside their
// avatar. The layout lives in style.css under `html[data-message-layout=
// "bubbles"]`; a theme only colours it (docs/resources/themes.md § Bubbles).
// Not every theme offers the choice. ps is always Bubbles: the layout is the
// same shared one, but ps paints the bubbles itself (its cards, glass and
// words over the scene), so it also gets `data-bubble-paint="theme"` and
// style.css leaves the colours to it. The period themes keep the look of
// the client they copy, and day and morning are TheLounge's originals, kept
// as they were: for those the attribute is left off and the setting is not
// shown. What the reader chose comes back when they return to a theme that
// offers it. Vue-free: test/helpers/messageLayout.ts.

export const messageLayouts = ["lines", "bubbles"] as const;

export type MessageLayout = (typeof messageLayouts)[number];

export const defaultMessageLayout: MessageLayout = "lines";

/** The themes the shared bubble layout is drawn for. A new theme on
 * coffee's tokens belongs here unless it copies a period client. */
export const bubbleThemes: ReadonlySet<string> = new Set([
	"coffee",
	"creama",
	"cobalt",
	"frost",
	"molokai",
	"princess",
	"princess_",
	"keeki",
	"keekiblush",
	"macos",
]);

/** Themes that are always Bubbles and paint the bubbles themselves. */
export const themePaintedBubbles: ReadonlySet<string> = new Set(["ps"]);

/** A stored setting can be anything; anything but the two names means the default. */
export function normalizeMessageLayout(value: unknown): MessageLayout {
	return messageLayouts.includes(value as MessageLayout)
		? (value as MessageLayout)
		: defaultMessageLayout;
}

/** Whether Settings offers the choice in `theme` (the theme on screen). */
export function themeOffersBubbles(theme: string): boolean {
	return bubbleThemes.has(theme);
}

/** The layout to apply in `theme`, or null where the theme has no choice
 * and `data-message-layout` is left off. */
export function messageLayoutFor(value: unknown, theme: string): MessageLayout | null {
	if (themePaintedBubbles.has(theme)) {
		return "bubbles";
	}

	return themeOffersBubbles(theme) ? normalizeMessageLayout(value) : null;
}

/** Whether `theme` paints its bubbles itself (`data-bubble-paint="theme"`). */
export function themePaintsBubbles(theme: string): boolean {
	return themePaintedBubbles.has(theme);
}
