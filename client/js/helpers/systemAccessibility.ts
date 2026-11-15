// The system's Reduce Motion, Increase Contrast and Reduce Transparency, as
// three attributes on <html> that every rule reads: `data-reduce-motion`,
// `data-contrast="more"` (style.css, keeki.css) and `data-reduce-transparency`
// (ps.css, macos.css). In a browser and the iOS shell the first two come
// from the media queries, live. WebKit has no `prefers-reduced-transparency`
// at all (bugs.webkit.org 175497), so in the iOS and macOS shells the third
// comes from the shell's `Transparency` plugin (SeancePlugin.swift,
// Bridge.swift), and elsewhere from the query where the engine has it
// (Chromium, so WebView2 and Android's WebView). Android's WebView answers
// those queries from the settings as they were when its process started and
// never again (Chromium observes the accessibility settings in WebView only
// behind WebViewObserveAccessibilityState, off by default for its startup
// cost), and the "stay connected" service keeps that process for days — so
// in the Android shell the settings come from the shell itself
// (SystemAccessibility.kt), which watches them, and the media
// queries are only the first guess until it answers.
//
// Imports nothing but the bridge, so boot.ts can call it before anything
// mounts and a component can subscribe without pulling in the store.

import {isAndroidShell, nativeCall, nativeListen, nativePlatform} from "./shell";

export interface SystemAccessibility {
	reduceMotion: boolean;
	highContrast: boolean;
	reduceTransparency: boolean;
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
export function fromAndroidSettings(
	s: AndroidAccessibilitySettings
): Omit<SystemAccessibility, "reduceTransparency"> {
	return {
		highContrast: s.highTextContrast === 1 || s.contrast === 1,
		reduceMotion: s.animatorDurationScale === 0,
	};
}

/** Everything SystemAccessibility.kt reports, `status` and
 * `changed` alike: the accessibility settings, the font scale
 * (helpers/systemTextSize.ts) and battery saver (the ps scene's Auto,
 * themeScene.ts). A shell built before a field omits it. */
export interface AndroidSystemStatus extends Partial<AndroidAccessibilitySettings> {
	fontScale?: number;
	powerSave?: boolean;
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
const REDUCE_TRANSPARENCY_QUERY = "(prefers-reduced-transparency: reduce)";

/** What the Apple shells' Transparency plugin reports. */
export interface TransparencyStatus {
	reduce?: boolean;
}

let current: SystemAccessibility = {
	reduceMotion: false,
	highContrast: false,
	reduceTransparency: false,
};
let fromShell = false;
let transparencyFromShell = false;
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

	root.toggleAttribute("data-reduce-transparency", next.reduceTransparency);

	if (
		next.reduceMotion === current.reduceMotion &&
		next.highContrast === current.highContrast &&
		next.reduceTransparency === current.reduceTransparency
	) {
		return;
	}

	current = next;

	for (const listener of listeners) {
		listener(current);
	}
}

function fromMedia(): Omit<SystemAccessibility, "reduceTransparency"> {
	return {
		reduceMotion: window.matchMedia?.(REDUCE_MOTION_QUERY).matches === true,
		highContrast: window.matchMedia?.(HIGH_CONTRAST_QUERY).matches === true,
	};
}

function transparencyFromMedia(): boolean {
	return window.matchMedia?.(REDUCE_TRANSPARENCY_QUERY).matches === true;
}

/** Reduce Motion and Increase Contrast, from wherever they come now. */
function applyMotionContrast(next: Omit<SystemAccessibility, "reduceTransparency">): void {
	apply({...next, reduceTransparency: current.reduceTransparency});
}

function applyTransparency(reduceTransparency: boolean): void {
	apply({...current, reduceTransparency});
}

function fromAppleShell(status: TransparencyStatus | null | undefined): void {
	// A shell built before the plugin answers nothing.
	if (typeof status?.reduce !== "boolean") {
		return;
	}

	transparencyFromShell = true;
	applyTransparency(status.reduce);
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
	applyMotionContrast(fromAndroidSettings({highTextContrast, contrast, animatorDurationScale}));
}

/** Start following the system. Synchronous for the first value: call it
 * before anything renders. */
export function followSystemAccessibility(): void {
	if (following) {
		return;
	}

	following = true;
	apply({...fromMedia(), reduceTransparency: transparencyFromMedia()});

	for (const query of [REDUCE_MOTION_QUERY, HIGH_CONTRAST_QUERY]) {
		window.matchMedia?.(query).addEventListener?.("change", () => {
			if (!fromShell) {
				applyMotionContrast(fromMedia());
			}
		});
	}

	window.matchMedia?.(REDUCE_TRANSPARENCY_QUERY).addEventListener?.("change", () => {
		if (!transparencyFromShell) {
			applyTransparency(transparencyFromMedia());
		}
	});

	onAndroidSystemStatus(fromAndroidShell);

	const platform = nativePlatform();

	if (platform === "ios" || platform === "macos") {
		nativeListen("Transparency", "changed", fromAppleShell);
		nativeCall<TransparencyStatus>("Transparency", "status").then(fromAppleShell, () => {
			// An older shell: the query stands, which WebKit never matches.
		});
	}
}
