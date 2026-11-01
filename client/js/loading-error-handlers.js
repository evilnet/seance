"use strict";

/*
 * This is a separate file for two reasons:
 * 1. CSP policy does not allow inline javascript
 * 2. It has to be a small javascript executed before all other scripts,
 *    so that the timeout can be triggered while slow JS is loading
 */

(function () {
	// The splash speaks before the app's catalogs exist: English literals
	// first (the pot is the only source of English copy — these four keys
	// are pinned to this file by test/tests/i18n-toolchain.ts), overlaid
	// best-effort by the locale the pre-paint script wrote into <html lang>.
	// The overlay fetch may never answer (offline, file://, a deploy without
	// that catalog); every path below degrades to the English fallback.
	const I18N_COPY = {
		"loading.starting": "Loading the app…",
		"loading.error": "An error has occurred that prevented the client from loading correctly.",
		"loading.errorDetails": "More details",
		"loading.errorDevtools": "Open the developer tools of your browser for more information.",
	};

	let overlay = null;
	let lastKey = null;

	const tr = (key) => {
		const localized = overlay && overlay[key];
		return typeof localized === "string" && localized.length > 0 ? localized : I18N_COPY[key];
	};

	const msg = document.getElementById("loading-page-message");

	const say = (key) => {
		lastKey = key;

		if (msg) {
			msg.textContent = tr(key);
		}
	};

	say("loading.starting");

	// Best-effort overlay: the pre-paint script (js/prepaint.js) has already
	// resolved the locale (and the direction); en needs no fetch, and a
	// production build never serves qqx.json, so the 404 just falls through.
	const lang = (document.documentElement.lang || "").trim();

	if (lang && lang !== "en") {
		fetch(new URL(`locales/${lang}.json`, document.baseURI))
			.then((response) => (response.ok ? response.json() : null))
			.then((catalog) => {
				if (catalog && typeof catalog === "object") {
					overlay = catalog;
					say(lastKey ?? "loading.starting"); // re-render in the real language
				}
			})
			.catch(() => {});
	}

	document.getElementById("loading-reload")?.addEventListener("click", () => location.reload());

	const displayReload = () => {
		const loadingReload = document.getElementById("loading-reload");

		if (loadingReload) {
			loadingReload.style.visibility = "visible";
		}
	};

	const loadingSlowTimeout = setTimeout(() => {
		const loadingSlow = document.getElementById("loading-slow");

		if (loadingSlow) {
			loadingSlow.style.visibility = "visible";
		}

		displayReload();
	}, 5000);

	/**
	 * @param {ErrorEvent} e
	 **/
	const errorHandler = (e) => {
		if (!msg) {
			return;
		}

		say("loading.error");

		const summary = document.createElement("summary");
		summary.textContent = tr("loading.errorDetails");

		const data = document.createElement("pre");
		data.textContent = e.message; // e is an ErrorEvent

		const info = document.createElement("p");
		info.textContent = tr("loading.errorDevtools");

		const details = document.createElement("details");
		details.appendChild(summary);
		details.appendChild(data);
		details.appendChild(info);
		msg.parentNode?.insertBefore(details, msg.nextSibling);

		window.clearTimeout(loadingSlowTimeout);
		displayReload();
	};

	window.addEventListener("error", errorHandler);

	window.g_TheLoungeRemoveLoading = () => {
		delete window.g_TheLoungeRemoveLoading;
		window.clearTimeout(loadingSlowTimeout);
		window.removeEventListener("error", errorHandler);
		document.getElementById("loading")?.remove();
	};

	// The light/dark theme pairs, `[dark, light]` each: webpack.config.ts
	// writes client/js/helpers/themePairs.json over the marker (this file is
	// copied, not bundled, so it cannot import themeAppearance.ts).
	/** @type {unknown} */
	const themePairs = "__THEME_PAIRS__";

	/** The light/dark pair `theme` belongs to, if any. */
	const pairOf = (/** @type {string | undefined} */ theme) =>
		Array.isArray(themePairs)
			? themePairs.find((p) => Array.isArray(p) && p.includes(theme))
			: undefined;

	/** The half of `theme`'s pair that matches the system's mode, or `theme`
	 * itself when it has no partner (effectiveTheme in themeAppearance.ts). */
	const pairedTheme = (/** @type {string | undefined} */ theme) => {
		const pair = pairOf(theme);

		if (!pair) {
			return theme;
		}

		return window.matchMedia("(prefers-color-scheme: dark)").matches ? pair[0] : pair[1];
	};

	// Apply user theme as soon as possible, before any other code loads
	// This prevents flash of white while other code loads and socket connects
	try {
		const parsed = JSON.parse(localStorage.getItem("settings") || "{}");
		// A damaged entry (a number, a string, null) holds no settings.
		const userSettings = typeof parsed === "object" && parsed !== null ? parsed : {};
		const themeEl = document.getElementById("theme");

		if (!themeEl) {
			return;
		}

		// The theme loadTheme (settings.ts) will load, so the page does not
		// open on the chosen theme and swap to its partner a moment later:
		// with matchSystemAppearance on, a paired theme is shown as whichever
		// half matches the system's light or dark mode. The setting defaults
		// to on in the native shell (Capacitor's bridge is injected before any
		// script runs) and off on the web (helpers/platformDefaults.ts). Not
		// stored yet (the first launch after the upgrade that brought it), it
		// is what the migration will decide: off for a stored paired theme
		// other than the default, which following the system would override
		// (overridesChoice in helpers/settingsMigration.ts). The default here
		// is the build's (data-server-theme): config.json has not loaded, so a
		// deploy with a branded paired default may load the wrong half once,
		// until the migration stores its answer.
		const defaultTheme = themeEl.dataset.serverTheme;
		const storedTheme = typeof userSettings.theme === "string" ? userSettings.theme : undefined;
		const chosen = storedTheme ?? defaultTheme;
		// The shell test is platformDefaults.ts currentPlatform's, inlined:
		// this file is copied, not bundled.
		const matchSystem =
			typeof userSettings.matchSystemAppearance === "boolean"
				? userSettings.matchSystemAppearance
				: window.Capacitor?.isNativePlatform?.() === true &&
				  !(storedTheme && storedTheme !== defaultTheme && pairOf(storedTheme));
		const theme = matchSystem ? pairedTheme(chosen) : chosen;

		if (theme && themeEl.getAttribute("href") !== `themes/${theme}.css`) {
			themeEl.setAttribute("href", `themes/${theme}.css`);
		}

		if (
			typeof userSettings.userStyles === "string" &&
			!/[?&]nocss/.test(window.location.search)
		) {
			const userSpecifiedCSSElement = document.getElementById("user-specified-css");

			if (!userSpecifiedCSSElement) {
				return;
			}

			userSpecifiedCSSElement.innerHTML = userSettings.userStyles;
		}
	} catch (e) {
		//
	}

	// Trigger early service worker registration. Browsers only expose
	// navigator.serviceWorker in secure contexts, but be explicit about it and
	// never let a failed registration surface as an unhandled rejection: the
	// app works without the worker, it just is not installable/offline-capable.
	const isAllowedServiceWorkersHost =
		window.isSecureContext === true ||
		location.protocol === "https:" ||
		location.hostname === "localhost" ||
		location.hostname === "127.0.0.1" ||
		location.hostname === "[::1]";

	if (isAllowedServiceWorkersHost && "serviceWorker" in navigator) {
		navigator.serviceWorker.register("service-worker.js", {scope: "./"}).catch((e) => {
			// eslint-disable-next-line no-console
			console.error("Service worker registration failed:", e);
		});

		// Handler for messages coming from the service worker

		const messageHandler = (/** @type {MessageEvent} */ event) => {
			if (event.data && event.data.type === "fetch-error") {
				// @ts-expect-error Argument of type '{ message: string; }' is not assignable to parameter of type 'ErrorEvent'.
				errorHandler({
					message: `Service worker failed to fetch an url: ${event.data.message}`,
				});

				// Display only one fetch error
				navigator.serviceWorker.removeEventListener("message", messageHandler);
			}
		};

		navigator.serviceWorker.addEventListener("message", messageHandler);
	}
})();
