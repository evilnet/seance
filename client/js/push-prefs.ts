/**
 * Reader preferences the service worker needs (it cannot read
 * localStorage), mirrored into the IndexedDB store it already uses
 * (seance-push/kv, key "prefs"): whether Markdown renders, so a push
 * notification strips markers exactly when the page does (settings.ts
 * `markdown.apply`, at boot and on every change), and the conversations
 * muted on this device (mute.ts, at load and on every change), which a push
 * shows quietly, and each network's ignore list (ignore.ts, as a list loads
 * and on every change), from which a push shows nothing new.
 */
import {idbGet, idbSet} from "./idb";

/** `muted`: the conversations muted on this device (`<network uuid>/<name
 * lowercased>`, client/js/mute.ts; the worker compares them under IRC's
 * case folding). */
export type PushPrefs = {
	markdown: boolean;
	muted: string[];
	/** Each network's ignore list (client/js/ignore.ts), by network uuid;
	 * the worker matches a push's sender against it (push/ignore.ts). */
	ignored: Record<string, IgnoredMask[]>;
};

/** An ignore entry as the worker needs it: the mask, not when it was added. */
export type IgnoredMask = {nick: string; ident: string; hostname: string};

export const PREFS_KEY = "prefs";

// One update at a time: each reads the entry and writes it back, so two in
// flight (the markdown setting, the mute list, at boot) would each write
// what it read and drop the other's field.
let queue: Promise<void> = Promise.resolve();

export function mirrorPushPrefs(
	patch: Partial<PushPrefs> | ((prev: Partial<PushPrefs>) => Partial<PushPrefs>)
): Promise<void> {
	queue = queue.then(async () => {
		try {
			const prev = (await idbGet<Partial<PushPrefs>>(PREFS_KEY)) ?? {};
			const next = typeof patch === "function" ? patch(prev) : patch;
			await idbSet(PREFS_KEY, {...prev, ...next});
		} catch (error) {
			// No IndexedDB (private mode, quota): the worker uses the default.
		}
	});

	return queue;
}

/** One network's ignore list, in place of what was mirrored for it before. */
export function mirrorIgnoreList(networkUuid: string, masks: IgnoredMask[]): Promise<void> {
	return mirrorPushPrefs((prev) => {
		const ignored = {...prev.ignored};

		if (masks.length > 0) {
			ignored[networkUuid] = masks;
		} else {
			delete ignored[networkUuid];
		}

		return {ignored};
	});
}
