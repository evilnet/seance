/**
 * Which of the ps scene's animated layers are in the page's render tree
 * (docs/projects/ps-theme.md §10: nothing animates unseen). Each layer here
 * has a window: the stars, the fireflies and the smoke come up with the
 * dark, the sun goes down, the skeins fly around sunset and at night (only
 * as many flocks as the night's count), the buzzard rides the thermals, the
 * larks sing in season, the seeds blow while the wind shows them (the
 * weather layer builds them on any day with wind, but deep in winter its
 * level is 0), and the heat band shimmers over a hot midday. The
 * scene publishes each as an opacity (scene.ts `sceneVars`); a layer at 0 is
 * not painted, but its animations, CSS and SMIL alike, would still run and
 * be restyled every frame. So outside its window a layer leaves the render
 * tree (ps.css `.ps-off`, display: none) and the SMIL in its svgs is paused.
 *
 * A layer that fades keeps its place through its own fade (ps.css's opacity
 * transition, `fadeMs` below): it goes once the fade is over, and comes back
 * before the value that fades it in is written, with the page's style
 * computed in between, since a transition never runs from display: none. On
 * the scene's first moment nothing has been shown, so what is out goes out
 * at once and nothing is computed early (as before, nothing fades in on
 * load); a hidden page takes out at once what was waiting for its fade.
 *
 * Pure and DOM-free: scene.ts finds the elements and carries out the effects
 * (a class, the style's computation, a timer), so mocha drives all of it.
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

/** A gate's elements (the `index`th match alone, for one flock) and its fade out in ps.css, in ms. */
export interface GateSpec {
	selector: string;
	index?: number;
	fadeMs: number;
}

/** Past a fade's end before the layer goes, so its last frame at 0 is the one drawn. */
export const FADE_MARGIN_MS = 100;

export const GATES: Readonly<Record<Gate, GateSpec>> = {
	stars: {selector: ".ps-stars", fadeMs: 0},
	sun: {selector: ".ps-sun", fadeMs: 0},
	fireflies: {selector: ".ps-fireflies", fadeMs: 0},
	smoke: {selector: ".ps-smoke", fadeMs: 380},
	skeins: {selector: ".ps-skeins", fadeMs: 1400},
	flock0: {selector: ".ps-flock", index: 0, fadeMs: 1800},
	flock1: {selector: ".ps-flock", index: 1, fadeMs: 1800},
	flock2: {selector: ".ps-flock", index: 2, fadeMs: 1800},
	buzzard: {selector: ".ps-buzzard", fadeMs: 1400},
	larks: {selector: ".ps-lark", fadeMs: 1400},
	seeds: {selector: ".ps-seeds", fadeMs: 0},
	heatband: {selector: ".ps-heatband", fadeMs: 0},
};

const ORDER = Object.keys(GATES) as Gate[];

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

/** What the gates ask of the page. `after` returns its own cancel. */
export interface GateEffects {
	/** Take the gate's elements out of the render tree (true) or put them back (false). */
	set(gate: Gate, off: boolean): void;
	/** Compute the page's style now. */
	flush(): void;
	after(ms: number, fn: () => void): () => void;
}

export interface LayerGates {
	/**
	 * One moment: put back what is live (then compute the style, unless
	 * `first`), `write` the moment's values, then take out what is not, once
	 * its fade is over (at once if `first`, or if it has none).
	 */
	apply(live: Readonly<Record<Gate, boolean>>, write: () => void, first: boolean): void;
	/** The page is hidden: take out now what was waiting for its fade. */
	settle(): void;
	/** The gate's element was rebuilt: the new one is in the tree, and nothing waits for the old. */
	forget(gate: Gate): void;
	/** Cancel every wait; nothing further happens. */
	stop(): void;
}

export function layerGates(fx: GateEffects): LayerGates {
	const out = new Set<Gate>();
	const waiting = new Map<Gate, () => void>();

	const takeOut = (gate: Gate) => {
		waiting.delete(gate);
		out.add(gate);
		fx.set(gate, true);
	};

	return {
		apply(live, write, first) {
			let back = false;

			for (const gate of ORDER) {
				if (!live[gate]) {
					continue;
				}

				// Back during its fade: still in the tree, and the fade reverses by itself.
				waiting.get(gate)?.();
				waiting.delete(gate);

				if (out.delete(gate)) {
					fx.set(gate, false);
					back = true;
				}
			}

			if (back && !first) {
				fx.flush();
			}

			write();

			for (const gate of ORDER) {
				if (live[gate] || out.has(gate) || waiting.has(gate)) {
					continue;
				}

				const {fadeMs} = GATES[gate];

				if (first || fadeMs === 0) {
					takeOut(gate);
				} else {
					waiting.set(
						gate,
						fx.after(fadeMs + FADE_MARGIN_MS, () => takeOut(gate))
					);
				}
			}
		},

		settle() {
			for (const gate of ORDER) {
				const cancel = waiting.get(gate);

				if (cancel) {
					cancel();
					takeOut(gate);
				}
			}
		},

		forget(gate) {
			waiting.get(gate)?.();
			waiting.delete(gate);
			out.delete(gate);
		},

		stop() {
			for (const cancel of waiting.values()) {
				cancel();
			}

			waiting.clear();
		},
	};
}
