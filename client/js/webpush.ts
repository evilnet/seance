import {reactive} from "vue";

import socket from "./socket";
import {store} from "./store";
import storage from "./localStorage";
import {idbGet, idbSet} from "./idb";
import {BUILD} from "./build";
import * as saved from "./irc/saved-networks";
import type {SavedNetwork} from "./irc/saved-networks";
import {
	decodeApplicationServerKey,
	keyChangePolicy,
	sameApplicationServerKey,
	usableApplicationServerKey,
} from "./helpers/pushKeys";
import {
	anyStale,
	entryStale,
	parseStoredSubscriptions,
	type LegacyEntry,
	type PushEntry,
	type PushKeys,
} from "./helpers/pushStore";
import {networkFromScope, pushScopePath} from "./push/scope";
import {
	loadNativePush,
	nativeClearNotifications,
	nativePushAvailable,
	nativePushCancelled,
	nativePushPermission,
	nativeRecordSeen,
	nativeSubscribe,
	nativeSubscription,
	nativeUnsubscribe,
	onNativeEndpointChange,
	refreshNativePush,
} from "./helpers/nativePush";
import {isAndroidShell, isIOSShell} from "./helpers/capacitor";
import {clearNativeAlert} from "./helpers/nativeAlerts";
import {ChanType} from "../../shared/types/chan";
import type {ClientChan} from "./types";

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

/** Device-local: the user said Yes to push here (the prompt, or Renew), in
 * the Android shell, where the notification permission alone does not say
 * so ({@link pushConsented}). */
const CONSENT_KEY = "thelounge.push.consent";

/** What the connect-time prompt asks: to subscribe this device to a
 * network, or to renew a subscription the server's VAPID rotation made
 * useless. */
type PromptKind = "subscribe" | "renew";

/** The connect-time prompt (yes/no/never). Rendered by
 * components/PushPrompt.vue; state lives here because the decision needs
 * this module's servers/subscriptions view. `network` is the uuid of the
 * network whose connect asked (the prompt names it), `vapid` the key a
 * subscription made from this prompt is created against, `armed` whether
 * it takes answers yet ({@link PROMPT_ARM_MS}). */
const pushPrompt = reactive<{
	visible: boolean;
	kind: PromptKind;
	network: string | undefined;
	vapid: string | undefined;
	armed: boolean;
}>({
	visible: false,
	kind: "subscribe",
	network: undefined,
	vapid: undefined,
	armed: false,
});

/** How long a prompt that has just opened takes no answer. It opens on its
 * own — a network connecting, or {@link PROMPT_HANDOFF_MS} after the last
 * prompt was answered, in the same place — so a click or tap meant for what
 * was there before must not answer it: above all a double-click's second
 * click, which comes up to ~500 ms (the usual OS setting) after the first,
 * i.e. up to ~200 ms into the next prompt; 450 ms covers a double-click
 * twice as slow as that and a tap aimed at the app as the prompt appears.
 * Nobody reads the question and answers it this fast. */
const PROMPT_ARM_MS = 450;

let promptArmTimer: ReturnType<typeof setTimeout> | undefined;

/** Per connected network, as announced by `webpush:available`: the server's
 * VAPID key (undefined when it cannot push) and whether this connection
 * logged in with SASL. Reactive so the per-network rows re-render. */
const servers = reactive(new Map<string, {vapid: string | undefined; sasl: boolean}>());

/** Persisted subscriptions by network uuid. Reactive for the same reason;
 * one object identity, mutated in place and saved through {@link saveSubs}. */
const subs = reactive<Record<string, PushEntry>>({});

/** What this page decided and what the browser and the server answered,
 * newest last — Settings → Notifications → Diagnostics ({@link diagnostics})
 * shows it beside the worker's own log, so a device nobody debugging it can
 * hold (an iPhone) can say where push stops. */
const JOURNAL_CAP = 60;
const journal: string[] = [];

function note(text: string): void {
	journal.push(`${new Date().toISOString()} ${text}`);

	if (journal.length > JOURNAL_CAP) {
		journal.splice(0, journal.length - JOURNAL_CAP);
	}
}

/** The first characters of a key or a uuid: enough to tell two apart. */
function short(value: string | null | undefined): string {
	return value ? `${value.slice(0, 10)}…` : "none";
}

