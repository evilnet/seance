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
const themeColor =
	typeof branding.themeColor === "string" && /^#[0-9a-f]{6}$/i.test(branding.themeColor)
		? branding.themeColor
		: "#1a1816";

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
		// context: crypto.subtle, the other secure-context-only APIs and the
		// mixed-content rules behave exactly as on the web. Plain ws:// to an
		// IRC server is then blocked as mixed content -- use wss://.
		androidScheme: "https",
		iosScheme: "capacitor",
	},
	android: {
		allowMixedContent: false,
	},
	ios: {
		// Keep the WebView below the status bar / notch instead of under it.
		contentInset: "always",
		preferredContentMode: "mobile",
	},
	plugins: {
		StatusBar: {
			overlaysWebView: false,
			style: "DARK",
			backgroundColor: themeColor,
		},
	},
};

export default config;
