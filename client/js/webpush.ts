import {reactive} from "vue";

import socket from "./socket";
import {store} from "./store";
import storage from "./localStorage";
import {idbGet, idbSet} from "./idb";
import * as saved from "./irc/saved-networks";
import type {SavedNetwork} from "./irc/saved-networks";
import {
	decodeApplicationServerKey,
	keyChangePolicy,
	sameApplicationServerKey,
} from "./helpers/pushKeys";
import {
	anyStale,
	entryStale,
	parseStoredSubscriptions,
	type LegacyEntry,
	type PushEntry,
	type PushKeys,
} from "./helpers/pushStore";
import {pushScopePath} from "./push/scope";
import {ChanType} from "../../shared/types/chan";

/**
 * Web Push subscriptions (IRCv3 `draft/webpush`), one per network.
 *
 * docs/projects/push-per-network.md is the design, push-subscription.md
 * the history, notifications.md the bigger picture. A browser holds one
 * push subscription per service-worker registration, bound to the
 * `applicationServerKey` it was created with, and every ircd announces its
 * own VAPID key — so each push-enabled network gets its own registration of
 * the same worker script at `push/<uuid>/` and its own subscription against
 * that network's key. The root registration (`./`, pwa.ts) keeps the offline
 * shell and holds no subscription.
 *
 *   `webpush:available` (per network, at registration)  ──►  re-REGISTER that network's entry
 *   connect-time prompt (yes/no/never)                   ──►  PushManager.subscribe() ──► `webpush:register`
 *   `webpush:state` (server echo / FAIL WEBPUSH)         ──►  state updates
 *
 * Re-sending an identical REGISTER on every connect is the draft's renewal
 * mechanism, so nothing else schedules refreshes; `pushsubscriptionchange`
 * (and the worker, per registration) self-heal expired subscriptions and
 * the boot-time sync below picks the renewed endpoint up. A server-side
 * VAPID rotation is different: the entry then matches no announced key, and
 * the browser refuses `subscribe()` with the new key until the old
 * subscription is dropped (`InvalidStateError`). That is never healed
 * silently by default — a device that stops receiving pushes without a word
 * is what this module must not produce — so the connect opens the prompt in
 * its `renew` variant; the `pushKeyChange` setting can make that automatic
 * (`trust`) or turn it off (`ignore`), and Settings reports the `stale`
 * state either way, with the Renew button in that network's settings.
 *
 * The entries persist in `thelounge.push` keyed by network uuid (the old
 * per-key shape is migrated, see `legacy`); the worker's own working copy
 * (each network's key + credentials for throwaway IRC connections used by
 * quick-reply, mute and renewal) lives in IndexedDB `seance-push` and only
 * carries a password when the user chose to remember it.
 */

/** A browser push subscription, reduced to what the ircd needs. */
interface PushMaterial {
	endpoint: string;
	keys: PushKeys;
}

const STORAGE_KEY = "thelounge.push";

/** Endpoints of the pre-per-network subscription, waiting to be
 * UNREGISTERed from the networks that announce their key. */
const LEGACY_KEY = "thelounge.push.legacy";

/** Device-local "never ask again" answer for the connect-time subscribe
 * prompt (thelounge.* key convention; deliberately not in `thelounge.push`
 * so the subscription map keeps its shape). */
const NEVER_ASK_KEY = "thelounge.push.neverAsk";

/** What the connect-time prompt asks: to subscribe this device to a
 * network, or to renew a subscription the server's VAPID rotation made
 * useless. */
type PromptKind = "subscribe" | "renew";

/** The connect-time prompt (yes/no/never). Rendered by
 * components/PushPrompt.vue; state lives here because the decision needs
 * this module's servers/subscriptions view. `network` is the uuid of the
 * network whose connect asked (the prompt names it), `vapid` the key a
 * subscription made from this prompt is created against. */
const pushPrompt = reactive<{
	visible: boolean;
	kind: PromptKind;
	network: string | undefined;
	vapid: string | undefined;
}>({
	visible: false,
	kind: "subscribe",
	network: undefined,
	vapid: undefined,
});

/** Per connected network, as announced by `webpush:available`: the server's
 * VAPID key (undefined when it cannot push) and whether this connection
 * logged in with SASL. Reactive so the per-network rows re-render. */
const servers = reactive(new Map<string, {vapid: string | undefined; sasl: boolean}>());

/** Persisted subscriptions by network uuid. Reactive for the same reason;
 * one object identity, mutated in place and saved through {@link saveSubs}. */
const subs = reactive<Record<string, PushEntry>>({});