/** A key's bytes as the base64url the server announced it in. */
function base64url(bytes: Uint8Array): string {
	let binary = "";

	for (const b of bytes) {
		binary += String.fromCharCode(b);
	}

	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** An endpoint for the eyes: its host and the tail of its path. The whole
 * URL is a capability — anyone holding it can push to the device — and the
 * report is meant to be pasted where others read it. */
function endpointLabel(endpoint: string | null | undefined): string {
	if (!endpoint) {
		return "none";
	}

	try {
		const url = new URL(endpoint);
		return `${url.host}/…${url.pathname.slice(-8)}`;
	} catch {
		return "unparsable";
	}
}

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

/** How this device takes pushes: through the Push API and a service worker
 * per network, as in a browser (`worker`), through the Android shell's
 * UnifiedPush registrations (`native`, helpers/nativePush.ts — its WebView
 * has no PushManager), or not at all. */
type PushBackend = "worker" | "native" | "none";

function pushBackend(): PushBackend {
	if (nativePushAvailable()) {
		return "native";
	}

	return typeof window !== "undefined" &&
		"PushManager" in window &&
		"serviceWorker" in navigator &&
		window.isSecureContext
		? "worker"
		: "none";
}

/** The browser half of Web Push, or the Android shell's stand-in for it. */
function browserSupported(): boolean {
	return pushBackend() !== "none";
}

/** Push through the Push API and service workers, as in a browser. */
function workerPush(): boolean {
	return pushBackend() === "worker";
}

/** Whether this device may show notifications: the browser's permission,
 * or Android's in the shell. */
function notificationPermission(): "granted" | "denied" | "prompt" {
	if (pushBackend() === "native") {
		return nativePushPermission();
	}

	if (typeof Notification === "undefined" || Notification.permission === "default") {
		return "prompt";
	}

	return Notification.permission;
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
	return notificationPermission() === "denied";
}

function permissionGranted(): boolean {
	return notificationPermission() === "granted";
}

/** Whether the user agreed to push on this device, so a network may be
 * subscribed without asking. In a browser that is the notification
 * permission, which only a Yes to the prompt (or the user in the browser's
 * settings) grants. Not in the Android shell: Android grants the permission
 * there by default before 13, and the "stay connected" service asks for it
 * for its own notification — so there the prompt's Yes (or Renew) is
 * recorded, and only that counts. */
function pushConsented(): boolean {
	if (!permissionGranted()) {
		return false;
	}

	return pushBackend() !== "native" || storage.get(CONSENT_KEY) !== null;
}

/** Remember that the user asked for push (see {@link pushConsented}). */
function recordConsent(): void {
	if (pushBackend() === "native") {
		storage.set(CONSENT_KEY, "1");
	}
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

/** Whether a subscribe under way for a network should still finish: the
 * network is still saved and its push still on. Asked after every wait, since
 * the user can switch push off, or remove the network, while the browser
 * asks for permission or creates the subscription. */
function stillWanted(uuid: string): boolean {
	return saved.get(uuid) !== undefined && pushOn(uuid);
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
	if (!subs[uuid] || !workerPush()) {
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
	if (pushBackend() === "native") {
		// The connector takes nothing else, and keeps (and crashes on) a key
		// it refuses: the shell checks too, this says so without asking it.
		if (!usableApplicationServerKey(vapid)) {
			throw new Error("the network's push key is not a P-256 public key");
		}

		// Bound to the key like a browser's: FCM checks the VAPID signature.
		return nativeSubscribe(uuid, saved.get(uuid)?.name ?? "", vapid);
	}

	const registration = await ensureRegistration(uuid);
	const applicationServerKey = decodeApplicationServerKey(vapid);
	const existing = await registration.pushManager.getSubscription();

	note(
		`subscribe ${short(uuid)}: registration active=${Boolean(
			registration.active
		)}, browser subscription ${existing ? endpointLabel(existing.endpoint) : "none"}`
	);

	if (
		existing &&
		!sameApplicationServerKey(existing.options.applicationServerKey, applicationServerKey)
	) {
		note(
			`subscribe ${short(uuid)}: the subscription was made against another key — dropping it`
		);
		await existing.unsubscribe();
	}

	const sub = await registration.pushManager.subscribe({
		userVisibleOnly: true,
		applicationServerKey,
	});

	note(`subscribe ${short(uuid)}: the browser subscribed (${endpointLabel(sub.endpoint)})`);

	return materialOf(sub);
}

/** An error's name and message, for the journal. */
function describeError(error: unknown): string {
	if (error && typeof error === "object") {
		const e = error as {name?: unknown; message?: unknown};
		return `${typeof e.name === "string" ? e.name : "Error"}: ${
			typeof e.message === "string" ? e.message : String(error)
		}`;
	}

	return String(error);
}

/** The root registration holds no subscription in the per-network design:
 * the pre-per-network one lived there, and an older root worker's
 * `pushsubscriptionchange` could make one again. One found at boot is
 * unsubscribed and its endpoint queued for `WEBPUSH UNREGISTER` on the
 * network whose key it was made against — left alone, the server pushes
 * every message to it as well, the root worker drops the copy as seen, and
 * that is a silent push on Chrome, every time. */
async function dropRootSubscription(): Promise<void> {
	if (!workerPush()) {
		return;
	}

	try {
		const registration = await navigator.serviceWorker.ready;
		const existing = await registration.pushManager.getSubscription();

		if (existing) {
			const key = existing.options.applicationServerKey;
			const vapid = key ? base64url(new Uint8Array(key)) : undefined;

			note(
				`boot: the root registration held a subscription (${endpointLabel(
					existing.endpoint
				)}) — dropped${vapid ? ", endpoint queued for UNREGISTER" : ""}`
			);

			if (vapid && queueUnregister({vapid, endpoint: existing.endpoint})) {
				saveLegacy();
			}

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
/** A push-only registration of this app for a network this device no
 * longer has (`push/<uuid>/` under this app's base, the uuid of no saved
 * network): its subscription is still an endpoint the server pushes every
 * message to, and its worker, finding the message already shown by the
 * live network's, showed nothing — on Chrome a silent push per message.
 * Dropped at every boot: the subscription (its endpoint queued for
 * UNREGISTER on the network whose key it carries) and the registration.
 * Another app on the origin (a Pages preview) has its own base and is
 * never touched. */
async function dropStaleRegistrations(): Promise<void> {
	if (!workerPush()) {
		return;
	}

	try {
		const base = new URL(pushScopePath(""), document.baseURI).href;
		let queued = false;

		for (const registration of await navigator.serviceWorker.getRegistrations()) {
			if (!registration.scope.startsWith(base)) {
				continue;
			}

			const uuid = networkFromScope(registration.scope);

			if (uuid === undefined || uuid === "" || saved.get(uuid) !== undefined) {
				continue;
			}

			const existing = await registration.pushManager.getSubscription();
			const key = existing?.options.applicationServerKey;
			const vapid = key ? base64url(new Uint8Array(key)) : undefined;

			note(
				`boot: push registration ${short(uuid)} is of no saved network — ${
					existing ? `its subscription (${endpointLabel(existing.endpoint)}) and ` : ""
				}the registration dropped${vapid ? ", endpoint queued for UNREGISTER" : ""}`
			);

			if (existing) {
				if (vapid && queueUnregister({vapid, endpoint: existing.endpoint})) {
					queued = true;
				}

				await existing.unsubscribe();
			}

			delete subs[uuid];
			await registration.unregister();
		}

		if (queued) {
			saveLegacy();
		}
	} catch (error) {
		// eslint-disable-next-line no-console
		console.warn("[webpush] could not drop stale push registrations", error);
	}
}

async function syncStoredWithBrowser(): Promise<void> {
	if (pushBackend() === "native") {
		return syncStoredWithShell();
	}

	if (!workerPush()) {
		return;
	}

	let changed = false;
	let queued = false;

	for (const uuid of Object.keys(subs)) {
		try {
			const registration = await pushRegistration(uuid);

			if (registration) {
				checkForNewWorker(registration);
			}

			const live = registration ? await registration.pushManager.getSubscription() : null;
			const entry = subs[uuid];

			if (!live) {
				// The browser dropped the subscription — WebKit does after three
				// silent pushes (service-worker.js), with no event — and the
				// server would keep pushing to the endpoint: the silent subscribe
				// the next connect makes replaces it, and each such cycle used to
				// leave one more dead endpoint on the account
				// (WEBPUSH_MAX_REGISTRATIONS). Tell the network to forget it when
				// it next connects (unregisterLegacy) — but only when this
				// build's own registration is there without a subscription. No
				// registration at all may mean another build on the same origin
				// (a Pages preview under /pr<N>/ shares `thelounge.push` with the
				// release app), whose live endpoint must not be unregistered.
				if (registration) {
					queued =
						queueUnregister({
							vapid: entry.vapid,
							endpoint: entry.endpoint,
							network: uuid,
						}) || queued;
				}

				note(
					`sync ${short(uuid)}: registration ${
						registration ? "found" : "missing"
					}, no browser subscription — entry ${endpointLabel(entry.endpoint)} dropped${
						registration ? ", endpoint queued for UNREGISTER" : ""
					}`
				);
				delete subs[uuid];
				changed = true;
				continue;
			}

			const material = materialOf(live);

			if (
				material.endpoint !== entry.endpoint ||
				material.keys.p256dh !== entry.keys.p256dh ||
				material.keys.auth !== entry.keys.auth
			) {
				note(
					`sync ${short(uuid)}: the browser's subscription changed (${endpointLabel(
						material.endpoint
					)}) — entry updated`
				);
				subs[uuid] = {vapid: entry.vapid, ...material};
				changed = true;
			} else {
				note(
					`sync ${short(uuid)}: entry matches the browser (${endpointLabel(
						entry.endpoint
					)})`
				);
			}
		} catch (error) {
			// leave the entry; the server-side re-REGISTER is idempotent
			note(`sync ${short(uuid)}: failed — ${describeError(error)}`);
		}
	}

	if (changed) {
		saveSubs();
		refreshState();
	}

	if (queued) {
		saveLegacy();
	}
}

/** {@link syncStoredWithBrowser} for the Android shell: an entry follows the
 * endpoint and keys the distributor renewed — or a renewal that outlived its
 * subscribe() call, under the key it was made for — and goes when the app no
 * longer holds the network (data cleared, reinstalled, the distributor
 * dropped it). An endpoint replaced or dropped is queued for unregistering
 * on its network, as subscribe() does with a replaced one: left registered,
 * the server would keep pushing to it while it still works. A shell that
 * cannot be asked leaves the entry as it is. */
async function syncStoredWithShell(): Promise<void> {
	let changed = false;
	let queued = false;

	for (const uuid of Object.keys(subs)) {
		let live: Awaited<ReturnType<typeof nativeSubscription>>;

		try {
			live = await nativeSubscription(uuid);
		} catch (error) {
			// eslint-disable-next-line no-console
			console.warn("[webpush] could not read the shell's subscription", error);
			continue;
		}

		const entry = subs[uuid];

		if (!live || live.endpoint !== entry.endpoint) {
			queued =
				queueUnregister({vapid: entry.vapid, endpoint: entry.endpoint, network: uuid}) ||
				queued;
		}

		if (!live) {
			delete subs[uuid];
			changed = true;
		} else if (
			live.endpoint !== entry.endpoint ||
			live.keys.p256dh !== entry.keys.p256dh ||
			live.keys.auth !== entry.keys.auth ||
			(live.vapid ?? entry.vapid) !== entry.vapid
		) {
			// A new endpoint, or the same one with new keys: the next REGISTER
			// (autoRegister) carries them; the server would otherwise encrypt
			// to keys nobody holds. A late renewal can bring back the same
			// endpoint and keys under the new key, and the entry must take it
			// or the network reads as stale and is never re-registered.
			subs[uuid] = {
				vapid: live.vapid ?? entry.vapid,
				endpoint: live.endpoint,
				keys: live.keys,
			};
			changed = true;
		}
	}

	if (changed) {
		saveSubs();
	}

	if (queued) {
		saveLegacy();
	}

	refreshState();
}

/** Queue an endpoint for unregistering on its network, once: false when it
 * is queued already. */
function queueUnregister(item: LegacyEntry): boolean {
	if (legacy.some((queued) => queued.endpoint === item.endpoint)) {
		return false;
	}

	legacy.push(item);
	return true;
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
				renewal: true,
			});
			await writeStash(); // every connect: the worker's copy of the networks stays current
		}
	})();
}

/** Tell a connecting network to forget the endpoints queued for it: those
 * of the old shared subscription registered under its key, and those the
 * Android distributor replaced on it. */
function unregisterLegacy(uuid: string, vapid: string | undefined): void {
	if (vapid === undefined || legacy.length === 0) {
		return;
	}

	const isMine = (item: LegacyEntry) =>
		item.network !== undefined ? item.network === uuid : item.vapid === vapid;
	const mine = legacy.filter(isMine);

	if (mine.length === 0) {
		return;
	}

	for (const item of mine) {
		socket.emit("webpush:unregister", {network: uuid, endpoint: item.endpoint});
	}

	legacy = legacy.filter((item) => !isMine(item));
	saveLegacy();
}

socket.on("webpush:available", ({network, vapid, sasl}) => {
	servers.set(network, {vapid, sasl});

	// The Android shell's stand-in for the `init` sweep below: this network
	// registered in front of the user, who catches up on it in-app. The
	// shell, not the backend: notifications already shown go whether or not
	// a distributor is still there.
	if (isAndroidShell() && document.visibilityState === "visible" && document.hasFocus()) {
		nativeClearNotifications(network);
	}

	autoRegister(network, vapid);
	refreshState();
	// After the boot reconciliation: in the Android shell whether push is
	// available at all is the shell's answer to a bridge call, which an
	// autoconnect's registration can beat, and the reconciliation is what
	// queues an endpoint the distributor replaced for unregistering.
	void synced.then(() => {
		unregisterLegacy(network, vapid);
		maybePrompt(network);
	});
});

/** subscribe() runs in flight, by network: a burst of connects, a Renew
 * click and a prompt's Yes for the same network share one run. */
const subscribing = new Map<string, Promise<void>>();

/** Networks whose turn at the prompt came while it was busy
 * ({@link promptBusy}); {@link scheduleHandoff} looks at them again once it
 * is free. Only these: a network decided on its own turn is not looked at
 * again until it reconnects, so a subscribe that keeps failing under a
 * granted permission is tried once per connection, not in a loop. */
const waiting = new Set<string>();

/** How long the prompt stays closed before the next network's opens: longer
 * than the overlay's 0.2 s fade, so the user sees one question close and
 * another open rather than the text changing under the pointer. */
const PROMPT_HANDOFF_MS = 300;

let handoffTimer: ReturnType<typeof setTimeout> | undefined;

/** Prompts answered "not now" in this page, by `declineKey`: a reconnect
 * (every registration announces `webpush:available`) must not ask again,
 * and a permission granted since (another network's Yes) does not turn it
 * into a silent subscribe. Page-lived on purpose — a reload asks once more,
 * "never" is the lasting answer — and keyed by kind and key, so declining to
 * subscribe does not silence the renew prompt a later key rotation brings. */
const declined = new Set<string>();

function declineKey(kind: PromptKind, uuid: string, vapid: string): string {
	return `${kind} ${uuid} ${vapid}`;
}

/** The subscribe a Yes started, until it settles: while it runs the
 * browser's own permission dialog may be up, `Notification.permission`
 * still says "default", and a second network asking now would open its
 * prompt over it. Only a Yes holds the prompt — a silent subscribe (the
 * permission already granted, or a trusted renewal) asks the user nothing,
 * and a Renew click comes from a form, not from the prompt. */
let promptHold: Promise<void> | undefined;

let promptHoldTimer: ReturnType<typeof setTimeout> | undefined;

/** How long a Yes's subscribe may hold the prompt. A permission dialog the
 * user leaves open, or a subscribe that never settles (a worker that never
 * activates), must not keep every other network from being asked until the
 * page is reloaded; past this, the next network's prompt may open over a
 * permission dialog still up — the lesser harm. */
const PROMPT_HOLD_MAX_MS = 60000;

function holdPrompt(run: Promise<void>): void {
	clearTimeout(promptHoldTimer);
	promptHold = run;

	const release = () => {
		if (promptHold !== run) {
			return; // a later Yes holds it now
		}

		clearTimeout(promptHoldTimer);
		promptHold = undefined;
		promptHoldTimer = undefined;
		scheduleHandoff();
	};

	promptHoldTimer = setTimeout(release, PROMPT_HOLD_MAX_MS);
	void run.finally(release);
}

/** The prompt is busy while it is open, while a Yes's subscribe holds it
 * ({@link promptHold}), and while a hand-off is on its way, so a network
 * announcing in the gap queues behind the ones already waiting instead of
 * jumping ahead. */
function promptBusy(): boolean {
	return pushPrompt.visible || promptHold !== undefined || handoffTimer !== undefined;
}

/** The one place the prompt passes on: called whenever it may have become
 * free (it closed, a Yes's subscribe settled). Once it is, the waiting
 * networks get their turn, on a later task — never in the tick that closed
 * the last prompt — each by its own rules and only while still connected;
 * the first that needs the prompt opens it and the rest wait again. */
function scheduleHandoff(): void {
	if (waiting.size === 0 || promptBusy()) {
		return;
	}

	handoffTimer = setTimeout(() => {
		handoffTimer = undefined;

		if (promptBusy()) {
			return; // what made it busy calls back here when it settles
		}

		const next = [...waiting];
		waiting.clear();

		for (const uuid of next) {
			if (networkUp(uuid)) {
				maybePrompt(uuid);
			}
		}
	}, PROMPT_HANDOFF_MS);
}

/** Offer the prompt once per connection that logged in with SASL on a
 * push-capable network: the server can push only for accounts, so an
 * anonymous connect has nothing to offer. Skipped when this browser cannot
 * subscribe or permission is already denied. One prompt at a time: a
 * network that needs it while it is busy ({@link promptBusy}) waits its
 * turn; one that needs no question (a silent subscribe) does not wait.
 *
 * "Not now" ({@link declined}) holds for the page whatever happens to the
 * permission meanwhile: a network the user said no to is not subscribed
 * because another network's Yes granted permission since. Otherwise, with
 * no entry for the network it asks to subscribe (or just subscribes when
 * permission is already granted — the network's push option is the user's
 * choice), unless the user answered "never" on this device. With an entry
 * made against a key the network no longer announces, the `pushKeyChange`
 * setting decides: `ask` (default) opens the renew prompt, permission or
 * not — the renewal replaces the endpoint the server pushes to; `trust`
 * renews on the spot when permission is granted (otherwise the prompt's
 * button is the gesture the permission ask needs); `ignore` does nothing —
 * the entry stays stale and the network's settings keep offering Renew. The
 * renew prompt's "Never" sets `ignore`, so the choice is visible and
 * reversible in Settings. */
function maybePrompt(uuid: string): void {
	const server = servers.get(uuid);

	if (!server || !server.sasl || server.vapid === undefined || !pushOn(uuid)) {
		note(
			`connect ${short(uuid)}: nothing to offer — ${
				!server
					? "not connected"
					: !server.sasl
					? "no SASL login"
					: server.vapid === undefined
					? "the server announced no push key"
					: "push is off for this network"
			}`
		);
		return;
	}

	// A subscribe already running for it answers the question; asking again
	// meanwhile would reopen a renew prompt for a key it is replacing.
	if (subscribing.has(uuid)) {
		return;
	}

	if (!browserSupported() || needsInstall() || permissionDenied()) {
		note(
			`connect ${short(uuid)}: cannot subscribe here — ${
				!browserSupported()
					? "no Push API"
					: needsInstall()
					? "iOS, not installed to the Home Screen"
					: "permission denied"
			}`
		);
		return;
	}

	const vapid = server.vapid;

	// Nothing to offer: the shell cannot subscribe with that key.
	if (pushBackend() === "native" && !usableApplicationServerKey(vapid)) {
		return;
	}

	const entry = subs[uuid];

	if (entry && entry.vapid === vapid) {
		note(
			`connect ${short(uuid)}: subscribed (${endpointLabel(entry.endpoint)}), re-registering`
		);
		return; // subscribed; autoRegister re-registers it
	}

	const kind: PromptKind = entry ? "renew" : "subscribe";

	if (declined.has(declineKey(kind, uuid, vapid))) {
		note(`connect ${short(uuid)}: ${kind} declined earlier on this page`);
		return;
	}

	if (kind === "renew") {
		const policy = keyChangePolicy(store.state.settings.pushKeyChange);

		if (policy === "ignore") {
			note(`connect ${short(uuid)}: key changed, policy ignore`);
			return;
		}

		if (policy === "trust" && pushConsented()) {
			note(`connect ${short(uuid)}: key changed, renewing silently`);
			void subscribe(uuid);
			return;
		}

		note(`connect ${short(uuid)}: key changed, asking to renew`);
		askOrWait("renew", uuid, vapid);
		return;
	}

	// Permission already granted (in the Android shell: the user said Yes
	// before, pushConsented): subscribe directly instead of asking again.
	// "default" (never asked) needs a user gesture, which the prompt's
	// buttons provide; "never ask again" suppresses that prompt on this
	// device.
	if (pushConsented()) {
		note(`connect ${short(uuid)}: no entry, permission granted — subscribing silently`);
		void subscribe(uuid);
		return;
	}

	if (storage.get(NEVER_ASK_KEY)) {
		note(`connect ${short(uuid)}: no entry, never ask again is set`);
		return;
	}

	note(`connect ${short(uuid)}: no entry, asking`);
	askOrWait("subscribe", uuid, vapid);
}

/** Open the prompt for a network that needs it, or — while it is busy
 * ({@link promptBusy}) — queue the network for its turn. Only a question
 * waits: what needs no answer (a silent subscribe) goes ahead at once. */
function askOrWait(kind: PromptKind, uuid: string, vapid: string): void {
	if (pushPrompt.visible && pushPrompt.network === uuid) {
		return; // already asking it
	}

	if (promptBusy()) {
		waiting.add(uuid);
		return;
	}

	openPrompt(kind, uuid, vapid);
}

function openPrompt(kind: PromptKind, network: string, vapid: string): void {
	pushPrompt.kind = kind;
	pushPrompt.network = network;
	pushPrompt.vapid = vapid;
	pushPrompt.armed = false;
	pushPrompt.visible = true;

	clearTimeout(promptArmTimer);
	promptArmTimer = setTimeout(() => {
		pushPrompt.armed = true;
	}, PROMPT_ARM_MS);
}

/** The prompt's one way out: every answer, a network whose push is
 * switched off while it asks, and one that disconnects. The next network's
 * turn follows from here, once whatever the answer started has settled. */
function closePrompt(): void {
	clearTimeout(promptArmTimer);
	pushPrompt.armed = false;
	pushPrompt.visible = false;
	scheduleHandoff();
}

/** A network that drops (or is removed) while its prompt is up: the
 * question goes with the connection, unanswered — a Yes now would subscribe
 * against a server that cannot take the registration, and the networks
 * waiting behind it would wait for nothing. The next connect asks again. */
function dropNetworkPrompt(uuid: string): void {
	waiting.delete(uuid);

	if (pushPrompt.visible && pushPrompt.network === uuid) {
		closePrompt();
	}
}

socket.on("network:status", ({network, connected}) => {
	if (!connected) {
		dropNetworkPrompt(network);
	}
});

socket.on("quit", ({network}) => {
	dropNetworkPrompt(network);
});

type PromptAnswer = "yes" | "no" | "never";

/**
 * The user's answer to the prompt that names `network` — the network the
 * prompt showed when the user acted (PushPrompt.vue passes it). An answer
 * for a prompt that is not open, or that asks about another network by now,
 * answers nothing: the user never saw that question. Nor does one in the
 * prompt's first moments ({@link PROMPT_ARM_MS}): it was meant for what was
 * on screen before.
 *
 * - yes: subscribe, or renew — the same flow; the click is the permission
 *   user gesture, so the subscribe starts here, in the click's task.
 * - no: not now — not asked again until the page is reloaded (or the
 *   network's push option is switched back on).
 * - never: never ask this question again on this device. For the renew
 *   prompt that is the `pushKeyChange` setting flipped to `ignore` (visible
 *   and reversible in Settings → Notifications); a stale entry stays stale,
 *   nothing is unsubscribed behind the user's back.
 */
function answerPrompt(answer: PromptAnswer, network: string | undefined): void {
	if (
		!pushPrompt.visible ||
		!pushPrompt.armed ||
		network === undefined ||
		network !== pushPrompt.network
	) {
		return;
	}

	const {kind, vapid} = pushPrompt;

	if (answer === "yes") {
		recordConsent();
		holdPrompt(subscribe(network));
	} else if (answer === "no") {
		if (vapid !== undefined) {
			declined.add(declineKey(kind, network, vapid));
		}
	} else if (kind === "renew") {
		void store.dispatch("settings/update", {
			name: "pushKeyChange",
			value: "ignore",
			sync: true,
		});
	} else {
		storage.set(NEVER_ASK_KEY, "1");
	}

	closePrompt();
}

socket.on("webpush:state", ({network, action, endpoint, ok, code, reason}) => {
	note(
		`server ${short(network)}: ${action} ${endpointLabel(endpoint)} ${
			ok ? "acknowledged" : `refused (${code ?? "?"}: ${reason ?? "no reason given"})`
		}`
	);

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
 * Resolves when that is done — a call while a run for the network is in
 * flight gets that run, not a second one.
 */
function subscribe(uuid: string): Promise<void> {
	const running = subscribing.get(uuid);

	if (running) {
		return running;
	}

	if (!browserSupported()) {
		refreshState();
		return Promise.resolve();
	}

	// Started before it is recorded, so the permission request is made in
	// this task — the caller's user gesture.
	const run = subscribeNow(uuid).finally(() => {
		subscribing.delete(uuid);
	});

	subscribing.set(uuid, run);
	return run;
}

async function subscribeNow(uuid: string): Promise<void> {
	try {
		// The shell asks for Android's permission inside its subscribe. In a
		// browser the permission is asked for only while it is undecided:
		// WebKit's requestPermission() resolves "denied" whenever it is called
		// without a user gesture, with the permission already granted too
		// (Notification.cpp checks the gesture first and never the stored
		// permission), and the silent subscribes have no gesture — the one
		// after the browser dropped a subscription (iOS, after three silent
		// pushes), a second network's, a renewal under `trust`, a worker's
		// resubscribe. On an iPhone every one of them ended here as "denied"
		// while iOS still allowed notifications, so a revoked subscription was
		// never made again. subscribe() itself needs no gesture once the
		// permission is granted (PushManager.cpp).
		const permissionBefore = notificationPermission();
		const permission =
			pushBackend() === "native" || permissionBefore === "granted"
				? "granted"
				: await Notification.requestPermission();

		note(
			`subscribe ${short(uuid)}: permission ${permissionBefore}${
				permissionBefore === "granted" || pushBackend() === "native"
					? ""
					: ` → asked → ${permission}`
			}`
		);

		if (permission !== "granted") {
			// Refused: by the user, or by WebKit for want of a gesture while the
			// permission is still undecided — then nobody was asked, and the
			// next connect's prompt asks with a button.
			if (notificationPermission() === "denied") {
				setState("denied");
			} else {
				refreshState();
			}

			return;
		}

		if (!stillWanted(uuid)) {
			refreshState();
			return;
		}

		const vapid = announcedKey(uuid);

		if (vapid === undefined) {
			// The network is not connected, or cannot push (cap not negotiated
			// or no key): nothing to subscribe against right now.
			note(`subscribe ${short(uuid)}: the network is not connected or announced no key`);
			refreshState();
			return;
		}

		// Client-side enforcement of the account requirement (the server
		// refuses REGISTER without one anyway).
		const net = saved.get(uuid);

		if (!net || !net.saslAccount) {
			note(`subscribe ${short(uuid)}: the network has no SASL account`);
			setState("blocked");
			return;
		}

		const material = await pushSubscription(uuid, vapid);

		// Switched off or removed meanwhile: nothing is stored or registered.
		// Switching off unsubscribes once this run has settled
		// (onNetworkSaved), which drops the subscription just made, the
		// browser's or the shell's.
		if (!stillWanted(uuid)) {
			refreshState();
			return;
		}

		// Read now, not before the subscription was made: the shell's
		// distributor may have replaced the endpoint meanwhile, and
		// syncStoredWithShell has then queued the old one for unregistering
		// already — it must not be unregistered twice.
		const previous = subs[uuid]?.endpoint;
		subs[uuid] = {vapid, ...material};
		saveSubs();

		// The browser mints a fresh endpoint whenever the subscription is
		// recreated; without this the old one stays registered on the account
		// and the server keeps pushing to it — every notification twice.
		if (previous !== undefined && previous !== material.endpoint) {
			socket.emit("webpush:unregister", {network: uuid, endpoint: previous});
		}

		// Unqueued: an endpoint the shell handed out again (the distributor
		// kept it) is live and must not be unregistered, and the one just
		// unregistered must not be unregistered again when the network
		// next connects.
		const settled = (item: LegacyEntry) =>
			item.endpoint === material.endpoint || item.endpoint === previous;

		if (legacy.some(settled)) {
			legacy = legacy.filter((item) => !settled(item));
			saveLegacy();
		}

		await writeStash();

		if (!stillWanted(uuid)) {
			refreshState();
			return; // the unsubscribe waiting for this run forgets the entry
		}

		note(
			`subscribe ${short(uuid)}: WEBPUSH REGISTER sent (${endpointLabel(material.endpoint)})`
		);
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
		note(`subscribe ${short(uuid)}: failed — ${describeError(error)}`);

		// Push switched off for this network while the shell was subscribing:
		// it withdrew the registration, and that is all that happened.
		if (!pushOn(uuid) || nativePushCancelled(error)) {
			refreshState();
			return;
		}

		// A renewal through the shell that failed (timed out waiting for the
		// distributor, say) left the subscription it would have replaced in
		// place: that one still stands, and the state says so.
		if (pushBackend() === "native" && subs[uuid] !== undefined && !permissionDenied()) {
			refreshState();
			// eslint-disable-next-line no-console
			console.warn("[webpush] renewal failed; the previous subscription stays", error);
			return;
		}

		setState(permissionDenied() ? "denied" : "blocked");
		// eslint-disable-next-line no-console
		console.warn("[webpush] subscription failed", error);
	}
}

/** Settings opened: say where push stands now. In the Android shell the
 * permission is read again first — it may have been granted in Android's
 * settings since the page last asked, and nothing else re-reads it. */
function refresh(): void {
	refreshState();

	if (pushBackend() === "native") {
		void refreshNativePush().then(refreshState);
	}
}

/** Renew this device's subscription for one network — the Edit-network
 * form's button when {@link networkPushInfo} says `stale` — against the key
 * that network announces (the click is the permission user gesture). */
function renew(uuid: string): void {
	recordConsent();
	void subscribe(uuid);
}

/** The networks the stash in IndexedDB carries a login for (an account and
 * a remembered password): what the worker can sign in with when no page is
 * left. Seeded from the stash itself at boot, since a reloaded page needs
 * it before its own first write, and replaced by every write. Read
 * synchronously at `pagehide` ({@link hasStashedLogin}). */
const stashedLogins = new Set<string>();
let stashWritten = false;

function noteStashedLogins(
	networks: {uuid?: unknown; saslAccount?: unknown; saslPassword?: unknown}[]
): void {
	stashedLogins.clear();

	for (const net of networks) {
		if (typeof net.uuid === "string" && net.saslAccount && net.saslPassword) {
			stashedLogins.add(net.uuid);
		}
	}
}

/** Whether the service worker holds a login for `uuid` (presence.ts
 * `leavesAwayToWorker`: the deferred `AWAY *` of a closing page). */
export function hasStashedLogin(uuid: string): boolean {
	return stashedLogins.has(uuid);
}

if (typeof indexedDB !== "undefined") {
	void idbGet<{networks?: unknown}>("stash")
		.then((stash) => {
			// A write that landed first is newer: keep it.
			if (!stashWritten && Array.isArray(stash?.networks)) {
				noteStashedLogins(stash.networks);
			}
		})
		.catch(() => undefined);
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
		stashWritten = true;
		noteStashedLogins(networks);
	} catch (error) {
		// eslint-disable-next-line no-console
		console.warn("[webpush] could not write the service worker stash", error);
	}
}

/** Unsubscribe this device from one network: drop its browser subscription
 * and registration, tell the network, forget the entry. */
async function unsubscribe(uuid: string): Promise<void> {
	try {
		const registration = workerPush() ? await pushRegistration(uuid) : undefined;
		const live = registration ? await registration.pushManager.getSubscription() : null;

		if (live) {
			await live.unsubscribe();
		}

		// The shell, not the backend: whether a distributor is still there or
		// not (Play services or ntfy removed since), the registration and the
		// shell's record of it go.
		if (isAndroidShell()) {
			await nativeUnsubscribe(uuid);
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

/** Per-network browser-notification flag (the editor's checkbox), reactive
 * so sidebar icons re-render on edits; seeded from storage on first read. */
const notifyFlags = reactive(new Map<string, boolean>());

/** React to a saved network whose push flag changed (NetworkEdit form).
 *
 * Off: this device unsubscribes from that network right away — its
 * subscription and registration go, the network is told, and a prompt
 * asking about it closes.
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
		// Its question is moot: a prompt asking about it closes, unanswered.
		waiting.delete(next.uuid);

		if (pushPrompt.visible && pushPrompt.network === next.uuid) {
			closePrompt();
		}

		// A subscribe still running for it would store and register the
		// subscription after the unsubscribe had finished: let it settle
		// first (it sees push is off and stops short). Switched back on
		// meanwhile, the subscribe it finished is the one wanted: keep it.
		const running = subscribing.get(next.uuid);

		void (async () => {
			await running;

			if (!pushOn(next.uuid)) {
				await unsubscribe(next.uuid);
			}
		})();
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
synced = loadNativePush()
	.then(syncStoredWithBrowser)
	.then(dropRootSubscription)
	.then(dropStaleRegistrations)
	.catch(() => undefined);
refreshState();

// The Android shell's distributor renewed or dropped an endpoint by itself:
// follow it, and tell the network the new one if it is connected.
onNativeEndpointChange((uuid) => {
	// Never rejects: every later `synced.then` (autoRegister, the prompt)
	// waits on it.
	synced = synced
		.then(syncStoredWithShell)
		.then(() => {
			const server = servers.get(uuid);
			unregisterLegacy(uuid, server?.vapid);
			autoRegister(uuid, server?.vapid);
		})
		.catch((error) => {
			// eslint-disable-next-line no-console
			console.warn("[webpush] could not follow the shell's endpoint change", error);
		});
});

/** WebKit refuses a close within 30 s of a show, and replaces nothing by
 * tag: what is left after that is closed by doing it again
 * (service-worker.js `tidy`). */
const AGAIN_AFTER_MS = 32_000;
/** The same for a message the page took: its push reaches the worker later
 * than the message reaches the page, and its quiet stub's 30 s start then. */
const TIDY_AFTER_PUSH_MS = 60_000;
const againTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Run `fn` after `delay`, in place of what was waiting under `key`. */
function again(key: string, delay: number, fn: () => void): void {
	clearTimeout(againTimers.get(key));
	againTimers.set(
		key,
		setTimeout(() => {
			againTimers.delete(key);
			fn();
		}, delay)
	);
}

// Opening the app means the user is catching up in-app: drop any push
// notifications the workers are still showing (badge included). Each
// network's worker keeps its own, so every registration is swept. The
// Android shell sees no `init` when it is opened (the "stay connected"
// service keeps its networks registered); there a network registering in
// front of the user is the catching up, and only that network's go — a
// reconnect behind the user's back closes nothing (`webpush:available`).
socket.on("init", async () => {
	if (!workerPush()) {
		return;
	}

	try {
		await closePushNotifications();
		// WebKit refuses those closes for a notification under 30 s old:
		// close them again once it lets them through, but not what came since.
		const openedAt = Date.now();
		again("opened", AGAIN_AFTER_MS, () => void closePushNotifications(openedAt));

		await idbSet("badge", {});

		if (navigator.clearAppBadge) {
			void navigator.clearAppBadge();
		}
	} catch {
		// no SW / not ready — nothing to clear
	}
});

/** Close the push notifications every registration shows: all of them, or
 * those shown before `before` (the worker's `data.shownAt`, on this clock). */
async function closePushNotifications(before = Infinity): Promise<void> {
	for (const registration of await navigator.serviceWorker.getRegistrations()) {
		for (const n of await registration.getNotifications()) {
			if (n.tag && n.tag.startsWith("push-") && (Number(n.data?.shownAt) || 0) < before) {
				n.close();
			}
		}
	}
}

/** The page took a pushable message on `uuid`: in the Android shell, its
 * push for this device shows nothing. A network this device is not
 * subscribed on gets no push, so there is nothing to tell the shell. */
function recordSeenOnShell(uuid: string, msgid: string | undefined): void {
	if (pushBackend() === "native" && subs[uuid] !== undefined) {
		nativeRecordSeen(msgid);
	}
}

// Reading a conversation closes what the network's push worker shows for
// it. The page's own notifications live there (pushWorkerFor), and the
// server's read push only follows a message it pushed — a notification the
// page put on the worker while the account was attended has nobody else to
// close it, and would otherwise come back counted in the next push.
/** How long a hidden page on Chrome waits before closing a notification
 * for a read another session made: the server's relay of that read reaches
 * the worker within seconds and, finding the notification still up, closes
 * it itself just after its event — a relay that finds nothing is a silent
 * push there (service-worker.js `readRelay`). */
const ECHO_READ_DELAY_MS = 8000;

/** WebKit on this page: where the worker's own 30 s rules apply, and where
 * there is no silent-push budget to protect by waiting. */
function webkitPage(): boolean {
	return /AppleWebKit\//.test(navigator.userAgent) && !/Chrome\//.test(navigator.userAgent);
}

function readOnWorker(uuid: string, channel: ClientChan, echo = false): void {
	const target = channel.name;

	// The shell, not the backend: its notifications are closed even after
	// the distributor that brought them is gone.
	if (isAndroidShell()) {
		nativeClearNotifications(uuid, target);
		return;
	}

	if (isIOSShell()) {
		clearNativeAlert(uuid, target);
		return;
	}

	const send = (ts?: string) =>
		void pushWorkerFor(uuid).then((worker) => worker?.postMessage({type: "read", target, ts}));

	if (echo && !webkitPage() && document.visibilityState !== "visible") {
		again(`echo ${uuid} ${target}`, ECHO_READ_DELAY_MS, () => send());
	} else {
		send();
	}

	// WebKit refuses a close within 30 s of a show: read it again once that
	// has passed, up to the newest message read now (a server time, as the
	// worker's are), so a message that came since stays.
	const time = channel.messages.findLast((m) => !m.pending)?.time;

	if (time && workerPush() && subs[uuid] !== undefined) {
		const ts = new Date(time).toISOString();
		again(`read ${uuid} ${target}`, AGAIN_AFTER_MS, () => send(ts));
	}
}

/** A push for a message the page took on `uuid` is showing quietly on its
 * push worker: tidy it once WebKit lets the closes through. */
function tidySoon(uuid: string): void {
	if (pushBackend() === "native" || !workerPush() || subs[uuid] === undefined) {
		return;
	}

	again(
		`tidy ${uuid}`,
		TIDY_AFTER_PUSH_MS,
		() => void pushWorkerFor(uuid).then((worker) => worker?.postMessage({type: "tidy"}))
	);
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

	readOnWorker(active.network.uuid, active.channel);
}

store.watch((state) => state.activeChannel, readActive);
window.addEventListener("focus", readActive);
document.addEventListener("visibilitychange", readActive);

// Another session read it to the end (draft/read-marker).
socket.on("markread", (data) => {
	const found = data.unread === 0 ? store.getters.findChannel(data.chan) : undefined;

	if (found) {
		readOnWorker(found.network.uuid, found.channel, true);
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

/**
 * Subscribe this device to every connected network that announced a push
 * key and has push on — the Diagnostics button, a user gesture: the one
 * road that works whatever the silent path did, and the one whose outcome
 * the journal reports in the browser's own words.
 */
async function subscribeConnected(): Promise<void> {
	const targets = saved
		.list()
		.filter((net) => pushOn(net.uuid) && announcedKey(net.uuid) !== undefined);

	if (targets.length === 0) {
		note("Subscribe now: no connected network announces a push key");
		return;
	}

	for (const net of targets) {
		note(`Subscribe now: ${short(net.uuid)} (${net.name || net.host})`);
		await subscribe(net.uuid);
	}
}

/**
 * Everything this device knows about push, as text to copy: the
 * environment, the permission, each network's announced key, stored entry,
 * registration and live browser subscription, the journal, and the worker's
 * own log (service-worker.js `logPush`). Endpoints and keys are shortened:
 * the report is meant to be pasted where others read it.
 */
async function diagnostics(): Promise<string> {
	const lines: string[] = [];
	const standalone =
		(typeof window.matchMedia === "function" &&
			window.matchMedia("(display-mode: standalone)").matches) ||
		window.navigator.standalone === true;

	lines.push(`push diagnostics ${new Date().toISOString()}`);
	lines.push(
		`build ${process.env.SEANCE_VERSION || "dev"} (${BUILD}) at ${location.origin}${
			location.pathname
		}`
	);
	lines.push(`agent ${navigator.userAgent}`);
	lines.push(
		`backend=${pushBackend()} standalone=${standalone} secure=${window.isSecureContext} ` +
			`PushManager=${"PushManager" in window} serviceWorker=${
				"serviceWorker" in navigator
			} ` +
			`Notification=${typeof Notification !== "undefined"}`
	);
	lines.push(
		`permission=${notificationPermission()} state=${store.state.pushNotificationState} ` +
			`neverAsk=${storage.get(NEVER_ASK_KEY) !== null} consent=${
				storage.get(CONSENT_KEY) !== null
			} keyChange=${store.state.settings.pushKeyChange}`
	);

	for (const net of saved.list()) {
		const server = servers.get(net.uuid);
		const entry = subs[net.uuid];
		const live = store.getters.findNetwork(net.uuid);

		lines.push(
			`network ${short(net.uuid)} ${net.name || net.host}: push=${
				pushOn(net.uuid) ? "on" : "off"
			} sasl=${net.saslAccount ? "account" : "none"} connected=${Boolean(
				live && live.status.connected
			)} announcedKey=${server ? short(server.vapid) : "not announced"} saslLogin=${
				server ? server.sasl : "n/a"
			}`
		);
		lines.push(
			`  entry: ${
				entry ? `${endpointLabel(entry.endpoint)} key=${short(entry.vapid)}` : "none"
			}`
		);

		if (workerPush()) {
			try {
				const registration = await pushRegistration(net.uuid);

				if (!registration) {
					lines.push("  registration: none");
				} else {
					const subscription = await registration.pushManager.getSubscription();
					lines.push(
						`  registration: active=${Boolean(
							registration.active
						)} installing=${Boolean(registration.installing)} waiting=${Boolean(
							registration.waiting
						)}`
					);
					lines.push(
						`  browser subscription: ${
							subscription
								? `${endpointLabel(subscription.endpoint)} key=${short(
										subscription.toJSON().keys?.p256dh
								  )} expires=${subscription.expirationTime ?? "never"}`
								: "none"
						}`
					);
				}
			} catch (error) {
				lines.push(`  registration: failed — ${describeError(error)}`);
			}
		}
	}

	if (workerPush()) {
		try {
			const registrations = await navigator.serviceWorker.getRegistrations();
			lines.push(`service worker registrations: ${registrations.length}`);

			for (const registration of registrations) {
				const scope = registration.scope.replace(location.origin, "");
				const subscription = await registration.pushManager.getSubscription();
				lines.push(
					`  ${scope} active=${Boolean(registration.active)} subscription=${
						subscription ? endpointLabel(subscription.endpoint) : "none"
					}`
				);
			}
		} catch (error) {
			lines.push(`service worker registrations: failed — ${describeError(error)}`);
		}
	}

	lines.push("journal:");

	for (const line of journal) {
		lines.push(`  ${line}`);
	}

	lines.push("worker log:");

	try {
		const log = await idbGet<unknown>("pushlog");

		if (Array.isArray(log) && log.length > 0) {
			for (const line of log) {
				lines.push(`  ${String(line)}`);
			}
		} else {
			lines.push("  empty");
		}
	} catch (error) {
		lines.push(`  unreadable — ${describeError(error)}`);
	}

	return lines.join("\n");
}

export default {
	subscribe,
	renew,
	unsubscribe,
	refresh,
	onNetworkSaved,
	networkPushInfo,
	notifyOn,
	pushWorkerFor,
	recordSeenOnShell,
	tidySoon,
	pushPrompt,
	answerPrompt,
	subscribeConnected,
	diagnostics,
};
