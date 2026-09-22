/**
 * The install guide: which platform the page runs on, whether the guide
 * should open at start, and the steps it walks through. Vue-free and
 * DOM-free (`test/helpers/installGuide.ts`); `InstallGuide.vue` renders it
 * and `pwa.ts` decides when to open it.
 *
 * Chrome and Edge fire `beforeinstallprompt`, so on those the guide can
 * offer a real Install button (`pwa.ts` `promptInstall`). Every other
 * browser that can install a web app — Safari on iOS and macOS, Firefox and
 * Samsung Internet on Android — hides the option somewhere in its own UI,
 * and the guide's only job there is to show where.
 */

/** The localStorage key holding the user's answer to "don't show this again". */
export const STORAGE_KEY = "thelounge.state.installGuide";
export const DISMISSED = "dismissed";

export type InstallOs = "ios" | "android" | "mac" | "windows" | "linux" | "other";
export type InstallBrowser = "safari" | "chrome" | "edge" | "samsung" | "firefox" | "other";

/** Which set of instructions applies; `null` when the browser cannot install. */
export type InstallPlatform = "ios" | "android" | "desktop-chromium" | "mac-safari";

export interface InstallEnvironment {
	userAgent: string;
	/** `navigator.userAgentData.brands[].brand`, where the browser offers them. */
	brands?: string[];
	/** `navigator.maxTouchPoints` — the only way to tell an iPad from a Mac. */
	maxTouchPoints?: number;
	/** `display-mode: standalone` or `navigator.standalone`: already installed. */
	standalone?: boolean;
	/** A Capacitor or Electron shell: nothing to install. */
	native?: boolean;
}

export interface InstallTarget {
	os: InstallOs;
	browser: InstallBrowser;
	platform: InstallPlatform | null;
	/** iPad: the toolbar with the Share button is at the top, not the bottom. */
	tablet: boolean;
}

/** Each illustration `InstallGuideArt.vue` can draw. */
export type InstallArt =
	| "intro"
	| "ios-share-bottom"
	| "ios-share-top"
	| "share-sheet"
	| "ios-add"
	| "android-menu"
	| "android-confirm"
	| "desktop-omnibox"
	| "desktop-confirm"
	| "mac-dock"
	| "home-screen";

export interface InstallStep {
	title: string;
	body: string;
	art: InstallArt;
	/** A secondary line under the body: the fallback route, a version note. */
	note?: string;
	/** The step carries the browser's own Install button (`beforeinstallprompt`). */
	action?: "prompt";
}

function detectIos(env: InstallEnvironment): boolean {
	const ua = env.userAgent;

	if (/iPhone|iPad|iPod/.test(ua)) {
		return true;
	}

	// iPadOS 13+ asks for the desktop site by default and reports itself as
	// a Mac; a Mac has no touch screen.
	return /Macintosh/.test(ua) && (env.maxTouchPoints ?? 0) > 1;
}

function iosBrowser(ua: string): InstallBrowser {
	if (/CriOS/.test(ua)) {
		return "chrome";
	}

	if (/EdgiOS/.test(ua)) {
		return "edge";
	}

	if (/FxiOS/.test(ua)) {
		return "firefox";
	}

	// Every other iOS browser is a WebKit view that offers the system share
	// sheet; the instructions for Safari fit them.
	return "safari";
}

function androidBrowser(ua: string): InstallBrowser {
	if (/SamsungBrowser/.test(ua)) {
		return "samsung";
	}

	if (/EdgA/.test(ua)) {
		return "edge";
	}

	if (/Firefox/.test(ua)) {
		return "firefox";
	}

	if (/Chrome\//.test(ua)) {
		return "chrome";
	}

	return "other";
}

function desktopBrowser(env: InstallEnvironment): InstallBrowser {
	const brands = env.brands ?? [];
	const ua = env.userAgent;

	if (brands.some((b) => /Microsoft Edge/i.test(b)) || /Edg\//.test(ua)) {
		return "edge";
	}

	if (brands.some((b) => /Google Chrome|Chromium/i.test(b)) || /Chrome\//.test(ua)) {
		return "chrome";
	}

	if (/Firefox\//.test(ua)) {
		return "firefox";
	}

	if (/Safari\//.test(ua) && /Version\//.test(ua)) {
		return "safari";
	}

	return "other";
}