/** The old per-key subscription's endpoints, until every network announcing
 * their key has been told to forget them. */
let legacy: LegacyEntry[] = [];

function loadStored(): void {
	const parsed = parseStoredSubscriptions(storage.get(STORAGE_KEY));

	Object.assign(subs, parsed.entries);
	legacy = [...parsed.legacy, ...loadLegacyList()];

	if (parsed.legacy.length > 0) {
		// First boot with per-network subscriptions: the map takes its new
		// shape, the old endpoints queue for unregistering, and the root
		// registration's subscription — the one they belong to — goes.
		saveSubs();
		saveLegacy();
		void dropRootSubscription();
	}
}

function loadLegacyList(): LegacyEntry[] {
	try {
		const raw = storage.get(LEGACY_KEY);
		const list: unknown = raw ? JSON.parse(raw) : [];

		return Array.isArray(list)
			? list.filter(
					(item): item is LegacyEntry =>
						typeof item === "object" &&
						item !== null &&
						typeof (item as LegacyEntry).vapid === "string" &&
						typeof (item as LegacyEntry).endpoint === "string"
			  )
			: [];
	} catch {
		return [];
	}
}

function saveLegacy(): void {
	if (legacy.length === 0) {
		storage.remove(LEGACY_KEY);
	} else {
		storage.set(LEGACY_KEY, JSON.stringify(legacy));
	}
}

function saveSubs(): void {
	storage.set(STORAGE_KEY, JSON.stringify(subs));
}

function setState(state: string): void {
	store.commit("pushNotificationState", state);
}

/** The browser half of Web Push: Push API + service worker + secure context. */
function browserSupported(): boolean {
	return (
		typeof window !== "undefined" &&
		"PushManager" in window &&
		"serviceWorker" in navigator &&
		window.isSecureContext
	);
}

/** iOS/iPadOS only expose the Push API to installed Home-Screen web apps. */
function needsInstall(): boolean {
	const isIOS =
		/iPad|iPhone|iPod/.test(navigator.userAgent) ||
		(navigator.userAgent.includes("Mac") && "ontouchend" in document);

	if (!isIOS) {
		return false;
	}

	return !("PushManager" in window);
}

function permissionDenied(): boolean {
	return typeof Notification !== "undefined" && Notification.permission === "denied";
}

function permissionGranted(): boolean {
	return typeof Notification !== "undefined" && Notification.permission === "granted";
}

/** The key a connected network announced, if any. */
function announcedKey(uuid: string): string | undefined {
	return servers.get(uuid)?.vapid;
}

/** Any VAPID key among the connected networks. */
function anyVapid(): string | undefined {
	for (const server of servers.values()) {
		if (server.vapid !== undefined) {
			return server.vapid;
		}
	}

	return undefined;
}

/** Whether a network takes part in Web Push: its saved `pushEnabled` flag
 * (Settings live per network — some servers can push, others cannot). */
function pushOn(uuid: string): boolean {
	return saved.pushEnabledOf(saved.get(uuid));
}

/** Recompute the coarse state the Settings screen renders. */
function refreshState(): void {
	if (!browserSupported()) {
		setState(needsInstall() ? "not-installed" : "unsupported");
		return;
	}

	if (permissionDenied()) {
		setState("denied");
		return;
	}

	// A server rotated its VAPID key: that network's entry was made against
	// the old one and delivers nothing. Settings says so and points at the
	// network's settings, where Renew lives; the connect-time prompt is the
	// other way out.
	if (
		anyStale(
			subs,
			[...servers].map(([uuid, server]) => [uuid, server.vapid])
		)
	) {
		setState("stale");
		return;
	}

	// A stored subscription means "subscribed": it survives reloads and
	// disconnects (the server keeps it until the device unregisters, and the
	// worker renews it). This must win over the current-connection checks so
	// the Settings page doesn't flip to unsubscribed on every reload.
	if (Object.keys(subs).length > 0) {
		setState("subscribed");
		return;
	}

	if (anyVapid() === undefined) {
		// No connected network advertises draft/webpush (or none is connected
		// yet) — the server half is what phase 1 cannot do without.
		setState("server-unsupported");
		return;
	}

	setState("unsubscribed");
}

// --- registrations -----------------------------------------------------------

/** The absolute scope of a network's push-only registration. */
function scopeUrl(uuid: string): string {
	return new URL(pushScopePath(uuid), document.baseURI).href;
}

/** A network's push-only registration, if it exists. `getRegistration`
 * answers with the longest matching scope, which is the root registration
 * when the network has none — hence the exact-scope check. */
