// The native shells' message alerts. No shell's WebView has the Notification
// API, so the page hands its alert to the OS, which owns the banner and the
// sound (an <audio> ping took the audio session and stopped Music).
//
// - iOS: Capacitor's LocalNotifications plugin, which presents them in front
//   too.
// - macOS, Windows, Linux: the Tauri shell's LocalNotifications (Swift on
//   macOS, src/alerts.rs elsewhere) in the plugin's shapes; a click opens the
//   conversation, and reading it takes the alert back except on Windows,
//   which cannot remove a shown toast.
// - Android: the shell's push service (NativePush `show`), so a page alert
//   and a push are the same notification: merged per conversation, cleared
//   on read (webpush.ts readOnWorker), tapped through helpers/nativePush.ts.

import {isAndroidShell, isDesktopShell, nativeCall, nativeListen, nativePlatform} from "./shell";

/** The ping, as a path in the app bundle, which goes to `UNNotificationSound`
 * as is: the iOS bundle's copy of the web build (`App/public/`), and on macOS
 * the one file the Tauri shell puts there (tauri.conf.json `bundle.macOS`).
 * Android's alert takes its channel's sound (PushService `messages`), and
 * Windows and Linux the platform's own ping. */
const APPLE_SOUND = "public/audio/pop.wav";

export function nativeAlertsAvailable(): boolean {
	return ["ios", "android", "macos", "windows", "linux"].includes(nativePlatform());
}

let asking: Promise<boolean | null> | null = null;

/**
 * Ask for the notification permission while it is undecided; granted,
 * denied, or null (undecided). On iOS that is banners, sound and the badge
 * in the one prompt iOS ever shows. One ask at a time: a second alert while
 * the dialog is up waits for the same answer.
 */
export function askNativeAlertPermission(): Promise<boolean | null> {
	asking ??= ask().finally(() => {
		asking = null;
	});
	return asking;
}

async function ask(): Promise<boolean | null> {
	let answer: string | undefined;

	if (isAndroidShell()) {
		answer = (await nativeCall<{permission?: string}>("NativePush", "askPermission"))
			?.permission;
	} else {
		type Display = {display?: string};
		answer = (await nativeCall<Display>("LocalNotifications", "checkPermissions"))?.display;

		if (answer === "prompt" || answer === "prompt-with-rationale") {
			answer = (await nativeCall<Display>("LocalNotifications", "requestPermissions"))
				?.display;
		}
	}

	return answer === "granted" ? true : answer === "denied" ? false : null;
}

export interface NativeAlert {
	/** The network's uuid. */
	network: string;
	/** The window the message is in: a channel, a query (the other side), the lobby. */
	target: string;
	title: string;
	body: string;
	sound: boolean;
	message: {
		from: string;
		/** Wire text: IRC formatting kept, an action as CTCP ACTION. */
		text: string;
		msgid?: string;
		/** ISO 8601. */
		time?: string;
		notice: boolean;
	};
}

/** The id an alert is kept under: one per conversation and the same across
 * reloads (the page's channel ids are not), so a new alert replaces the
 * conversation's last and reading it clears it. Positive, as the plugin
 * takes an Int32. */
export function alertId(network: string, target: string): number {
	const key = `${network}\n${target.toLowerCase()}`;
	let hash = 0x811c9dc5;

	for (let i = 0; i < key.length; i++) {
		hash = Math.imul(hash ^ key.charCodeAt(i), 0x01000193);
	}

	return hash >>> 1 || 1;
}

/** Hand `alert` to the OS; false when it was not shown (the permission refused or undecided). */
export async function showNativeAlert(alert: NativeAlert): Promise<boolean> {
	if ((await askNativeAlertPermission()) !== true) {
		return false;
	}

	if (isAndroidShell()) {
		await nativeCall("NativePush", "show", {
			network: alert.network,
			conversation: alert.target,
			...alert.message,
			silent: !alert.sound,
		});
		return true;
	}

	await nativeCall("LocalNotifications", "schedule", {
		notifications: [
			{
				id: alertId(alert.network, alert.target),
				title: alert.title,
				body: alert.body,
				...(alert.sound ? {sound: APPLE_SOUND} : {}),
				extra: {network: alert.network, target: alert.target},
			},
		],
	});
	return true;
}

/** The conversation was read: its alert goes (iOS, macOS, Linux; Windows
 * cannot take a toast back). */
export function clearNativeAlert(network: string, target: string): void {
	void nativeCall("LocalNotifications", "removeDeliveredNotifications", {
		notifications: [{id: alertId(network, target)}],
	});
}

/** A tapped alert (iOS, macOS, Windows, Linux): the conversation it was about. Android's
 * taps come through helpers/nativePush.ts. */
export function onNativeAlertTap(handler: (network: string, target: string) => void): void {
	if (!nativeAlertsAvailable() || isAndroidShell()) {
		return;
	}

	nativeListen(
		"LocalNotifications",
		"localNotificationActionPerformed",
		(data: {notification?: {extra?: {network?: unknown; target?: unknown}}}) => {
			const extra = data?.notification?.extra;

			if (typeof extra?.network === "string" && typeof extra.target === "string") {
				handler(extra.network, extra.target);
			}
		}
	);
}

/** An alert came while the window was not in front: the desktop shells bounce
 * the Dock icon (macOS), flash the taskbar button (Windows) or mark the
 * window urgent (Linux). The shell does nothing while the window has the
 * focus, and the platform stops it once the window comes forward. */
export function requestAttention(): void {
	if (isDesktopShell()) {
		void nativeCall("App", "requestAttention");
	}
}