function desktopOs(ua: string): InstallOs {
	if (/Windows/.test(ua)) {
		return "windows";
	}

	if (/Macintosh|Mac OS X/.test(ua)) {
		return "mac";
	}

	if (/Linux|X11|CrOS/.test(ua)) {
		return "linux";
	}

	return "other";
}

/** What the page runs on and which instructions, if any, apply to it. */
export function detectInstallTarget(env: InstallEnvironment): InstallTarget {
	const ua = env.userAgent;

	if (detectIos(env)) {
		const tablet = /iPad/.test(ua) || /Macintosh/.test(ua);
		return {os: "ios", browser: iosBrowser(ua), platform: "ios", tablet};
	}

	if (/Android/.test(ua)) {
		const browser = androidBrowser(ua);
		return {
			os: "android",
			browser,
			platform: browser === "other" ? null : "android",
			tablet: !/Mobile/.test(ua),
		};
	}

	const os = desktopOs(ua);
	const browser = desktopBrowser(env);

	let platform: InstallPlatform | null = null;

	if (browser === "chrome" || browser === "edge") {
		platform = "desktop-chromium";
	} else if (browser === "safari" && os === "mac") {
		// Safari 17 (macOS Sonoma) added File → Add to Dock.
		platform = "mac-safari";
	}

	return {os, browser, platform, tablet: false};
}

/**
 * Whether the guide opens at start: the browser can install the app, the
 * page is not already running as one, and the user has not asked for it to
 * stay away (`stored` is the value under STORAGE_KEY).
 */
export function shouldShowInstallGuide(env: InstallEnvironment, stored: string | null): boolean {
	if (env.standalone || env.native) {
		return false;
	}

	if (stored === DISMISSED) {
		return false;
	}

	return detectInstallTarget(env).platform !== null;
}

interface StepOptions {
	/** `beforeinstallprompt` has fired: the guide can show the real dialog. */
	canPrompt: boolean;
}

function introBody(appName: string): string {
	return (
		`${appName} runs best as an app on this device: it opens in its own window, ` +
		`keeps your networks and settings, and can alert you when someone mentions you.`
	);
}

function iosSteps(target: InstallTarget, appName: string): InstallStep[] {
	const finish: InstallStep = {
		title: "Tap Add",
		body: `${appName} appears on your Home Screen. Open it from there from now on.`,
		art: "ios-add",
	};

	const choose: InstallStep = {
		title: "Choose Add to Home Screen",
		body: "It is further down the list. Scroll the sheet if you do not see it.",
		art: "share-sheet",
	};

	if (target.browser === "chrome" || target.browser === "edge") {
		return [
			{
				title: "Open the Share menu",
				body: "Tap the Share button at the right end of the address bar.",
				art: "ios-share-top",
			},
			choose,
			finish,
		];
	}

	if (target.browser === "firefox") {
		return [
			{
				title: "Open the Share menu",
				body: "Tap the menu button in the toolbar, then Share.",
				art: "ios-share-bottom",
			},
			choose,
			finish,
		];
	}

	return [
		{
			title: "Open the Share menu",
			body: target.tablet
				? "Tap the Share button at the top right of the screen."
				: "Tap the Share button in the toolbar at the bottom of the screen.",
			art: target.tablet ? "ios-share-top" : "ios-share-bottom",
		},
		choose,
		finish,
	];
}

