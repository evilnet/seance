/**
 * Reader preferences the service worker needs (it cannot read
 * localStorage), mirrored into the IndexedDB store it already uses
 * (seance-push/kv, key "prefs"): whether Markdown renders, so a push
 * notification strips markers exactly when the page does (settings.ts
 * `markdown.apply`, at boot and on every change), the UI language tag
 * (client/js/i18n) for the worker's own copy, and the conversations muted on
 * this device (mute.ts, at load and on every change), which a push shows
 * quietly.
 */
import {idbGet, idbSet} from "./idb";

/** `muted`: the conversations muted on this device (`<network uuid>/<name
 * lowercased>`, client/js/mute.ts; the worker compares them under IRC's
 * case folding). */
export type PushPrefs = {markdown: boolean; locale?: string; muted: string[]};

export const PREFS_KEY = "prefs";

// One update at a time: each reads the entry and writes it back, so two in
// flight (the markdown setting, the mute list, at boot) would each write
// what it read and drop the other's field.
let queue: Promise<void> = Promise.resolve();

export function mirrorPushPrefs(patch: Partial<PushPrefs>): Promise<void> {
	queue = queue.then(async () => {
		try {
			const prev = (await idbGet<Partial<PushPrefs>>(PREFS_KEY)) ?? {};
			await idbSet(PREFS_KEY, {...prev, ...patch});
		} catch (error) {
			// No IndexedDB (private mode, quota): the worker uses the default.
		}
	});

	return queue;
}
