"use strict";

/*
 * Before first paint: the stored (or system) language decides <html lang>
 * and the text direction, so an RTL language never flashes left-to-right.
 *
 * A file of its own, loaded synchronously from <head> ahead of the
 * stylesheet, rather than inline: a deploy's Content-Security-Policy (the
 * Electron shell's `script-src 'self'`, shells/electron/main.js) refuses
 * inline scripts, and a hash would change with every locale list. Copied
 * rather than bundled (it runs before the bundle loads); webpack.config.ts
 * writes the locale list from client/locales/tags.json over the quoted
 * marker below as it copies, dropping the dev-only tags from a production
 * build.
 *
 * Reads the same settings blob as client/js/settings.ts; resolves "auto"
 * against the baked locale list. The match order differs from
 * client/js/i18n bestLocale() — exact-or-base per candidate here,
 * exact-then-base per preference there — which can pick a different tag of
 * the same language; harmless, and moot while the list ships no subtags.
 * The RTL tag list is pinned to client/js/i18n/core.ts by
 * test/helpers/i18n.ts. Fail-closed: any error means English/left-to-right
 * until boot.
 */

(function () {
	try {
		const stored = JSON.parse(localStorage.getItem("settings") || "{}");
		const available = "__AVAILABLE_LOCALES__".split(",");
		const storedLocale =
			typeof stored.locale === "string" && stored.locale !== "auto" ? stored.locale : "";
		let tag = "";

		if (storedLocale) {
			// The stored tag activates as chosen only when this build
			// still ships it: a stale one (a locale the deploy dropped,
			// a settings blob restored from a backup) must not pin a
			// lang/dir no catalog backs — boot's activate() falls back
			// to en for the same reason, so auto-resolution is skipped
			// here too and lang/dir stay as authored.
			for (let k = 0; k < available.length && !tag; k++) {
				if (available[k].toLowerCase() === storedLocale.toLowerCase()) {
					tag = available[k];
				}
			}
		} else {
			// Traditional Chinese never falls to the Simplified "zh", and
			// neither does the bare "zh" Chrome appends after it — the same
			// rule as isTraditionalChinese()/bestLocale() in
			// client/js/i18n/core.ts (test/helpers/i18n.ts runs both).
			let traditional = false;

			for (let i = 0; i < (navigator.languages || []).length && !tag; i++) {
				const want = navigator.languages[i].toLowerCase();
				const parts = want.split(/[-_]/);
				const isTraditional =
					parts[0] === "zh" &&
					(parts.indexOf("hant") !== -1 ||
						(parts.indexOf("hans") === -1 &&
							(parts.indexOf("tw") !== -1 ||
								parts.indexOf("hk") !== -1 ||
								parts.indexOf("mo") !== -1)));

				if (isTraditional) {
					traditional = true;
				} else if (traditional && want === "zh") {
					continue;
				}

				for (let j = 0; j < available.length && !tag; j++) {
					if (
						want === available[j].toLowerCase() ||
						(!isTraditional && want.split("-")[0] === available[j].toLowerCase())
					) {
						tag = available[j];
					}
				}
			}
		}

		if (tag) {
			document.documentElement.lang = tag;
			document.documentElement.dir = /^(ar|fa|he|ur|ps|sd|ug|yi|qqx)\b/.test(tag)
				? "rtl"
				: "ltr";
		}
	} catch (e) {
		/* blocked storage or an unparseable blob: boot decides instead */
	}
})();
