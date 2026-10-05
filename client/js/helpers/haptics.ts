// A short nudge for a gesture the app took (the long press that opens the
// message toolbar). In the native shell it is the Haptics plugin, the same
// tap UIKit gives a context menu; in a browser it is `navigator.vibrate`,
// which Android has and iOS does not — so on an iOS web page there is none.

import {isNativeShell, nativeCall} from "./capacitor";

export function nudge(): void {
	if (isNativeShell()) {
		void nativeCall("Haptics", "impact", {style: "MEDIUM"});
		return;
	}

	if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
		navigator.vibrate(15);
	}
}
