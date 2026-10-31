// A short nudge for a gesture the app took (the long press that opens the
// message toolbar). In the phone shells it is the Haptics plugin, the same
// tap UIKit gives a context menu; in a browser it is `navigator.vibrate`,
// which Android has and iOS does not — so on an iOS web page there is none.

import {isMobileShell, nativeCall} from "./shell";

export function nudge(): void {
	if (isMobileShell()) {
		void nativeCall("Haptics", "impact", {style: "MEDIUM"});
		return;
	}

	if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
		navigator.vibrate(15);
	}
}
