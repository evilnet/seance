// The Capacitor bridge, and nothing else. The web build never bundles
// Capacitor: the shell's WebView injects `window.Capacitor` (its "native
// bridge") before our scripts run, so everything here is feature-detected and
// a no-op in a browser. Only the bridge's own `addListener` / `nativePromise`
// are used; `Capacitor.Plugins` stays empty unless `@capacitor/core` is
// bundled.
//
// This module imports nothing. `settings.ts` and the helpers it pulls in reach
// the shell through here rather than through `native.ts`, which carries the
// store, the router and the IRC manager with it.

interface CapacitorBridge {
	isNativePlatform?: () => boolean;
	getPlatform?: () => string;
	addListener?: (plugin: string, event: string, cb: (data: any) => void) => unknown;
	nativePromise?: (plugin: string, method: string, options?: unknown) => Promise<unknown>;
}

/** The bridge with the two members every call site needs. */
export type NativeBridge = CapacitorBridge & {
	addListener: NonNullable<CapacitorBridge["addListener"]>;
	nativePromise: NonNullable<CapacitorBridge["nativePromise"]>;
};

declare global {
	interface Window {
		Capacitor?: CapacitorBridge;
		/** Capacitor Android's SystemBars plugin, a JavascriptInterface. */
		CapacitorSystemBarsAndroidInterface?: {onDOMReady: () => void};
	}
}

/** Which shell: `"ios"`, `"android"`, or `"web"` in a browser. */
export function nativePlatform(): string {
	return window.Capacitor?.getPlatform?.() ?? "web";
}

/** The bridge, when this page runs inside the native shell. */
export function nativeBridge(): NativeBridge | null {
	const cap = window.Capacitor;

	if (!cap?.isNativePlatform?.() || !cap.addListener || !cap.nativePromise) {
		return null;
	}

	return cap as NativeBridge;
}

/** True inside the Capacitor shell (iOS / Android). */
export function isNativeShell(): boolean {
	return nativeBridge() !== null;
}

export function isIOSShell(): boolean {
	return isNativeShell() && nativePlatform() === "ios";
}

export function isAndroidShell(): boolean {
	return isNativeShell() && nativePlatform() === "android";
}

/**
 * Call a plugin, or resolve to null where there is nothing to call: a
 * browser, a shell whose build predates the plugin, a method the platform
 * does not implement. A rejection is never thrown on — an unhandled one at
 * every boot is what a missing method used to cost — so a caller that needs
 * to tell "it answered" from "it did not" checks for null.
 */
export async function nativeCall<T>(
	plugin: string,
	method: string,
	options: unknown = {}
): Promise<T | null> {
	const cap = nativeBridge();

	if (!cap) {
		return null;
	}

	try {
		return (await cap.nativePromise(plugin, method, options)) as T;
	} catch {
		return null;
	}
}

/** Subscribe to a plugin's event; a no-op in a browser. */
export function nativeListen(plugin: string, event: string, cb: (data: any) => void): void {
	nativeBridge()?.addListener(plugin, event, cb);
}
