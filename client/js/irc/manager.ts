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

import socket from "../socket";
import {store} from "../store";
import {parseKeywordList} from "../highlight";
import {setMuteStatus} from "../mute";
import {registerBusHandlers} from "./bus";
import {IrcClient} from "./client";
import * as saved from "./saved-networks";
import type {SavedNetwork} from "./saved-networks";
import type {ConnectOptions} from "./types";

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
		saved.findMatching(options.host, options.port, options.nick)?.uuid ||
		saved.newUuid();
	const existing = saved.get(uuid);
	const merged: Record<string, unknown> = {...(existing ?? {}), uuid};

	for (const [key, value] of Object.entries(options)) {
		if (value !== undefined) {
			merged[key] = value;
		}
	}

	const entry = saved.normalize(merged);

	if (!entry) {
		throw new Error("createNetwork: missing uuid");
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

export function autoconnectSavedNetworks(): IrcClient[] {
	if (autoconnectDone) {
		return [];
	}

	autoconnectDone = true;
	const started: IrcClient[] = [];

	for (const entry of saved.list()) {
		if (!entry.autoconnect || clients.has(entry.uuid)) {
			continue;
		}

		if (entry.sasl === "plain" && !entry.saslPassword) {
			continue;
		}

		started.push(createNetwork(entry));
	}

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

/**
 * Poke every live connection: networks waiting out reconnect backoff retry
 * now, open ones probe the socket (PING; silence means the OS killed it, and
 * the transport then closes it and reconnects). Called when the app returns
 * to the foreground — browsers from foreground.ts, native shells from
 * native.ts; deliberately disconnected networks are left alone.
 */
/** The page's attention changed: every connection tells its server (presence.ts). */
export function setAttendedAll(attended: boolean): void {
	for (const client of clients.values()) {
		client.setAttended(attended);
	}
}

export function reconnectAll(): void {
	const now = Date.now();

	if (now - lastPokeAt < POKE_INTERVAL_MS) {
		return;
	}

	lastPokeAt = now;

	for (const client of clients.values()) {
		const transport = client.transport;

		if (transport.state === "reconnect-wait") {
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
	remove: (uuid) => void clients.delete(uuid),
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
			client.input(client.lobby.id, command);
		}
	}
});
