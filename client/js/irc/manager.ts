/**
 * NetworkManager: the registry of live {@link IrcClient}s keyed by network
 * uuid. Imported once at boot for its side effect (registering the bus
 * handlers, see `bus.ts`); the connect form calls {@link createNetwork}.
 *
 * Several networks can be live at once: each has its own client, channel ids
 * are allocated from one shared counter so the bus can route `input` /
 * `open` / `names` / `more` by channel id, and every client's `init` carries
 * all networks (`networksForInit`) because the store's `init` listener
 * replaces the network list wholesale.
 *
 * Network configs are persisted in localStorage by `saved-networks.ts`; a
 * successful `createNetwork` saves/updates the entry and marks it last used.
 */

import {CLOSED_STORAGE_KEY, closedStorageChanged, onClosedSharingStopped} from "./closedQueries";
import {ref} from "vue";
import socket from "../socket";
import {store} from "../store";
import {parseKeywordList} from "../highlight";
import {setMuteStatus} from "../mute";
import {ignoreListFor} from "../ignore";
import {registerBusHandlers} from "./bus";
import {IrcClient} from "./client";
import {flushQueryLogs} from "./querylog";
import {forgetLogin, typedCredentialsDiffer} from "./saslTrust";
import {pruneUserAway} from "./userAwayStore";
import {leavesAwayToWorker, syncPresence} from "./presence";
import {claimMute, clearRemoteDnd} from "./pushMute";
import * as saved from "./saved-networks";
import type {SavedNetwork} from "./saved-networks";
import type {ConnectOptions} from "./types";
import type {GlobalModeState} from "../helpers/dnd";
import {shellBridge} from "../helpers/shell";

/** The global do-not-disturb as client/js/dnd.ts last set it; new clients start with it. */
const globalDnd: {active: boolean; until: number | null} = {active: false, until: null};
/** The page's global mode (client/js/dnd.ts), given to every client. */
const globalMode: GlobalModeState = {value: "auto", at: null};

const clients = new Map<string, IrcClient>();

/**
 * What the connect form (or `network:new`) hands us: connection details plus
 * the optional saved-network extras. Without a `uuid` an existing entry for
 * the same host/port/nick is reused, else a fresh one is generated.
 */
export type CreateNetworkOptions = ConnectOptions &
	Partial<
		Pick<
			SavedNetwork,
			| "uuid"
			| "name"
			| "autoconnect"
			| "rememberPassword"
			| "pushEnabled"
			| "notifyEnabled"
			| "commands"
		>
	>;

function highlightKeywords() {
	return {
		keywords: parseKeywordList(store.state.settings.highlights),
		exceptions: parseKeywordList(store.state.settings.highlightExceptions),
	};
}

/** `SharedNetwork` snapshots of every network, for `init`. */
function allNetworks() {
	return Array.from(clients.values()).map((client) => client.network);
}

/** Persist the entry for these options and return it (with the live password). */
function rememberNetwork(options: CreateNetworkOptions): SavedNetwork {
	const uuid =
		options.uuid ||
		saved.findMatching(options.host, options.port, options.nick, options.transport)?.uuid ||
		saved.newUuid();
	const existing = saved.get(uuid);
	const entry = saved.normalize(saved.mergeOptions(existing, uuid, options));

	if (!entry) {
		throw new Error("createNetwork: missing uuid");
	}

	// Credentials from the connect form are unproven: a mistyped password on
	// a network whose login has worked gets no retries (saslTrust.ts).
	if (typedCredentialsDiffer(existing, options)) {
		forgetLogin(uuid);
	}

	saved.save(entry);
	saved.touchLastUsed(uuid);
	return entry;
}

/** Create (or reuse) the client for these options, save the config and connect. */
export function createNetwork(options: CreateNetworkOptions): IrcClient {
	const entry = rememberNetwork(options);
	let client = clients.get(entry.uuid);

	if (!client) {
		client = new IrcClient({
			...saved.toConnectOptions(entry),
			uuid: entry.uuid,
			// The app shell's raw sockets, for a network set to IRC over TCP.
			socketBridge: shellBridge() ?? undefined,
			highlights: highlightKeywords,
			networksForInit: allNetworks,
			setMuteStatus,
			// An STS upgrade at connect time is persisted so future connects go secure.
			onStsUpgrade({port, tls}) {
				const current = saved.get(entry.uuid);

				if (current) {
					saved.save({...current, port, tls});
				}
			},
			// A refused login stops the entry connecting by itself: the same
			// credentials would be refused again at every page load, and a
			// network that never registers is not one the user can get back
			// to the connect screen from.
			onSaslRejected() {
				const current = saved.get(entry.uuid);

				if (current?.autoconnect) {
					saved.save({...current, autoconnect: false});
				}
			},
		});
		clients.set(entry.uuid, client);
		// Load the network's ignore list now, which mirrors it for the push
		// worker (ignore.ts): a list restored, or kept from before the
		// mirror existed, filters pushes from the first connect on.
		ignoreListFor(entry.uuid);
		// A mode never chosen has no time, which leaves the client's alone.
		client.setPresenceMode(saved.presenceModeOf(entry), entry.presenceAt);
		client.setGlobalMode(globalMode);
		client.setGlobalDnd(globalDnd.active, globalDnd.until);

		// A client starts attended and foreground.ts only reports changes:
		// a page that boots hidden (a shell relaunched in the background,
		// a background tab) would otherwise read whatever it opens.
		if (document.visibilityState === "hidden") {
			client.setAttended(false);
		}

		if (entry.name) {
			client.setNetworkName(entry.name);
		}
	} else {
		// Reconnecting an existing network through the connect screen: the
		// form's settings win, same rules as `network:edit` in bus.ts.
		client.applySettings(saved.toConnectOptions(entry));

		if (entry.nick && entry.nick !== client.nick) {
			client.input(client.lobby.id, `/nick ${entry.nick}`);
		}

		if (entry.name && entry.name !== client.name) {
			client.setNetworkName(entry.name);
		}
	}

	client.connect();
	return client;
}

