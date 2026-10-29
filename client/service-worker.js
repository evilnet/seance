// @ts-nocheck
// Seance service worker (derived from The Lounge - https://github.com/thelounge/thelounge)
/* global clients, importScripts */
"use strict";

// Seance is a static single-page app: everything under the registration scope
// is a build artifact (index.html, js/, css/, themes/, img/, ...). IRC traffic
// goes over WebSocket straight to the ircd and is never routed through here —
// service workers do not receive fetch events for WebSocket handshakes, and the
// same-origin/http(s) guards below make sure nothing else is intercepted either.
//
// Strategy: network-first with a cache fallback for the static bundle, plus a
// precached copy of the app shell (index.html) so that navigations still
// resolve when the host is unreachable and the PWA can open offline.
//
// Web Push (draft/webpush): the server sends one raw IRC line per push
// (no CRLF). The handler below is deliberately the smallest thing that
// renders one — phase-2 slice 0, per docs/projects/push-subscription.md;
// parsed messages, grouping and MARKREAD dedupe are planned in
// notifications.md. In-page `Notification` requests are still routed through
// this worker (see the "message" handler) so that clicks on them focus or
// reopen the app.

const cacheName = "__HASH__";
// The deploy's name (config.json `appName`), written in at build time like
// the hash; a worker run from source (the test harness) says "Seance".
const STAMPED_APP_NAME = "__APP_NAME__";
const appName = STAMPED_APP_NAME.startsWith("__") ? "Seance" : STAMPED_APP_NAME;
const isDevBuild = cacheName === "dev";

// Cache Storage the translation engines own (client/js/translate/): the
// model weights a user downloaded once. transformers.js keeps
// "transformers-cache", WebLLM keeps "webllm/model", "webllm/wasm" and
// "webllm/config". A shell update must never evict them.
const isModelCache = (name) => name === "transformers-cache" || name.startsWith("webllm/");

// The push module (client/js/push/*, built to js/push.js): the line parser,
// the strippers and the merged-body renderer, shared with the page so the
// two agree. Loaded at start-up — a service worker may only importScripts
// what it imported while installing. If it fails, push() below falls back
// to the inline minimum (no Markdown stripping).
try {
	importScripts(`js/push.js?v=${cacheName}`);
} catch (e) {
	// push() falls back
}

// The app shell is cached under the scope URL because, with hash-based
// routing, every navigation request resolves to the scope root.
const shellUrl = self.registration.scope;

// Push-only registrations: the page registers this same script once more
// per push-enabled network, at `<app>/push/<uuid>/`, because a browser holds
// one push subscription per registration and each network has its own VAPID
// key (docs/projects/push-per-network.md). Such a worker serves that one
// network's pushes and nothing else: no shell cache, no fetch handling, and
// deep links open the app, never its own scope.
const scopeNetwork = networkOfScope(shellUrl);
const pushOnly = scopeNetwork !== undefined;
const appUrl = pushOnly ? shellUrl.replace(/push\/[^/]+\/$/, "") : shellUrl;

function networkOfScope(scope) {
	if (self.seancePush && self.seancePush.networkFromScope) {
		return self.seancePush.networkFromScope(scope);
	}

	// The push chunk did not load: the same rule, inline.
	const m = /\/push\/([^/]+)\/$/.exec(scope);

	try {
		return m ? decodeURIComponent(m[1]) : undefined;
	} catch (e) {
		return undefined;
	}
}

// Everything a cold start needs, so that an installed app opens offline
// straight after the first visit (rather than only after a second load has
// filled the runtime cache). Versioned assets use the same `?v=` query as
// index.html so the keys match the requests. Other themes, sounds and icons
// are cached on first use.
const shellPaths = [
	"",
	"index.html",
	"manifest.webmanifest",
	"config.json",
	"favicon.ico",
	`js/prepaint.js?v=${cacheName}`,
	`js/loading-error-handlers.js?v=${cacheName}`,
	`js/bundle.vendor.js?v=${cacheName}`,
	`js/bundle.js?v=${cacheName}`,
	`js/push.js?v=${cacheName}`,
	`css/style.css?v=${cacheName}`,
	"themes/coffee.css",
	"themes/day.css", // coffee.css @imports it (the window frame)
	"fonts/fa-solid-900.woff2",
	"img/logo-tile.png",
];

// Paths that must never be served from cache: Cloudflare challenge
// endpoints, and `models/`, where a deploy that mirrors the translation
// weights next to the app puts them (config.json `translation.modelBase`);
// a gigabyte of weights has no place in the shell cache, and the ML
// libraries keep their own Cache Storage entries.
const excludedPathsFromCache = /^(cdn-cgi|models)\//;

self.addEventListener("install", function (event) {
	// A push-only worker has no shell to cache (nothing lives under its
	// scope); activating at once is all it needs.
	event.waitUntil(
		(pushOnly ? Promise.resolve() : precacheShell()).then(() => self.skipWaiting())
	);
});

self.addEventListener("activate", function (event) {
	if (pushOnly) {
		// The cache belongs to the root worker; a push-only one of another
		// build must not sweep it, and there are no clients to claim.
		return;
	}

	event.waitUntil(
		caches
			.keys()
			.then((names) =>
				Promise.all(
					names
						.filter((name) => name !== cacheName && !isModelCache(name))
						.map((name) => caches.delete(name))
				)
			)
	);

	event.waitUntil(self.clients.claim().then(announceBuild));
});

// Tell every open window which build serves it now. A page whose bundle is
// older compares (client/js/pwa.ts) and offers "Reload to update"; a page
// that has just loaded is this build already and stays quiet. Uncontrolled
// windows included: a hard reload leaves a page without a controller.
async function announceBuild() {
	const windows = await self.clients.matchAll({type: "window", includeUncontrolled: true});

	for (const client of windows) {
		client.postMessage({type: "build", build: cacheName});
	}
}

self.addEventListener("fetch", function (event) {
	if (pushOnly || event.request.method !== "GET") {
		return;
	}

	const url = event.request.url;

	// Only ever touch http(s) requests inside our own scope. Cross-origin
	// requests (link previews, external images, ...) and anything that is not
	// a plain http(s) URL are left entirely to the browser.
	if (!/^https?:/i.test(url) || !url.startsWith(shellUrl)) {
		return;
	}

	const path = url.substring(shellUrl.length);

	if (excludedPathsFromCache.test(path)) {
		return;
	}

	event.respondWith(networkOrCache(event));
});

async function precacheShell() {
	if (isDevBuild) {
		return;
	}

	try {
		const cache = await caches.open(cacheName);

		await Promise.all(
			shellPaths.map(async (path) => {
				const response = await fetch(new URL(path, shellUrl).href, {
					cache: "no-cache",
					redirect: "follow",
				});

				if (response.ok) {
					await cache.put(cacheKeyFor(path), response);
				}
			})
		);
	} catch (e) {
		// A failed precache must not prevent the worker from installing; the
		// runtime cache will fill in on the first successful online load.
		// eslint-disable-next-line no-console
		console.warn("Failed to precache app shell:", e.message);
	}
}

function cacheKeyFor(path) {
	// index.html is the same document as the scope root; store it once.
	return path === "index.html" ? shellUrl : new URL(path, shellUrl).href;
}

function isNavigation(request) {
	return request.mode === "navigate" || request.destination === "document";
}

// Cross-origin isolation (docs/projects/translation-devices.md
// § Multithreading): multithreaded WebAssembly for the CPU translation
// models needs a cross-origin-isolated page and worker, which needs these
// two headers on the document and on the worker's script, and a static
// host (GitHub Pages) sends neither. So the worker adds them to the app's
// documents and its own worker scripts, from the network and from the
// shell cache alike. `credentialless`, not `require-corp`: a cross-origin
// image, video or upload host keeps loading without a header of its own,
// fetched without cookies. A deploy that sends its own policy keeps it.
// The page is isolated from the load after the worker took control of it.
// WebKit (Safari, every iOS browser: `strictUserVisible` below) has no
// `credentialless`, so it gets neither header and stays exactly as it was.
// The fetch event sees every request a controlled page makes, other
// origins' included, but the fetch handler returns early for any URL that
// does not start with `shellUrl`, so only requests inside the scope reach
// this, and a worker script here is always the app's own.
const ISOLATION_HEADERS = [
	["Cross-Origin-Opener-Policy", "same-origin"],
	["Cross-Origin-Embedder-Policy", "credentialless"],
];

function wantsIsolation(request) {
	return (isNavigation(request) || request.destination === "worker") && !strictUserVisible();
}

function isolate(response) {
	// An error or opaque response has nothing to add to (and status 0
	// cannot be constructed).
	if (!response || response.status === 0 || response.type === "opaque") {
		return response;
	}

	const headers = new Headers(response.headers);

	for (const [name, value] of ISOLATION_HEADERS) {
		if (!headers.has(name)) {
			headers.set(name, value);
		}
	}

	return new Response(response.body, {
		headers,
		status: response.status,
		statusText: response.statusText,
	});
}

// The shell cache exists so an installed app opens offline; it is not a
// general-purpose cache, and a browser that runs out of quota evicts the
// whole origin at once. A large same-origin response — a mirrored model
// shard, a video, an archive a deploy serves next to the app — is served
// and forgotten. (Weights under `models/` never reach the fetch handler at
// all, `excludedPathsFromCache` above; this is the catch-all.)
const MAX_SHELL_CACHE_BYTES = 8 * 1024 * 1024;

function tooBigToCache(response) {
	const length = Number(response.headers.get("content-length"));

	// No `content-length` (a streamed or compressed response) means "cache
	// it": the shell's own files all have one, and guessing is worse than
	// the status quo.
	return Number.isFinite(length) && length > MAX_SHELL_CACHE_BYTES;
}

async function putInCache(request, response) {
	if (tooBigToCache(response)) {
		return;
	}

	const cache = await caches.open(cacheName);
	await cache.put(request, response);
}

