/**
 * `/server`: without arguments, reconnect the current network;
 * `/server <host> [[+]port]` opens a new network with the current nick
 * (`+port` means TLS, as in the old server). The new network goes through
 * the bus (`network:new`) so the manager — not this module — owns it.
 *
 * Not `/connect`: that is the ircd's own command (an oper linking two
 * servers), so it stays unregistered and goes to the server raw.
 */

import {MessageType} from "../../../../shared/types/msg";
import socket from "../../socket";
import {t} from "../../i18n/core";
import {defaultPort} from "../saved-networks";
import type {Command, ConnectOptions} from "../types";

const server: Command = {
	commands: ["server"],
	allowDisconnected: true,
	input({client, chan, args}) {
		if (args.length === 0) {
			if (client.isConnected) {
				client.pushMessage(chan, {
					type: MessageType.ERROR,
					text: t("cmd.alreadyConnected"),
				});
				return;
			}

			client.connect();
			return;
		}

		let portArg = args[1] ?? "";
		const tls = portArg.startsWith("+");

		if (tls) {
			portArg = portArg.slice(1);
		}

		const port = /^\d+$/.test(portArg) ? parseInt(portArg, 10) : defaultPort(tls);
		// Only what the command says. The manager lays these over a saved
		// entry for the same server and nick (saved-networks mergeOptions),
		// where an empty join or SASL field would wipe the entry's channels
		// and login; a network never saved gets them empty (normalize).
		const options: Pick<ConnectOptions, "host" | "port" | "tls" | "nick"> = {
			host: args[0],
			port,
			tls,
			nick: client.nick,
		};

		socket.emit("network:new", options);
	},
};

export default server;