/**
 * Connect every saved network flagged `autoconnect`. Runs once per page load
 * from boot; entries that need a SASL password that was not remembered are
 * skipped so the user can type it.
 */
let autoconnectDone = false;

/**
 * Until boot reaches autoconnect, an entry it is about to dial is not shown
 * as a not-connected network in the sidebar (NetworkList.vue): its live row
 * comes a moment later. Reactive, so the rows appear if boot stops short —
 * a link waiting on the user's answer (`endAutoconnectWait`).
 */
const bootDialing = ref(true);

/** Whether boot's autoconnect, not run yet, will dial this entry by itself. */
export function autoconnectPending(entry: SavedNetwork): boolean {
	return bootDialing.value && willAutoconnect(entry);
}

/** Boot will not autoconnect for now (it waits on the user). */
export function endAutoconnectWait(): void {
	bootDialing.value = false;
}

function willAutoconnect(entry: SavedNetwork): boolean {
	return !!entry.autoconnect && !(entry.sasl === "plain" && !entry.saslPassword);
}

export function autoconnectSavedNetworks(): IrcClient[] {
	if (autoconnectDone) {
		return [];
	}

	autoconnectDone = true;
	const started: IrcClient[] = [];
	// Once per page: the `/away` memory of networks that are gone.
	pruneUserAway([...saved.list().map((entry) => entry.uuid), ...clients.keys()]);

	for (const entry of saved.list()) {
		if (!willAutoconnect(entry) || clients.has(entry.uuid)) {
			continue;
		}

		started.push(createNetwork(entry));
	}

	// After the dials: their live rows are in the store by now.
	endAutoconnectWait();
	return started;
}

export function clientForNetwork(uuid: string): IrcClient | undefined {
	return clients.get(uuid);
}

export function clientForChannel(chanId: number): IrcClient | undefined {
	for (const client of clients.values()) {
		if (client.channelById(chanId)) {
			return client;
		}
	}

	return undefined;
}

export function allClients(): IrcClient[] {
	return Array.from(clients.values());
}

/**
 * On page unload (tab close / navigation), say goodbye properly: a QUIT
 * lets a bouncer-enabled ircd hold the session deterministically (the
 * m_quit hold gate) instead of racing the socket teardown, and other
 * servers see a clean quit. Fire-and-forget — the page is going away, so
 * at most the first bytes make it out; the transport is not closed here
 * (the browser does that the moment the page dies).
 *
 * `pagehide` fires for tab close, navigation and refresh — on refresh the
 * reconnect after the reload re-attaches the held session, so nothing is
 * lost either way. A `persisted` pagehide is different: the page is going
 * into the back/forward cache and may come back as it is (`pageshow`
 * pokes it then), so the socket — if the browser lets it live — is worth
 * more than the deterministic hold. Nothing is sent for those.
 */
if (typeof window !== "undefined") {
	// The private conversations' log writes on a trailing throttle: write
	// it out whenever the page may not come back — a phone kills a hidden
	// page without a pagehide.
	window.addEventListener("pagehide", flushQueryLogs);
	// Private conversations no longer kept: every connected network deletes
	// the account's list of closed ones (a network down meanwhile does so at
	// its next login read).
	onClosedSharingStopped(() => {
		for (const client of allClients()) {
			client.unshareClosed();
		}
	});
	// Another tab closed a query: a window this one opened by itself for
	// that conversation goes too (irc/closedQueries.ts).
	window.addEventListener("storage", (ev: StorageEvent) => {
		if (ev.key === CLOSED_STORAGE_KEY) {
			closedStorageChanged(allClients());
		}
	});
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") {
			flushQueryLogs();
		}
	});

	window.addEventListener("pagehide", (ev: PageTransitionEvent) => {
		if (ev.persisted) {
			return;
		}

		for (const client of allClients()) {
			if (client.isConnected) {
				client.send("QUIT :page closed");
			}
		}
	});
}

