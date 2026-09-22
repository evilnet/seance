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
//  - update detection: an installed app has no reload button, so when a
//    newer build's worker takes over a window that still runs the old
//    bundle, the store is flagged and Help offers a reload. Long-lived
//    windows ask for the check themselves (checkForUpdate), since browsers
//    only look for a new worker script when a page loads.
//
// Web push lives in webpush.ts (subscription, the connect-time prompt) and
// the service worker (delivery).

import {store} from "./store";
import {BeforeInstallPromptEvent} from "./types";
import {isOtherBuild} from "./build";
import {isNativeShell} from "./helpers/capacitor";

/** A window that stays open re-checks the worker script this often. */
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
/** Foreground events come in bursts (focus, visibility, online): one check per gap. */
const UPDATE_CHECK_MIN_GAP_MS = 5 * 60 * 1000;

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
let registration: ServiceWorkerRegistration | null = null;
let lastUpdateCheck = 0;

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
	// The native shell (shells/capacitor) loads the bundle from the app
	// itself: nothing to cache for offline, and a new build is a new app from
	// the store, not a worker update. WKWebView would refuse the worker on
	// the app's custom scheme anyway.
	if (!("serviceWorker" in navigator) || !isSecureContext() || isNativeShell()) {
		return;
	}

	// A worker announces its build when it takes over (`activate` in
	// service-worker.js) and the page compares that with the build it is
	// itself (build.ts). A different one means a newer build's worker was
	// installed under a page that keeps running the old bundle until it
	// reloads — the one time "Reload to update" is true. `controllerchange`
	// on its own cannot tell: the worker serves network-first, so a page
	// that has just loaded already runs the new bundle by the time the new
	// worker claims it.
	navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
		if (event.data?.type === "build" && isOtherBuild(event.data.build)) {
			store.commit("updateAvailable");
		}
	});

	// A message posted before the page listens is held until it says so
	// (the announce can land while the bundle is still loading).
	if (typeof navigator.serviceWorker.startMessages === "function") {
		navigator.serviceWorker.startMessages();
	}

	navigator.serviceWorker
		.register("service-worker.js", {scope: "./"})
		.then((reg) => {
			registration = reg;
			// Registering is itself an update check.
			lastUpdateCheck = Date.now();
			window.setInterval(() => checkForUpdate(true), UPDATE_CHECK_INTERVAL_MS);
			return navigator.serviceWorker.ready;
		})
		.then((ready) => {
			// Only advertise the worker once it is active, so that the
			// notification path never posts to a worker that cannot answer.
			if (ready.active) {
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

/**
 * Ask the browser to re-fetch the worker script — how a deploy gets noticed
 * by a window that stays open, since browsers only look on their own when a
 * page loads. A changed script installs, activates and announces its build
 * (registerServiceWorker). Called from the foreground hooks, throttled;
 * `force` is the hourly timer.
 */
export function checkForUpdate(force = false): void {
	if (!registration) {
		return;
	}

	const now = Date.now();

	if (!force && now - lastUpdateCheck < UPDATE_CHECK_MIN_GAP_MS) {
		return;
	}

	lastUpdateCheck = now;
	registration.update().catch(() => {
		// Offline, or the host is down: the next check tries again.
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