async function pushRegistration(uuid: string): Promise<ServiceWorkerRegistration | undefined> {
	const registration = await navigator.serviceWorker.getRegistration(pushScopePath(uuid));

	return registration && registration.scope === scopeUrl(uuid) ? registration : undefined;
}

/**
 * The worker that receives this network's pushes on this device, when it is
 * subscribed: the page shows its own notifications for the network through
 * it (socket-events/msg.ts), so a push for a message the page already took
 * finds that notification on its own registration. Chrome counts visible
 * notifications per registration, and a push that leaves none there is
 * "silent" — enough of those and it shows "This site has been updated in
 * the background". Undefined when the network has no subscription here or
 * its worker is not active.
 */
async function pushWorkerFor(uuid: string): Promise<ServiceWorker | undefined> {
	if (!subs[uuid] || !("serviceWorker" in navigator)) {
		return undefined;
	}

	try {
		const registration = await pushRegistration(uuid);
		return registration?.active ?? undefined;
	} catch {
		return undefined;
	}
}

/** Ask the browser to re-fetch a push-only registration's worker. Nothing
 * else ever does: a worker re-checks its script on a navigation inside its
 * scope (the page never navigates inside `push/<uuid>/`), on a push event
 * only when the last check is a day old, and on `register()` only when the
 * script URL changed — so a device that subscribed before a deploy would
 * keep the old worker, and with it the old notification actions and reply
 * path. Fire and forget: `update()` rejects offline or while an install is
 * already under way, and the worker in place keeps working either way. */
function checkForNewWorker(registration: ServiceWorkerRegistration): void {
	registration.update().catch(() => {
		// offline, or an install already under way
	});
}

/** Wait until a registration has an active worker (a fresh registration
 * installs first; `navigator.serviceWorker.ready` is the root's only). */
async function awaitActive(registration: ServiceWorkerRegistration): Promise<void> {
	if (registration.active) {
		return;
	}

	const worker = registration.installing ?? registration.waiting;

	if (!worker) {
		throw new Error("push worker did not install");
	}

	await new Promise<void>((resolve, reject) => {
		const onState = () => {
			if (worker.state === "activated") {
				worker.removeEventListener("statechange", onState);
				resolve();
			} else if (worker.state === "redundant") {
				worker.removeEventListener("statechange", onState);
				reject(new Error("push worker became redundant before activating"));
			}
		};

		worker.addEventListener("statechange", onState);
		onState();
	});
}

/** The network's push-only registration, created and activated on demand. */
async function ensureRegistration(uuid: string): Promise<ServiceWorkerRegistration> {
	const existing = await pushRegistration(uuid);

	if (existing) {
		checkForNewWorker(existing);
	}

	const registration =
		existing ??
		(await navigator.serviceWorker.register("service-worker.js", {scope: pushScopePath(uuid)}));

	await awaitActive(registration);

	return registration;
}

function materialOf(sub: PushSubscription): PushMaterial {
	const json = sub.toJSON() as PushSubscriptionJSON & {
		keys?: {p256dh?: string; auth?: string};
	};
	const p256dh = json.keys?.p256dh;
	const auth = json.keys?.auth;

	if (!json.endpoint || !p256dh || !auth) {
		throw new Error("push subscription is missing endpoint or keys");
	}

	return {endpoint: json.endpoint, keys: {p256dh, auth}};
}

/** Create the browser subscription for a network against `vapid`. A
 * registration holds one push subscription, bound to the key it was created
 * with, and refuses `subscribe()` with another key (`InvalidStateError`:
 * "unsubscribe then resubscribe") — so a subscription left over from before
 * a VAPID rotation is dropped first. The caller unregisters its endpoint
 * from the server. */
async function pushSubscription(uuid: string, vapid: string): Promise<PushMaterial> {
	const registration = await ensureRegistration(uuid);
	const applicationServerKey = decodeApplicationServerKey(vapid);
	const existing = await registration.pushManager.getSubscription();

	if (
		existing &&
		!sameApplicationServerKey(existing.options.applicationServerKey, applicationServerKey)
	) {
		await existing.unsubscribe();
	}

	const sub = await registration.pushManager.subscribe({
		userVisibleOnly: true,
		applicationServerKey,
	});

	return materialOf(sub);
}

/** The pre-per-network subscription lived on the root registration; once
 * its endpoints are queued for unregistering it has no use. */
async function dropRootSubscription(): Promise<void> {
	if (!browserSupported()) {
		return;
	}

	try {
		const registration = await navigator.serviceWorker.ready;
		const existing = await registration.pushManager.getSubscription();

		if (existing) {
			await existing.unsubscribe();
		}
	} catch (error) {
		// eslint-disable-next-line no-console
		console.warn("[webpush] could not drop the root registration's subscription", error);
	}
}

