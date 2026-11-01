/**
 * `/connect` (`/server`): without arguments, reconnect the current network;
 * `/connect <host> [[+]port]` opens a new network with the current nick
 * (`+port` means TLS, as in the old server). The new network goes through
 * the bus (`network:new`) so the manager — not this module — owns it.
 */

import {MessageType} from "../../../../shared/types/msg";
import socket from "../../socket";
import {t} from "../../i18n/core";
import type {Command, ConnectOptions} from "../types";

/** nefarious2's WebSocket ports: 8443 for wss://, 8067 for ws://. */
function defaultPort(tls: boolean): number {
	return tls ? 8443 : 8067;
}

const connect: Command = {
	commands: ["connect", "server"],
	allowDisconnected: true,
	input({client, chan, args, opts}) {
		const params = args.filter((arg) => arg.length > 0);

		if (params.length === 0) {
			if (client.isConnected) {
				client.pushMessage(chan, {
					type: MessageType.ERROR,
					text: t("cmd.alreadyConnected"),
				});
				return;
			}

			// Typed or clicked ("Connect now"): the user asked, so it dials
			// even while the server's throttle would refuse it. A saved
			// command runs after every registration and asked nothing.
			client.connect({force: opts?.auto !== true});
			return;
		}

		let portArg = params[1] ?? "";
		const tls = portArg.startsWith("+");

		if (tls) {
			portArg = portArg.slice(1);
		}

		const port = /^\d+$/.test(portArg) ? parseInt(portArg, 10) : defaultPort(tls);
		const options: ConnectOptions = {
			host: params[0],
			port,
			tls,
			nick: client.nick,
			join: "",
			sasl: "",
			saslAccount: "",
			saslPassword: "",
		};

		socket.emit("network:new", options);
	},
};

export default connect;
