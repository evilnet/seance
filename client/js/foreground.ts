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

import {reconnectAll, setAttendedAll} from "./irc/manager";
import {UNFOCUSED_AWAY_MS} from "./irc/presence";
import {checkForUpdate} from "./pwa";

function wake(): void {
	reconnectAll();
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

			setAttendedAll(false);
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

	window.addEventListener("online", () => wake());
	window.addEventListener("focus", () => {
		wake();
		attend();
	});

	window.addEventListener("pageshow", (ev: PageTransitionEvent) => {
		if (ev.persisted) {
			wake();
		}
	});
}
