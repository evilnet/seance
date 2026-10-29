/**
 * The push worker's i18n: the same Vue-free resolver the app uses
 * (client/js/i18n/core.ts, en bundled with it), with the overlay fetched
 * per tag instead of webpack-imported. A classic service worker may only
 * importScripts while it installs, so a lazy webpack chunk reached from
 * the push handler could never load — the compiled catalogs are copied to
 * public/locales/ by the build instead, and the overlay is fetched
 * same-origin from the app root (the worker's script URL is the app root,
 * so the URL needs no configuration and no scope mapping).
 *
 * The worker awaits applyLocale on every push, before composing any
 * reader-visible string — the locale can change between pushes and no page
 * may be open to apply it for us. The app root and the fetch both come
 * from the caller (client/service-worker.js derives the root from its
 * registration scope; worker-entry.ts binds the worker's global fetch), so
 * this module stays free of `self` — that is what lets
 * test/tests/service-worker.ts install it in the vm sandbox with its own
 * transport.
 */

import enCatalog from "../../locales/en.json";
import {setCatalog, type Catalog} from "../i18n/core";

/** The transport an overlay loads through: the Response shape the loader
 * needs, no more — in the worker that is the global fetch, and the vm
 * harness binds one that serves the compiled catalogs from disk. */
export type CatalogFetcher = (
	url: string
) => Promise<{ok: boolean; status?: number; json(): Promise<unknown>}>;

/** Overlays already fetched in this worker's lifetime, keyed by tag. */
const overlays = new Map<string, Catalog>();

/** Overlay fetches still on the way, keyed by tag: a push that gave up
 * waiting leaves its fetch running, and the next push joins it. */
const loading = new Map<string, Promise<Catalog>>();

/**
 * How long a push waits for its overlay before it goes out in English. A
 * phone's worker is usually terminated between pushes, so the overlay is
 * fetched again on most of them; on a slow or stalled connection the
 * notification would otherwise wait for the browser's own fetch timeout
 * (and WebKit's 20 s fallback would show a stub in its place). A late
 * overlay is still kept for the next push.
 */
export const OVERLAY_TIMEOUT_MS = 2000;

function loadOverlay(fetcher: CatalogFetcher, appUrl: string, locale: string): Promise<Catalog> {
	let pending = loading.get(locale);

	if (!pending) {
		pending = (async () => {
			const response = await fetcher(new URL(`locales/${locale}.json`, appUrl).href);

			if (!response.ok) {
				throw new Error(`no catalog for ${locale} (HTTP ${response.status ?? 0})`);
			}

			return (await response.json()) as Catalog;
		})();
		loading.set(locale, pending);
		pending.then(
			(overlay) => {
				overlays.set(locale, overlay);
				loading.delete(locale);
			},
			() => loading.delete(locale)
		);
	}

	return pending;
}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("overlay timed out")), ms);
	});

	return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/** Tags that may build a fetch URL: BCP-47-ish, nothing URL-special. The
 * value comes from our own IndexedDB (push-prefs.ts), but the worker has
 * no way to vouch for what a stale entry carries. */
function safeTag(tag: string | undefined | null): string {
	return typeof tag === "string" && /^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$/.test(tag) ? tag : "en";
}

/**
 * Install the prefs' locale for this push: en as-is (it ships inside the
 * chunk), any other tag as its compiled overlay over en. Never rejects —
 * anything wrong (no prefs, an unknown tag, a fetch that misses) lands
 * back on en, so the notification still resolves real copy. Returns the
 * tag that was applied.
 */
export async function applyLocale(
	fetcher: CatalogFetcher,
	appUrl: string,
	tag: string | undefined | null,
	timeoutMs = OVERLAY_TIMEOUT_MS
): Promise<string> {
	const locale = safeTag(tag);

	if (locale === "en") {
		setCatalog("en", enCatalog, undefined);
		return locale;
	}

	try {
		const overlay =
			overlays.get(locale) ?? (await within(loadOverlay(fetcher, appUrl, locale), timeoutMs));

		setCatalog(locale, enCatalog, overlay);
		return locale;
	} catch {
		// Unknown tag, the fetch missed, or it is taking too long: the
		// notification still goes out, in the default language.
		setCatalog("en", enCatalog, undefined);
		return "en";
	}
}
