// @ts-nocheck
// Seance service worker (derived from The Lounge - https://github.com/thelounge/thelounge)
/* global clients */
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
// There is no Web Push handler: push needs a server-side relay to hold the
// subscription and send the pushes, and there is none in client-only mode.
// In-page `Notification` requests are still routed through this worker (see
// the "message" handler) so that clicks on them focus or reopen the app.

const cacheName = "__HASH__";
const isDevBuild = cacheName === "dev";

// The app shell is cached under the scope URL because, with hash-based
// routing, every navigation request resolves to the scope root.
const shellUrl = self.registration.scope;

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
	`js/loading-error-handlers.js?v=${cacheName}`,
	`js/bundle.vendor.js?v=${cacheName}`,
	`js/bundle.js?v=${cacheName}`,
	`css/style.css?v=${cacheName}`,
	"themes/default.css",
	"fonts/fa-solid-900.woff2",
	"img/logo-tile.png",
];

// Paths that must never be served from cache (Cloudflare challenge endpoints).
const excludedPathsFromCache = /^cdn-cgi\//;

self.addEventListener("install", function (event) {
	event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", function (event) {
	event.waitUntil(
		caches
			.keys()
			.then((names) =>
				Promise.all(
					names.filter((name) => name !== cacheName).map((name) => caches.delete(name))
				)
			)
	);

	event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", function (event) {
	if (event.request.method !== "GET") {
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

async function putInCache(request, response) {
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
self.addEventListener("message", function (event) {
	if (!event.data || event.data.type !== "notification") {
		return;
	}

	showNotification(event, event.data);
});

function showNotification(event, payload) {
	// get current notification, close it, and draw new
	event.waitUntil(
		self.registration
			.getNotifications({
				tag: `chan-${payload.chanId}`,
			})
			.then((notifications) => {
				for (const notification of notifications) {
					notification.close();
				}

				return self.registration.showNotification(payload.title, {
					tag: `chan-${payload.chanId}`,
					icon: "img/icon-192.png",
					body: payload.body,
					timestamp: payload.timestamp,
				});
			})
	);
}

self.addEventListener("notificationclick", function (event) {
	event.notification.close();

	event.waitUntil(
		clients
			.matchAll({
				includeUncontrolled: true,
				type: "window",
			})
			.then((clientList) => {
				if (clientList.length === 0) {
					if (clients.openWindow) {
						return clients.openWindow(`.#/${event.notification.tag}`);
					}

					return;
				}

				const client = findSuitableClient(clientList);

				client.postMessage({
					type: "open",
					channel: event.notification.tag,
				});

				if ("focus" in client) {
					client.focus();
				}
			})
	);
});

function findSuitableClient(clientList) {
	for (let i = 0; i < clientList.length; i++) {
		const client = clientList[i];

		if (client.focused || client.visibilityState === "visible") {
			return client;
		}
	}

	return clientList[0];
}
