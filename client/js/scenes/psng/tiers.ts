import type {SceneHostState} from "../../themeScene";

/** How much of the NG scene moves: everything, the slow few, or nothing. */
export type Tier = "full" | "calm" | "still";

export function tierFor(state: SceneHostState, reduceMotion: boolean): Tier {
	if (
		!state.visible ||
		!state.attended ||
		state.view === "query" ||
		reduceMotion ||
		state.motion === "still"
	) {
		return "still";
	}

	return state.motion === "calm" ? "calm" : "full";
}
