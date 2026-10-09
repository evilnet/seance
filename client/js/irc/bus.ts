/**
 * Services the client→server side of the event bus (`socket.emit(...)`) by
 * routing each emit to the {@link IrcClient} that owns the channel. Kept free
 * of store imports so it can run under mocha; `manager.ts` wires it up with
 * the real registry.
 */

import type {EventBus} from "../socket";
import type {IrcClient} from "./client";
import {requestMore} from "./history";
import {refreshOper, setSnomask} from "./oper";
import {request} from "./request";
import * as saved from "./saved-networks";
import type {ConnectOptions} from "./types";
import {REPLY_TAG} from "./wire";

export interface ClientRegistry {
	clientForChannel(chanId: number): IrcClient | undefined;
	clientForNetwork(uuid: string): IrcClient | undefined;
	allClients(): IrcClient[];
	createNetwork(options: ConnectOptions): IrcClient;
	remove(uuid: string): void;
}

/**
 * What `network:info` carries: the saved entry (what the next connect will
 * use) merged over the live client's view, with the live nick and connection
 * state on top. `undefined` when the uuid is unknown on both sides.
 */
export function networkInfo(
	registry: ClientRegistry,
	uuid: string
): (Record<string, unknown> & {uuid: string}) | undefined {
	const client = registry.clientForNetwork(uuid);
	const stored = saved.get(uuid);

	if (!client && !stored) {
		return undefined;
	}

	return {
		...(client?.editableInfo ?? {}),
		...(stored ?? {}),
		uuid,
		name: stored?.name || client?.name || "",
		nick: client?.nick ?? stored?.nick ?? "",
		connected: client?.isConnected ?? false,
	};
}

