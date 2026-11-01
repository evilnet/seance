/**
 * `/kick <nick> [reason]` in the current channel.
 */

import {ChanType} from "../../../../shared/types/chan";
import {MessageType} from "../../../../shared/types/msg";
import {formatLine} from "../message";
import {trailingLine} from "../wire";
import type {Command} from "../types";
import {textAfter} from "./words";

const kick: Command = {
	commands: ["kick"],
	input({client, chan, cmd, args, rest}) {
		if (chan.type !== ChanType.CHANNEL) {
			client.pushMessage(chan, {
				type: MessageType.ERROR,
				text: `${cmd} command can only be used in channels.`,
			});
			return;
		}

		if (args.length === 0 || args[0].length === 0) {
			return;
		}

		const reason = textAfter(rest, 1);
		client.send(
			reason
				? trailingLine("KICK", [chan.name, args[0], reason])
				: formatLine({command: "KICK", params: [chan.name, args[0]]})
		);
	},
};

export default kick;