function androidSteps(target: InstallTarget, appName: string): InstallStep[] {
	const confirm: InstallStep = {
		title: "Confirm",
		body: `Tap Install. ${appName} appears on your home screen and in your app list.`,
		art: "android-confirm",
	};

	switch (target.browser) {
		case "samsung":
			return [
				{
					title: "Open the browser menu",
					body: "Tap the menu button at the bottom right of the screen.",
					art: "android-menu",
				},
				{
					title: "Choose Add page to, then Home screen",
					body: "Samsung Internet lists the option under Add page to.",
					art: "android-menu",
				},
				{
					title: "Confirm",
					body: `Tap Add. ${appName} appears on your home screen.`,
					art: "android-confirm",
				},
			];
		case "edge":
			return [
				{
					title: "Open the browser menu",
					body: "Tap the three dots at the bottom of the screen.",
					art: "android-menu",
				},
				{
					title: "Choose Add to phone",
					body: "It is in the second row of the menu.",
					art: "android-menu",
				},
				confirm,
			];
		case "firefox":
			return [
				{
					title: "Open the browser menu",
					body: "Tap the three dots in the toolbar.",
					art: "android-menu",
				},
				{
					title: "Choose Install",
					body: "Older versions say Add to Home screen instead.",
					art: "android-menu",
				},
				confirm,
			];
		default:
			return [
				{
					title: "Open the browser menu",
					body: "Tap the three dots at the top right of the screen.",
					art: "android-menu",
				},
				{
					title: "Choose Install app",
					body: "Older versions say Add to Home screen instead.",
					art: "android-menu",
				},
				confirm,
			];
	}
}

function desktopSteps(target: InstallTarget, appName: string): InstallStep[] {
	const where =
		target.os === "mac"
			? "a shortcut in Launchpad and the Dock"
			: target.os === "windows"
			? "a shortcut in the Start menu"
			: "a shortcut in your app launcher";

	if (target.browser === "edge") {
		return [
			{
				title: "Use the install button in the address bar",
				body: "It is at the right end of the address bar, next to the favourites star.",
				note: "Not there? Open the browser menu and choose Apps, then Install this site as an app.",
				art: "desktop-omnibox",
			},
			{
				title: "Confirm",
				body: `Click Install. ${appName} opens in its own window and gets ${where}.`,
				art: "desktop-confirm",
			},
		];
	}

	return [
		{
			title: "Use the install button in the address bar",
			body: "It is at the right end of the address bar, next to the bookmark star.",
			note: "Not there? Open the browser menu and choose Cast, save and share, then Install page as app.",
			art: "desktop-omnibox",
		},
		{
			title: "Confirm",
			body: `Click Install. ${appName} opens in its own window and gets ${where}.`,
			art: "desktop-confirm",
		},
	];
}

function macSafariSteps(appName: string): InstallStep[] {
	return [
		{
			title: "Choose File, then Add to Dock",
			body: "The Share button in the toolbar offers the same option.",
			note: "Needs Safari 17 or later (macOS Sonoma).",
			art: "mac-dock",
		},
		{
			title: "Confirm",
			body: `Click Add. ${appName} opens in its own window from the Dock from now on.`,
			art: "home-screen",
		},
	];
}

/**
 * The steps the guide walks through for `target`: an introduction first,
 * then the platform's own route. With `canPrompt` the introduction offers
 * the browser's Install dialog directly and the manual route stays as the
 * fallback.
 */
export function installSteps(
	target: InstallTarget,
	appName: string,
	options: StepOptions
): InstallStep[] {
	if (!target.platform) {
		return [];
	}

	const intro: InstallStep = {
		title: `Install ${appName}`,
		body: introBody(appName),
		art: "intro",
	};

	if (options.canPrompt) {
		intro.action = "prompt";
		intro.note = "Prefer to do it by hand? The next steps show where the option is.";
	}

	switch (target.platform) {
		case "ios":
			return [intro, ...iosSteps(target, appName)];
		case "android":
			return [intro, ...androidSteps(target, appName)];
		case "desktop-chromium":
			return [intro, ...desktopSteps(target, appName)];
		case "mac-safari":
			return [intro, ...macSafariSteps(appName)];
	}
}

/** The environment as the browser reports it; `null` outside a browser. */
export function currentEnvironment(extra: Partial<InstallEnvironment> = {}): InstallEnvironment {
	const nav = typeof navigator === "undefined" ? undefined : navigator;
	const brands = (nav as {userAgentData?: {brands?: Array<{brand: string}>}} | undefined)
		?.userAgentData?.brands;

	return {
		userAgent: nav?.userAgent ?? "",
		brands: brands?.map((b) => b.brand),
		maxTouchPoints: nav?.maxTouchPoints ?? 0,
		...extra,
	};
}