/** Reconcile the stored entries with what the browser actually holds: no
 * registration or no subscription → the entry goes (the device lost it; the
 * next connect re-subscribes silently under a granted permission); another
 * endpoint (the worker renewed it) → the entry follows. {@link autoRegister}
 * waits for this so it never re-registers a dead endpoint. Every
 * registration found is also asked for a newer worker
 * ({@link checkForNewWorker}): this is the one moment a deploy reaches the
 * push-only workers already installed on a device. */
async function syncStoredWithBrowser(): Promise<void> {
	if (!browserSupported()) {
		return;
	}

	let changed = false;

	for (const uuid of Object.keys(subs)) {
		try {
			const registration = await pushRegistration(uuid);

			if (registration) {
				checkForNewWorker(registration);
			}

			const live = registration ? await registration.pushManager.getSubscription() : null;

			if (!live) {
				delete subs[uuid];
				changed = true;
				continue;
			}

			const material = materialOf(live);
			const entry = subs[uuid];

			if (
				material.endpoint !== entry.endpoint ||
				material.keys.p256dh !== entry.keys.p256dh ||
				material.keys.auth !== entry.keys.auth
			) {
				subs[uuid] = {vapid: entry.vapid, ...material};
				changed = true;
			}
		} catch {
			// leave the entry; the server-side re-REGISTER is idempotent
		}
	}

	if (changed) {
		saveSubs();
		refreshState();
	}
}

/** {@link syncStoredWithBrowser}, started at boot once the stored entries
 * are loaded (below) — started any earlier it would sweep an empty map. */
let synced: Promise<void> = Promise.resolve();

// --- per-network decisions ---------------------------------------------------

/** Re-register a network's stored subscription with it on connect — the
 * draft's renewal mechanism. An entry made against another key (the server
 * rotated its VAPID key) is not touched here: {@link maybePrompt} decides. */
function autoRegister(uuid: string, vapid: string | undefined): void {
	if (vapid === undefined || !pushOn(uuid)) {
		return;
	}

	void (async () => {
		await synced;

		const entry = subs[uuid];

		if (entry && entry.vapid === vapid) {
			socket.emit("webpush:register", {
				network: uuid,
				endpoint: entry.endpoint,
				keys: entry.keys,
			});
			await writeStash(); // every connect: the worker's copy of the networks stays current
		}
	})();
}

/** Tell a connecting network to forget the endpoints of the old shared
 * subscription that were registered under its key. */
function unregisterLegacy(uuid: string, vapid: string | undefined): void {
	if (vapid === undefined || legacy.length === 0) {
		return;
	}

	const mine = legacy.filter((item) => item.vapid === vapid);

	if (mine.length === 0) {
		return;
	}

	for (const item of mine) {
		socket.emit("webpush:unregister", {network: uuid, endpoint: item.endpoint});
	}

	legacy = legacy.filter((item) => item.vapid !== vapid);
	saveLegacy();
}

socket.on("webpush:available", ({network, vapid, sasl}) => {
	servers.set(network, {vapid, sasl});
	unregisterLegacy(network, vapid);
	autoRegister(network, vapid);
	refreshState();
	maybePrompt(network);
});

/** Networks with a subscribe() run in flight (a burst of connects). */
const subscribing = new Set<string>();

/** Prompts answered "not now" in this page, by `declineKey`: a reconnect
 * (every registration announces `webpush:available`) must not ask again.
 * Page-lived on purpose — a reload asks once more, "never" is the lasting
 * answer — and keyed by kind and key, so declining to subscribe does not
 * silence the renew prompt a later key rotation brings. */
const declined = new Set<string>();

function declineKey(kind: PromptKind, uuid: string, vapid: string): string {
	return `${kind} ${uuid} ${vapid}`;
}

/** Offer the prompt once per connection that logged in with SASL on a
 * push-capable network: the server can push only for accounts, so an
 * anonymous connect has nothing to offer. Skipped when this browser cannot
 * subscribe or permission is already denied.
 *
 * With no entry for the network it asks to subscribe (or just subscribes
 * when permission is already granted — the network's push option is the
 * user's choice), unless the user answered "never" on this device. With an
 * entry made against a key the network no longer announces, the
 * `pushKeyChange` setting decides: `ask` (default) opens the renew prompt,
 * permission or not — the renewal replaces the endpoint the server pushes
 * to; `trust` renews on the spot when permission is granted (otherwise the
 * prompt's button is the gesture the permission ask needs); `ignore` does
 * nothing — the entry stays stale and the network's settings keep offering
 * Renew. The renew prompt's "Never" sets `ignore`, so the choice is visible
 * and reversible in Settings. */
