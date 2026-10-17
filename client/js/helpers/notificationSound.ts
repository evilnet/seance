// Who plays an alert's sound, and the page's ping when it is the page.
//
// A page's <audio> is media playback: on a Mac it takes the audio output
// (AirPods switch over to the Mac), and on iOS it stops Music for good. A
// system notification's sound is an alert sound and does neither, so the
// page leaves the sound to the notification wherever it can.

type AudioSessionType = "auto" | "playback" | "transient" | "transient-solo" | "ambient";

type NavigatorWithAudioSession = Navigator & {audioSession?: {type: AudioSessionType}};

let pop: HTMLAudioElement | undefined;
let restoreType: AudioSessionType | undefined;

function restoreSession() {
	const session = (navigator as NavigatorWithAudioSession).audioSession;

	if (session && restoreType !== undefined) {
		session.type = restoreType;
	}

	restoreType = undefined;
}

function audio(): HTMLAudioElement {
	if (!pop) {
		pop = new Audio("audio/pop.wav");
		pop.addEventListener("ended", restoreSession);
		pop.addEventListener("error", restoreSession);
	}

	return pop;
}

/** The ping. Where WebKit has the Audio Session API it plays as ambient
 * sound, mixing with Music and muted by the silent switch; the session type
 * is page-wide, so it goes back once the ping is over (a video preview the
 * user plays must stay playback). */
export function playNotificationSound(): Promise<void> {
	try {
		const session = (navigator as NavigatorWithAudioSession).audioSession;

		if (session && restoreType === undefined) {
			restoreType = session.type;
			session.type = "ambient";
		}

		const el = audio();
		el.currentTime = 0;
		return Promise.resolve(el.play()).catch((e) => {
			restoreSession();
			throw e;
		});
	} catch (e) {
		restoreSession();
		return Promise.reject(e);
	}
}

export interface AlertSoundCase {
	/** The setting: play a sound with an alert. */
	soundOn: boolean;
	/** A native shell: the OS shows the alert and plays its sound. */
	native: boolean;
	/** The page will show a system notification for this alert. */
	notifying: boolean;
	/** The platform's notifications make a sound (Linux and ChromeOS's
	 * usually do not). */
	osSound: boolean;
	/** An iPhone or iPad (WebKit with an audio session, touch-first). */
	ios: boolean;
	/** The page is on screen. */
	visible: boolean;
}

/**
 * The page plays the ping only when no notification will: there is none,
 * the platform's are silent, or it is iOS with the web app on screen, where
 * iOS may not present the app's own notifications. The notification is then
 * silent, so the sound is never doubled.
 */
export function alertSound(c: AlertSoundCase): {inPage: boolean; silentNotification: boolean} {
	if (!c.soundOn) {
		return {inPage: false, silentNotification: true};
	}

	if (c.native) {
		return {inPage: false, silentNotification: false};
	}

	if (!c.notifying || !c.osSound || (c.ios && c.visible)) {
		return {inPage: true, silentNotification: true};
	}

	return {inPage: false, silentNotification: false};
}
