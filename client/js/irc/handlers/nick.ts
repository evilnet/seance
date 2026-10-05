/**
 * NICK: rename across every channel; update our own nick when it is us.
 */

import {MessageType} from "../../../../shared/types/msg";
import {msgidOf} from "../message";
import type {Handler} from "../types";

const nick: Handler = (client, msg) => {
	const oldNick = msg.source?.name ?? "";
	const newNick = msg.params[0] ?? "";

	if (!oldNick || !newNick) {
		return;
	}

	const time = client.timeOf(msg);

	if (client.replaying) {
		// History (draft/event-playback): the batch's channel, no renames.
		const chan = client.replayTarget;

		if (chan) {
			client.pushMessage(chan, {
				type: MessageType.NICK,
				time,
				from: chan.userRef(oldNick),
				new_nick: newNick,
				...msgidOf(msg),
			});
		}

		return;
	}

	if (client.isSelf(oldNick)) {
		client.setNick(newNick);
		client.pushMessage(client.lobby, {text: `You're now known as ${newNick}`}, true);
	}

	for (const chan of client.channels) {
		const user = chan.findUser(oldNick);

		if (!user) {
			continue;
		}

		client.pushMessage(chan, {
			type: MessageType.NICK,
			time,
			from: {nick: oldNick, mode: user.mode},
			new_nick: newNick,
			...msgidOf(msg),
		});
		chan.renameUser(oldNick, newNick);
		client.usersChanged(chan);
	}
};

export default {NICK: nick};