async function cleanRedirect(response) {
	// Not all browsers support the Response.body stream, so fall back
	// to reading the entire body into memory as a blob.
	const bodyPromise = "body" in response ? Promise.resolve(response.body) : response.blob();

	const body = await bodyPromise;

	// new Response() is happy when passed either a stream or a Blob.
	return new Response(body, {
		headers: response.headers,
		status: response.status,
		statusText: response.statusText,
	});
}

async function networkOrCache(event) {
	const response = await fromNetworkOrCache(event);

	return wantsIsolation(event.request) ? isolate(response) : response;
}

async function fromNetworkOrCache(event) {
	const request = event.request;
	const navigation = isNavigation(request);

	try {
		let response = await fetch(request, {
			cache: "no-cache",
			redirect: "follow",
		});

		if (response.redirected) {
			response = await cleanRedirect(response.clone());
		}

		if (response.ok) {
			if (!isDevBuild) {
				// Navigations are stored under the shell key so that offline
				// opens of "/", "/index.html" and "/?anything" all find it.
				event.waitUntil(putInCache(navigation ? shellUrl : request, response.clone()));
			}

			return response;
		}

		throw new Error(`Request failed with HTTP ${response.status}`);
	} catch (e) {
		const cache = await caches.open(cacheName);
		let matching = await cache.match(request, {ignoreSearch: navigation});

		if (!matching && navigation) {
			matching = await cache.match(shellUrl);
		}

		if (matching) {
			return matching;
		}

		// eslint-disable-next-line no-console
		console.error(e.message, request.url);

		if (event.clientId) {
			const client = await clients.get(event.clientId);

			if (client) {
				client.postMessage({
					type: "fetch-error",
					message: e.message,
				});
			}
		}

		return Response.error();
	}
}

// Notifications requested by the page. Routing them through the worker (rather
// than `new Notification()` in the page) is what makes them work on Android and
// lets "notificationclick" below reopen the app when the tab is gone.
//
// A message the page took live, on a network this device is subscribed to,
// comes to that network's push-only worker with the message itself
// (`message`): it is shown exactly as its push would be — same tag, data
// and actions, merged by msgid — so the push the server may send for it
// finds it already on this registration. Chrome counts visible
// notifications per registration, and a push this worker drops as a
// duplicate while the page's copy sits on the root worker counts as
// silent: enough of those and Chrome shows its generic "This site has been
// updated in the background". A worker from before this shows `message`
// payloads the per-channel way, still on the push registration.
//
// The page read a conversation (opened it, came back to it, or another
// session moved its marker): `{type: "read", target, ts?}` closes what this
// worker shows for it. The server's read push only follows a message it
// pushed, so a notification the page put here is closed by the page.
self.addEventListener("message", function (event) {
	if (event.data && event.data.type === "away-on-close" && Array.isArray(event.data.networks)) {
		const networks = event.data.networks.filter((uuid) => typeof uuid === "string");
		event.waitUntil(awayOnClose(networks));
		return;
	}

	if (event.data && event.data.type === "read" && typeof event.data.target === "string") {
		const {target, ts} = event.data;

		event.waitUntil(
			enqueuePush(async () => {
				await closeForTarget(target, typeof ts === "string" ? ts : undefined);

				if (strictUserVisible()) {
					await tidy();
				}

				await updateBadge();
			})
		);
		return;
	}

	// The page, a while after a push for a message it took: what WebKit
	// refused to close then can go now.
	if (event.data && event.data.type === "tidy") {
		event.waitUntil(enqueuePush(tidy).catch(() => undefined));
		return;
	}

	if (!event.data || event.data.type !== "notification") {
		return;
	}

	if (event.data.message && typeof event.data.message === "object") {
		event.waitUntil(handlePageMessage(event.data));
		return;
	}

	showPageNotification(event, event.data);
});

/** Page-requested notification (in-app notify path): tag/replace per channel.
 * The page also names the network (uuid) and the target so a click can
 * still find the conversation after the page — and its session-local
 * channel ids — is gone. */
function showPageNotification(event, payload) {
	event.waitUntil(
		self.registration
			.getNotifications({tag: `chan-${payload.chanId}`})
			.then((notifications) => {
				for (const notification of notifications) {
					notification.close();
				}

				return self.registration.showNotification(payload.title, {
					tag: `chan-${payload.chanId}`,
					icon: "img/icon-192.png",
					body: payload.body,
					timestamp: payload.timestamp,
					// The page's sound setting; the OS plays the sound otherwise.
					silent: payload.silent === true,
					data: {
						kind: "page",
						network: payload.network,
						target: payload.target,
					},
				});
			})
	);
}

// --- Web Push (draft/webpush) ----------------------------------------------
// The ircd pushes one notification per event. The payload is what
// draft/webpush asks for: ONE RAW IRC LINE — `@msgid;time;account
// :nick!u@h PRIVMSG target :text`, a multiline message as one push per
// line — `batch=<base msgid>` on every line, the msgid on the first line
// only (draft/multiline's fallback form) — ordered by
// `evilnet.github.io/line=<i>/<sent>/<total>`, and a read relay as
// `:server MARKREAD target timestamp=…` (docs/projects/
// push-payload-multiline.md §3). The JSON opt-down tiers (`{"t":"msg"|
// "notice"|"hl",…}` without text, `{"t":"read",…}`) are still parsed.
//
// Discord-style behaviour layered on top:
//   - per-target merging with a rising unread count (once per message, not
//     per multiline line), a combined body stripped of IRC formatting and —
//     when the reader renders Markdown — of its markers, and the recent
//     messages kept in the notification's data (tag `push-<target>`); the
//     tag replaces the record in place, and `renotify` only for a new
//     message,
//   - app badge = total unread across push notifications,
//   - actions on every platform: Mark read and Reply (an inline text field
//     where the platform has one; a button that opens the conversation
//     elsewhere). A typed reply goes out through an open page when there
//     is one, else over a short-lived IRC connection the worker opens
//     itself (credentials come from the page via IndexedDB, only stashed
//     when the user enabled push AND password remembering), else it is
//     queued in IndexedDB and the app opened on the conversation to send
//     it — never dropped. Mark read sets the account's read marker
//     (draft/read-marker) the same three ways, minus opening the app: the
//     server relays the marker to every push subscription, which is what
//     closes the notification on the other devices.
//   - clicks deep-link by network + target (`#/net/<uuid>/<target>`), which
//     survives the page and its session-local channel ids,
//   - `pushsubscriptionchange` re-subscribes with the stashed VAPID key and
//     re-registers, so expiry self-heals.
//
// WebKit (an iPhone's Home Screen web app, Safari) enforces `userVisibleOnly`
// its own way, and it is the way push used to die there: when a push is
// handed to the worker, webpushd starts a 30 s clock and waits for a
// `showNotification` on that registration (WebPushDaemon.mm
// `m_potentialSilentPushes`, `silentPushTimeoutForProduction`); none in
// time is one silent push, the count only ever goes up (PushDatabase
// `incrementSilentPushCount`, no reset), and at the third (`maxSilentPushCount`
// in WebPushDaemonConstants.h) it removes EVERY subscription of the origin —
// every network's — without telling the worker (no `pushsubscriptionchange`).
// Chrome instead counts the notifications visible on the registration when
// the event ends, which the page's hand-off above satisfies. So the paths
// below that end a push event without showing — a push the live page already
// took, a redelivery, a read relay that only closes — are exactly what
// revoked the subscription on iOS, three at a time, and the next app launch
// quietly subscribed again (webpush.ts `syncStoredWithBrowser`): push that
// works for a few notifications after each launch. On WebKit
// (`strictUserVisible`) every push event therefore shows something: a
// message push shows (or re-shows, same tag and count) its notification
// rather than being dropped, a read relay replaces the target's notification
// with a silent "Marked as read" stub — WebKit also refuses a `close()`
// within 30 s of a show (bug 309940), so a stub closed at once would stay
// anyway — that the worker closes once that lifetime is over, and a handler
// that has shown nothing after STRICT_SHOW_DEADLINE_MS (a stalled
// IndexedDB) shows the generic notification before WebKit's clock runs out.

/** WebKit's `silentPushTimeoutForProduction`: how long webpushd waits for a
 * `showNotification` after handing a push over, and the age below which it
 * refuses to close a persistent notification. */
const WEBKIT_SILENT_PUSH_TIMEOUT_MS = 30000;
/** A strict push event that has shown nothing by then shows the generic
 * notification: inside WebKit's clock, with room for the show itself. */
const STRICT_SHOW_DEADLINE_MS = 20000;
/** How long the read stub stays before the worker closes it: just past the
 * minimum lifetime, since an earlier close is refused. */
const READ_STUB_LIFETIME_MS = WEBKIT_SILENT_PUSH_TIMEOUT_MS + 1000;

/** Whether this worker runs under WebKit, where a push event that shows no
 * notification counts toward unsubscribing the whole origin. Every WebKit
 * browser carries `AppleWebKit/` (Chromium does too, with `Chrome/` after it;
 * Firefox carries neither). */
function strictUserVisible() {
	const ua = (self.navigator && self.navigator.userAgent) || "";

	return /AppleWebKit\//.test(ua) && !/Chrome\//.test(ua);
}

/** A notification's tag: per network, since tags are per origin and the
 * networks' push workers would otherwise replace each other's same-named
 * conversations. */
function tagFor(network, name) {
	return "push-" + (network ? network + "/" : "") + name;
}

/** The read stub and the quiet show: notifications that say nothing is
 * unread, closed by the worker once WebKit lets it. */
function isStub(n) {
	return Boolean(n.data && (n.data.kind === "read" || n.data.kind === "quiet"));
}

