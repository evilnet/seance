// The system translator's language packs the reading pipeline found it
// could use but did not open the system's sheet for (service.ts
// `ResolveOptions.quiet`): the line translates with the app's own models
// and the first line translated from that pair offers the pack under it
// ("Apple can translate Portuguese on this device · Get it",
// TranslationLine.vue). One line per pair per page load; once tapped, the
// pair is not offered again.

import {reactive} from "vue";

/** Per `from>to`: available (null), shown on that message's line (its id), or taken. */
const packs = reactive(new Map<string, number | null | "taken">());

const key = (from: string, to: string) => `${from}>${to}`;

/** The service's `onApplePack`: the pair can be offered. */
export function notePack(from: string, to: string): void {
	if (!packs.has(key(from, to))) {
		packs.set(key(from, to), null);
	}
}

/** A line translated from `from` into `to`: it shows the offer if the pair has no line yet. */
export function claimPack(id: number, from: string | null | undefined, to: string): void {
	if (from && packs.get(key(from, to)) === null) {
		packs.set(key(from, to), id);
	}
}

/** Whether the line `id` shows the pair's offer. */
export function packShownOn(id: number, from: string | null | undefined, to: string): boolean {
	return !!from && packs.get(key(from, to)) === id;
}

/** The offer was taken (the sheet opened): no line offers the pair again. */
export function takePack(from: string, to: string): void {
	packs.set(key(from, to), "taken");
}

/** Translation switched off: nothing is offered from before. */
export function clearPacks(): void {
	packs.clear();
}
