/**
 * AWAY (`away-notify`, and the server's echo of our own), plus the 305/306
 * confirmations of our own `/away`. Channel users get `away` set silently;
 * query windows show a message; our own goes to the lobby — the 305/306,
 * being a reply the user asked for, follows to the active tab.
 */

import {ChanType} from "../../../../shared/types/chan";
import {MessageType} from "../../../../shared/types/msg";
import type {Handler} from "../types";
import {AWAY_STAR, takeQuietAwayReply} from "../presence";

const away: Handler = (client, msg) => {
	const nick = msg.source?.name ?? "";
	const raw = msg.params[0] ?? "";
	// `draft/pre-away`: `*` is away for an unspecified reason — away, no text.
	const text = raw === AWAY_STAR ? "" : raw;
	const type = raw ? MessageType.AWAY : MessageType.BACK;
	const time = client.timeOf(msg);

	if (!nick) {
		return;
	}

	if (client.isSelf(nick)) {
		// Our own star and the bare AWAY that ends it (this page coming back,
		// or another connection of the account) are the attention signal,
		// not something to announce: a self line shows only its text, so
		// they would print a clock beside nothing. A /back typed here is
		// confirmed by its 305.
		if (text) {
			client.pushMessage(client.lobby, {type, time, text, self: true}, true);
		}

		return;
	}

	for (const chan of client.channels) {
		if (chan.type === ChanType.QUERY) {
			// The state keeps the star itself (not "" — that is present), so
			// "lunch" → `*` → back still ends with an "is back" line.
			if (!client.namesEqual(chan.name, nick) || chan.userAway === raw) {
				continue;
			}

			chan.userAway = raw;

			// Someone else's star is their client saying it is not looking
			// (`draft/pre-away`); the server only shows it to us because we
			// speak pre-away too. State, not news: no line in the query, and
			// no "is back" for a return from it either.
			if (raw === AWAY_STAR || (type === MessageType.BACK && !chan.awayShown)) {
				continue;
			}

			chan.awayShown = type === MessageType.AWAY;
			client.pushMessage(chan, {type, time, text, from: chan.userRef(nick)});
		} else if (chan.type === ChanType.CHANNEL) {
			const user = chan.findUser(nick);

			if (user) {
				user.away = raw;
			}
		}
	}
};

/** RPL_UNAWAY / RPL_NOWAWAY: <me> :You are no longer marked as being away… */
function selfAway(type: MessageType): Handler {
	return (client, msg) => {
		if (takeQuietAwayReply(client)) {
			return;
		}

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
