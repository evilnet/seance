// Settings whose default depends on where the app runs: following the
// system's light or dark mode is on in every app shell, where the platform
// guidelines ask an app to honour the system's settings, and off on the web,
// where a browser keeps what it was given; following the system's text size
// is on in the phone shells alone — a desktop has no system body size to
// follow, and its windows take the page's own font-size step.
// settings.ts takes the defaults from here, and so does a settings restore
// (helpers/settingsBackup.ts), which moves a value that was only the source
// platform's default onto this platform's. Vue-free; mocha loads it
// (test/helpers/settingsBackup.ts). loading-error-handlers.js, which cannot
// import, repeats the rule for matchSystemAppearance.

import {nativePlatform} from "./shell";

/** Where the app runs: a browser, or one of the app shells. */
export type Platform = "web" | "ios" | "android" | "macos" | "windows" | "linux";

const PLATFORMS: readonly string[] = ["web", "ios", "android", "macos", "windows", "linux"];

const onInTheShells = (platform: Platform) => platform !== "web";
const onOnThePhones = (platform: Platform) => platform === "ios" || platform === "android";

/** Each platform-dependent setting and its default on a given platform. */
export const PLATFORM_DEFAULTS: Readonly<Record<string, (platform: Platform) => boolean>> = {
	matchSystemTextSize: onOnThePhones,
	matchSystemAppearance: onInTheShells,
};

/** The platform this page runs on. */
export function currentPlatform(): Platform {
	return nativePlatform();
}

export function isPlatform(value: unknown): value is Platform {
	return typeof value === "string" && PLATFORMS.includes(value);
}
