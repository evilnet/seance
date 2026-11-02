/**
 * `/invite <nick> [#chan]` (current channel when omitted) and
 * `/invitelist` (MODE query using INVEX; replies land in `handlers/lists.ts`).
 */

import {ChanType} from "../../../../shared/types/chan";
import {MessageType} from "../../../../shared/types/msg";
import {formatLine} from "../message";
import type {Command} from "../types";

const invite: Command = {
	commands: ["invite", "invitelist"],
	input({client, chan, cmd, args}) {
		if (cmd === "invitelist") {
			if (chan.type !== ChanType.CHANNEL) {
				client.pushMessage(chan, {
					type: MessageType.ERROR,
					text: `${cmd} command can only be used in channels.`,
				});
				return;
			}

			const invex = client.isupport.get("INVEX") || "I";
			client.send(formatLine({command: "MODE", params: [chan.name, invex]}));
			return;
		}

		if (args.length === 2) {
			client.send(formatLine({command: "INVITE", params: [args[0], args[1]]}));
		} else if (args.length === 1 && chan.type === ChanType.CHANNEL) {
			client.send(formatLine({command: "INVITE", params: [args[0], chan.name]}));
		} else {
			client.pushMessage(chan, {
				type: MessageType.ERROR,
				text: `${cmd} command can only be used in channels or by specifying a target.`,
			});
		}
	},
};

export default invite;