export function registerBusHandlers(bus: EventBus, registry: ClientRegistry): void {
	bus.handle("input", ({target, text, reply, edit}) => {
		const client = registry.clientForChannel(target);

		if (client) {
			client.input(target, text, {reply, edit});
		} else {
			// eslint-disable-next-line no-console
			console.warn("[irc] input for unknown channel", target, text);
		}
	});

	// By network + target name rather than channel id: what a notification
	// can still name after the page is gone (the worker's relayed reply, the
	// outbox). Only over a connected client — a reconnecting one would throw.
	bus.handle("send", ({network, target, text, replyTo}) => {
		const client = registry.clientForNetwork(network);

		if (client && client.isConnected) {
			// A notification's reply answers the message it was shown for.
			client.sendMessage(target, text, replyTo ? {tags: {[REPLY_TAG]: replyTo}} : {});
		} else {
			// eslint-disable-next-line no-console
			console.warn("[irc] send to a network that is not connected", network, target);
		}
	});

	// The same road for a notification's Mark read: the account's marker
	// for a target the worker names, at the notification's newest message.
	bus.handle("markread", ({network, target, time}) => {
		const client = registry.clientForNetwork(network);

		if (client && client.isConnected) {
			client.markRead(target, time);
		}
	});

	bus.handle("msg:react", ({target, msgid, text, remove}) => {
		const client = registry.clientForChannel(target);
		const chan = client?.channelById(target);

		if (client && chan) {
			client.react(chan, msgid, text, remove ?? false);
		}
	});

	bus.handle("typing", ({target, state}) => {
		const client = registry.clientForChannel(target);
		const chan = client?.channelById(target);

		if (client && chan) {
			client.typing(chan, state);
		}
	});

	bus.handle("msg:redact", ({target, msgid, reason}) => {
		const client = registry.clientForChannel(target);
		const chan = client?.channelById(target);

		if (client && chan) {
			client.redact(chan, msgid, reason);
		}
	});

	// Web Push (draft/webpush): the browser subscription lives in
	// client/js/webpush.ts; these hand it to the network's server. The
	// echoes / FAILs come back as `webpush:state` (handlers/webpush.ts).
	bus.handle("webpush:register", ({network, endpoint, keys}) => {
		const client = registry.clientForNetwork(network);

		if (client) {
			client.webpushRegister(endpoint, keys);
		}
	});

	bus.handle("webpush:unregister", ({network, endpoint}) => {
		const client = registry.clientForNetwork(network);

		if (client) {
			client.webpushUnregister(endpoint);
		}
	});

	// Account metadata writes for webpush settings (payload tier, mute/
	// snooze list). SET with an empty value deletes the key.
	bus.handle("webpush:metadata", ({network, key, value}) => {
		const client = registry.clientForNetwork(network);

		if (client) {
			client.send(value ? `METADATA * SET ${key} * :${value}` : `METADATA * SET ${key}`);
		}
	});

	// Session visibility (draft/persistence): the Settings panel lists the
	// account's bouncer session(s) (PERSISTENCE LIST) and can end the current
	// one (PERSISTENCE DETACH). The SESSION/ENDOFLIST lines come back as
	// `persistence:sessions` (handlers/persistence.ts). The network uuid is
	// optional — any connected client shows the same account session.
	const persistenceClient = ({network}: {network?: string}) =>
		(network ? registry.clientForNetwork(network) : registry.allClients()[0]) ?? undefined;

	bus.handle("persistence:sessions:list", (params) => {
		persistenceClient(params)?.send("PERSISTENCE LIST");
	});

	bus.handle("persistence:sessions:logout", (params) => {
		persistenceClient(params)?.send("PERSISTENCE DETACH");
	});

	// Oper tools (oper.ts, request.ts): a labeled request whose whole answer
	// comes back raw as `oper:reply` (the UI parses it with the profile), the
	// snomask, a refresh of what OperState holds, and the notice log.
	bus.handle("oper:request", ({network, id, line, untagged, end}) => {
		const client = registry.clientForNetwork(network);

		if (!client) {
			bus.dispatch("oper:reply", {network, id, lines: [], outcome: "closed"});
			return;
		}

		void request(client, line, {untagged, end}).then((reply) => {
			bus.dispatch("oper:reply", {
				network,
				id,
				lines: reply.lines.map((msg) => msg.raw),
				outcome: reply.outcome,
			});
		});
	});

	bus.handle("oper:snomask", ({network, mask}) => {
		const client = registry.clientForNetwork(network);

		if (client) {
			void setSnomask(client, mask);
		}
	});

	bus.handle("oper:refresh", ({network}) => {
		const client = registry.clientForNetwork(network);

		if (client) {
			void refreshOper(client);
		}
	});

	bus.handle("oper:notices:get", ({network}) => {
		const client = registry.clientForNetwork(network);

		bus.dispatch("oper:notices", {network, entries: client ? client.noticeLog.all() : []});
	});

	bus.handle("open", (id) => {
		for (const client of registry.allClients()) {
			client.open(client.channelById(id) ? id : 0);
		}
	});

	bus.handle("names", ({target}) => {
		const client = registry.clientForChannel(target);
		const chan = client?.channelById(target);

		if (client && chan) {
			bus.dispatch("names", {
				id: target,
				users: chan.sortedUsers((symbol) => client.prefixRank(symbol)),
			});
		}
	});

	bus.handle("more", ({target, lastId}) => {
		const client = registry.clientForChannel(target);
		const chan = client?.channelById(target);

		// With draft/chathistory the reply follows when the batch closes (or
		// on FAIL / timeout, history.ts). Otherwise answer now, or the channel
		// stays in `historyLoading`.
		if (client && chan && requestMore(client, chan, lastId)) {
			return;
		}

		bus.dispatch("more", {
			chan: target,
			messages: [],
			totalMessages: chan?.shared.totalMessages ?? 0,
		});
	});

	bus.handle("history:trim", ({target, ids}) => {
		registry.clientForChannel(target)?.channelById(target)?.forget(ids);
	});

	bus.handle("network:get", (uuid) => {
		const info = networkInfo(registry, uuid);

		if (info) {
			bus.dispatch("network:info", info);
		}
	});

	bus.handle("network:edit", (data) => {
		const uuid = String(data.uuid ?? "");
		const client = registry.clientForNetwork(uuid);
		const existing = saved.get(uuid);

		if (!uuid || (!client && !existing)) {
			return;
		}

		// Unsaved live network (e.g. `/connect host`): seed from its options.
		const base = existing ?? saved.normalize({...(client?.editableInfo ?? {}), uuid});
		const next = saved.fromForm(data, base);
		saved.save(next);

		if (client) {
			// Host, port, TLS, channels and SASL: applied on the next connect,
			// or right away when the client is idle / waiting to reconnect.
			client.applySettings(saved.toConnectOptions(next));

			// Live-applicable fields: the nick (NICK when connected, local
			// otherwise — `/nick` does both) and the display name.
			if (next.nick && next.nick !== client.nick) {
				client.input(client.lobby.id, `/nick ${next.nick}`);
			}

			if (next.name && next.name !== client.name) {
				client.setNetworkName(next.name);
			}
		}

		const info = networkInfo(registry, uuid);

		if (info) {
			bus.dispatch("network:info", info);
		}
	});

	bus.handle("network:new", (data) => {
		registry.createNetwork(data as ConnectOptions);
	});

	bus.on("quit", ({network}) => {
		registry.remove(network);
	});
}
