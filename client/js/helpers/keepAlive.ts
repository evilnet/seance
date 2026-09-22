// The Android shell's "stay connected" foreground service, from the page
// (shells/capacitor: KeepAlivePlugin.java / ConnectionService.java). Nothing
// but the injected bridge is touched, so settings.ts can import this without
// pulling the store or the router into a cycle; a browser, and the iOS
// shell, have no such service and every call is a no-op.

export interface KeepAliveStatus {
	/** The foreground service is up. */
	running: boolean;
	/** Android lets the app show its notification (always true before 13). */
	notifications: boolean;
}

function bridge() {
	const cap = window.Capacitor;

	if (!cap?.isNativePlatform?.() || cap.getPlatform?.() !== "android" || !cap.nativePromise) {
		return null;
	}

	return cap;
}

/** True inside the Android shell, the one platform with the service. */
export function keepAliveAvailable(): boolean {
	return bridge() !== null;
}

/**
 * Start or stop the service. `quiet` is the boot-time re-apply of a stored
 * setting: it never asks for the notification permission, the toggle does.
 * Resolves to the service's status, or null where there is none.
 */
export async function setKeepAlive(on: boolean, quiet = false): Promise<KeepAliveStatus | null> {
	const cap = bridge();

	if (!cap) {
		return null;
	}

	try {
		const result = await cap.nativePromise!("KeepAlive", on ? "enable" : "disable", {quiet});
		return result as KeepAliveStatus;
	} catch (e) {
		// An old shell without the plugin: the setting has no effect there.
		return null;
	}
}

export async function keepAliveStatus(): Promise<KeepAliveStatus | null> {
	const cap = bridge();

	if (!cap) {
		return null;
	}

	try {
		return (await cap.nativePromise!("KeepAlive", "status", {})) as KeepAliveStatus;
	} catch (e) {
		return null;
	}
}
