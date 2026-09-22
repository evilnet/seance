// Native-shell glue (shells/capacitor): everything the page does *because* it
// is running inside the shell. The bridge itself is `helpers/capacitor.ts`,
// which imports nothing; this file is free to pull in the store and the
// router.

import {leavePage, onStandalonePage} from "./router";
import {closeOpenImage} from "./helpers/imageViewer";
import {reconnectAll} from "./irc/manager";
import {checkForUpdate} from "./pwa";
import {nativeBridge, nativeCall, nativeListen} from "./helpers/capacitor";

export function installNativeHooks(): void {
	if (!nativeBridge()) {
		return;
	}

	// iOS/Android drop the WebSocket while backgrounded: retry on foreground,
	// and look for a newer build while at it.
	nativeListen("App", "appStateChange", ({isActive}: {isActive?: boolean}) => {
		if (isActive) {
			reconnectAll();
			checkForUpdate();
		}
	});

	// Android back button: close an open image, else leave a standalone page
	// for the conversation it came from, else minimize (overrides the
	// default). Not `router.back()`: the history is kept one deep (router.ts).
	nativeListen("App", "backButton", () => {
		if (closeOpenImage()) {
			return;
		}

		if (onStandalonePage() && leavePage()) {
			return;
		}

		void nativeCall("App", "minimizeApp");
	});
}
