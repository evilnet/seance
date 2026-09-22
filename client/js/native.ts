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

// A link the OS handed the app — `irc:`, `ircs:` or `web+irc:`, the schemes
// Info.plist claims. Cold, it is the launch URL (`getLaunchUrl`), which
// boot.ts awaits before it routes, the way a browser page reads `?uri=`.
// While running it comes through `appUrlOpen`; iOS can report the launch
// URL that way too, so that one is delivered once.
let launchUrl: Promise<string | null> = Promise.resolve(null);
let launchHref: string | null = null;
let urlHandler: ((href: string) => void) | null = null;
let pendingHref: string | null = null;

/** The link the app was opened with, or null (at once, in a browser). */
export function nativeLaunchUrl(): Promise<string | null> {
	return launchUrl;
}

/** Links handed to the running app. One that arrives first waits here. */
export function onNativeUrl(handler: (href: string) => void): void {
	urlHandler = handler;

	if (pendingHref !== null) {
		const href = pendingHref;
		pendingHref = null;
		handler(href);
	}
}

// The native launch image (capacitor.config.ts keeps it up until told) comes
// down as soon as the page can paint in the user's theme — the theme
// stylesheet's load — so the page's own loading screen, the logo tile on
// that theme, takes over from the launch image (the logo on its own tile;
// iOS draws it before any code runs and cannot know the theme). Two frames
// first, so the hide reveals a painted page, never a blank one.
let splashHidden = false;

function hideSplash(): void {
	if (splashHidden) {
		return;
	}

	splashHidden = true;
	requestAnimationFrame(() => {
		requestAnimationFrame(() => {
			void nativeCall("SplashScreen", "hide");
		});
	});
}

/**
 * The page has booted and dropped its own loading screen: the launch image
 * goes now if the theme's load did not take it down already.
 */
export function nativeAppReady(): void {
	hideSplash();
}

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

	launchUrl = nativeCall<{url?: string}>("App", "getLaunchUrl").then((result) => {
		launchHref = result?.url || null;
		return launchHref;
	});

	nativeListen("App", "appUrlOpen", ({url}: {url?: string}) => {
		if (!url) {
			return;
		}

		// After the launch URL is known, never before: the two bridge calls
		// are in flight together, and a link compared against a launch URL
		// that has not come back yet is acted on twice.
		void launchUrl.then(() => {
			if (url === launchHref) {
				launchHref = null;
				return;
			}

			if (urlHandler) {
				urlHandler(url);
			} else {
				pendingHref = url;
			}
		});
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

	// The stylesheet the settings chose (boot.ts, before this runs) may be in
	// already — `sheet` is null while a swapped href is still loading.
	if (theme?.sheet) {
		hideSplash();
	} else {
		theme?.addEventListener("load", hideSplash, {once: true});
	}

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
