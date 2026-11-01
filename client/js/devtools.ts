// In-page devtools (eruda) for development builds only.
//
// `process.env.NODE_ENV` is replaced by webpack at build time, so under
// `--mode=production` the `import("eruda")` below is unreachable and webpack
// emits neither the call nor an eruda chunk: production bundles never
// contain eruda.

export const devtoolsAvailable = process.env.NODE_ENV !== "production";

type Eruda = typeof import("eruda").default;

let eruda: Eruda | null = null;
let shown = false;

/** Load eruda on first use and toggle its panel. No-op in production. */
export async function toggleDevtools(): Promise<void> {
	// Spelled out (not `devtoolsAvailable`): webpack only treats the branch
	// as dead when the DefinePlugin expression itself is the condition.
	if (process.env.NODE_ENV === "production") {
		return;
	}

	if (!eruda) {
		eruda = (await import(/* webpackChunkName: "eruda" */ "eruda")).default;
		eruda.init({useShadowDom: true, defaults: {displaySize: 50}});
	}

	shown = !shown;

	if (shown) {
		eruda.show();
	} else {
		eruda.hide();
	}
}