function maybePrompt(uuid: string): void {
	const server = servers.get(uuid);

	if (!server || !server.sasl || server.vapid === undefined || !pushOn(uuid)) {
		return;
	}

	if (pushPrompt.visible || !browserSupported() || needsInstall() || permissionDenied()) {
		return;
	}

	const vapid = server.vapid;
	const entry = subs[uuid];

	if (entry) {
		if (entry.vapid === vapid) {
			return; // subscribed; autoRegister re-registers it
		}

		const policy = keyChangePolicy(store.state.settings.pushKeyChange);

		if (policy === "ignore") {
			return;
		}

		if (policy === "trust" && permissionGranted()) {
			void subscribe(uuid);
			return;
		}

		askOnce("renew", uuid, vapid);
		return;
	}

	// Permission already granted: subscribe directly instead of asking
	// again. "default" (never asked) needs a user gesture, which the
	// prompt's buttons provide; "never ask again" suppresses that prompt on
	// this device.
	if (permissionGranted()) {
		void subscribe(uuid);
		return;
	}

	if (storage.get(NEVER_ASK_KEY)) {
		return;
	}

	askOnce("subscribe", uuid, vapid);
}

/** Open the prompt unless the user already said "not now" to this very
 * question in this page. */
function askOnce(kind: PromptKind, network: string, vapid: string): void {
	if (!declined.has(declineKey(kind, network, vapid))) {
		openPrompt(kind, network, vapid);
	}
}

function openPrompt(kind: PromptKind, network: string, vapid: string): void {
	pushPrompt.kind = kind;
	pushPrompt.network = network;
	pushPrompt.vapid = vapid;
	pushPrompt.visible = true;
}

/** Prompt answer: subscribe, or renew — the same flow, for the network that
 * asked (the click is the permission user gesture). */
function acceptPrompt(): void {
	pushPrompt.visible = false;

	if (pushPrompt.network !== undefined) {
		void subscribe(pushPrompt.network);
	}
}

/** Prompt answer: not now — not asked again until the page is reloaded
 * (or the network's push option is switched back on). */
function declinePrompt(): void {
	pushPrompt.visible = false;

	if (pushPrompt.network !== undefined && pushPrompt.vapid !== undefined) {
		declined.add(declineKey(pushPrompt.kind, pushPrompt.network, pushPrompt.vapid));
	}
}

/** Prompt answer: never ask this question again on this device. For the
 * renew prompt that is the `pushKeyChange` setting flipped to `ignore`
 * (visible and reversible in Settings → Notifications); a stale entry stays
 * stale, nothing is unsubscribed behind the user's back. */
function neverPrompt(): void {
	if (pushPrompt.kind === "renew") {
		void store.dispatch("settings/update", {
			name: "pushKeyChange",
			value: "ignore",
			sync: true,
		});
	} else {
		storage.set(NEVER_ASK_KEY, "1");
	}

	pushPrompt.visible = false;
}

socket.on("webpush:state", ({network, action, endpoint, ok, code, reason}) => {
	if (ok) {
		refreshState();
		return;
	}

	// The server refused the subscription. ACCOUNT_REQUIRED is nefarious2's
	// non-spec code for "log in first"; MAX_REGISTRATIONS is spec but not yet
	// sent by the server. The state text is the user-facing report.
	store.commit("pushNotificationState", "blocked");
	// eslint-disable-next-line no-console
	console.warn(
		`[webpush] ${action} of ${endpoint} on ${network} failed (${code}): ${
			reason ?? "no reason given"
		}`
	);
});

/**
 * Subscribe this device to one network: ask permission (must be a user
 * gesture), create that network's registration and browser subscription
 * against the key it announced, persist the entry, tell the network to
 * forget the endpoint this replaces, and register the new one with it.
 */
