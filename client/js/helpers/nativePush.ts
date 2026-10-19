// The Android shell's stand-in for the Push API (shells/capacitor:
// NativePushPlugin.java, PushService.java). Its WebView has no PushManager,
// so a subscription there is a UnifiedPush registration made with the
// network's VAPID key — through FCM on a phone with Google Play services,
// or the user's own distributor — which hands back the same
// `{endpoint, keys}` a browser gives webpush.ts, and is registered with the
// ircd exactly as a browser's would be. Only the bridge is touched
// (helpers/capacitor.ts imports nothing); everywhere else every call is a
// no-op.

import {NativeCallError, isAndroidShell, nativeCall, nativeInvoke, nativeListen} from "./capacitor";

export interface NativePushMaterial {
	endpoint: string;
	keys: {p256dh: string; auth: string};
	/** The VAPID key the registration was made for (the shell records it). */
	vapid?: string;
}

export type NativePushPermission = "granted" | "denied" | "prompt";

interface NativePushStatus {
	/** A UnifiedPush distributor is on the device: the embedded FCM one
	 * (Google Play services present) or an app such as ntfy. */
	available: boolean;
	permission: NativePushPermission;
}

let status: NativePushStatus | null = null;

/**
 * Ask the shell what it can do; webpush.ts awaits this once at boot. A
 * browser, the iOS shell and a phone with no UnifiedPush distributor (the
 * embedded one needs Google Play services) all come back unavailable.
 */
export async function loadNativePush(): Promise<void> {
	if (!isAndroidShell()) {
		status = null;
		return;
	}

	status = await nativeCall<NativePushStatus>("NativePush", "status");
}

/** Push goes through the shell rather than the Push API. */
export function nativePushAvailable(): boolean {
	return status?.available === true;
}

export function nativePushPermission(): NativePushPermission {
	return status?.permission ?? "prompt";
}

/** Subscribe this device on a network: asks for the notification permission
 * first where Android needs one. Throws when there is no subscription, with
 * the shell's reason as the {@link NativeCallError} code — `denied` (which
 * {@link nativePushPermission} then says too), `cancelled` (see
 * {@link nativePushCancelled}), `unavailable` or `failed`. */
export async function nativeSubscribe(
	network: string,
	name: string,
	vapid: string
): Promise<NativePushMaterial> {
	try {
		const material = await nativeInvoke<NativePushMaterial>("NativePush", "subscribe", {
			network,
			name,
			vapid,
		});

		return {endpoint: material.endpoint, keys: material.keys};
	} finally {
		// The answer to the permission ask, whichever it was.
		await refreshNativePush();
	}
}

/** The subscribe was withdrawn while it ran (unsubscribed, or a later one
 * took over): nothing failed. */
export function nativePushCancelled(error: unknown): boolean {
	return error instanceof NativeCallError && error.code === "cancelled";
}

/** Read again what the shell can do: the user may have granted or revoked
 * the permission in Android's settings since. */
export async function refreshNativePush(): Promise<void> {
	if (isAndroidShell()) {
		status = (await nativeCall<NativePushStatus>("NativePush", "status")) ?? status;
	}
}

/** The network's current subscription — the distributor may renew its
 * endpoint — or null when this device is not subscribed there. Throws when
 * the shell could not be asked: that says nothing about the subscription. */
export async function nativeSubscription(network: string): Promise<NativePushMaterial | null> {
	const material = await nativeInvoke<{
		endpoint: string | null;
		keys?: NativePushMaterial["keys"];
		vapid?: string;
	} | null>("NativePush", "subscription", {network});

	return material?.endpoint && material.keys
		? {endpoint: material.endpoint, keys: material.keys, vapid: material.vapid}
		: null;
}

export async function nativeUnsubscribe(network: string): Promise<void> {
	await nativeCall("NativePush", "unsubscribe", {network});
}

/**
 * The page took a pushable message while the user was looking at it: the
 * shell drops its push (PushSeen.java, the twin of push-seen.ts). Only while
 * attended — the WebView has no Notification API, so a message the page
 * takes hidden (the "stay connected" service keeps it running) has nobody
 * but the push to announce it. webpush.ts calls it only for a network this
 * device is subscribed on, so nothing crosses the bridge otherwise.
 */
export function nativeRecordSeen(msgid: string | undefined): void {
	if (
		msgid &&
		nativePushAvailable() &&
		document.visibilityState === "visible" &&
		document.hasFocus()
	) {
		void nativeCall("NativePush", "seen", {msgid});
	}
}

/** Close the notifications for one conversation, a network's, or all of them. */
export function nativeClearNotifications(network?: string, target?: string): void {
	if (isAndroidShell()) {
		void nativeCall("NativePush", "clear", {network, target});
	}
}

/** Hear notification taps: the one that launched the app, then each later one. */
export function onNativePushTap(cb: (network: string, target: string) => void): void {
	if (!isAndroidShell()) {
		return;
	}

	nativeListen("NativePush", "tap", (tap: {network?: string; target?: string}) => {
		if (tap?.network) {
			cb(tap.network, tap.target ?? "");
		}
	});

	void nativeCall<{tap: {network?: string; target?: string} | null}>(
		"NativePush",
		"takeTap"
	).then((result) => {
		if (result?.tap?.network) {
			cb(result.tap.network, result.tap.target ?? "");
		}
	});
}

/** Hear the distributor renewing or dropping a network's endpoint by itself. */
export function onNativeEndpointChange(cb: (network: string) => void): void {
	nativeListen("NativePush", "endpoint", (data: {network?: string}) => {
		if (data?.network) {
			cb(data.network);
		}
	});
}
