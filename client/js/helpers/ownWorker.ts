/**
 * Whether a `navigator.serviceWorker` message comes from this deploy's own
 * service worker. One origin can hold several deploys of the app (GitHub
 * Pages: the release at /seance/, develop at /seance/develop/, previews at
 * /seance/prN/), and a worker that asks the browser for "every window"
 * reaches all of them. A worker of this deploy, the root one or a per-network
 * push-only one (webpush.ts registers the same script under `push/<uuid>/`),
 * runs `service-worker.js` from this page's directory; another deploy's runs
 * it from its own. The workers filter their windows themselves
 * (`appWindows()`); this is for workers installed before they did.
 *
 * A message without a sending worker is accepted, so a browser that leaves
 * `source` out loses this check, not the message.
 */
export function fromOwnWorker(event: MessageEvent, pageUrl: string = location.href): boolean {
	const source = event.source as {scriptURL?: unknown} | null;

	if (!source || typeof source.scriptURL !== "string") {
		return true;
	}

	return source.scriptURL === new URL("service-worker.js", pageUrl).href;
}
