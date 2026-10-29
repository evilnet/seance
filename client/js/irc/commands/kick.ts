/**
 * `/kick <nick> [reason]` in the current channel.
 */

import {ChanType} from "../../../../shared/types/chan";
import {MessageType} from "../../../../shared/types/msg";
import {formatLine} from "../message";
import {trailingLine} from "../wire";
import {t} from "../../i18n/core";
import type {Command} from "../types";

const kick: Command = {
	commands: ["kick"],
	input({client, chan, cmd, args}) {
		if (chan.type !== ChanType.CHANNEL) {
			client.pushMessage(chan, {
				type: MessageType.ERROR,
				text: t("cmd.channelsOnly", {cmd}),
			});
			return;
		}

		if (args.length === 0 || args[0].length === 0) {
			return;
		}

		const reason = args.slice(1).join(" ");
		client.send(
			reason
				? trailingLine("KICK", [chan.name, args[0], reason])
				: formatLine({command: "KICK", params: [chan.name, args[0]]})
		);
	},
};

export default kick;
