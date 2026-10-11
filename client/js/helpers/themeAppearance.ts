// The themes that come as a light/dark pair, and which of the pair to show.
// With the matchSystemAppearance setting on, the chosen theme stands for its
// pair: whichever of the two matches the system's light or dark mode
// (prefers-color-scheme) is the one loaded, and a change of mode swaps it
// live. A theme with no partner is shown as chosen either way. Vue-free:
// test/helpers/themeAppearance.ts.
//
// The pairs themselves are themePairs.json, `[dark, light]` each, because
// the early loader (loading-error-handlers.js, which is copied rather than
// bundled) needs them too: webpack.config.ts writes the same list into it.

import pairs from "./themePairs.json";

type Appearance = "light" | "dark";

/** The light/dark pairs, dark first (docs/resources/themes.md). */
export const THEME_PAIRS: ReadonlyArray<readonly [dark: string, light: string]> = pairs.map(
	([dark, light]) => [dark, light] as const
);

/** Each paired theme, its own appearance and its partner. */
const PAIRS = new Map<string, {appearance: Appearance; partner: string}>();

for (const [dark, light] of THEME_PAIRS) {
	PAIRS.set(dark, {appearance: "dark", partner: light});
	PAIRS.set(light, {appearance: "light", partner: dark});
}

/** The partner of a paired theme, or null. */
export function themePartner(theme: string): string | null {
	return PAIRS.get(theme)?.partner ?? null;
}

/** The theme to load for `chosen`: its partner when following the system
 * and the system's mode is the other one, else `chosen` itself. */
export function effectiveTheme(chosen: string, matchSystem: boolean, systemDark: boolean): string {
	const pair = PAIRS.get(chosen);

	if (!matchSystem || !pair) {
		return chosen;
	}

	const wanted: Appearance = systemDark ? "dark" : "light";
	return pair.appearance === wanted ? chosen : pair.partner;
}

/** The theme picker's name for a pair, from its halves' display names, dark
 * first: "Coffee / Creama", or the one name when the halves share it
 * (Princess_ and Princess are "Princess"). */
export function pairLabel(dark: string, light: string): string {
	const plain = (name: string) => name.replace(/_+$/, "");
	return plain(dark) === plain(light) ? plain(light) : `${dark} / ${light}`;
}

/** A theme as the build lists it (configuration.ts `themes`). */
export interface ThemeEntry {
	name: string;
	displayName: string;
}

/** One entry of the theme picker: the theme stored when it is picked, and
 * what the list calls it. */
export interface ThemeChoice {
	value: string;
	label: string;
}

/**
 * The theme picker's entries. Following the system (matchSystemAppearance
 * on), a pair is one entry, in the place of whichever half the build lists
 * first: its value is the stored theme when that is one of the two, so the
 * entry stays selected whichever half is showing, and the dark half
 * otherwise. Not following, every theme is its own entry. A half whose
 * partner the build does not list is a theme of its own.
 */
export function themeChoices(
	themes: readonly ThemeEntry[],
	followSystem: boolean,
	chosen: string
): ThemeChoice[] {
	const listed = new Map(themes.map((t) => [t.name, t]));
	const choices: ThemeChoice[] = [];
	const done = new Set<string>();

	for (const theme of themes) {
		const partner = followSystem ? themePartner(theme.name) : null;
		const other = partner ? listed.get(partner) : undefined;

		if (!partner || !other) {
			choices.push({value: theme.name, label: theme.displayName});
			continue;
		}

		if (done.has(theme.name)) {
			continue;
		}

		done.add(theme.name).add(partner);
		const [dark, light] =
			PAIRS.get(theme.name)?.appearance === "dark" ? [theme, other] : [other, theme];
		choices.push({
			value: chosen === theme.name || chosen === partner ? chosen : dark.name,
			label: pairLabel(dark.displayName, light.displayName),
		});
	}

	return choices;
}

/** The pairs as a sentence's list, "Coffee / Creama, …and Morning / Day",
 * each as the picker names it, by `label` (Settings → Appearance's hint). */
export function describeThemePairs(label: (theme: string) => string): string {
	const names = THEME_PAIRS.map(([dark, light]) => pairLabel(label(dark), label(light)));
	return names.length > 1
		? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
		: names.join("");
}