/** Foreground signals arrive in clusters (visibility + focus + native); one poke per second is plenty. */
const POKE_INTERVAL_MS = 1000;
/** probe() deadline for the foreground poke (the default is 10 s). */
const FOREGROUND_PROBE_MS = 4_000;
/** A dial older than this at foreground time is presumed stuck. */
const STALE_DIAL_MS = 3_000;
let lastPokeAt = 0;

/** The page's attention changed: every connection tells its server (presence.ts). */
export function setAttendedAll(attended: boolean, except?: ReadonlySet<string>): void {
	for (const client of clients.values()) {
		if (!except?.has(client.uuid)) {
			client.setAttended(attended);
		}
	}
}

/** The page is unloading: the networks whose `AWAY *` the service worker takes over (presence.ts). */
export function networksLeavingAwayToWorker(stashed: (uuid: string) => boolean): string[] {
	return allClients()
		.filter((client) => leavesAwayToWorker(client, stashed))
		.map((client) => client.uuid);
}

/** The page's global mode, given to every network (docs/projects/shared-presence-modes.md § 2). */
export function setGlobalModeAll(mode: GlobalModeState): void {
	globalMode.value = mode.value;
	globalMode.at = mode.at;

	for (const client of clients.values()) {
		client.setGlobalMode(mode);
	}
}

/**
 * The page's do not disturb (client/js/dnd.ts) changed: remember it for
 * networks created later and hand it to every client, which says it to its
 * server (`AWAY *`, the push mute) through syncPresence. `until` is a
 * Date.now() time for a timed DND, null for an indefinite one or none.
 */
export function setGlobalDndAll(active: boolean, until: number | null): void {
	globalDnd.active = active;
	globalDnd.until = until;

	for (const client of clients.values()) {
		client.setGlobalDnd(active, until);
	}
}

/**
 * The pill's Off: remove every network's `*` entry, whoever wrote it. A
 * network in mode dnd keeps its own (removing it would only have the next
 * sync write it again).
 */
export function clearRemoteDndAll(): void {
	for (const client of clients.values()) {
		if (client.presenceMode !== "dnd") {
			clearRemoteDnd(client);
		}
	}
}

/** The user changed the do not disturb by hand: see pushMute.ts `claimMute`. */
export function claimMuteAll(): void {
	for (const client of clients.values()) {
		claimMute(client);
	}
}

/** Re-judge every client's presence (the do-not-disturb minute tick): timed
 * mute entries expire without a word from the server. */
export function syncPresenceAll(): void {
	for (const client of clients.values()) {
		syncPresence(client);
	}
}

/**
 * Poke every live connection: networks waiting out reconnect backoff retry
 * now, open ones probe the socket (PING; silence means the OS killed it, and
 * the transport then closes it and reconnects). Called when the app returns
 * to the foreground — browsers from foreground.ts, native shells from
 * native.ts; deliberately disconnected networks are left alone.
 */
export function reconnectAll(opts: {networkBack?: boolean} = {}): void {
	const now = Date.now();

	// The network coming back is rare and the one signal an offline wait
	// waits for: never folded into a focus poke a moment before it.
	if (!opts.networkBack && now - lastPokeAt < POKE_INTERVAL_MS) {
		return;
	}

	lastPokeAt = now;

	for (const client of clients.values()) {
		const transport = client.transport;

		// A long wait is left to run (transport.ts holding).
		if (transport.state === "reconnect-wait" && !transport.holding?.()) {
			client.connect();
		} else if (transport.state === "connecting") {
			// A dial started while the OS had the radio off can sit in
			// CONNECTING for a long time; past the grace, start over now.
			if (
				transport.connectingForMs &&
				transport.redial &&
				transport.connectingForMs() > STALE_DIAL_MS
			) {
				transport.redial();
			}
		} else if (transport.state === "open") {
			if (transport.probe) {
				// Shorter than the background probe: the user is looking at the
				// screen, and a live server answers a PING well within this.
				transport.probe(FOREGROUND_PROBE_MS);
			} else {
				transport.send("PING :resume");
			}
		}
	}
}

registerBusHandlers(socket, {
	clientForChannel,
	clientForNetwork,
	allClients,
	createNetwork,
	remove(uuid) {
		clients.get(uuid)?.queryLog.dispose();
		clients.delete(uuid);
		forgetLogin(uuid);
	},
});

// Saved-network policies layered on top of the client's own events.

// A custom name from the edit form beats ISUPPORT NETWORK: when a client
// renames itself to something else, put the user's choice back (setNetworkName
// is a no-op when the name already matches, so this cannot loop).
socket.on("network:name", ({uuid, name}) => {
	const custom = saved.get(uuid)?.name;
	const client = clients.get(uuid);

	if (client && custom && custom !== name) {
		client.setNetworkName(custom);
	}
});

// Commands-on-connect: run the saved slash commands in the lobby after every
// registration, like the old server's `connection.ts` did.
socket.on("network:status", ({network, connected}) => {
	if (!connected) {
		return;
	}

	const client = clients.get(network);
	const commands = saved.get(network)?.commands ?? [];

	if (client && client.isConnected) {
		for (const command of commands) {
			client.input(client.lobby.id, command, {auto: true});
		}
	}
});
