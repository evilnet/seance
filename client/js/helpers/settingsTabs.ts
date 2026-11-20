import type {RouteLocationNormalizedLoaded} from "vue-router";
import {store} from "../store";

export function shouldShowGeneralSettings() {
	const config = store.state.serverConfiguration;
	return !config?.public || !!config?.fileUpload;
}

/** The settings tab a route belongs to: the one its `meta.tab` names (a
 * page opened inside a tab, router.ts), else its own name. */
export function settingsTabFor(route: RouteLocationNormalizedLoaded): string | undefined {
	if (route.meta.tab) {
		return route.meta.tab;
	}

	return typeof route.name === "string" ? route.name : undefined;
}
