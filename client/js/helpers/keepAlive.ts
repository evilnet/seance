// The Android shell's "stay connected" foreground service, from the page
// (shells/capacitor: KeepAlivePlugin.java / ConnectionService.java). Only the
// bridge is touched (helpers/capacitor.ts imports nothing), so settings.ts can
// import this without pulling the store or the router into a cycle; a browser,
// and the iOS shell, have no such service and every call is a no-op.

import {isAndroidShell, nativeCall} from "./capacitor";

export interface KeepAliveStatus {
	/** The foreground service is up. */
	running: boolean;
	/** Android lets the app show its notification (always true before 13). */
	notifications: boolean;
}

type StatusListener = (status: KeepAliveStatus) => void;
const listeners = new Set<StatusListener>();

/**
 * Hear every status the shell reports — after an enable/disable (which,
 * for the first enable, resolves only once Android's permission prompt is
 * answered) and after a status query. Returns the unsubscribe.
 */
export function onKeepAliveStatus(listener: StatusListener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Pass a status on to the listeners; null (no shell, no plugin) is nothing. */
function publish(status: KeepAliveStatus | null): KeepAliveStatus | null {
	if (status) {
		for (const listener of listeners) {
			listener(status);
		}
	}

	return status;
}

/** True inside the Android shell, the one platform with the service. */
export function keepAliveAvailable(): boolean {
	return isAndroidShell();
}

/**
 * Start or stop the service. `quiet` is the boot-time re-apply of a stored
 * setting: it never asks for the notification permission, the toggle does.
 * Resolves to the service's status, or null where there is none — a browser,
 * the iOS shell, or an Android shell built before the plugin existed.
 */
export async function setKeepAlive(on: boolean, quiet = false): Promise<KeepAliveStatus | null> {
	if (!keepAliveAvailable()) {
		return null;
	}

	return publish(
		await nativeCall<KeepAliveStatus>("KeepAlive", on ? "enable" : "disable", {quiet})
	);
}

export async function keepAliveStatus(): Promise<KeepAliveStatus | null> {
	if (!keepAliveAvailable()) {
		return null;
	}

	return publish(await nativeCall<KeepAliveStatus>("KeepAlive", "status"));
}
