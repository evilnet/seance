/**
 * PART. Our own PART removes the channel from the UI (as `/close` did in the
 * old server); somebody else's is a message plus a user-list update.
 */

import {MessageType} from "../../../../shared/types/msg";
import {msgidOf} from "../message";
import type {Handler} from "../types";

const part: Handler = (client, msg) => {
	const [name, reason = ""] = msg.params;
	const nick = msg.source?.name ?? "";
	const chan = name ? client.findChannel(name) : undefined;

	if (!chan || !nick) {
		return;
	}

	if (client.isSelf(nick) && !client.replaying) {
		chan.autoJoin = false;
		client.removeChannel(chan);
		return;
	}

	client.pushMessage(chan, {
		type: MessageType.PART,
		time: client.timeOf(msg),
		from: chan.userRef(nick),
		hostmask: `${msg.source?.user ?? ""}@${msg.source?.host ?? ""}`,
		text: reason,
		self: client.isSelf(nick),
		...msgidOf(msg),
	});

	if (!client.replaying) {
		chan.removeUser(nick);
	}
};

export default {PART: part};
