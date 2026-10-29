/**
 * `/rejoin`, `/cycle`: PART and JOIN the current channel (with its key, if
 * one is known). The PART echo removes the window and the JOIN echo brings
 * it back.
 */

import {ChanType} from "../../../../shared/types/chan";
import {MessageType} from "../../../../shared/types/msg";
import {trailingLine} from "../wire";
import {t} from "../../i18n/core";
import type {Command} from "../types";

const rejoin: Command = {
	commands: ["cycle", "rejoin"],
	input({client, chan}) {
		if (chan.type !== ChanType.CHANNEL) {
			client.pushMessage(chan, {
				type: MessageType.ERROR,
				text: t("cmd.rejoinChannels"),
			});
			return;
		}

		client.send(trailingLine("PART", [chan.name, "Rejoining"]));
		client.joinChannel(chan.name, chan.shared.key);
	},
};

export default rejoin;
