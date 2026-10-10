// Settings whose default depends on where the app runs: following the
// system's text size and its light or dark mode is on in the native shells,
// where Apple's and Google's guidelines ask an app to honour the system's
// settings, and off on the web, where a browser keeps what it was given.
// settings.ts takes the defaults from here, and so does a settings restore
// (helpers/settingsBackup.ts), which moves a value that was only the source
// platform's default onto this platform's. Vue-free; mocha loads it
// (test/helpers/settingsBackup.ts). loading-error-handlers.js, which cannot
// import, repeats the rule for matchSystemAppearance.

import {isAndroidShell, isIOSShell} from "./capacitor";

/** Where the app runs: a browser, or one of the Capacitor shells. */
export type Platform = "web" | "ios" | "android";

const onInTheShells = (platform: Platform) => platform !== "web";

/** Each platform-dependent setting and its default on a given platform. */
export const PLATFORM_DEFAULTS: Readonly<Record<string, (platform: Platform) => boolean>> = {
	matchSystemTextSize: onInTheShells,
	matchSystemAppearance: onInTheShells,
};

/** The platform this page runs on. */
export function currentPlatform(): Platform {
	return isIOSShell() ? "ios" : isAndroidShell() ? "android" : "web";
}

export function isPlatform(value: unknown): value is Platform {
	return value === "web" || value === "ios" || value === "android";
}
