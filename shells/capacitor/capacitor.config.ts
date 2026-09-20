// Capacitor configuration for the Seance native shell.
//
// The web app is the root build (`NODE_ENV=production yarn build` -> `public/`);
// this file only wraps it. `appName` and the status bar colour are read from
// `public/config.json` (the same branding file the SPA fetches at boot, see
// docs/resources/branding.md) when the Capacitor CLI evaluates this config,
// so a rebranded deploy only has to change that file and `appId` below.

import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import type {CapacitorConfig} from "@capacitor/cli";

// Relative so the copy embedded in the native projects stays machine-independent.
const webDir = "../../public";

interface Branding {
	appName?: unknown;
	themeColor?: unknown;
}

function readBranding(): Branding {
	try {
		const parsed: unknown = JSON.parse(
			readFileSync(resolve(__dirname, webDir, "config.json"), "utf8")
		);
		return typeof parsed === "object" && parsed !== null ? (parsed as Branding) : {};
	} catch (e) {
		// Missing or unbuilt public/ (or invalid JSON): fall back to defaults.
		// `cap sync` will complain about the missing webDir on its own.
		return {};
	}
}

const branding = readBranding();
const appName =
	typeof branding.appName === "string" && branding.appName.trim() ? branding.appName : "Seance";
const config: CapacitorConfig = {
	// REBRAND: reverse-DNS bundle id. Placeholder until a network ships this;
	// changing it after `cap add` also means editing the generated
	// android/app/build.gradle (applicationId, namespace) and the Xcode
	// PRODUCT_BUNDLE_IDENTIFIER, or simply deleting android/ and ios/ and
	// re-running `cap add`.
	appId: "chat.seance.app",
	appName,
	webDir,
	server: {
		// Serve the bundle from https://localhost so the page is a secure
		// context: service worker, Notification / Push, crypto.subtle and
		// mixed-content rules behave exactly as on the web. Plain ws:// to an
		// IRC server is then blocked as mixed content -- use wss://.
		androidScheme: "https",
		iosScheme: "capacitor",
	},
	android: {
		allowMixedContent: false,
	},
	ios: {
		// The WebView fills the screen, status bar included, and the page
		// pads its own top from env(safe-area-inset-top) (native.ts sets
		// html[data-shell="native"] and viewport-fit=cover). Any native inset
		// would show as a band of the wrong colour above the header.
		contentInset: "never",
		preferredContentMode: "mobile",
	},
	plugins: {
		// Translucent over the page, which paints under it in the theme's
		// canvas colour; native.ts picks the text style from that colour at
		// boot and on every theme change. `style` is only the first paint.
		StatusBar: {
			overlaysWebView: true,
			style: "DARK",
		},
	},
};

export default config;
