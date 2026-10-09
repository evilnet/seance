// The system's text size in the native shells, as `--system-text-scale` on
// <html> (the system's body text size over the browser's 16px), which
// style.css applies
// while `data-system-text` is set: the matchSystemTextSize setting, on by
// default in the shells. Off, the in-app font-size step is the whole story,
// as on the web — where the browser's own font-size preference is already
// honoured, every step being a percentage of it.
//
// iOS: a WKWebView keeps the browser's 16px whatever Dynamic Type says, but
// WebKit resolves the system font keyword `-apple-system-body` from it — 17px
// at the default size, the size iOS's own apps set body text in, live — so a
// hidden probe set in that font, measured by a ResizeObserver, gives the
// user's choice and every change to it (Control Center's slider with the app
// in front included).
//
// Android: the WebView would apply the font scale itself as its text zoom,
// but that scales glyphs only, never rem lengths, so text outgrew the
// buttons and fields drawn around it. The shell pins the text zoom at 100%
// (MainActivity.java) and reports `Configuration.fontScale` instead
// (SystemAccessibilityPlugin.java), live; Android's body text is 16sp at the
// default scale, the browser's 16px.

import {currentPlatform} from "./platformDefaults";
import {onAndroidSystemStatus} from "./systemAccessibility";

/** The browser's default font size, what 100% on the root is. */
const BROWSER_DEFAULT_PX = 16;

let scale = 1;
/** A scale has been read: until then the in-app step stays in charge, so an
 * Android shell that has not answered (or never will) changes nothing. */
let measured = false;
let matching = false;
let following = false;

function render(): void {
	const root = document.documentElement;
	const on = matching && following && measured;

	root.toggleAttribute("data-system-text", on);

	if (on && Math.abs(scale - 1) >= 0.001) {
		root.style.setProperty("--system-text-scale", scale.toFixed(3));
	} else {
		root.style.removeProperty("--system-text-scale");
	}
}

function setScale(next: number): void {
	// Nonsense (a probe not laid out yet, a shell reporting nothing) is the
	// default size; style.css caps the result at the "huge" step.
	scale = Number.isFinite(next) && next > 0 ? next : 1;
	measured = true;
	render();
}

/** The matchSystemTextSize setting (settings.ts). */
export function setMatchSystemTextSize(on: boolean): void {
	matching = on;
	render();
}

function followIOS(): void {
	const probe = document.createElement("span");
	probe.setAttribute("aria-hidden", "true");
	probe.textContent = "M";
	probe.style.cssText =
		"font: -apple-system-body; position: absolute; visibility: hidden; " +
		"pointer-events: none; left: -100px; top: 0;";
	document.body.append(probe);

	const read = () => setScale(parseFloat(getComputedStyle(probe).fontSize) / BROWSER_DEFAULT_PX);
	read();
	new ResizeObserver(read).observe(probe);
}

function followAndroid(): void {
	// The reports systemAccessibility.ts already asks for, shared.
	onAndroidSystemStatus((status) => {
		// A shell built before the plugin reported the font scale: leave the
		// step alone rather than guess.
		if (typeof status.fontScale === "number") {
			setScale(status.fontScale);
		}
	});
}

/** Start following the system's text size; the native shells only. */
export function followSystemTextSize(): void {
	if (following) {
		return;
	}

	const platform = currentPlatform();

	if (platform === "ios") {
		following = true;
		followIOS();
	} else if (platform === "android") {
		following = true;
		followAndroid();
	}

	render();
}

/** True where there is a system text size to follow (the setting's toggle
 * is shown only there). */
export function systemTextSizeAvailable(): boolean {
	return currentPlatform() !== "web";
}
