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
const isDevBuild = cacheName === "dev";

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

// Paths that must never be served from cache (Cloudflare challenge endpoints).
const excludedPathsFromCache = /^cdn-cgi\//;

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
					names.filter((name) => name !== cacheName).map((name) => caches.delete(name))
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
	if (event.data && event.data.type === "read" && typeof event.data.target === "string") {
		const {target, ts} = event.data;

		event.waitUntil(
			enqueuePush(async () => {
				await closeForTarget(target, typeof ts === "string" ? ts : undefined);
				await updateBadge();
			})
		);
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
 * it); `ctx.onLine(fn)` sees every later line.  Resolves through done(ok):
 * false on any SASL/registration failure, a close, or the timeout.
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

				for (const line of pre) {
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
	const all = await self.registration.getNotifications();
	const mine = all.reduce((sum, n) => sum + ((n.data && n.data.count) || 1), 0);
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

// The lines of a multiline message reach the worker together (FCM hands
// them over at once) and a service worker runs push handlers concurrently.
// Each handler reads the notification's stored message list, awaits a few
// IndexedDB reads, then writes the list back — so two in flight would lose
// each other's line, leaving `…` placeholders. Pushes are therefore handled
// one at a time, in arrival order; a failed one never blocks the next.
let pushChain = Promise.resolve();

function handlePush(raw) {
	return enqueuePush(() => handlePushNow(raw));
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
		text: typeof json.text === "string" ? json.text : "New message",
	};
}

async function handlePushNow(raw) {
	let json = null;

	// RFC 8188 says the decrypter strips the aes128gcm padding delimiter
	// (a trailing 0x02) before the payload reaches the SW; if a browser
	// ever delivers it unstripped, JSON.parse would throw and the push
	// would degrade to the generic fallback. Trim trailing control bytes
	// before parsing so the payload is always clean.
	const clean = raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]+$/, "");

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
			await closeForTarget(json.target, json.ts);
			await updateBadge();
			return;
		}

		const P = push();
		const parsed = json ? fromJson(json) : P.parsePushLine(clean);

		// The same relay as a MARKREAD line (the full tier).
		if (parsed && parsed.command === "MARKREAD") {
			await closeForTarget(parsed.target, parsed.timestamp);
			await updateBadge();
			return;
		}

		if (parsed && (parsed.command === "PRIVMSG" || parsed.command === "NOTICE")) {
			await showMessage(P, parsed, true);
			return;
		}

		// userVisibleOnly means every push should surface something.
		await showSafely("Seance", {
			tag: "push-activity",
			icon: "img/icon-192.png",
			body: "New activity while you were away.",
		});

		await updateBadge();
	} catch (e) {
		await showSafely("Seance", {
			tag: "push-activity",
			icon: "img/icon-192.png",
			body: "New activity while you were away.",
		});
		await updateBadge();
	}
}

/** Show (or merge) one message's notification: a pushed PRIVMSG/NOTICE, or
 * a page's message (`checkSeen` false — the page recorded it as seen
 * itself, and is asking for it to be shown). */
async function showMessage(P, parsed, checkSeen) {
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

	if (checkSeen && seenId) {
		const seen = await idbGet("seen");

		if (
			Array.isArray(seen) &&
			((msgid && seen.includes(msgid)) || seen.includes(seenId) || seen.includes(seenKey))
		) {
			return;
		}
	}

	const isChannel = isChannelName(parsed.target);
	const replyTo = isChannel ? parsed.target : parsed.nick;
	const tag = "push-" + (replyTo || "activity");

	// The page mirrors the reader's markdown setting here (client/js/
	// push-prefs.ts); absent means the app default, on.
	const prefs = (await idbGet("prefs")) || {};
	const markdown = prefs.markdown !== false;

	// Merge per target: the message list rides on the notification's
	// data so it survives the worker being killed between pushes, and a
	// multiline message grows in place, one line per push.
	const existing = await self.registration.getNotifications({tag});
	const prev = existing[0] && existing[0].data;
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
	// plain message pushed again adds nothing, so show nothing again.
	if (!added.isNew && !line) {
		return;
	}

	const count = ((prev && prev.count) || 0) + (added.isNew ? 1 : 0);
	const body = P.renderMergedBody(added.entries, isChannel, (text) =>
		P.notificationText(text, {markdown})
	);

	const title = isChannel
		? parsed.nick + " in " + parsed.target + (count > 1 ? " (" + count + ")" : "")
		: parsed.nick + (count > 1 ? " (" + count + ")" : "");

	// Inline reply renders as a text field where the browser supports
	// it (desktop Chrome) and degrades to a button that deep-links the
	// chat where it does not — the click handler falls back to openApp
	// when no reply text arrives.  showSafely guards the whole call if
	// a browser rejects the actions outright.  Reply goes last, on the
	// right: that is where a thumb lands on a phone held in one hand.
	// Mark read is "seen, no answer needed": the account's read marker
	// at this notification's newest message, on every device.
	const actions = [
		{action: "markread", title: "Mark read"},
		{action: "reply", type: "text", title: "Reply", placeholder: "Reply…"},
	];

	// The payload names no network: a push-only worker serves exactly
	// one (its scope says which); the root worker, which only ever
	// held the pre-per-network subscription, falls back to the first
	// stashed network.
	const stash = await getStash();
	const network = scopeNetwork || (stash.networks[0] ? stash.networks[0].uuid : undefined);
	const time = typeof parsed.tags.time === "string" ? parsed.tags.time : undefined;

	await showSafely(title, {
		tag,
		renotify: added.isNew,
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

	if (seenId) {
		await idbAppend("seen", seenKey, SEEN_CAP);
	}

	await updateBadge();
}

/** The page's message as a parsed push line, shown by showMessage. */
async function handlePageMessageNow(payload) {
	const m = payload.message;

	if (typeof m.from !== "string" || typeof payload.target !== "string") {
		return;
	}

	await showMessage(
		push(),
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
		false
	);
}

/** showNotification that cannot silently fail: if Chrome rejects any
 * option (an unsupported action, a bad icon), retry with the body only,
 * then bare.  A delivered push that renders nothing is the worst outcome
 * there is, so every path here ends in a visible notification. */
async function showSafely(title, options) {
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
	const cs = await self.clients.matchAll({includeUncontrolled: true, type: "window"});

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
