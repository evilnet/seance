// Native-shell glue (shells/capacitor): everything the page does *because* it
// is running inside the shell. The bridge itself is `helpers/capacitor.ts`,
// which imports nothing; this file is free to pull in the store and the
// router.

import {leavePage, onStandalonePage} from "./router";
import {closeOpenImage} from "./helpers/imageViewer";
import {reconnectAll} from "./irc/manager";
import {
	nativeBridge,
	nativeCall,
	nativeListen,
	nativePlatform,
	isAndroidShell,
} from "./helpers/capacitor";

export function installNativeHooks(): void {
	if (!nativeBridge()) {
		return;
	}

	// iOS/Android drop the WebSocket while backgrounded: retry on foreground.
	// (No build check: a new build of the shell is a new app from the store.)
	nativeListen("App", "appStateChange", ({isActive}: {isActive?: boolean}) => {
		if (isActive) {
			reconnectAll();
		}
	});

	// The WebView fills the screen (capacitor.config.ts), so the page draws
	// under the status bar: `viewport-fit=cover` makes env(safe-area-inset-top)
	// real and style.css pads #viewport by it in the theme's canvas colour.
	// The bar's text follows that colour's luminance, at boot and again
	// whenever a theme stylesheet finishes loading.
	document.documentElement.dataset.shell = "native";
	document.documentElement.dataset.platform = nativePlatform();

	const viewport = document.querySelector('meta[name="viewport"]');
	const content = viewport?.getAttribute("content") ?? "";

	if (viewport && !content.includes("viewport-fit")) {
		viewport.setAttribute("content", `${content}, viewport-fit=cover`);
	}

	// Android: Capacitor's SystemBars reads that meta once, at DOMContentLoaded
	// — before this runs — and without `viewport-fit=cover` it insets the
	// WebView natively (a band in the window's colour above the header, and
	// the env() values 0) instead of handing the page the insets. Asking it
	// to look again is the same call its own DOM-ready hook makes; it
	// re-applies the window insets, and from there the page pads itself, in
	// the theme's colour, as it does on iOS. A WebView older than Chromium
	// 140 takes the native inset whatever the meta says (MainActivity paints
	// the band in the deploy's colour for those).
	window.CapacitorSystemBarsAndroidInterface?.onDOMReady();

	const styleStatusBar = () => {
		const rgb = getComputedStyle(document.documentElement).backgroundColor;
		const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb);

		if (!m) {
			return;
		}

		const [r, g, b] = [m[1], m[2], m[3]].map(Number);
		// Style names the bar's text: DARK is light text for a dark page.
		const style = (r * 299 + g * 587 + b * 114) / 1000 < 128 ? "DARK" : "LIGHT";

		void nativeCall("StatusBar", "setStyle", {style});

		// Android's navigation bar draws its buttons over the page too, and
		// only the core SystemBars plugin styles that one (both bars, no
		// `bar` given).
		if (isAndroidShell()) {
			void nativeCall("SystemBars", "setStyle", {style});
		}
	};

	styleStatusBar();

	const theme = document.getElementById("theme") as HTMLLinkElement | null;
	theme?.addEventListener("load", styleStatusBar);

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
