// The themes this build ships, one entry each (docs/resources/themes.md §
// The theme registry): everything the app knows about a theme apart from its
// stylesheet, client/themes/<name>.css. The Settings list and the browser
// chrome colour (configuration.ts), the looks (helpers/messageLayout.ts)
// and the scenes (themeScene.ts) all read it, and test/tests/themeRegistry.ts
// holds it to client/themes/*.css both ways. Adding a theme is its CSS file
// and its entry here (and a line in helpers/themePairs.json, which the
// early loader needs as a file of its own, if it is half of a light/dark pair).
//
// Data only, free of the store and the DOM, so mocha loads it. A scene is a loader, so its code stays a
// chunk of its own, fetched only when that theme is applied.

import type {SceneLoader} from "./themeScene";

export interface ThemeManifest {
	/** The stylesheet's name, client/themes/<name>.css, and the stored setting's value. */
	readonly name: string;
	/** What Settings → Appearance calls it. */
	readonly displayName: string;
	/** The browser chrome colour (`<meta name="theme-color">`), or null to
	 * leave it to the deploy (config.json's themeColor, else the build's). */
	readonly themeColor: string | null;
	/**
	 * The looks (helpers/messageLayout.ts): `offered`, the reader's choice of
	 * Classic, Messenger or Workspace; `painted`, always Messenger and the
	 * theme paints the bubbles itself (`data-bubble-paint="theme"`). Absent,
	 * the theme has no choice and draws Classic.
	 */
	readonly looks?: "offered" | "painted";
	/** Page elements of its own (themeScene.ts), mounted while it is applied. */
	readonly scene?: SceneLoader;
}

/** Every theme, in the order Settings lists them. */
export const THEMES: readonly ThemeManifest[] = [
	// The four handoff themes (Ink & Amber, Cobalt Frost) carry their
	// titlebar tone as the browser chrome colour.
	{name: "coffee", displayName: "Coffee", themeColor: "#1a1816", looks: "offered"},
	{name: "creama", displayName: "Creama", themeColor: "#efe9de", looks: "offered"},
	{name: "cobalt", displayName: "Cobalt", themeColor: "#101720", looks: "offered"},
	{name: "frost", displayName: "Frost", themeColor: "#eef2f7", looks: "offered"},
	{name: "molokai", displayName: "Molokai", themeColor: "#1b1d1e", looks: "offered"},
	{name: "princess", displayName: "Princess", themeColor: "#f2f7fc", looks: "offered"},
	{name: "princess_", displayName: "Princess_", themeColor: "#000000", looks: "offered"},
	{name: "keeki", displayName: "Keeki", themeColor: "#22143a", looks: "offered"},
	{name: "keekiblush", displayName: "Keeki Blush", themeColor: "#f1d6e4", looks: "offered"},
	// The period themes keep the look of the client they copy: no choice of look.
	{name: "sandrof", displayName: "Sandrof", themeColor: "#020402"},
	{name: "oikarinen", displayName: "Oikarinen", themeColor: "#040301"},
	{name: "bourbaki", displayName: "Bourbaki", themeColor: "#000000"},
	{name: "gates", displayName: "Gates", themeColor: "#0000aa"},
	{name: "mardam", displayName: "Mardam", themeColor: "#d4d0c8"},
	{name: "zelenzy", displayName: "Zelenzy", themeColor: "#ece9d8"},
	{name: "panasync", displayName: "Panasync", themeColor: "#000000"},
	// TheLounge's originals, kept as they were: no colour of their own, no choice of look.
	{name: "day", displayName: "Day", themeColor: null},
	{name: "morning", displayName: "Morning", themeColor: null},
	// Its colour is the daylight fallback's canvas until the scene writes the
	// sky's (themes.md § The ps theme).
	{
		name: "ps",
		displayName: "ps",
		themeColor: "#3f8fe6",
		looks: "painted",
		scene: () => import("./scenes/psng/scene"),
	},
	// Light or dark with the system on its own (one file, no pair), and the
	// Mac app's default (boot.ts).
	{name: "macos", displayName: "macOS", themeColor: null, looks: "offered"},
];
