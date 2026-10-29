/**
 * `/part [#chan] [reason]`, `/leave`, `/close`. Queries, parted channels and
 * anything while disconnected are removed locally; joined channels send PART
 * and wait for the server's echo.
 */

import {ChanState, ChanType} from "../../../../shared/types/chan";
import {MessageType} from "../../../../shared/types/msg";
import {trailingLine} from "../wire";
import {t} from "../../i18n/core";
import type {Command} from "../types";

const part: Command = {
	commands: ["close", "leave", "part"],
	allowDisconnected: true,
	input({client, chan, args}) {
		let target = chan;

		if (args.length > 0) {
			const named = client.findChannel(args[0]);

			if (named) {
				target = named;
				args.shift();
			}
		}

		if (target.type === ChanType.LOBBY) {
			client.pushMessage(chan, {
				type: MessageType.ERROR,
				text: t("cmd.partLobby"),
			});
			return;
		}

		// Closing a query is meant: a line from before the close must not
		// open it again — here after a reconnect, or on another device
		// (irc/closedQueries.ts). Its boundary is the newest line the server
		// sent in it; one with nothing from the server has nothing to replay.
		if (target.type === ChanType.QUERY && target.newestServerAt !== undefined) {
			client.closed.close(target.name, target.newestServerAt);
			client.writeClosed(); // and on the account's other devices
		}

		if (
			target.type !== ChanType.CHANNEL ||
			target.state === ChanState.PARTED ||
			!client.isConnected
		) {
			target.autoJoin = false;
			client.removeChannel(target);
			return;
		}

		const reason = args.join(" ") || client.options.leaveMessage || "Seance";
		client.send(trailingLine("PART", [target.name, reason]));
	},
};

export default part;
