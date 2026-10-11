// In the native shells an on/off setting is a switch, not a checkbox — every
// settings screen on iOS and Android looks that way. Still an
// <input type="checkbox"> to the page — checked, change events, labels and
// forms all as before. Every checkbox carries the `v-switch` directive
// (registered in vue.ts; test/tests/nativeSwitches.ts fails a checkbox
// without it), which marks it as it mounts:
//
// - iOS: WebKit draws a checkbox carrying the `switch` attribute (iOS 17.4+)
//   as the native control and VoiceOver calls it a switch. Older iOS ignores
//   it and keeps the checkbox.
// - Android: Chromium has no such control, so style.css draws a Material
//   switch (html[data-platform="android"]), and `role="switch"` makes
//   TalkBack say "switch, on" rather than "checkbox, checked".
//
// In a browser it does nothing.

import type {Directive} from "vue";
import {currentPlatform, type Platform} from "./platformDefaults";

let platform: Platform | null = null;

function shellPlatform(): Platform {
	if (platform === null) {
		platform = currentPlatform();
	}

	return platform;
}

/** `v-switch`: marks a checkbox as an on/off switch in the native shells. */
export const switchDirective: Directive<HTMLInputElement> = {
	mounted(box) {
		switch (shellPlatform()) {
			case "ios":
				box.setAttribute("switch", "");
				break;
			case "android":
				box.setAttribute("role", "switch");
				break;
		}
	},
};
