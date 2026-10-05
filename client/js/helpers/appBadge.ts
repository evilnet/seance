// The app icon's badge: the unread highlight count (vue.ts watches the
// store's `highlightCount`). In a browser that is the Badging API, which an
// installed PWA honours; in the native shell (shells/capacitor) it is the
// Badge plugin, because WKWebView has no `navigator.setAppBadge`.
//
// iOS shows a badge only with the notification permission's badge grant, so
// the first highlight asks for it, badge only (the plugin requests nothing
// else). A refusal is remembered by the OS and nothing here asks again; a
// sheet dismissed without an answer (the app backgrounded under it) leaves
// the permission undecided, and the next highlight asks again.

import {isNativeShell, nativeCall} from "./capacitor";

interface BadgePermission {
	display?: "granted" | "denied" | "prompt" | "prompt-with-rationale";
}

let nativeGranted: boolean | null = null;

// The count the store wants shown, and the bridge calls that show it, one at
// a time: a set held up by the iOS permission sheet must not land after a
// clear that came later. Each turn reads the count when it runs, so a turn
// that has been overtaken writes the newer count, never its own.
let wantedCount = 0;
let nativeQueue: Promise<void> = Promise.resolve();

function setNativeBadge(count: number): void {
	wantedCount = count;
	nativeQueue = nativeQueue.then(applyNativeBadge).catch(() => {});
}

async function applyNativeBadge(): Promise<void> {
	if (wantedCount <= 0) {
		// Harmless without the permission: there is no badge to clear.
		await nativeCall("Badge", "clear");
		return;
	}

	if (nativeGranted === null) {
		nativeGranted = await askBadgePermission();
	}

	// Zero by now means a clear is queued behind this turn.
	if (nativeGranted && wantedCount > 0) {
		await nativeCall("Badge", "set", {count: wantedCount});
	}
}

/** Granted or denied, remembered; still undecided (sheet dismissed), null. */
async function askBadgePermission(): Promise<boolean | null> {
	const check = await nativeCall<BadgePermission>("Badge", "checkPermissions");
	let status = check?.display;

	if (status === "prompt" || status === "prompt-with-rationale") {
		status = (await nativeCall<BadgePermission>("Badge", "requestPermissions"))?.display;
	}

	return status === "granted" ? true : status === "denied" ? false : null;
}

export function setAppBadge(count: number): void {
	if (isNativeShell()) {
		setNativeBadge(count);
		return;
	}

	const nav = window.navigator;

	if (typeof nav.setAppBadge !== "function") {
		return;
	}

	if (count > 0) {
		nav.setAppBadge(count).catch(() => {});
	} else if (typeof nav.clearAppBadge === "function") {
		nav.clearAppBadge().catch(() => {});
	}
}
