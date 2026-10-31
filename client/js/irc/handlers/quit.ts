/**
 * QUIT: one message in every channel the user shared with us.
 */

import {MessageType} from "../../../../shared/types/msg";
import type {Channel} from "../channel";
import {msgidOf} from "../message";
import type {Handler} from "../types";
import {scriptManager} from "../scripting/manager";

const quit: Handler = (client, msg) => {
	const nick = msg.source?.name ?? "";
	const reason = msg.params[0] ?? "";

	if (!nick) {
		return;
	}

	if (!client.replaying) {
		scriptManager.dispatchQuit({
			network: client.name,
			networkUuid: client.uuid,
			nick,
			message: reason || undefined,
		});
	}

	const time = client.timeOf(msg);
	const quitIn = (chan: Channel) =>
		client.pushMessage(chan, {
			type: MessageType.QUIT,
			time,
			from: chan.userRef(nick),
			hostmask: `${msg.source?.user ?? ""}@${msg.source?.host ?? ""}`,
			text: reason,
			...msgidOf(msg),
		});

	if (client.replaying) {
		// History (draft/event-playback): the batch's channel, no user-list change.
		if (client.replayTarget) {
			quitIn(client.replayTarget);
		}

		return;
	}

	for (const chan of client.channels) {
		if (!chan.findUser(nick)) {
			continue;
		}

		quitIn(chan);
		chan.removeUser(nick);
	}
};

export default {QUIT: quit};
