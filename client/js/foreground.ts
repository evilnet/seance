// Browser build: come back the moment the page does.
//
// Mobile browsers drop the WebSocket as soon as the app goes to the
// background — or the OS kills it without a close event — and while the page
// is hidden its reconnect timer is throttled. So when the page becomes
// visible again, the network comes back or the page is restored from the
// back/forward cache, every connection is poked (`reconnectAll`): the ones
// waiting to reconnect dial now, open ones probe their socket and treat
// silence as a dead connection. The Capacitor shells do the same from
// `appStateChange` (native.ts); reconnectAll de-bounces the overlap.
//
// The same moments are when a window that stayed open should look for a
// newer build (pwa.ts checkForUpdate, throttled there).

import {networksLeavingAwayToWorker, reconnectAll, setAttendedAll} from "./irc/manager";
import {UNFOCUSED_AWAY_MS} from "./irc/presence";
import {checkForUpdate} from "./pwa";
import {hasStashedLogin} from "./webpush";

function wake(opts: {networkBack?: boolean} = {}): void {
	reconnectAll(opts);
	checkForUpdate();
}

export function installForegroundHooks(): void {
	if (typeof document === "undefined" || typeof window === "undefined") {
		return;
	}

	// Attention (presence.ts): a hidden page is unattended at once — that
	// is a phone switching apps; a visible page that lost focus waits
	// UNFOCUSED_AWAY_MS so an alt-tab does not flap `AWAY *`.
	let unfocusedTimer: ReturnType<typeof setTimeout> | null = null;
	// The networks whose `AWAY *` the service worker took over as the page
	// unloads (below): the visibilitychange that follows leaves them alone.
	let handedOff: ReadonlySet<string> = new Set();

	const attend = () => {
		if (unfocusedTimer !== null) {
			clearTimeout(unfocusedTimer);
			unfocusedTimer = null;
		}

		setAttendedAll(true);
	};

	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") {
			wake();

			if (document.hasFocus()) {
				attend();
			}
		} else {
			if (unfocusedTimer !== null) {
				clearTimeout(unfocusedTimer);
				unfocusedTimer = null;
			}

			setAttendedAll(false, handedOff);
		}
	});

	// A close and a reload look the same here, and the `AWAY *` a present
	// user's page sends as it goes makes them blink away and back to
	// everyone when it was a reload. So a network that qualifies
	// (presence.ts leavesAwayToWorker) is handed to the service worker,
	// which says it only if no window of the app is open a few seconds on.
	// pagehide comes before the unload's visibilitychange. Without a
	// controlling worker nothing is handed over and the star goes now; the
	// back/forward cache keeps the page, which is a plain hide.
	window.addEventListener("pagehide", (ev: PageTransitionEvent) => {
		const worker = navigator.serviceWorker?.controller;

		if (ev.persisted || !worker) {
			return;
		}

		const networks = networksLeavingAwayToWorker(hasStashedLogin);

		if (networks.length === 0) {
			return;
		}

		try {
			worker.postMessage({type: "away-on-close", networks});
			handedOff = new Set(networks);
		} catch {
			// The star goes from here after all.
		}
	});
	window.addEventListener("blur", () => {
		if (unfocusedTimer === null) {
			unfocusedTimer = setTimeout(() => {
				unfocusedTimer = null;
				setAttendedAll(false);
			}, UNFOCUSED_AWAY_MS);
		}
	});

	// Page Lifecycle: a frozen tab thaws (Chrome, Android especially) —
	// the socket almost certainly died while it was frozen.
	document.addEventListener("resume", () => wake());

	window.addEventListener("online", () => wake({networkBack: true}));
	window.addEventListener("focus", () => {
		wake();
		attend();
	});

	window.addEventListener("pageshow", (ev: PageTransitionEvent) => {
		// A page restored from the back/forward cache is this document again:
		// whatever it handed over is its own to say once more.
		handedOff = new Set();

		if (ev.persisted) {
			wake();
		}
	});
}