// WebKit never replaces a notification by its tag: webpushd files each one
// under its own UUID (WebPushDaemon.mm `showNotification`,
// `requestWithIdentifier: notificationID`) and reads the tag only to filter
// `getNotifications()`. So under WebKit a show under a tag that is up adds a
// second notification beside the first, and a close within 30 s of a show
// is refused (above) — a read stub stood beside the message it was meant to
// replace, and the message, read, stayed. `tidy` closes by hand what a tag
// would have replaced and what a refused close left: every notification but
// the newest under a tag, and a stub past its lifetime. It runs after every
// push and every read (a close refused now succeeds on a later wake) and
// when the page asks (`{type: "tidy"}`); the page also sends its reads
// again once the 30 s have passed (webpush.ts `again`).

/** When a notification was shown (showSafely stamps it); 0 for one an older
 * worker showed, which is older than any this one did. */
function shownAt(n) {
	return (n.data && Number(n.data.shownAt)) || 0;
}

/** The newest of notifications sharing a tag: under WebKit the older ones
 * are still listed (and on screen) until `tidy` closes them. */
function newest(list) {
	let best;

	for (const n of list) {
		if (!best || shownAt(n) >= shownAt(best)) {
			best = n;
		}
	}

	return best;
}

/** The notifications a tag-replacing browser would show: the newest per tag. */
function current(all) {
	const byTag = new Map();

	for (const n of all) {
		const key = n.tag || n;

		if (!byTag.has(key) || shownAt(n) >= shownAt(byTag.get(key))) {
			byTag.set(key, n);
		}
	}

	return all.filter((n) => byTag.get(n.tag || n) === n);
}

/** Under WebKit, close what a tag would have replaced and a stub whose
 * lifetime is over (see above). A close WebKit refuses (the notification is
 * under 30 s old) is simply tried again on the next run. */
async function tidy() {
	if (!strictUserVisible()) {
		return;
	}

	const now = Date.now();
	const all = (await self.registration.getNotifications()).filter(
		(n) => n.tag && n.tag.startsWith("push-")
	);
	const live = current(all);

	for (const n of all) {
		if (!live.includes(n) || (isStub(n) && now - shownAt(n) >= WEBKIT_SILENT_PUSH_TIMEOUT_MS)) {
			n.close();
		}
	}

	await updateBadge();
}

/** `tidy` once WebKit lets a close through, if the worker is still alive by
 * then (outside `waitUntil`, like the stub's own close). */
function tidyLater() {
	setTimeout(() => {
		void enqueuePush(tidy).catch(() => undefined);
	}, READ_STUB_LIFETIME_MS);
}

/** This worker's network: its scope's, or (the root worker) the first one
 * the page stashed, remembered for the push whose store has stalled. */
let knownNetwork = scopeNetwork;

async function networkOf() {
	if (!knownNetwork) {
		const stash = await getStash();
		knownNetwork = stash.networks[0] ? stash.networks[0].uuid : undefined;
	}

	return knownNetwork;
}

const IDB_NAME = "seance-push";
const IDB_STORE = "kv";

