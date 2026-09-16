/**
 * AWAY (`away-notify`, and the server's echo of our own), plus the 305/306
 * confirmations of our own `/away`. Channel users get `away` set silently;
 * query windows show a message; our own goes to the lobby — the 305/306,
 * being a reply the user asked for, follows to the active tab.
 */

import {ChanType} from "../../../../shared/types/chan";
import {MessageType} from "../../../../shared/types/msg";
import type {Handler} from "../types";

const away: Handler = (client, msg) => {
	const nick = msg.source?.name ?? "";
	const raw = msg.params[0] ?? "";
	// `draft/pre-away`: `*` is away for an unspecified reason — away, no text.
	const text = raw === "*" ? "" : raw;
	const type = raw ? MessageType.AWAY : MessageType.BACK;
	const time = client.timeOf(msg);

	if (!nick) {
		return;
	}

	if (client.isSelf(nick)) {
		client.pushMessage(client.lobby, {type, time, text, self: true}, true);
		return;
	}

	for (const chan of client.channels) {
		if (chan.type === ChanType.QUERY) {
			if (!client.namesEqual(chan.name, nick) || chan.userAway === text) {
				continue;
			}

			chan.userAway = text;
			client.pushMessage(chan, {type, time, text, from: chan.userRef(nick)});
		} else if (chan.type === ChanType.CHANNEL) {
			const user = chan.findUser(nick);

			if (user) {
				user.away = text;
			}
		}
	}
};

/** RPL_UNAWAY / RPL_NOWAWAY: <me> :You are no longer marked as being away… */
function selfAway(type: MessageType): Handler {
	return (client, msg) => {
		client.pushMessage(
			client.lobby,
			{
				type,
				time: client.timeOf(msg),
				text: msg.params[msg.params.length - 1] ?? "",
				self: true,
				showInActive: true,
			},
			true
		);
	};
}

export default {AWAY: away, "305": selfAway(MessageType.BACK), "306": selfAway(MessageType.AWAY)};
