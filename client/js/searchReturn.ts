// What Back to results (Chat.vue) brings back: the search window as it was left
// for a hit (Windows/SearchResults.vue). Only that button restores it; any other
// way to the same search asks the server again.
import type {SearchHit} from "../../shared/types/search";

export type KeptResults = {
	windowId: number;
	q: string;
	rows: SearchHit[];
	mode: "server" | "unsupported" | "offline" | "partial";
	reachedEnd: boolean;
	scrollTop: number;
	hit: number;
};

let kept: KeptResults | null = null;
let returning = false;

export function keepResults(results: KeptResults): void {
	kept = results;
	returning = false;
}

/** The bar's ✕: the search is over, and opening search again starts afresh. */
export function forgetResults(): void {
	kept = null;
	returning = false;
}

export function returnToResults(): void {
	returning = true;
}

/** The results to show for this search, if the button brought us to them; spent either way. */
export function takeResults(windowId: number, q: string): KeptResults | null {
	const results = returning && kept?.windowId === windowId && kept.q === q ? kept : null;
	kept = null;
	returning = false;
	return results;
}
