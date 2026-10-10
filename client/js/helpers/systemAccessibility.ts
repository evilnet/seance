// The system's Reduce Motion and Increase Contrast, as two attributes on
// <html> that every rule reads: `data-reduce-motion` and
// `data-contrast="more"` (style.css, keeki.css). In a browser and the iOS
// shell they come from the media queries, live. Android's WebView answers
// those queries from the settings as they were when its process started and
// never again (Chromium observes the accessibility settings in WebView only
// behind WebViewObserveAccessibilityState, off by default for its startup
// cost), and the "stay connected" service keeps that process for days — so
// in the Android shell the settings come from the shell itself
// (SystemAccessibilityPlugin.java), which watches them, and the media
// queries are only the first guess until it answers.
//
// Imports nothing but the bridge, so boot.ts can call it before anything
// mounts and a component can subscribe without pulling in the store.

import {isAndroidShell, nativeCall, nativeListen} from "./capacitor";

export interface SystemAccessibility {
	reduceMotion: boolean;
	highContrast: boolean;
}

/** What the Android shell reports: the raw settings. */
export interface AndroidAccessibilitySettings {
	/** Settings.Secure high_text_contrast_enabled (0/1). */
	highTextContrast: number;
	/** UiModeManager.getContrast(), -1…1; 0 before Android 14. */
	contrast: number;
	/** Settings.Global animator_duration_scale; 0 is "Remove animations". */
	animatorDurationScale: number;
}

/**
 * Chromium's own rule for Android (ui/native_theme/os_settings_provider_android.cc,
 * AccessibilityStateDelegateImpl.java), so the app agrees with Chrome: high
 * contrast is "High contrast text" or the Contrast setting at its top step,
 * and only "Remove animations" (scale 0) is reduced motion — 0.5× is not.
 */
export function fromAndroidSettings(s: AndroidAccessibilitySettings): SystemAccessibility {
	return {
		highContrast: s.highTextContrast === 1 || s.contrast === 1,
		reduceMotion: s.animatorDurationScale === 0,
	};
}

/** Everything SystemAccessibilityPlugin.java reports, `status` and
 * `changed` alike: the accessibility settings and the font scale
 * (helpers/systemTextSize.ts). A shell built before a field omits it. */
export interface AndroidSystemStatus extends Partial<AndroidAccessibilitySettings> {
	fontScale?: number;
}

const statusListeners = new Set<(status: AndroidSystemStatus) => void>();
let lastStatus: AndroidSystemStatus | null = null;
let bridged = false;

function fanOut(status: AndroidSystemStatus | null): void {
	// A shell built before the plugin answers nothing.
	if (!status) {
		return;
	}

	lastStatus = status;

	for (const listener of statusListeners) {
		listener(status);
	}
}

/**
 * Hear the Android shell's SystemAccessibility reports: one `changed`
 * subscription and one `status` call for every reader, the last report
 * replayed to a late one. Nothing outside the Android shell.
 */
export function onAndroidSystemStatus(listener: (status: AndroidSystemStatus) => void): void {
	if (!isAndroidShell()) {
		return;
	}

	statusListeners.add(listener);

	if (lastStatus) {
		listener(lastStatus);
	}

	if (bridged) {
		return;
	}

	bridged = true;
	nativeListen("SystemAccessibility", "changed", fanOut);
	void nativeCall<AndroidSystemStatus>("SystemAccessibility", "status").then(fanOut);
}

const REDUCE_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const HIGH_CONTRAST_QUERY = "(prefers-contrast: more)";

let current: SystemAccessibility = {reduceMotion: false, highContrast: false};
let fromShell = false;
let following = false;
const listeners = new Set<(state: SystemAccessibility) => void>();

/** The settings as they stand now. */
export function systemAccessibility(): SystemAccessibility {
	return current;
}

/** Hear every change; returns the unsubscribe. */
export function onSystemAccessibility(listener: (state: SystemAccessibility) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function apply(next: SystemAccessibility): void {
	const root = document.documentElement;
	root.toggleAttribute("data-reduce-motion", next.reduceMotion);

	if (next.highContrast) {
		root.setAttribute("data-contrast", "more");
	} else {
		root.removeAttribute("data-contrast");
	}

	if (next.reduceMotion === current.reduceMotion && next.highContrast === current.highContrast) {
		return;
	}

	current = next;

	for (const listener of listeners) {
		listener(current);
	}
}

function fromMedia(): SystemAccessibility {
	return {
		reduceMotion: window.matchMedia?.(REDUCE_MOTION_QUERY).matches === true,
		highContrast: window.matchMedia?.(HIGH_CONTRAST_QUERY).matches === true,
	};
}

function fromAndroidShell(status: AndroidSystemStatus): void {
	const {highTextContrast, contrast, animatorDurationScale} = status;

	// A report without the settings: the media queries are all there is.
	if (
		typeof highTextContrast !== "number" ||
		typeof contrast !== "number" ||
		typeof animatorDurationScale !== "number"
	) {
		return;
	}

	fromShell = true;
	apply(fromAndroidSettings({highTextContrast, contrast, animatorDurationScale}));
}

/** Start following the system. Synchronous for the first value: call it
 * before anything renders. */
export function followSystemAccessibility(): void {
	if (following) {
		return;
	}

	following = true;
	apply(fromMedia());

	for (const query of [REDUCE_MOTION_QUERY, HIGH_CONTRAST_QUERY]) {
		window.matchMedia?.(query).addEventListener?.("change", () => {
			if (!fromShell) {
				apply(fromMedia());
			}
		});
	}

	onAndroidSystemStatus(fromAndroidShell);
}
