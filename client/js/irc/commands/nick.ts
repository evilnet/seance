/**
 * `/nick <newnick>`: sent to the server when connected (the NICK echo
 * updates the UI), applied locally otherwise so the next registration uses it.
 */

import {MessageType} from "../../../../shared/types/msg";
import {formatLine} from "../message";
import {t} from "../../i18n/core";
import type {Command} from "../types";

const nick: Command = {
	commands: ["nick"],
	allowDisconnected: true,
	input({client, chan, args}) {
		if (args.length === 0 || args[0].length === 0) {
			client.pushMessage(chan, {
				type: MessageType.ERROR,
				text: t("cmd.usageNickChange"),
			});
			return;
		}

		if (args.length !== 1) {
			client.pushMessage(chan, {
				type: MessageType.ERROR,
				text: t("cmd.nickSpaces"),
			});
			return;
		}

		const newNick = args[0];

		if (newNick.length > 100) {
			client.pushMessage(chan, {
				type: MessageType.ERROR,
				text: t("cmd.nickTooLong"),
			});
			return;
		}

		if (client.isConnected) {
			client.send(formatLine({command: "NICK", params: [newNick]}));
			return;
		}

		client.setNick(newNick);
	},
};

export default nick;
