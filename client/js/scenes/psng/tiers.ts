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

/** Seconds from local midnight of `reference`'s day to `now`: the phase every loop of the NG scene starts from. */
export function phaseSeconds(now: Date, reference: Date): number {
	const midnight = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate());
	return (now.getTime() - midnight.getTime()) / 1000;
}