function idbOpen() {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(IDB_NAME, 1);
		req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

async function idbGet(key) {
	const db = await idbOpen();

	return new Promise((resolve, reject) => {
		const req = db.transaction(IDB_STORE).objectStore(IDB_STORE).get(key);
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

async function idbSet(key, value) {
	const db = await idbOpen();

	return new Promise((resolve, reject) => {
		const tx = db.transaction(IDB_STORE, "readwrite");
		tx.objectStore(IDB_STORE).put(value, key);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

/** Mirrors CAP in client/js/push-seen.ts: the "seen" ring's length. */
const SEEN_CAP = 200;

/** Append `value` to the list stored under `key` (newest last, capped),
 * read and written in one transaction so the page's own appends to the
 * same ring (push-seen.ts) cannot be lost. */
async function idbAppend(key, value, cap) {
	const db = await idbOpen();

	return new Promise((resolve, reject) => {
		const tx = db.transaction(IDB_STORE, "readwrite");
		const store = tx.objectStore(IDB_STORE);
		const get = store.get(key);

		get.onsuccess = () => {
			const prev = Array.isArray(get.result) ? get.result : [];

			if (prev.includes(value)) {
				resolve();
				return;
			}

			store.put([...prev, value].slice(-cap), key);
		};

		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

/** How long a throwaway connection may take to reach 001 (or finish). */
const SW_IRC_TIMEOUT_MS = 15000;

/** A throwaway connection's nick. Random on purpose: nefarious2's bouncer
 * holds a QUIT'd account session as a ghost that keeps its nick, so a fixed
 * nick collides with the ghost of the previous reply (433) — and once the
 * connection attaches to the account's session the server renames it to
 * the session's nick anyway. */
function randomNick() {
	return "seance-" + Math.random().toString(36).slice(2, 8);
}

/**
 * Open a throwaway IRC connection (SASL PLAIN) and hand the live socket to
 * `onReady(ws, done, ctx)` at 001.  `pre` lines go out after SASL completes
 * but before CAP END.  `ctx.nick` is what the server calls us after
 * registration (the account's session nick when the bouncer attached us to
 * it); `ctx.onLine(fn)` sees every later line.  `pre` may be a function of
 * `ctx`, called at 903 once the optional caps' answer is known.  Resolves
 * through done(ok): false on any SASL/registration failure, a close, or the
 * timeout.
 */
function swIrcOpen(net, pre, onReady, optional = []) {
	return new Promise((resolve) => {
		const scheme = net.tls ? "wss://" : "ws://";
		const url = scheme + net.host + ":" + net.port + "/";
		let ws = null;
		let stage = 0; // 0 LS, 1 REQ, 2 AUTHENTICATE PLAIN, 3 payload, 4 CAP END sent, 5 registered
		let nick = randomNick();
		let nickTries = 0;
		let settled = false;
		let offered = []; // CAP LS, possibly over several lines
		let asked = []; // the optional caps requested (those the server offered)
		const watchers = [];
		const ctx = {
			nick,
			/** The optional caps the server acknowledged. */
			caps: new Set(),
			/** `message-tags` negotiated: client tags (`+draft/reply`) may go out. */
			tags: false,
			onLine(fn) {
				watchers.push(fn);
			},
		};

		const timer = setTimeout(() => done(false), SW_IRC_TIMEOUT_MS);

		function done(ok) {
			if (settled) {
				return;
			}

			settled = true;
			clearTimeout(timer);

			try {
				ws.close();
			} catch (e) {
				//
			}

			resolve(ok);
		}

		try {
			ws = new WebSocket(url, "text.ircv3.net");
		} catch (e) {
			done(false);
			return;
		}

		ws.onopen = () => {
			ws.send("CAP LS 302");
			ws.send("NICK " + nick);
			ws.send("USER seance-sw 0 * :seance service worker");
		};

		ws.onmessage = (e) => {
			const l = e.data;

			if (l.startsWith("PING")) {
				ws.send("PONG " + l.slice(5));
				return;
			}

			if (stage === 5) {
				for (const fn of watchers) {
					fn(l);
				}

				return;
			}

			// Nick taken before registration (433/436/437): try another.
			if (/^\S+ 43[367] /.test(l)) {
				if (++nickTries > 3) {
					done(false);
					return;
				}

				nick = randomNick();
				ctx.nick = nick;
				ws.send("NICK " + nick);
				return;
			}

			// Each branch flips the stage BEFORE sending: a synchronously
			// scripted (or locally proxied) server re-enters this handler
			// from send() before the send returns.
			if (stage === 0 && / CAP .* LS /.test(l)) {
				// `CAP * LS * :…` continues on the next line; the last one has
				// no `*`.  Ask for the optional caps only where they are
				// offered (message-tags so a reply can answer the message it
				// was typed under, draft/read-marker for a marker).
				const list = l.slice(l.indexOf(" :", l.indexOf(" LS ")) + 2).split(" ");
				offered = offered.concat(list.map((cap) => cap.split("=")[0]));

				if (/ LS \* :/.test(l)) {
					return;
				}

				stage = 1;
				asked = optional.filter((cap) => offered.includes(cap));
				ws.send("CAP REQ :" + ["sasl"].concat(asked).join(" "));
				return;
			}

			if (stage === 1 && / CAP .* ACK /.test(l)) {
				stage = 2;
				ctx.caps = new Set(asked);
				ctx.tags = ctx.caps.has("message-tags");
				ws.send("AUTHENTICATE PLAIN");
				return;
			}

			if (stage === 1 && / CAP .* NAK /.test(l)) {
				// The optional caps were the problem, not SASL: ask for SASL alone.
				if (asked.length > 0) {
					asked = [];
					ws.send("CAP REQ :sasl");
					return;
				}

				done(false);
				return;
			}

			if (stage === 2 && /^AUTHENTICATE \+$/.test(l)) {
				stage = 3;
				ws.send("AUTHENTICATE " + btoa("\0" + net.saslAccount + "\0" + net.saslPassword));
				return;
			}

			// SASL failures: 902 and 904-908 (903 success is handled below).
			if (stage === 3 && (l.startsWith("FAIL") || / 90[245678] /.test(l))) {
				done(false);
				return;
			}

			if (stage === 3 && / 903 /.test(l)) {
				stage = 4;

				for (const line of typeof pre === "function" ? pre(ctx) : pre) {
					ws.send(line);
				}

				ws.send("CAP END");
				return;
			}

			if (stage === 4 && /^ERROR /.test(l)) {
				done(false);
				return;
			}

			if (stage === 4 && /^\S+ 001 /.test(l)) {
				stage = 5;
				// `:server 001 <nick> :Welcome…` — the bouncer may have renamed us.
				ctx.nick = l.split(" ")[2] || nick;
				onReady(ws, done, ctx);
			}
		};

		ws.onerror = () => done(false);
		ws.onclose = () => done(false);
	});
}

/** Run one batch of lines over a throwaway IRC connection: `pre` before
 * CAP END, `post` after 001.  Resolves true when both were sent. */
function swIrcAct(net, pre, post) {
	return swIrcOpen(net, pre, (ws, done) => {
		for (const line of post) {
			ws.send(line);
		}

		ws.send("QUIT :done");
		done(true);
	});
}

// --- sending a reply over a throwaway connection ---------------------------
// The reply connection logs in as the account, so nefarious2's bouncer
// attaches it to the account's session (as an alias while the app is
// connected elsewhere, resuming a held session otherwise). The session's
// channel memberships are replayed to us right AFTER 001 — a channel
// PRIVMSG fired at 001 races that replay and comes back as 404 — so a
// channel reply waits for our JOIN of the target (or the "Session resumed"
// notice that ends the replay), with a settle timer as the fallback, and a
// 404 earns one retry. A PM has no such race.

/** Mirrors REPLY_TAG in client/js/irc/wire.ts. */
const REPLY_TAG = "+draft/reply";
const REPLAY_SETTLE_MS = 1500; // channel reply: wait at most this long for the JOIN replay
const REPLY_GRACE_MS = 600; // after sending: time for the server to refuse (404) before QUIT
const REPLY_RETRY_MS = 800;
/** One PRIVMSG line stays under nefarious2's 512-byte body / 528-byte frame
 * limits; the server prepends `:nick!user@host ` on relay. */
const REPLY_CHUNK_BYTES = 380;

function isChannelName(target) {
	return /^[#&!+]/.test(target || "");
}

/** Split reply text into PRIVMSG-sized chunks at word boundaries. */
function splitReply(text) {
	const encoder = new TextEncoder();
	const chunks = [];
	let rest = text.replace(/[\r\n]+/g, " ").trim();

	while (rest.length > 0) {
		if (encoder.encode(rest).length <= REPLY_CHUNK_BYTES) {
			chunks.push(rest);
			break;
		}

		let cut = rest.length;

		while (cut > 0 && encoder.encode(rest.slice(0, cut)).length > REPLY_CHUNK_BYTES) {
			cut--;
		}

		const space = rest.lastIndexOf(" ", cut);

		if (space > cut / 2) {
			cut = space;
		}

		chunks.push(rest.slice(0, cut).trim());
		rest = rest.slice(cut).trim();
	}

	return chunks;
}

/** Our own JOIN of `target` (the bouncer's membership replay). */
function isOwnJoin(line, nick, target) {
	const m = /^(?:@\S+ )?:([^! ]+)\S* JOIN :?(\S+)/.exec(line);

	return (
		m !== null &&
		m[1].toLowerCase() === nick.toLowerCase() &&
		m[2].toLowerCase() === target.toLowerCase()
	);
}

/** A client-tag value, escaped per the message-tags spec. */
function escapeTagValue(value) {
	return String(value)
		.replace(/\\/g, "\\\\")
		.replace(/;/g, "\\:")
		.replace(/ /g, "\\s")
		.replace(/\r/g, "\\r")
		.replace(/\n/g, "\\n");
}

/** Send `text` to `target` over a throwaway connection as the account, as
 * a reply to `replyTo` (a msgid) where the server takes client tags.
 * Resolves true once every chunk went out without a 404. */
function swIrcSend(net, target, text, replyTo) {
	const chunks = splitReply(text);

	if (chunks.length === 0) {
		return Promise.resolve(false);
	}

	return swIrcOpen(
		net,
		[],
		(ws, done, ctx) => {
			const channel = isChannelName(target);
			const prefix =
				replyTo && ctx.tags ? "@" + REPLY_TAG + "=" + escapeTagValue(replyTo) + " " : "";
			let fired = false;
			let retried = false;
			let settle = null;
			let grace = null;

			const finish = (ok) => {
				clearTimeout(settle);
				clearTimeout(grace);

				try {
					ws.send("QUIT :done");
				} catch (e) {
					//
				}

				done(ok);
			};

			const fire = () => {
				if (fired) {
					return;
				}

				fired = true;
				clearTimeout(settle);

				for (const chunk of chunks) {
					ws.send(prefix + "PRIVMSG " + target + " :" + chunk);
				}

				grace = setTimeout(() => finish(true), REPLY_GRACE_MS);
			};

			ctx.onLine((l) => {
				if (!fired && channel) {
					if (isOwnJoin(l, ctx.nick, target) || / NOTICE \S+ :Session resumed/.test(l)) {
						fire();
					}

					return;
				}

				if (fired && /^\S+ 404 /.test(l)) {
					clearTimeout(grace);

					if (retried) {
						finish(false);
						return;
					}

					retried = true;
					fired = false;
					settle = setTimeout(fire, REPLY_RETRY_MS);
				}
			});

			if (channel) {
				settle = setTimeout(fire, REPLAY_SETTLE_MS);
			} else {
				fire();
			}
		},
		["message-tags"]
	);
}

// --- marking read over a throwaway connection ------------------------------
// MARKREAD wants the cap on the session and an account (m_markread.c): the
// server stores the marker, echoes it to the account's clients and relays
// it to every push subscription — that relay is what closes the
// notification on the other devices. No channel membership is involved, so
// a channel marker goes out at 001: unlike a reply, nothing here races the
// bouncer's JOIN replay.

/** Mirrors MARKREAD_CAP in client/js/irc/handlers/markread.ts. */
const READMARKER_CAP = "draft/read-marker";
const MARKREAD_GRACE_MS = 600; // after sending: time for the server to refuse before QUIT

/** Set the account's read marker for `target` at `time` (ISO 8601) over a
 * throwaway connection. Resolves true once the server echoed the marker
 * back or stayed silent past the grace period, false when it refused or
 * offers no draft/read-marker at all. */
function swMarkRead(net, target, time) {
	return swIrcOpen(
		net,
		[],
		(ws, done, ctx) => {
			let grace = null;

			const finish = (ok) => {
				clearTimeout(grace);

				try {
					ws.send("QUIT :done");
				} catch (e) {
					//
				}

				done(ok);
			};

			if (!ctx.caps.has(READMARKER_CAP)) {
				finish(false);
				return;
			}

			ctx.onLine((l) => {
				if (/^FAIL MARKREAD /.test(l) || /^\S+ 421 \S+ MARKREAD /.test(l)) {
					finish(false);
					return;
				}

				// Our own echo: `:server MARKREAD <target> timestamp=<time>`. The
				// bouncer also volunteers stored markers after its JOIN replay,
				// so only the one at our time counts.
				const parts = l.split(" ");

				if (
					parts[1] === "MARKREAD" &&
					(parts[2] || "").toLowerCase() === target.toLowerCase() &&
					parts[3] === "timestamp=" + time
				) {
					finish(true);
				}
			});

			ws.send("MARKREAD " + target + " timestamp=" + time);
			grace = setTimeout(() => finish(true), MARKREAD_GRACE_MS);
		},
		[READMARKER_CAP]
	);
}

// --- the away state of a closed page ---------------------------------------
// A page that unloads cannot tell a reload from a close, and the `AWAY *` it
// would send then makes a present user blink away and back to everyone on
// every reload. So a page on Auto whose session nefarious2's bouncer holds
// hands its networks here instead (client/js/foreground.ts, presence.ts
// `leavesAwayToWorker`): after a few seconds, if no window of the app is
// open (a reload's new document is one at once), log in as the account and
// say `AWAY *` to the held session — before CAP END for the alias path, and
// again after 001, since resuming a held session as its primary connection
// drops the pre-registration one — then QUIT, which the bouncer holds.

const AWAY_ON_CLOSE_DELAY_MS = 5000;
/** After the post-001 AWAY: how long to wait for its 306 before QUIT. */
const AWAY_REPLY_MS = 2000;
/** Mirrors PRE_AWAY_CAP in client/js/irc/presence.ts. */
const PRE_AWAY_CAP = "draft/pre-away";

/** Windows of this app: `includeUncontrolled` reports every window on the
 * origin, and a github.io origin holds other projects' pages too. */
async function appWindows() {
	const all = await self.clients.matchAll({type: "window", includeUncontrolled: true});
	return all.filter((c) => typeof c.url === "string" && c.url.startsWith(appUrl));
}

/**
 * The one pending run: a close, a reopen and a close again inside the delay
 * restart its timer instead of logging in twice. A close that arrives while
 * the run is logging in (SASL, then up to AWAY_REPLY_MS) is queued for one
 * more run after it, and the run's promise waits for that one too.
 */
let closeRun = null;

function awayOnClose(uuids) {
	if (closeRun && closeRun.running) {
		for (const uuid of uuids) {
			closeRun.queued.add(uuid);
		}

		return closeRun.promise;
	}

	if (closeRun) {
		for (const uuid of uuids) {
			closeRun.networks.add(uuid);
		}

		clearTimeout(closeRun.timer);
		closeRun.timer = setTimeout(closeRun.fire, AWAY_ON_CLOSE_DELAY_MS);
		return closeRun.promise;
	}

	const run = {
		networks: new Set(uuids),
		queued: new Set(),
		running: false,
		timer: null,
		fire: null,
		promise: null,
	};
	run.promise = new Promise((resolve) => {
		run.fire = () => {
			run.running = true;
			awayOnCloseNow([...run.networks])
				.catch(() => undefined)
				.finally(() => {
					closeRun = null;
					// Resolving with the next run's promise waits for it too.
					resolve(run.queued.size > 0 ? awayOnClose([...run.queued]) : undefined);
				});
		};

		run.timer = setTimeout(run.fire, AWAY_ON_CLOSE_DELAY_MS);
	});
	closeRun = run;
	return run.promise;
}

async function awayOnCloseNow(uuids) {
	const windows = await appWindows();

	if (windows.length > 0) {
		return; // a reload, or the app was opened again: that page speaks for itself
	}

	const stash = await getStash();

	for (const uuid of uuids) {
		// By uuid only: stashNetwork's fallback to the first network would
		// mark another network away.
		const net = stash.networks.find((n) => n && n.uuid === uuid);

		if (canLogin(net)) {
			await swAway(net);
		}
	}
}

/** `AWAY *` over a throwaway connection; resolves true once it was sent. */
function swAway(net) {
	return swIrcOpen(
		net,
		(ctx) => (ctx.caps.has(PRE_AWAY_CAP) ? ["AWAY *"] : []),
		(ws, done, ctx) => {
			let finished = false;
			let timer = null;

			const finish = () => {
				if (finished) {
					return;
				}

				finished = true;
				clearTimeout(timer);

				try {
					ws.send("QUIT :done");
				} catch (e) {
					//
				}

				done(true);
			};

			// Armed first: a server that answers inside send() finishes at once.
			timer = setTimeout(finish, AWAY_REPLY_MS);

			ctx.onLine((l) => {
				if (/^(@\S+ )?:\S+ 306 /.test(l)) {
					finish();
				}
			});

			ws.send("AWAY *");
		},
		[PRE_AWAY_CAP]
	);
}

/** The stash the page writes when push is enabled: our VAPID key and the
 * networks that are push-capable AND remember their SASL password. */
async function getStash() {
	const stash = (await idbGet("stash")) || {};

	return {
		vapid: stash.vapid || null,
		networks: Array.isArray(stash.networks) ? stash.networks : [],
	};
}

/** Total unread across push notifications -> app badge. Notifications live
 * on the registration that showed them and the badge is one per origin, so
 * each worker files its own count under its scope in one IndexedDB document
 * (`badge`) and the badge shows the sum; the page resets the document when
 * the app opens. */
async function updateBadge() {
	// Under WebKit an older copy under the same tag is still listed until
	// `tidy` closes it: only the newest counts.
	const all = current(await self.registration.getNotifications());
	// A read stub or a quiet show (showStub) says nothing is unread.
	const mine = all.reduce((sum, n) => sum + (isStub(n) ? 0 : (n.data && n.data.count) || 1), 0);
	let total = mine;

	try {
		const doc = (await idbGet("badge")) || {};

		doc[shellUrl] = mine;
		await idbSet("badge", doc);
		total = Object.values(doc).reduce((sum, n) => sum + (Number(n) || 0), 0);
	} catch (e) {
		// IndexedDB unavailable: this worker's own count is the best there is
	}

	if (total > 0 && self.navigator.setAppBadge) {
		self.navigator.setAppBadge(total);
	} else if (self.navigator.clearAppBadge) {
		self.navigator.clearAppBadge();
	}
}

self.addEventListener("push", function (event) {
	const raw = event.data ? event.data.text() : "";

	event.waitUntil(handlePush(raw));
});

/** The generic notification: what a push shows when nothing better can be
 * made of it, and what a strict push event shows when its handler has not
 * shown anything in time. */
function showGeneric(tag = "push-activity", target = undefined) {
	return showSafely(appName, {
		tag,
		icon: "img/icon-192.png",
		body: t("sw.newActivity"),
		data: target ? {kind: "generic", target} : undefined,
	});
}

// The lines of a multiline message reach the worker together (FCM hands
// them over at once) and a service worker runs push handlers concurrently.
// Each handler reads the notification's stored message list, awaits a few
// IndexedDB reads, then writes the list back — so two in flight would lose
// each other's line, leaving `…` placeholders. Pushes are therefore handled
// one at a time, in arrival order; a failed one never blocks the next.
let pushChain = Promise.resolve();
/** The strict push the queue is running (handlePush): showSafely marks it
 * shown, so its deadline knows it has answered WebKit. */
let activePush = null;

function handlePush(raw) {
	if (!strictUserVisible()) {
		return enqueuePush(() => handlePushNow(raw));
	}

	// WebKit's clock runs from the moment the push was handed over, so the
	// deadline is timed from here, ahead of the queue — a push waiting
	// behind a stalled one is just as silent. Each push has its own: one
	// push's show does not answer for another's.
	const state = {settled: false, shown: false, fellBack: false};
	let deadline = null;
	const run = enqueuePush(async () => {
		activePush = state;

		try {
			return await handlePushNow(raw, state);
		} finally {
			activePush = null;
			await tidy().catch(() => undefined);
		}
	}).finally(() => {
		state.settled = true;
		clearTimeout(deadline);
	});

	// Only a push that has shown nothing yet: one stuck after its show (on
	// the badge's store, say) has answered WebKit already.
	deadline = setTimeout(() => {
		if (!state.settled && !state.shown) {
			state.fellBack = true;
			void showFallback(raw);
		}
	}, STRICT_SHOW_DEADLINE_MS);

	return run;
}

/** A push's payload as text, without the trailing padding delimiter some
 * browsers leave (see handlePushNow). */
function cleanPayload(raw) {
	return raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]+$/, "");
}

/** What a push is about, read without IndexedDB: its conversation and
 * whether it is a read relay (the stalled-push fallback, below). */
function pushTarget(raw) {
	const clean = cleanPayload(raw);
	let json = null;

	try {
		json = JSON.parse(clean);
	} catch (e) {
		// the raw IRC line
	}

	if (json && json.t === "read") {
		return {target: json.target, read: true};
	}

	const parsed = json ? fromJson(json) : push().parsePushLine(clean);

	if (!parsed) {
		return {target: undefined, read: false};
	}

	if (parsed.command === "MARKREAD") {
		return {target: parsed.target, read: true};
	}

	if (parsed.command === "PRIVMSG" || parsed.command === "NOTICE") {
		return {target: conversationOf(parsed), read: false};
	}

	return {target: undefined, read: false};
}

/** The conversation a message belongs to: its channel, or the sender's query. */
function conversationOf(parsed) {
	return isChannelName(parsed.target) ? parsed.target : parsed.nick;
}

/**
 * A strict push whose handler has not finished by the deadline (the store
 * stalled): show something now, silently, under a tag of its own
 * (`push-<network>/fallback/<conversation>`) — never the conversation's, so
 * it cannot overwrite the real notification should that land meanwhile.
 * The real notification, or the quiet stub of a push that should not alert,
 * closes it once it is shown (closeFallbacks); a read relay's is a stub that
 * closes itself. A store that never answers leaves the silent "New activity".
 */
async function showFallback(raw) {
	let about = {target: undefined, read: false};

	try {
		about = pushTarget(raw);
	} catch (e) {
		// shown as the generic notification
	}

	const tag = tagFor(knownNetwork, "fallback/" + foldName(about.target || "activity"));

	if (about.read) {
		await showStub(tag, "read", about.target, knownNetwork, true);
		return;
	}

	await showSafely(appName, {
		tag,
		silent: true,
		icon: "img/icon-192.png",
		body: t("sw.newActivity"),
		data: {kind: "generic", target: about.target, fallback: true},
	});
}

/** A page's message (see the "message" listener), in the same queue as the
 * pushes: it merges into the same notifications they do. */
function handlePageMessage(payload) {
	return enqueuePush(() => handlePageMessageNow(payload));
}

function enqueuePush(task) {
	const run = pushChain.then(task);

	pushChain = run.catch(() => undefined);

	return run;
}

// --- the push module ---------------------------------------------------------
// Parsing, stripping and the merged body live in client/js/push/* (mocha-
// tested) and reach the worker as `self.seancePush` (js/push.js, imported
// at the top). The fallback below is what the worker can still do when
// that chunk did not load: parse the line and strip IRC control bytes.

// Mirrors MERGE_KEEP in client/js/push/merge.ts; must stay equal.
const MERGE_KEEP_FALLBACK = 4;

function push() {
	if (self.seancePush) {
		return self.seancePush;
	}

	return {
		parsePushLine,
		lineIndexOf: () => null,
		CONCAT_TAG: "draft/multiline-concat",
		stripFormatting: stripFormattingInline,
		notificationText: (text) =>
			stripFormattingInline(text.replace(/\x01ACTION /, "*").replace(/\x01$/, "*")),
		addMessage: (entries, incoming, keep = MERGE_KEEP_FALLBACK) =>
			incoming.msgid && entries.some((m) => m.msgid === incoming.msgid)
				? {entries: entries.slice(-keep), isNew: false}
				: {
						entries: [
							...entries,
							{from: incoming.from, text: incoming.text, msgid: incoming.msgid},
						].slice(-keep),
						isNew: true,
				  },
		renderMergedBody: (entries, isChannel, render = (t) => t) =>
			entries
				.map((m) => (isChannel && m.from ? m.from + ": " + render(m.text) : render(m.text)))
				.join("\n"),
		MERGE_KEEP: MERGE_KEEP_FALLBACK,
	};
}

// --- the worker's own copy ----------------------------------------------------
// The strings the worker itself composes — notification actions, the title
// fragments, the fallback activity body — resolve through the same i18n
// catalog the app uses: the push module installs applyLocale/t/interpolate
// (client/js/push/i18n.ts), and handlePushNow applies the prefs' locale per
// push, before composing anything. t() below prefers that surface; the
// literals here are what it falls back to when js/push.js did not load and
// no catalog exists anywhere. They must stay equal to the pot's sw.* msgids
// (client/locales/messages.pot) — pinned by test/tests/service-worker.ts
// against the compiled en.json.

const SW_COPY_FALLBACK = {
	"sw.markRead": "Mark read",
	"sw.reply": "Reply",
	"sw.replyPlaceholder": "Reply…",
	"sw.newActivity": "New activity while you were away.",
	"sw.markedRead": "Marked as read",
	"sw.newMessage": "New message",
	"sw.titleChannel": "{nick} in {target}",
	"sw.titleChannelCount": "{nick} in {target} ({count})",
	"sw.titleNickCount": "{nick} ({count})",
};

/** {name} interpolation over the fallback copy (core.ts's interpolate). */
function swInterpolate(template, vars) {
	return template.replace(/\{(\w+)\}/g, (match, name) =>
		vars && Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
	);
}

/** A label the worker itself composes: the push module's catalog when its
 * chunk loaded, the English literals above when it did not. Call sites are
 * written t("key") so tools/i18n/check.ts's call-site scan sees them. */
function t(key, vars) {
	const pushModule = self.seancePush;

	if (pushModule && typeof pushModule.t === "function") {
		return pushModule.t(key, vars);
	}

	return swInterpolate(SW_COPY_FALLBACK[key] || key, vars || {});
}

/** shared/irc.ts's matchFormatting, inline for the fallback. */
function stripFormattingInline(text) {
	return text
		.replace(
			/\x02|\x1D|\x1F|\x16|\x0F|\x11|\x1E|\x03(?:[0-9]{1,2}(?:,[0-9]{1,2})?)?|\x04(?:[0-9a-f]{6}(?:,[0-9a-f]{6})?)?/gi,
			""
		)
		.trim();
}

/** A JSON-tier payload in the shape parsePushLine returns. */
function fromJson(json) {
	if (json.t !== "msg" && json.t !== "notice" && json.t !== "hl") {
		return null;
	}

	return {
		tags: {
			msgid: typeof json.msgid === "string" ? json.msgid : undefined,
			time: typeof json.time === "string" ? json.time : undefined,
		},
		nick: json.from,
		command: json.t === "notice" ? "NOTICE" : "PRIVMSG",
		target: json.target,
		text: typeof json.text === "string" ? json.text : t("sw.newMessage"),
	};
}

async function handlePushNow(raw, state = {fellBack: false}) {
	let json = null;

	// RFC 8188 says the decrypter strips the aes128gcm padding delimiter
	// (a trailing 0x02) before the payload reaches the SW; if a browser
	// ever delivers it unstripped, JSON.parse would throw and the push
	// would degrade to the generic fallback. Trim trailing control bytes
	// before parsing so the payload is always clean.
	const clean = cleanPayload(raw);
	// Under WebKit this event must end in a showNotification (above): the
	// seen ring is not consulted and a read relay leaves a stub.
	const strict = strictUserVisible();

	// Everything below reads IndexedDB (idbGet, getStash) and the
	// Notifications API — a rejection there (private mode, IndexedDB
	// blocked) must still surface something rather than leave Chrome's
	// generic "site updated in the background" as the only sign of a push.
	try {
		try {
			json = JSON.parse(clean);
		} catch (e) {
			// not JSON — the spec-shaped raw IRC line
		}

		// Another device read a channel (JSON opt-down tier): close what we show for it.
		if (json && json.t === "read") {
			await readRelay(json.target, json.ts, strict);
			return;
		}

		const P = push();

		// The page mirrors the reader's preferences here (client/js/
		// push-prefs.ts): whether Markdown renders, and the UI language tag
		// the worker's own copy resolves through. Applied here, per push and
		// before anything reader-visible is composed — the locale can change
		// between pushes and no page may be open to apply it for us. A stale
		// js/push.js (a mid-deploy worker) carries no surface: t() falls
		// back to the English literals instead. The catalog the installs
		// land in is one shared module state: a second push (or this
		// handler's own catch, below) applying a locale while an earlier
		// push is still composing wins last-writer-wins, so notifications
		// from one flurry can mix locales. Tolerated — one reader, and the
		// next push re-applies the prefs' choice.
		const prefs = (await idbGet("prefs")) || {};

		if (typeof P.applyLocale === "function") {
			await P.applyLocale(appUrl, prefs.locale);
		}

		const parsed = json ? fromJson(json) : P.parsePushLine(clean);

		// The same relay as a MARKREAD line (the full tier).
		if (parsed && parsed.command === "MARKREAD") {
			await readRelay(parsed.target, parsed.timestamp, strict);
			return;
		}

		if (parsed && (parsed.command === "PRIVMSG" || parsed.command === "NOTICE")) {
			await showMessage(P, parsed, true, strict);
			return;
		}

		// userVisibleOnly means every push should surface something.
		await showGeneric();
		await updateBadge();
	} catch (e) {
		// Whatever failed above, the prefs' locale may or may not have been
		// applied — a push that dies before it leaves a locale a previous
		// push installed, which must not leak into the fallback copy.
		// Resolve from the default instead.
		const surface = push();

		if (typeof surface.applyLocale === "function") {
			await surface.applyLocale(appUrl, undefined);
		}

		// The deadline's fallback already stands for this push: a second
		// generic would be a second alert for it.
		if (!state.fellBack) {
			await showGeneric();
		}

		await updateBadge().catch(() => undefined);
	}
}

/** A read relay (`:server MARKREAD target timestamp=…`, or the JSON tier's
 * `t:"read"`): close what this worker shows for the target up to the
 * marker. Under WebKit (`strict`) that alone is a silent push, so a silent
 * "Marked as read" stub takes the place of the target's notification (its
 * tag, found by name whatever the relay's spelling, so a close WebKit
 * refused within 30 s is replaced as well). A notification the marker
 * leaves standing (it postdates the marker) keeps its place and the stub
 * goes beside it, under a tag of its own the conversation's next message
 * closes. The worker closes a stub once WebKit lets it
 * (READ_STUB_LIFETIME_MS); one killed before then leaves it to the next
 * message or the page's app-opened sweep. Not inside `waitUntil`: the event
 * must not outlive WebKit's handler lifetime. */
async function readRelay(target, ts, strict) {
	await closeForTarget(target, ts);

	if (strict) {
		await showReadStub(target, ts);
	}

	await updateBadge();
}

async function showReadStub(target, ts) {
	const cutoff = ts ? Date.parse(ts) : Infinity;
	const network = await networkOf();
	const all = await self.registration.getNotifications();
	const shown = all.filter(
		(n) =>
			n.tag &&
			n.tag.startsWith("push-") &&
			!isStub(n) &&
			n.data &&
			sameName(n.data.target, target)
	);
	const kept = shown.some((n) => n.data.time && Date.parse(n.data.time) > cutoff);
	const tag = kept
		? tagFor(network, "read/" + foldName(target || ""))
		: shown.length
		? newest(shown).tag
		: tagFor(network, target || "read");

	await showStub(tag, "read", target, network);
}

/** A silent notification that says nothing is unread and carries no message
 * text — "Marked as read" (a read relay) or "New message" (a push shown only
 * because WebKit must see one) — closed once WebKit lets it. Its title names
 * no conversation: it sits on a lock screen. A tap still opens the
 * conversation (`data`, routeFor). */
async function showStub(tag, kind, target, network, fallback = false) {
	await showSafely(appName, {
		tag,
		silent: true,
		icon: "img/icon-192.png",
		body: kind === "read" ? t("sw.markedRead") : t("sw.newMessage"),
		data: {kind, target, network: network || undefined, fallback: fallback || undefined},
	});

	setTimeout(() => {
		void closeStub(tag);
	}, READ_STUB_LIFETIME_MS);
	tidyLater();
}

async function closeStub(tag) {
	try {
		for (const n of await self.registration.getNotifications({tag})) {
			if (isStub(n)) {
				n.close();
			}
		}

		await updateBadge();
	} catch (e) {
		// the next message on the target, or the page's sweep, takes it
	}
}

/** Show a notification again exactly as it stands, silently: what WebKit
 * needs to see, without a second alert for something already on screen. */
function reshowQuietly(n) {
	return showSafely(n.title, {
		tag: n.tag,
		silent: true,
		renotify: false,
		icon: "img/icon-192.png",
		body: n.body,
		data: n.data,
		actions: n.actions,
	});
}

/** Show (or merge) one message's notification: a pushed PRIVMSG/NOTICE, or
 * a page's message (`checkSeen` false — the page recorded it as seen
 * itself, and is asking for it to be shown). `mustShow` (a push under
 * WebKit, above) shows the notification even when the message adds nothing
 * to it: same tag, same count, so a redelivery or a message the page took
 * first is one notification, re-shown, and never a silent push. `silent`
 * (the page's own alert, with its sound setting off) shows it without one. */
async function showMessage(P, parsed, checkSeen, mustShow = false, silent = false) {
	const msgid = typeof parsed.tags.msgid === "string" ? parsed.tags.msgid : undefined;

	const line = P.lineIndexOf(parsed.tags);

	// A multiline message is one push per line: `batch=<base msgid>` on
	// every line is what the lines share, while the msgid itself rides
	// the first line only (draft/multiline's fallback form).
	const batch = line
		? typeof parsed.tags.batch === "string"
			? parsed.tags.batch
			: msgid
		: undefined;

	// Dedup against the "seen" ring (client/js/push-seen.ts): what this
	// device has already surfaced. The live page records every pushable
	// message it received over its own WebSocket — it owns that
	// notification, and the server pushes to attached-but-idle sessions
	// too (FEAT_WEBPUSH_IDLE), so without this every highlight would
	// notify twice; a frozen page writes nothing, which is exactly when
	// the push must show. This worker records what it showed (below), so
	// the same push delivered again — push services promise at least
	// once, and a notification the user already answered has no data
	// left to merge into — shows nothing. A batch's reference is the
	// msgid the page recorded from the BATCH opener, so the page blocks
	// every line by it though only the first carries a msgid; the worker
	// remembers lines one by one (`<batch>#<index>`) so the rest of a
	// batch still lands.
	const seenId = batch || msgid;
	const seenKey = line ? seenId + "#" + line.index : msgid;

	const isChannel = isChannelName(parsed.target);
	const replyTo = conversationOf(parsed);
	// The payload names no network: a push-only worker serves exactly
	// one (its scope says which); the root worker, which only ever
	// held the pre-per-network subscription, falls back to the first
	// stashed network.
	const network = await networkOf();
	const tag = tagFor(network, replyTo || "activity");

	// The page mirrors the reader's markdown setting and its muted
	// conversations here (client/js/push-prefs.ts); absent means the app
	// default (markdown on, nothing muted).
	const prefs = (await idbGet("prefs")) || {};
	const markdown = prefs.markdown !== false;
	const muteKey = typeof replyTo === "string" ? foldName(network + "/" + replyTo) : undefined;
	const muted =
		Array.isArray(prefs.muted) &&
		muteKey !== undefined &&
		prefs.muted.some((key) => typeof key === "string" && foldName(key) === muteKey);

	if (checkSeen && seenId) {
		const seen = await idbGet("seen");

		if (
			Array.isArray(seen) &&
			((msgid && seen.includes(msgid)) || seen.includes(seenId) || seen.includes(seenKey))
		) {
			// Under WebKit even this must show: quietly, never a second alert
			// (the page took it, or the user already dismissed it).
			if (mustShow) {
				await showQuiet(tag, replyTo, network);
			}

			return;
		}
	}

	// A conversation muted on this device alerts nothing, here as on the
	// page; a push still shows (WebKit counts one that does not), quietly
	// and without its text. The page never hands a muted message over.
	if (muted) {
		await showQuiet(tag, replyTo, network);
		return;
	}

	// Merge per target: the message list rides on the notification's
	// data so it survives the worker being killed between pushes, and
	// a multiline message grows in place, one line per push.
	const existing = await self.registration.getNotifications({tag});
	// An older worker showed it under the tag without the network: carry
	// its messages and count over, and close it once this one is up.
	const legacyTag = "push-" + (replyTo || "activity");
	const legacy =
		legacyTag === tag ? [] : await self.registration.getNotifications({tag: legacyTag});
	// Under WebKit the older copies under a tag are still listed: merge into
	// the newest.
	const prevShown = newest(existing) || newest(legacy);
	const prev = prevShown && prevShown.data;
	const added = P.addMessage(
		(prev && prev.messages) || [],
		{
			from: parsed.nick,
			text: parsed.text,
			msgid,
			batch: batch || undefined,
			line: line || undefined,
			concat: parsed.tags[P.CONCAT_TAG] === true,
		},
		P.MERGE_KEEP
	);

	// The ring lost this msgid but the notification still holds it: a
	// plain message pushed again adds nothing, so show nothing again —
	// except where showing nothing is what loses the subscription.
	if (!added.isNew && !line && !mustShow) {
		return;
	}

	const count = ((prev && prev.count) || 0) + (added.isNew ? 1 : 0);
	const body = P.renderMergedBody(added.entries, isChannel, (text) =>
		P.notificationText(text, {markdown})
	);

	// Titles resolve as whole sentences — the unread count is inside
	// the phrase, never glued on: a translation is free to reorder
	// (or drop) the count. The worker has no plural rules, so the
	// count > 1 shape is its own key; a query title below two
	// messages is the nick alone: nothing to translate.
	const title = isChannel
		? count > 1
			? t("sw.titleChannelCount", {
					nick: parsed.nick,
					target: parsed.target,
					count,
			  })
			: t("sw.titleChannel", {nick: parsed.nick, target: parsed.target})
		: count > 1
		? t("sw.titleNickCount", {nick: parsed.nick, count})
		: parsed.nick;

	// Inline reply renders as a text field where the browser supports
	// it (desktop Chrome) and degrades to a button that deep-links the
	// chat where it does not — the click handler falls back to openApp
	// when no reply text arrives.  showSafely guards the whole call if
	// a browser rejects the actions outright.  Reply goes last, on the
	// right: that is where a thumb lands on a phone held in one hand.
	// Mark read is "seen, no answer needed": the account's read marker
	// at this notification's newest message, on every device.
	const actions = [
		{action: "markread", title: t("sw.markRead")},
		{
			action: "reply",
			type: "text",
			title: t("sw.reply"),
			placeholder: t("sw.replyPlaceholder"),
		},
	];

	const time = typeof parsed.tags.time === "string" ? parsed.tags.time : undefined;

	await showSafely(title, {
		tag,
		renotify: added.isNew,
		silent,
		icon: "img/icon-192.png",
		body,
		timestamp: time ? Date.parse(time) : undefined,
		data: {
			kind: "push",
			count,
			from: parsed.nick,
			target: replyTo,
			network,
			time,
			messages: added.entries,
		},
		actions,
	});

	// Under WebKit the copy merged from is still up beside this one.
	if (prevShown && strictUserVisible()) {
		tidyLater();
	}

	if (seenId) {
		await idbAppend("seen", seenKey, SEEN_CAP);
	}

	// Shown by an older worker, before tags carried the network: merged in
	// above, and gone now.
	for (const n of legacy) {
		n.close();
	}

	await closeFallbacks(tag, replyTo);
	await updateBadge();
}

/**
 * The conversation's notification is up under `tag`: a stub for it under a
 * tag of its own (a read relay that kept a newer notification) or a stalled
 * push's fallback has had its say. WebKit refuses a close within 30 s of the
 * show, so it is tried again once that has passed — outside `waitUntil`,
 * like a stub's own close: a worker stopped before then leaves it to the
 * next message or the app-opened sweep.
 */
async function closeFallbacks(tag, target) {
	for (const n of await self.registration.getNotifications()) {
		if (
			(isStub(n) || (n.data && n.data.kind === "generic")) &&
			n.tag !== tag &&
			sameName(n.data.target, target)
		) {
			n.close();
			setTimeout(() => n.close(), READ_STUB_LIFETIME_MS);
		}
	}
}

/** A push WebKit must see shown but that should not alert (see showMessage):
 * the conversation's notification again, silently and unchanged, or — with
 * nothing up for it — a silent stub with no message text. */
async function showQuiet(tag, target, network) {
	const up = newest(await self.registration.getNotifications({tag}));

	if (up && !isStub(up)) {
		await reshowQuietly(up);
	} else {
		await showStub(tag, "quiet", target, network);
	}

	await closeFallbacks(tag, target);
	await updateBadge();
}

/** The page's message as a parsed push line, shown by showMessage. */
async function handlePageMessageNow(payload) {
	const m = payload.message;

	if (typeof m.from !== "string" || typeof payload.target !== "string") {
		return;
	}

	// The reader's language, as handlePushNow applies it for a push.
	const P = push();
	const prefs = (await idbGet("prefs")) || {};

	if (typeof P.applyLocale === "function") {
		await P.applyLocale(appUrl, prefs.locale);
	}

	await showMessage(
		P,
		{
			tags: {
				msgid: typeof m.msgid === "string" ? m.msgid : undefined,
				time: typeof m.time === "string" ? m.time : undefined,
			},
			nick: m.from,
			command: m.notice ? "NOTICE" : "PRIVMSG",
			target: payload.target,
			text: typeof m.text === "string" ? m.text : "",
		},
		false,
		false,
		payload.silent === true
	);
}

/** showNotification that cannot silently fail: if Chrome rejects any
 * option (an unsupported action, a bad icon), retry with the body only,
 * then bare.  A delivered push that renders nothing is the worst outcome
 * there is, so every path here ends in a visible notification. */
async function showSafely(title, options) {
	// A fallback runs beside the queue, for another push than the one in it.
	if (activePush && !(options.data && options.data.fallback)) {
		activePush.shown = true;
	}

	// Which copy under a tag is the newest (WebKit keeps them all; `tidy`).
	options = {...options, data: {...(options.data || {}), shownAt: Date.now()}};

	try {
		await self.registration.showNotification(title, options);
		return;
	} catch (e) {
		// fall through to the reduced forms
	}

	try {
		await self.registration.showNotification(title, {
			tag: options.tag,
			body: options.body,
			silent: options.silent === true,
			data: {shownAt: options.data.shownAt},
		});
		return;
	} catch (e) {
		// fall through to the bare form
	}

	try {
		await self.registration.showNotification(title, {});
	} catch (e) {
		// nothing else to try
	}
}

/** rfc1459 case folding, ASCII only — client/js/irc/casemap.ts `casefold`,
 * which the worker cannot import. */
function foldName(name) {
	return name.replace(/[A-Z[\\\]~]/g, (c) =>
		c === "~" ? "^" : String.fromCharCode(c.charCodeAt(0) + 0x20)
	);
}

/** Whether two channel names or nicks are the same one: IRC compares them
 * case-insensitively, and a read (the page's open conversation, a read
 * relay) need not spell the target as the notification it closes does. */
function sameName(a, b) {
	return typeof a === "string" && typeof b === "string" && foldName(a) === foldName(b);
}

/** Close push notifications for `target` whose message predates `ts`. */
async function closeForTarget(target, ts) {
	const cutoff = ts ? Date.parse(ts) : Infinity;
	const all = await self.registration.getNotifications();

	for (const n of all) {
		if (!n.tag || !n.tag.startsWith("push-")) {
			continue;
		}

		const sameTarget = n.data && sameName(n.data.target, target);
		const mine = !target && n.tag.startsWith("push-");

		if (
			(sameTarget || (mine && !target)) &&
			(!cutoff || !n.data.time || Date.parse(n.data.time) <= cutoff)
		) {
			n.close();
		}
	}
}

/** Fallback line parser (no tag unescaping) for when js/push.js did not load. */
function parsePushLine(line) {
	let rest = line;
	const tags = {};

	if (rest.startsWith("@")) {
		const space = rest.indexOf(" ");

		if (space === -1) {
			return null;
		}

		for (const pair of rest.slice(1, space).split(";")) {
			const eq = pair.indexOf("=");

			if (eq !== -1) {
				tags[pair.slice(0, eq)] = pair.slice(eq + 1);
			}
		}

		rest = rest.slice(space + 1);
	}

	if (!rest.startsWith(":")) {
		return null;
	}

	const first = rest.indexOf(" ");
	const nick = rest.slice(1, first).split("!")[0];
	const tail = rest.slice(first + 1);
	const second = tail.indexOf(" ");
	const command = (second === -1 ? tail : tail.slice(0, second)).toUpperCase();
	const params = second === -1 ? "" : tail.slice(second + 1);
	const colon = params.indexOf(" :");
	const target = (colon === -1 ? params : params.slice(0, colon)).split(" ")[0];
	const text = colon === -1 ? "" : params.slice(colon + 2);

	return {tags, nick, command, target, text};
}

// Renewal: the browser tells us the subscription died (or rotated). Re-create
// it with the stashed VAPID key and re-register over a throwaway IRC
// connection; when credentials are not stashed, ask any open page to redo it
// from the UI instead.
self.addEventListener("pushsubscriptionchange", function (event) {
	event.waitUntil(handleResubscribe(event.oldSubscription, event.newSubscription));
});

async function handleResubscribe(oldSub, newSub) {
	const stash = await getStash();
	// This worker's network (by scope) and the key its subscription was made
	// against; the root worker has only the stash-wide key.
	const net = stashNetwork(stash, scopeNetwork);
	const vapid = (net && net.vapid) || stash.vapid;
	const sub = newSub || (vapid ? await resubscribeWithVapid(vapid) : null);

	if (!sub) {
		// No usable subscription: ask the page (next open) to redo it, for
		// this network.
		const cs = await self.clients.matchAll({includeUncontrolled: true, type: "window"});

		for (const c of cs) {
			c.postMessage({type: "resubscribe", network: scopeNetwork});
		}

		return;
	}

	// A push-only worker re-registers with its own network only; the root
	// worker with every stashed one, as before.
	const networks = (pushOnly ? (net ? [net] : []) : stash.networks).filter(canLogin);

	if (networks.length === 0) {
		return;
	}

	// Drop the endpoint that just rotated away, or the account keeps two
	// registrations for this one device and every push arrives twice.
	const post = [];
	const oldEndpoint = oldSub && oldSub.endpoint;

	if (oldEndpoint && oldEndpoint !== sub.endpoint) {
		post.push("WEBPUSH UNREGISTER " + oldEndpoint);
	}

	post.push(
		"WEBPUSH REGISTER " + sub.endpoint + " p256dh=" + sub.keys.p256dh + ";auth=" + sub.keys.auth
	);

	// After 001: nefarious2 silently drops a WEBPUSH REGISTER sent between
	// SASL and CAP END (docs/projects/push-subscription.md).
	await swIrcAct(networks[0], [], post);
}

async function resubscribeWithVapid(vapid) {
	const reg = self.registration;

	try {
		const key = Uint8Array.from(atob(vapidB64ToStd(vapid)), (c) => c.charCodeAt(0));

		return await reg.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: key.buffer,
		});
	} catch (e) {
		return null;
	}
}

function vapidB64ToStd(b64) {
	const padding = "=".repeat((4 - (b64.length % 4)) % 4);

	return (b64 + padding).replace(/-/g, "+").replace(/_/g, "/");
}

/** The stashed network a notification belongs to: by uuid when the
 * notification names one, else this worker's own network (push-only), else
 * the first (the root worker, single-network deploys). */
function stashNetwork(stash, uuid) {
	const want = uuid || scopeNetwork;
	const found = stash.networks.find((n) => want && n.uuid === want);

	if (found) {
		return found;
	}

	return pushOnly ? null : stash.networks[0] || null;
}

/** Whether a stashed network can log in on its own (the user remembered
 * the password; the page never stashes one otherwise). */
function canLogin(net) {
	return Boolean(net && net.saslAccount && net.saslPassword);
}

// --- replying and marking read from the notification -----------------------
// A typed reply must never be lost. Three ways to send it, tried in order:
//   1. a live page (any window of the app, even a background one) sends it
//      over its own connection and acks through a MessageChannel — the
//      common case when the app is merely backgrounded;
//   2. the worker's own throwaway connection, when the password is stashed;
//   3. the outbox: the reply is queued in IndexedDB and the app is opened on
//      the conversation; the page sends the queue once that network is up.
// A read marker takes the same three roads; only the last one differs — a
// marker is nothing to type, so the outbox alone does, and the app stays
// closed.

const PAGE_REPLY_TIMEOUT_MS = 2500; // a frozen page never answers
const OUTBOX_KEY = "outbox";
const OUTBOX_CAP = 20;

/** Ask one page to send `message` (a `reply` or a `markread`, see
 * bus-contract §2.2): true on its ack, false when it says it cannot or
 * stays silent past the deadline (a frozen page). The deadline travels
 * with the message: a page that only wakes up after it must not send,
 * because by then the message went out another way. */
function askPage(client, message) {
	return new Promise((resolve) => {
		const deadline = Date.now() + PAGE_REPLY_TIMEOUT_MS;
		const channel = new MessageChannel();
		let settled = false;
		let timer = null;

		const finish = (ok) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				channel.port1.close();
				resolve(ok);
			}
		};

		timer = setTimeout(() => finish(false), PAGE_REPLY_TIMEOUT_MS);

		channel.port1.onmessage = (ev) => finish(Boolean(ev.data && ev.data.ok));

		try {
			client.postMessage({...message, deadline}, [channel.port2]);
		} catch (e) {
			finish(false);
		}
	});
}

/** Ask the open pages to send `message`, one at a time — the visible one
 * first — until one does. Asking them all at once would post a reply
 * once per window. Resolves true when a page sent it. */
async function viaPage(message) {
	// Only this app's windows answer; another project's on the origin
	// would only cost its timeout.
	const cs = await appWindows();

	if (cs.length === 0 || typeof MessageChannel !== "function") {
		return false;
	}

	const first = findSuitableClient(cs);
	const order = [first, ...cs.filter((c) => c !== first)];

	for (const c of order) {
		if (await askPage(c, message)) {
			return true;
		}
	}

	return false;
}

/** Queue a reply or a marker for the page to send when its network is
 * next connected. */
async function enqueueOutbox(entry) {
	const prev = await idbGet(OUTBOX_KEY);
	const outbox = Array.isArray(prev) ? prev : [];

	outbox.push(entry);
	await idbSet(OUTBOX_KEY, outbox.slice(-OUTBOX_CAP));
}

/** The msgid a reply typed into the notification answers: its newest
 * message (a batch entry carries the batch's msgid, which is the message's). */
function replyTargetOf(data) {
	const list = Array.isArray(data.messages) ? data.messages : [];
	const last = list[list.length - 1];

	return last && typeof last.msgid === "string" ? last.msgid : undefined;
}

async function handleReply(data, text) {
	if (!text || !data.target) {
		await openApp(data);
		return;
	}

	const stash = await getStash();
	const net = stashNetwork(stash, data.network);
	const replyTo = replyTargetOf(data);
	const reply = {
		type: "reply",
		network: net ? net.uuid : data.network,
		target: data.target,
		text,
		...(replyTo ? {replyTo} : {}),
		time: new Date().toISOString(),
	};

	if (await viaPage(reply)) {
		await doneWith(data);
		return;
	}

	if (canLogin(net) && (await swIrcSend(net, data.target, text, replyTo))) {
		await doneWith(data);
		return;
	}

	await enqueueOutbox(reply);
	await openApp(data);
}

/** Mark read: the user has seen the conversation, so set the account's
 * read marker at the notification's newest message (its `time`; the
 * click's when the push carried none). A page first, the worker's own
 * connection second, the outbox last — and the notification closes here
 * whatever happened, since there is nothing to type and nothing to lose.
 * The server's relay of the marker closes it on the other devices. */
async function handleMarkRead(data) {
	if (data.target) {
		const stash = await getStash();
		const net = stashNetwork(stash, data.network);
		const mark = {
			type: "markread",
			network: net ? net.uuid : data.network,
			target: data.target,
			time: typeof data.time === "string" ? data.time : new Date().toISOString(),
		};

		const sent =
			(await viaPage(mark)) ||
			(canLogin(net) && (await swMarkRead(net, mark.target, mark.time)));

		if (!sent) {
			await enqueueOutbox(mark);
		}
	}

	await doneWith(data);
}

/** The notification's conversation has been dealt with here. */
async function doneWith(data) {
	await closeForTarget(data.target, new Date().toISOString());
	await updateBadge();
}

self.addEventListener("notificationclick", function (event) {
	const data = event.notification.data || {};

	// Reply: an inline text field where the platform has one (event.reply),
	// a plain button elsewhere — that one opens the conversation to type in.
	if (event.action === "reply") {
		event.notification.close();
		event.waitUntil(handleReply(data, String(event.reply || "").trim()));
		return;
	}

	// Mark read: the account's read marker at the notification's newest
	// message, which the server relays to every device.
	if (event.action === "markread") {
		event.notification.close();
		event.waitUntil(handleMarkRead(data));
		return;
	}

	event.notification.close();
	event.waitUntil(openApp(data, event.notification.tag));
});

/** The in-app route for a notification: by network + target when known
 * (survives the page and its session-local ids), else by the page's
 * `chan-<id>` tag, else the app itself. */
function routeFor(data, tag) {
	if (data && data.network && data.target) {
		return `${appUrl}#/net/${encodeURIComponent(data.network)}/${encodeURIComponent(
			data.target
		)}`;
	}

	if (tag && tag.startsWith("chan-")) {
		return `${appUrl}#/${tag}`;
	}

	return appUrl;
}

/** Bring the app to the conversation a notification is about: tell an open
 * page to switch (and focus it), or open a window on the deep link. */
async function openApp(data, tag) {
	const cs = await clients.matchAll({includeUncontrolled: true, type: "window"});

	// Focusing or opening a window needs the user activation a notification
	// click carries; without it (a synthetic call) the browser refuses.
	// Nothing here may throw: a queued reply is already safe in the outbox,
	// and the page that is (or gets) told where to go does the rest.
	if (cs.length === 0) {
		if (clients.openWindow) {
			try {
				await clients.openWindow(routeFor(data, tag));
			} catch (e) {
				// eslint-disable-next-line no-console
				console.warn("[sw] could not open a window", e);
			}
		}

		return;
	}

	const client = findSuitableClient(cs);

	client.postMessage({
		type: "open",
		channel: tag,
		network: data ? data.network : undefined,
		target: data ? data.target : undefined,
	});

	if ("focus" in client) {
		try {
			await client.focus();
		} catch (e) {
			// already told where to go; focus is best effort
		}
	}
}

function findSuitableClient(clientList) {
	for (let i = 0; i < clientList.length; i++) {
		const client = clientList[i];

		if (client.focused || client.visibilityState === "visible") {
			return client;
		}
	}

	return clientList[0];
}
