// The native shells' message alerts. Neither WebView has the Notification
// API, so the page hands its alert to the OS, which owns the banner and the
// sound (an <audio> ping took the audio session and stopped Music).
//
// - iOS: the LocalNotifications plugin, which presents them in front too.
// - Android: the shell's push service (NativePush `show`), so a page alert
//   and a push are the same notification: merged per conversation, cleared
//   on read (webpush.ts readOnWorker), tapped through helpers/nativePush.ts.

import {isAndroidShell, isIOSShell, nativeCall, nativeListen} from "./capacitor";

/** The ping, from the app bundle's copy of the web build. */
const IOS_SOUND = "public/audio/pop.wav";

export function nativeAlertsAvailable(): boolean {
	return isIOSShell() || isAndroidShell();
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

	if (isIOSShell()) {
		type Display = {display?: string};
		answer = (await nativeCall<Display>("LocalNotifications", "checkPermissions"))?.display;

		if (answer === "prompt" || answer === "prompt-with-rationale") {
			answer = (await nativeCall<Display>("LocalNotifications", "requestPermissions"))
				?.display;
		}
	} else if (isAndroidShell()) {
		answer = (await nativeCall<{permission?: string}>("NativePush", "askPermission"))
			?.permission;
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

/** The id iOS keeps an alert under: one per conversation and the same across
 * reloads (the page's channel ids are not), so a new alert replaces the
 * conversation's last and reading it clears it. Positive, as the plugin
 * takes an Int32. */
export function iosAlertId(network: string, target: string): number {
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
				id: iosAlertId(alert.network, alert.target),
				title: alert.title,
				body: alert.body,
				...(alert.sound ? {sound: IOS_SOUND} : {}),
				extra: {network: alert.network, target: alert.target},
			},
		],
	});
	return true;
}

/** The conversation was read: its iOS alert goes. */
export function clearNativeAlert(network: string, target: string): void {
	void nativeCall("LocalNotifications", "removeDeliveredNotifications", {
		notifications: [{id: iosAlertId(network, target)}],
	});
}

/** A tapped iOS alert: the conversation it was about. */
export function onNativeAlertTap(handler: (network: string, target: string) => void): void {
	if (!isIOSShell()) {
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