async function subscribe(uuid: string): Promise<void> {
	if (subscribing.has(uuid)) {
		return;
	}

	if (!browserSupported()) {
		refreshState();
		return;
	}

	subscribing.add(uuid);

	try {
		const permission = await Notification.requestPermission();

		if (permission !== "granted") {
			setState("denied");
			return;
		}

		const vapid = announcedKey(uuid);

		if (vapid === undefined) {
			// The network is not connected, or cannot push (cap not negotiated
			// or no key): nothing to subscribe against right now.
			refreshState();
			return;
		}

		// Client-side enforcement of the account requirement (the server
		// refuses REGISTER without one anyway).
		const net = saved.get(uuid);

		if (!net || !net.saslAccount) {
			setState("blocked");
			return;
		}

		const previous = subs[uuid]?.endpoint;
		const material = await pushSubscription(uuid, vapid);

		subs[uuid] = {vapid, ...material};
		saveSubs();

		// The browser mints a fresh endpoint whenever the subscription is
		// recreated; without this the old one stays registered on the account
		// and the server keeps pushing to it — every notification twice.
		if (previous !== undefined && previous !== material.endpoint) {
			socket.emit("webpush:unregister", {network: uuid, endpoint: previous});
		}

		await writeStash();
		socket.emit("webpush:register", {
			network: uuid,
			endpoint: material.endpoint,
			keys: material.keys,
		});

		// Push payloads carry the message text (Discord-like); the account's
		// tier metadata controls this server-side.
		socket.emit("webpush:metadata", {
			network: uuid,
			key: "draft/webpush/payload",
			value: "full",
		});

		refreshState();
	} catch (error) {
		setState("blocked");
		// eslint-disable-next-line no-console
		console.warn("[webpush] subscription failed", error);
	} finally {
		subscribing.delete(uuid);
	}
}

/** Renew this device's subscription for one network — the Edit-network
 * form's button when {@link networkPushInfo} says `stale` — against the key
 * that network announces (the click is the permission user gesture). */
function renew(uuid: string): void {
	void subscribe(uuid);
}

/** Stash what the service workers need: for every push-enabled network
 * that announced a key or holds an entry, its uuid, connection details and
 * the key its subscription was made against — that is how a worker
 * deep-links a notification, relays a reply to this page, and renews its
 * subscription. The SASL password rides along ONLY for networks that
 * remember it (it never hits IndexedDB otherwise); that is what lets a
 * worker send a reply, mute, or renew over its own connection when no page
 * is alive. Rewritten on every connect so a password remembered later, or
 * changed, reaches the worker without re-subscribing. */
async function writeStash(): Promise<void> {
	const networks = saved
		.list()
		.filter(
			(net) =>
				pushOn(net.uuid) &&
				(announcedKey(net.uuid) !== undefined || subs[net.uuid] !== undefined)
		)
		.map((net) => ({
			uuid: net.uuid,
			host: net.host,
			port: net.port,
			tls: net.tls,
			saslAccount: net.saslAccount,
			saslPassword: net.rememberPassword === true ? net.saslPassword : undefined,
			vapid: subs[net.uuid]?.vapid ?? announcedKey(net.uuid) ?? null,
		}));

	try {
		await idbSet("stash", {vapid: anyVapid() ?? null, networks});
	} catch (error) {
		// eslint-disable-next-line no-console
		console.warn("[webpush] could not write the service worker stash", error);
	}
}

/** Unsubscribe this device from one network: drop its browser subscription
 * and registration, tell the network, forget the entry. */
async function unsubscribe(uuid: string): Promise<void> {
	try {
		const registration = browserSupported() ? await pushRegistration(uuid) : undefined;
		const live = registration ? await registration.pushManager.getSubscription() : null;

		if (live) {
			await live.unsubscribe();
		}

		const entry = subs[uuid];

		if (entry && servers.has(uuid)) {
			socket.emit("webpush:unregister", {network: uuid, endpoint: entry.endpoint});
		}

		delete subs[uuid];
		saveSubs();

		if (registration) {
			await registration.unregister();
		}

		await writeStash();
	} catch (error) {
		// eslint-disable-next-line no-console
		console.warn("[webpush] unsubscription failed", error);
	} finally {
		refreshState();
	}
}

/**
 * Snooze pushes for `ms` (0 = clear the snooze): account-wide, enforced by
 * the ircd's mute gate, so every device stops being woken up. Per-channel
 * mutes ride the same metadata key (see /pushmute).
 */
function setSnooze(ms: number): void {
	if (anyVapid() === undefined) {
		return;
	}

	const until = ms > 0 ? Math.floor(Date.now() / 1000) + Math.floor(ms / 1000) : 0;

	for (const [uuid, server] of servers) {
		if (server.vapid === undefined || !pushOn(uuid)) {
			continue;
		}

		socket.emit("webpush:metadata", {
			network: uuid,
			key: "draft/webpush/mute",
			value: until > 0 ? `*:${until}` : "",
		});
	}
}

/** Per-network browser-notification flag (the editor's checkbox), reactive
 * so sidebar icons re-render on edits; seeded from storage on first read. */
const notifyFlags = reactive(new Map<string, boolean>());

