// How a conversation's messages are drawn: the look (Settings → Appearance →
// Look). "lines" is Classic, the IRC log every theme has drawn so far, and
// the default; "bubbles" is Messenger, each sender's run of lines as a stack
// of bubbles beside their avatar (a private conversation as a two-sided
// chat); "workspace" is Workspace, the same runs as flat rows at the
// column's full width, the avatar in a gutter and the nick and time over
// the run. The stored names are the setting's values from before the looks
// had names, so nobody's choice changed. The looks live in style.css under
// `html[data-message-layout]` (docs/resources/themes.md § Looks); a theme
// only colours them.
// Not every theme offers the choice. ps is always Messenger: the shape is
// the same shared one, but ps paints the bubbles itself (its cards, glass
// and words over the scene), so it also gets `data-bubble-paint="theme"` and
// style.css leaves the colours to it. The period themes keep the look of
// the client they copy, and day and morning are TheLounge's originals, kept
// as they were: for those the attribute is left off and the setting is not
// shown. What the reader chose comes back when they return to a theme that
// offers it. Which themes do is the theme registry's (themeRegistry.ts).
// Vue-free: test/helpers/messageLayout.ts.

import {THEMES} from "../themeRegistry";

export const messageLayouts = ["lines", "bubbles", "workspace"] as const;

export type MessageLayout = (typeof messageLayouts)[number];

export const defaultMessageLayout: MessageLayout = "lines";

/** The themes that offer the reader the choice of look (themeRegistry.ts,
 * `looks: "offered"`). A new theme on coffee's tokens offers it unless it
 * copies a period client. */
export const lookThemes: ReadonlySet<string> = new Set(
	THEMES.filter((theme) => theme.looks === "offered").map((theme) => theme.name)
);

/** The themes that are always Messenger and paint the bubbles themselves
 * (themeRegistry.ts, `looks: "painted"`): ps. */
const paintingThemes: ReadonlySet<string> = new Set(
	THEMES.filter((theme) => theme.looks === "painted").map((theme) => theme.name)
);

/** A stored setting can be anything; anything but the three names means the default. */
export function normalizeMessageLayout(value: unknown): MessageLayout {
	return messageLayouts.includes(value as MessageLayout)
		? (value as MessageLayout)
		: defaultMessageLayout;
}

/** Whether Settings offers the choice of look in `theme` (the theme on screen). */
export function themeOffersLooks(theme: string): boolean {
	return lookThemes.has(theme);
}

/** The look to apply in `theme`, or null where the theme has no choice
 * and `data-message-layout` is left off. */
export function messageLayoutFor(value: unknown, theme: string): MessageLayout | null {
	if (themePaintsBubbles(theme)) {
		return "bubbles";
	}

	return themeOffersLooks(theme) ? normalizeMessageLayout(value) : null;
}

/** Whether `theme` is always Messenger and paints the bubbles itself
 * (`data-bubble-paint="theme"`): ps alone. */
export function themePaintsBubbles(theme: string): boolean {
	return paintingThemes.has(theme);
}
