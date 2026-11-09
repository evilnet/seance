// The bridge to the app shell around the page, and nothing else. A shell is
// whatever hosts the built SPA as an app: the Tauri shell (shells/tauri), on
// the phones and on the desktop (docs/projects/desktop-shells.md). It answers
// one contract — call a plugin's method, listen to a plugin's event — and a
// plugin or method a platform does not have answers null, so a caller never
// needs to know which platform it is on unless it means one.
//
// The web build bundles no shell code: the shell injects `window.seanceShell`
// before our scripts run.
//
// This module imports nothing. `settings.ts` and the helpers it pulls in reach
// the shell through here rather than through `native.ts`, which carries the
// store, the router and the IRC manager with it.

/** Where a shell runs. `web` is no shell: a browser tab or an installed PWA. */
export type ShellPlatform = "ios" | "android" | "macos" | "windows" | "linux";

/** What the shell puts on `window.seanceShell`. */
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

declare global {
	interface Window {
		seanceShell?: SeanceShell;
	}
}

const DESKTOP: readonly string[] = ["macos", "windows", "linux"];
const PLATFORMS: readonly string[] = [...DESKTOP, "ios", "android"];

/** The shell around this page, or null in a browser. */
export function shellBridge(): SeanceShell | null {
	const shell = window.seanceShell;

	if (
		!shell ||
		!PLATFORMS.includes(shell.platform) ||
		typeof shell.call !== "function" ||
		typeof shell.listen !== "function"
	) {
		return null;
	}

	return shell;
}

/** Which shell: one of {@link ShellPlatform}, or `"web"` in a browser. */
export function nativePlatform(): ShellPlatform | "web" {
	return shellBridge()?.platform ?? "web";
}

/**
 * The value for `data-tauri-drag-region` on the Mac app's drag surfaces (the
 * strip over the sidebar, a window's header): "deep", so a press anywhere in
 * it that is not a control moves the window and a double-click zooms it, as
 * a titlebar does (Tauri's own drag region; capabilities/mac-window-drag.json).
 * Undefined, so no attribute, everywhere else: other shells keep their own
 * titlebar.
 */
export function macDragRegion(): "deep" | undefined {
	return nativePlatform() === "macos" ? "deep" : undefined;
}

/** True inside any shell, phone or desktop. */
export function isShell(): boolean {
	return shellBridge() !== null;
}

/** True inside the shell on a phone (iOS / Android). */
export function isMobileShell(): boolean {
	const platform = nativePlatform();
	return platform === "ios" || platform === "android";
}

/** True inside the shell on a desktop (macOS / Windows / Linux). */
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
