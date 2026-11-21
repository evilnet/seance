import {BUILD} from "../build";

/**
 * A theme's stylesheet, as the page links it: the build's bundle of
 * `client/themes/<name>.css` (vite.config.mts bundleTheme), with the build in
 * the query so a deploy never pairs a new style.css with a theme the HTTP
 * cache kept from the last one. index.html, loading-error-handlers.js and the
 * service worker's precache spell it the same way.
 */
export function themeHref(name: string): string {
	return `themes/${name}.css?v=${BUILD}`;
}
