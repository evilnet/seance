/**
 * Which of the ps scene's animated layers are in the page's render tree
 * (docs/projects/ps-theme.md §10: nothing animates unseen). Each layer here
 * has a window: the stars, the fireflies and the smoke come up with the
 * dark, the sun goes down, the skeins fly around sunset and at night (only
 * as many flocks as the night's count), the buzzard rides the thermals, the
 * larks sing in season, the seeds blow while the wind shows them (the
 * weather layer builds them on any day with wind, but deep in winter its
 * level is 0), and the heat band shimmers over a hot midday. The
 * scene publishes each as an opacity (markup.ts `sceneVars`); a layer at 0 is
 * not painted, but its animations, CSS and SMIL alike, would still run and
 * be restyled every frame. So outside its window a layer leaves the render
 * tree (ps.css `.ps-off`, display: none) and the SMIL in its svgs is paused.
 *
 * The scene (psng/scene.ts) applies the gates at once, without fades.
 *
 * Pure and DOM-free, so mocha loads it.
 */

/** The gated layers, back to front. */
export type Gate =
	| "stars"
	| "sun"
	| "fireflies"
	| "smoke"
	| "skeins"
	| "flock0"
	| "flock1"
	| "flock2"
	| "buzzard"
	| "larks"
	| "seeds"
	| "heatband";

/** A gate's elements (the `index`th match alone, for one flock). */
export interface GateSpec {
	selector: string;
	index?: number;
}

export const GATES: Readonly<Record<Gate, GateSpec>> = {
	stars: {selector: ".ps-stars"},
	sun: {selector: ".ps-sun"},
	fireflies: {selector: ".ps-fireflies"},
	smoke: {selector: ".ps-smoke"},
	skeins: {selector: ".ps-skeins"},
	flock0: {selector: ".ps-flock", index: 0},
	flock1: {selector: ".ps-flock", index: 1},
	flock2: {selector: ".ps-flock", index: 2},
	buzzard: {selector: ".ps-buzzard"},
	larks: {selector: ".ps-lark"},
	seeds: {selector: ".ps-seeds"},
	heatband: {selector: ".ps-heatband"},
};

/**
 * Which layers are live, from the values the scene is about to write (its
 * `sceneVars`): each exactly while what ps.css paints it with is above 0, so
 * the gate and the stylesheet agree to the digit. A flock is live while the
 * skeins are and its number is under the night's count (ps.css `--fi`).
 */
export function liveLayers(vars: Readonly<Record<string, string>>): Record<Gate, boolean> {
	const shown = (name: string) => Number(vars[name]) > 0;
	const skeins = shown("--ps-skeins-op");
	const count = Number(vars["--ps-skein-count"]) || 0;
	return {
		stars: shown("--ps-stars"),
		sun: shown("--ps-sun-op"),
		fireflies: shown("--ps-ff-op"),
		smoke: shown("--ps-smoke-op"),
		skeins,
		flock0: skeins && count > 0,
		flock1: skeins && count > 1,
		flock2: skeins && count > 2,
		buzzard: shown("--ps-buzzard-op"),
		larks: shown("--ps-lark-op"),
		seeds: shown("--ps-wind-op"),
		heatband: shown("--ps-heat-op"),
	};
}
