// Native-shell glue (shells/capacitor). The web build never bundles Capacitor:
// the shell's WebView injects `window.Capacitor` (its "native bridge") before
// our scripts run, so everything here is feature-detected and a no-op in a
// browser. Only the bridge's own `addListener` / `nativePromise` are used;
// `Capacitor.Plugins` stays empty unless `@capacitor/core` is bundled.

import {leavePage, onStandalonePage} from "./router";
import {closeOpenImage} from "./helpers/imageViewer";
import {reconnectAll} from "./irc/manager";
import {checkForUpdate} from "./pwa";
import {setNativeKeyboard} from "./helpers/viewport";

interface CapacitorBridge {
	isNativePlatform?: () => boolean;
	addListener?: (plugin: string, event: string, cb: (data: any) => void) => unknown;
	nativePromise?: (plugin: string, method: string, options?: unknown) => Promise<unknown>;
}

declare global {
	interface Window {
		Capacitor?: CapacitorBridge;
	}
}

export function installNativeHooks(): void {
	const cap = window.Capacitor;

	if (!cap?.isNativePlatform?.() || !cap.addListener || !cap.nativePromise) {
		return;
	}

	// iOS/Android drop the WebSocket while backgrounded: retry on foreground,
	// and look for a newer build while at it.
	cap.addListener("App", "appStateChange", ({isActive}: {isActive?: boolean}) => {
		if (isActive) {
			reconnectAll();
			checkForUpdate();
		}
	});

	// The WebView fills the screen (capacitor.config.ts), so the page draws
	// under the status bar: `viewport-fit=cover` makes env(safe-area-inset-top)
	// real and style.css pads #viewport by it in the theme's canvas colour.
	// The bar's text follows that colour's luminance, at boot and again
	// whenever a theme stylesheet finishes loading.
	document.documentElement.dataset.shell = "native";

	const viewport = document.querySelector('meta[name="viewport"]');
	const content = viewport?.getAttribute("content") ?? "";

	if (viewport && !content.includes("viewport-fit")) {
		viewport.setAttribute("content", `${content}, viewport-fit=cover`);
	}

	const styleStatusBar = () => {
		const rgb = getComputedStyle(document.documentElement).backgroundColor;
		const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb);

		if (!m) {
			return;
		}

		const [r, g, b] = [m[1], m[2], m[3]].map(Number);
		// Style names the bar's text: DARK is light text for a dark page.
		const style = (r * 299 + g * 587 + b * 114) / 1000 < 128 ? "DARK" : "LIGHT";

		void cap.nativePromise!("StatusBar", "setStyle", {style});
	};

	styleStatusBar();
	document.getElementById("theme")?.addEventListener("load", styleStatusBar);

	// The keyboard, from the shell rather than from the visual viewport: the
	// plugin says its height before the animation, form bar included, and
	// says when it goes — the two things iOS never tells a page straight
	// (helpers/viewport.ts). Demo, 2026-09-20: logged so the phone can be
	// compared with the visual-viewport figures.
	// iOS's form accessory bar (˄ ˅ Done) above the keyboard: nothing in the
	// app for it to step between, and it is the floating pill that covered
	// the composer in the PWA. The keyboard's own Done key does the job.
	void cap.nativePromise!("Keyboard", "setAccessoryBarVisible", {isVisible: false});

	cap.addListener(
		"Keyboard",
		"keyboardWillShow",
		({keyboardHeight}: {keyboardHeight: number}) => {
			// eslint-disable-next-line no-console
			console.info(
				`[shell] keyboard will show ${keyboardHeight}px; vv ${window.visualViewport?.height} inner ${window.innerHeight}`
			);
			setNativeKeyboard(keyboardHeight);
		}
	);
	cap.addListener("Keyboard", "keyboardWillHide", () => {
		// eslint-disable-next-line no-console
		console.info(
			`[shell] keyboard will hide; vv ${window.visualViewport?.height} inner ${window.innerHeight}`
		);
		setNativeKeyboard(0);
	});

	// Android back button: close an open image, else leave a standalone page
	// for the conversation it came from, else minimize (overrides the
	// default). Not `router.back()`: the history is kept one deep (router.ts).
	cap.addListener("App", "backButton", () => {
		if (closeOpenImage()) {
			return;
		}

		if (onStandalonePage() && leavePage()) {
			return;
		}

		void cap.nativePromise!("App", "minimizeApp", {});
	});
}
