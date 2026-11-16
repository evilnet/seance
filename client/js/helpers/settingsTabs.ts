import type {RouteRecordName} from "vue-router";
import {store} from "../store";

export function shouldShowGeneralSettings() {
	const config = store.state.serverConfiguration;
	return !config?.public || !!config?.fileUpload;
}

/** Routes that open inside a tab, by the tab they belong to: the tab stays
 * lit while they are up. */
const PARENT_TAB: Record<string, string> = {
	NetworkEdit: "Networks",
	ScriptEdit: "Scripts",
	Aliases: "Scripts",
};

/** The settings tab a route name belongs to (its own name for a tab). */
export function settingsTabFor(name: RouteRecordName | null | undefined): string | undefined {
	if (typeof name !== "string") {
		return undefined;
	}

	return PARENT_TAB[name] ?? name;
}
