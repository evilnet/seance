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

async function setNativeBadge(count: number): Promise<void> {
	if (count <= 0) {
		// Harmless without the permission: there is no badge to clear.
		await nativeCall("Badge", "clear");
		return;
	}

	if (nativeGranted === null) {
		nativeGranted = await askBadgePermission();
	}

	if (nativeGranted) {
		await nativeCall("Badge", "set", {count});
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
		void setNativeBadge(count);
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
