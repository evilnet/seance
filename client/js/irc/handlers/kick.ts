/**
 * KICK. Being kicked keeps the channel in the list as PARTED (no auto-rejoin).
 */

import {ChanState} from "../../../../shared/types/chan";
import {MessageType} from "../../../../shared/types/msg";
import {msgidOf} from "../message";
import type {Handler} from "../types";

const kick: Handler = (client, msg) => {
	const [name, kicked, reason = ""] = msg.params;
	const kicker = msg.source?.name ?? "";
	const chan = name ? client.findChannel(name) : undefined;

	if (!chan || !kicked) {
		return;
	}

	const kickedSelf = client.isSelf(kicked);

	client.pushMessage(chan, {
		type: MessageType.KICK,
		time: client.timeOf(msg),
		from: chan.userRef(kicker),
		target: chan.userRef(kicked),
		text: reason,
		highlight: kickedSelf,
		self: client.isSelf(kicker),
		...msgidOf(msg),
	});

	if (client.replaying) {
		return; // history: no state changes
	}

	if (kickedSelf) {
		chan.users.clear();
		chan.state = ChanState.PARTED;
		chan.autoJoin = false;
		client.dispatch("channel:state", {chan: chan.id, state: chan.state});
	} else {
		chan.removeUser(kicked);
	}
};

export default {KICK: kick};
