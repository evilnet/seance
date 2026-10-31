// The bridge to the app shell around the page, and nothing else. A shell is
// whatever hosts the built SPA as an app: the Capacitor shells on the phones
// (shells/capacitor) and the desktop shell (shells/tauri;
// docs/projects/desktop-shells.md). Every shell answers the same contract —
// call a plugin's method, listen to a plugin's event — and a plugin or method
// a shell does not have answers null, so a caller never needs to know which
// shell it is in unless it means one platform.
//
// The web build bundles no shell code. A desktop shell injects
// `window.seanceShell` before our scripts run; the Capacitor shells inject
// `window.Capacitor` (their "native bridge"), adapted here to the same
// contract through its own `addListener` / `nativePromise` alone —
// `Capacitor.Plugins` stays empty unless `@capacitor/core` is bundled.
//
// This module imports nothing. `settings.ts` and the helpers it pulls in reach
// the shell through here rather than through `native.ts`, which carries the
// store, the router and the IRC manager with it.

/** Where a shell runs. `web` is no shell: a browser tab or an installed PWA. */
export type ShellPlatform = "ios" | "android" | "macos" | "windows" | "linux";

/** What a desktop shell puts on `window.seanceShell`. */
export interface SeanceShell {
	platform: ShellPlatform;
	/** The shell's own version, which is not the web build's. */
	version?: string;
	/** Call a plugin's method. Rejects with `{message, code?}` on a refusal,
	 * code `unimplemented` for a plugin or method the shell does not have. */
	call(plugin: string, method: string, options?: unknown): Promise<unknown>;
	/** Subscribe to a plugin's event. */
	listen(plugin: string, event: string, cb: (data: any) => void): void;
}

interface CapacitorBridge {
	isNativePlatform?: () => boolean;
	getPlatform?: () => string;
	addListener?: (plugin: string, event: string, cb: (data: any) => void) => unknown;
	nativePromise?: (plugin: string, method: string, options?: unknown) => Promise<unknown>;
}

declare global {
	interface Window {
		seanceShell?: SeanceShell;
		Capacitor?: CapacitorBridge;
		/** Capacitor Android's SystemBars plugin, a JavascriptInterface. */
		CapacitorSystemBarsAndroidInterface?: {onDOMReady: () => void};
	}
}

const DESKTOP: readonly string[] = ["macos", "windows", "linux"];

function desktopShell(): SeanceShell | null {
	const shell = window.seanceShell;

	if (
		!shell ||
		!DESKTOP.includes(shell.platform) ||
		typeof shell.call !== "function" ||
		typeof shell.listen !== "function"
	) {
		return null;
	}

	return shell;
}

// The adapter is made once per bridge object, so callers comparing shells
// (or holding one) see the same object every time.
let adapted: {from: CapacitorBridge; shell: SeanceShell} | null = null;

function capacitorShell(): SeanceShell | null {
	const cap = window.Capacitor;

	if (!cap?.isNativePlatform?.() || !cap.addListener || !cap.nativePromise) {
		return null;
	}

	const platform = cap.getPlatform?.();

	if (platform !== "ios" && platform !== "android") {
		return null;
	}

	if (adapted?.from !== cap) {
		const {addListener, nativePromise} = cap;
		adapted = {
			from: cap,
			shell: {
				platform,
				call: (plugin, method, options = {}) =>
					nativePromise.call(cap, plugin, method, options),
				listen: (plugin, event, cb) => void addListener.call(cap, plugin, event, cb),
			},
		};
	}

	return adapted.shell;
}

/** The shell around this page, or null in a browser. */
export function shellBridge(): SeanceShell | null {
	return capacitorShell() ?? desktopShell();
}

/** Which shell: one of {@link ShellPlatform}, or `"web"` in a browser. */
export function nativePlatform(): ShellPlatform | "web" {
	return shellBridge()?.platform ?? "web";
}

/** True inside any shell, phone or desktop. */
export function isShell(): boolean {
	return shellBridge() !== null;
}

/** True inside the Capacitor shell (iOS / Android). */
export function isMobileShell(): boolean {
	const platform = nativePlatform();
	return platform === "ios" || platform === "android";
}

/** True inside a desktop shell (macOS / Windows / Linux). */
export function isDesktopShell(): boolean {
	return DESKTOP.includes(nativePlatform());
}

export function isIOSShell(): boolean {
	return nativePlatform() === "ios";
}

export function isAndroidShell(): boolean {
	return nativePlatform() === "android";
}

/**
 * Call a plugin, or resolve to null where there is nothing to call: a
 * browser, a shell whose build predates the plugin, a method the platform
 * does not implement. A rejection is never thrown on — an unhandled one at
 * every boot is what a missing method used to cost — so a caller that needs
 * to tell "it answered" from "it did not" checks for null, and one that must
 * know why the plugin refused uses {@link nativeInvoke}.
 */
export async function nativeCall<T>(
	plugin: string,
	method: string,
	options: unknown = {}
): Promise<T | null> {
	const shell = shellBridge();

	if (!shell) {
		return null;
	}

	try {
		return (await shell.call(plugin, method, options)) as T;
	} catch {
		return null;
	}
}

/** A plugin call's rejection: the plugin's message, and its code when it gave one. */
export class NativeCallError extends Error {
	readonly code: string | undefined;

	constructor(message: string, code: string | undefined) {
		super(message);
		this.name = "NativeCallError";
		this.code = code;
	}
}

/**
 * {@link nativeCall} for a caller that must tell the plugin's answers
 * apart: resolves to what the plugin resolved, rejects with a
 * {@link NativeCallError} carrying the plugin's code when it rejected (or
 * when there is no bridge to call).
 */
export async function nativeInvoke<T>(
	plugin: string,
	method: string,
	options: unknown = {}
): Promise<T> {
	const shell = shellBridge();

	if (!shell) {
		throw new NativeCallError("no native bridge", "unavailable");
	}

	try {
		return (await shell.call(plugin, method, options)) as T;
	} catch (error) {
		const e = (error ?? {}) as {message?: unknown; code?: unknown};
		throw new NativeCallError(
			typeof e.message === "string" ? e.message : String(error),
			typeof e.code === "string" ? e.code : undefined
		);
	}
}

/** Subscribe to a plugin's event; a no-op in a browser. */
export function nativeListen(plugin: string, event: string, cb: (data: any) => void): void {
	shellBridge()?.listen(plugin, event, cb);
}
