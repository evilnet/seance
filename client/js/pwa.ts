// Progressive-web-app glue for the browser build.
//
// Everything here is feature-detected and a no-op where the platform does not
// offer it (plain http on a LAN host, the Electron/Capacitor shells, old
// browsers). It covers the four things Chrome needs beyond a manifest to make
// an installed Seance behave like an app:
//
//  - the service worker (offline shell + click-to-open for notifications),
//    registered in any secure context;
//  - the deferred `beforeinstallprompt` event, surfaced in the store so that
//    Settings can offer an "Install" button (and hide it once installed);
//  - the Launch Handler API: the manifest asks Chrome to `focus-existing`, so
//    a second launch — a `web+irc://` link, an `?uri=` URL, a shortcut — is
//    delivered to the running window via `window.launchQueue` instead of
//    reloading it and dropping the IRC connection;
//  - service-worker update detection: an installed app has no reload button,
//    so a new build is flagged in the store and Help offers a reload.
//
// Web push is intentionally absent (see webpush.ts).

import {store} from "./store";
import {BeforeInstallPromptEvent} from "./types";

interface LaunchParams {
	targetURL?: string;
}

interface LaunchQueue {
	setConsumer(consumer: (params: LaunchParams) => void): void;
}

declare global {
	interface Window {
		launchQueue?: LaunchQueue;
	}

	interface Navigator {
		standalone?: boolean;
	}
}

let installPromptEvent: BeforeInstallPromptEvent | null = null;

/** True when running as an installed app (standalone window / home screen). */
export function isStandalone(): boolean {
	return (
		(typeof window.matchMedia === "function" &&
			window.matchMedia("(display-mode: standalone)").matches) ||
		window.navigator.standalone === true
	);
}

function isSecureContext(): boolean {
	// Secure contexts cover https:, localhost, and privileged custom schemes
	// such as the Electron shell's app://; the explicit hosts are a fallback
	// for browsers that don't expose isSecureContext.
	return (
		window.isSecureContext === true ||
		location.protocol === "https:" ||
		location.hostname === "localhost" ||
		location.hostname === "127.0.0.1" ||
		location.hostname === "[::1]"
	);
}

function registerServiceWorker(): void {
	if (!("serviceWorker" in navigator) || !isSecureContext()) {
		return;
	}

	// A controller that changes while the page is already controlled means a
	// newer worker (i.e. a newer build; the worker's cache name is the release
	// hash) took over. The page keeps running the old bundle until reloaded.
	let controlled = navigator.serviceWorker.controller !== null;

	navigator.serviceWorker.addEventListener("controllerchange", () => {
		if (controlled) {
			store.commit("updateAvailable");
		}

		controlled = true;
	});

	navigator.serviceWorker
		.register("service-worker.js", {scope: "./"})
		.then(() => navigator.serviceWorker.ready)
		.then((registration) => {
			// Only advertise the worker once it is active, so that the
			// notification path never posts to a worker that cannot answer.
			if (registration.active) {
				store.commit("hasServiceWorker");
			}
		})
		.catch((err) => {
			// Registration is best effort: without it the app still runs,
			// it just is not installable offline and notifications fall
			// back to `new Notification()` in the page.
			// eslint-disable-next-line no-console
			console.error("Service worker registration failed:", err);
		});
}

function watchInstallPrompt(): void {
	window.addEventListener("beforeinstallprompt", (e) => {
		e.preventDefault();
		installPromptEvent = e as BeforeInstallPromptEvent;
		store.commit("installPromptAvailable", true);
	});

	window.addEventListener("appinstalled", () => {
		installPromptEvent = null;
		store.commit("installPromptAvailable", false);
	});
}

/**
 * Show the browser's install dialog (only possible after
 * `beforeinstallprompt`). Resolves to true when the user accepted.
 */
export async function promptInstall(): Promise<boolean> {
	const event = installPromptEvent;

	if (!event) {
		return false;
	}

	// The event is single-use: Chrome fires a fresh one later if the user
	// dismisses the dialog.
	installPromptEvent = null;
	store.commit("installPromptAvailable", false);

	try {
		await event.prompt();
		const choice = await event.userChoice;
		return choice.outcome === "accepted";
	} catch (e) {
		// eslint-disable-next-line no-console
		console.error("Install prompt failed:", e);
		return false;
	}
}

/**
 * Deliver launches that target an already-running window (manifest
 * `launch_handler: focus-existing`). The initial launch is queued too, so
 * callers de-duplicate against the URL the page was opened with.
 */
export function onLaunch(handler: (url: URL) => void): void {
	if (!window.launchQueue) {
		return;
	}

	window.launchQueue.setConsumer((params) => {
		if (!params.targetURL) {
			return;
		}

		try {
			handler(new URL(params.targetURL));
		} catch (e) {
			// eslint-disable-next-line no-console
			console.error("Ignoring malformed launch URL:", params.targetURL, e);
		}
	});
}

registerServiceWorker();
watchInstallPrompt();
