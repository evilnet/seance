// In-page devtools (eruda) for development builds only.
//
// `process.env.NODE_ENV` is replaced at build time (vite.config.mts
// `define`), so in a production build the `import("eruda")` below is
// unreachable and the bundler emits neither the call nor an eruda chunk:
// production bundles never contain eruda.

export const devtoolsAvailable = process.env.NODE_ENV !== "production";

type Eruda = typeof import("eruda").default;

let eruda: Eruda | null = null;
let shown = false;

/** Load eruda on first use and toggle its panel. No-op in production. */
export async function toggleDevtools(): Promise<void> {
	// Spelled out (not `devtoolsAvailable`): the branch is only dead when
	// the replaced expression itself is the condition.
	if (process.env.NODE_ENV === "production") {
		return;
	}

	if (!eruda) {
		eruda = (await import("eruda")).default;
		eruda.init({useShadowDom: true, defaults: {displaySize: 50}});
	}

	shown = !shown;

	if (shown) {
		eruda.show();
	} else {
		eruda.hide();
	}
}