/** React to a saved network whose push flag changed (NetworkEdit form).
 *
 * Off: this device unsubscribes from that network right away — its
 * subscription and registration go, the network is told.
 * On: re-register the stored entry when the network is connected, or
 * subscribe/prompt as a connect would; otherwise the next
 * `webpush:available` does it.
 *
 * Called from NetworkEdit after `network:edit` has saved the entry, with
 * the flag as it was *before* the save. */
function onNetworkSaved(next: SavedNetwork, wasEnabled: boolean): void {
	notifyFlags.set(next.uuid, saved.notifyEnabledOf(next));
	void writeStash(); // a password (un)remembered, a push flag flipped

	const enabled = next.pushEnabled !== false;

	if (enabled === wasEnabled) {
		return;
	}

	if (!enabled) {
		void unsubscribe(next.uuid);
	} else {
		// Switching push on is asking for it: an earlier "not now" is over.
		for (const key of [...declined]) {
			if (key.split(" ")[1] === next.uuid) {
				declined.delete(key);
			}
		}

		autoRegister(next.uuid, announcedKey(next.uuid));
		refreshState();
		maybePrompt(next.uuid);
	}
}

/** One network's push situation, for the editor and the sidebar bell. All
 * inputs are reactive (`servers`, `subs`), so rows re-render. */
function notifyOn(uuid: string): boolean {
	if (!notifyFlags.has(uuid)) {
		notifyFlags.set(uuid, saved.notifyEnabledOf(saved.get(uuid)));
	}

	return Boolean(notifyFlags.get(uuid));
}

function networkPushInfo(uuid: string): {
	enabled: boolean;
	vapid: boolean;
	subscribed: boolean;
	/** The entry was made against another key than the one this network
	 * announces (its push identity changed): the Edit-network form offers
	 * Renew. */
	stale: boolean;
} {
	const vapid = announcedKey(uuid);
	const entry = subs[uuid];

	return {
		enabled: pushOn(uuid),
		vapid: vapid !== undefined,
		subscribed: vapid !== undefined && entry !== undefined && entry.vapid === vapid,
		stale: entryStale(entry, vapid),
	};
}

// Boot: load what is stored (migrating the old shape), reconcile it with the
// browser — which is also when every network's push-only worker is asked to
// update — then replace the stub's "unsupported" with what this browser can
// do. Servers announce themselves (and re-register stored entries) via
// `webpush:available` as they connect; they wait for the reconciliation.
loadStored();
synced = syncStoredWithBrowser();
refreshState();

// Opening the app means the user is catching up in-app: drop any push
// notifications the workers are still showing (badge included). Each
// network's worker keeps its own, so every registration is swept.
socket.on("init", async () => {
	if (!browserSupported()) {
		return;
	}

	try {
		for (const registration of await navigator.serviceWorker.getRegistrations()) {
			for (const n of await registration.getNotifications()) {
				if (n.tag && n.tag.startsWith("push-")) {
					n.close();
				}
			}
		}

		await idbSet("badge", {});

		if (navigator.clearAppBadge) {
			void navigator.clearAppBadge();
		}
	} catch {
		// no SW / not ready — nothing to clear
	}
});

// Reading a conversation closes what the network's push worker shows for
// it. The page's own notifications live there (pushWorkerFor), and the
// server's read push only follows a message it pushed — a notification the
// page put on the worker while the account was attended has nobody else to
// close it, and would otherwise come back counted in the next push.
function readOnWorker(uuid: string, target: string): void {
	void pushWorkerFor(uuid).then((worker) => worker?.postMessage({type: "read", target}));
}

/** The open conversation, when the user can see it. */
function readActive(): void {
	const active = store.state.activeChannel;

	if (
		!active ||
		active.channel.type === ChanType.LOBBY ||
		active.channel.type === ChanType.SPECIAL ||
		document.visibilityState !== "visible" ||
		!document.hasFocus()
	) {
		return;
	}

	readOnWorker(active.network.uuid, active.channel.name);
}

store.watch((state) => state.activeChannel, readActive);
window.addEventListener("focus", readActive);
document.addEventListener("visibilitychange", readActive);

// Another session read it to the end (draft/read-marker).
socket.on("markread", (data) => {
	const found = data.unread === 0 ? store.getters.findChannel(data.chan) : undefined;

	if (found) {
		readOnWorker(found.network.uuid, found.channel.name);
	}
});

/** A reply typed into a notification, as the worker hands it over: by
 * network uuid + target name (the page's channel ids mean nothing to it). */
/** A reply typed into a notification: relayed by the service worker
 * (bus-contract §2.2) or queued in its outbox. */
