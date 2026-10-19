/**
 * `/investigate <nick|#channel>`: open the investigation card
 * (components/Oper/InvestigateCard.vue, irc/investigate.ts) for a user
 * or a channel on this network. Without an argument in a channel, the
 * channel; in a query, the other party. The card is a page element, so
 * the command only announces what to open (`oper:investigate` on the
 * eventbus, which has no store or DOM behind it).
 */

import {ChanType} from "../../../../shared/types/chan";
import {MessageType} from "../../../../shared/types/msg";
import eventbus from "../../eventbus";
import type {Command} from "../types";

const investigate: Command = {
	commands: ["investigate"],
	allowDisconnected: true,
	input({client, chan, args}) {
		let target = args.find((arg) => arg.length > 0) ?? "";

		if (!target) {
			if (chan.type === ChanType.CHANNEL || chan.type === ChanType.QUERY) {
				target = chan.name;
			} else {
				client.pushMessage(chan, {
					type: MessageType.ERROR,
					text: "Usage: /investigate <nick|#channel>",
				});
				return;
			}
		}

		eventbus.emit("oper:investigate", {
			network: client.uuid,
			kind: client.isChannelName(target) ? "channel" : "user",
			target,
		});
	},
};

export default investigate;