interface QueuedReply {
	/** Absent on entries an earlier build queued: those are replies. */
	type?: "reply";
	network: string;
	target: string;
	text: string;
	/** The msgid the reply answers (the notification's newest message). */
	replyTo?: string;
	time?: string;
	/** Relay only: past this (epoch ms) the worker has given up on this page
	 * and sent the reply another way, so the page must not send it too. A
	 * frozen page gets the message when it thaws, long after. */
	deadline?: number;
}

/** A notification's Mark read: the account's read marker for `target` at
 * `time` (the notification's newest message), relayed or queued like a
 * reply. */
interface QueuedMarkRead {
	type: "markread";
	network: string;
	target: string;
	time: string;
	deadline?: number;
}

type OutboxEntry = QueuedReply | QueuedMarkRead;

const OUTBOX_KEY = "outbox";

function networkUp(uuid: string): boolean {
	const network = store.getters.findNetwork(uuid);

	return Boolean(network && network.status.connected);
}

/** Send a relayed reply now if that network is connected. */
function sendReplyNow(reply: QueuedReply): boolean {
	if (!networkUp(reply.network)) {
		return false;
	}

	socket.emit("send", {
		network: reply.network,
		target: reply.target,
		text: reply.text,
		replyTo: reply.replyTo,
	});

	return true;
}

/** Set a relayed read marker now if that network is connected. Connected
 * is enough: without `draft/read-marker` the IRC layer sends nothing, and
 * nothing better could be done for that entry later either. */
function markReadNow(mark: QueuedMarkRead): boolean {
	if (!networkUp(mark.network)) {
		return false;
	}

	socket.emit("markread", {network: mark.network, target: mark.target, time: mark.time});

	return true;
}

/** Send one relayed or queued entry now; false while its network is down. */
function sendEntryNow(entry: OutboxEntry): boolean {
	return entry.type === "markread" ? markReadNow(entry) : sendReplyNow(entry);
}

/** Serialises outbox rewrites so a burst of connects cannot lose a reply. */
let outboxChain: Promise<void> = Promise.resolve();

/** Send what the worker queued for `network` (a reply typed, or a Mark
 * read tapped, while no page could send it), now that the network is
 * connected. */
function drainOutbox(network: string): void {
	outboxChain = outboxChain
		.then(async () => {
			const queued = (await idbGet<OutboxEntry[]>(OUTBOX_KEY)) ?? [];

			if (!Array.isArray(queued) || queued.length === 0) {
				return;
			}

			const rest = queued.filter(
				(entry) => !(entry.network === network && sendEntryNow(entry))
			);

			if (rest.length !== queued.length) {
				await idbSet(OUTBOX_KEY, rest);
			}
		})
		.catch((error) => {
			// eslint-disable-next-line no-console
			console.warn("[webpush] could not drain the reply outbox", error);
		});
}

// A network is up (post-001): anything queued for it can go out now.
socket.on("webpush:available", ({network}) => {
	drainOutbox(network);
});

if (browserSupported() && "serviceWorker" in navigator) {
	navigator.serviceWorker.addEventListener("message", (event) => {
		if (!event.data) {
			return;
		}

		// A worker asks the page to redo a subscription it could not renew
		// itself (pushsubscriptionchange without stashed credentials). It
		// names its network; a message without one comes from a root worker
		// of the previous build, whose subscription is gone anyway.
		if (event.data.type === "resubscribe") {
			if (typeof event.data.network === "string") {
				void subscribe(event.data.network);
			}

			return;
		}

		// A reply typed into a notification, or its Mark read: send it over
		// this page's own connection and tell the worker whether that worked
		// (it falls back to its own connection, or queues the entry, otherwise).
		if (event.data.type === "reply" || event.data.type === "markread") {
			const entry = event.data as OutboxEntry;
			const port = event.ports[0];
			let ok = false;

			try {
				// Delivered late (this page was frozen): the worker has already
				// sent or queued it — sending now would post a reply twice.
				const stale = typeof entry.deadline === "number" && Date.now() > entry.deadline;

				ok = !stale && sendEntryNow(entry);
			} catch (error) {
				// eslint-disable-next-line no-console
				console.warn("[webpush] relayed message failed", error);
			}

			if (port) {
				port.postMessage({ok});
			}
		}
	});
}

export default {
	subscribe,
	renew,
	unsubscribe,
	setSnooze,
	refresh: refreshState,
	onNetworkSaved,
	networkPushInfo,
	notifyOn,
	pushWorkerFor,
	pushPrompt,
	acceptPrompt,
	declinePrompt,
	neverPrompt,
};
