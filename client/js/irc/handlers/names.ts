/**
 * NAMES replies: 353 (and nefarious2's 355 for delayed-join members)
 * accumulate, 366 swaps the new list in and tells the UI. Understands
 * `multi-prefix` (several status symbols) and `userhost-in-names`.
 */

import {newUser, setUserModes} from "../channel";
import {onHistoryLineFrom, syncChannelAvatars} from "../avatars";
import type {Handler} from "../types";
import {MessageType} from "../../../../shared/types/msg";

const namesReply: Handler = (client, msg) => {
	// <me> <=|*|@> <channel> :<names>
	const name = msg.params[2];
	const chan = name ? client.findChannel(name) : undefined;

	if (!chan) {
		return;
	}

	if (!chan.namesBuffer) {
		chan.namesBuffer = new Map();
	}

	const symbols = client.isupport.prefix.symbols;
	const rank = (symbol: string) => client.prefixRank(symbol);

	for (const token of (msg.params[3] ?? "").split(" ")) {
		if (token.length === 0) {
			continue;
		}

		let i = 0;
		const modes: string[] = [];

		while (i < token.length && symbols.includes(token[i])) {
			modes.push(token[i]);
			i++;
		}

		const bang = token.indexOf("!", i);
		const nick = token.slice(i, bang === -1 ? undefined : bang);

		if (nick.length === 0) {
			continue;
		}

		// Keep the existing record so `lastMessage` survives a re-NAMES.
		const user = chan.findUser(nick) ?? newUser(nick);
		user.nick = nick;
		setUserModes(user, modes, rank);
		chan.namesBuffer.set(client.casefold(nick), user);
	}
};

/** The lines that draw their sender's avatar. */
const SPEAKING = new Set<string>([MessageType.MESSAGE, MessageType.ACTION, MessageType.NOTICE]);

const endOfNames: Handler = (client, msg) => {
	const name = msg.params[1];
	const chan = name ? client.findChannel(name) : undefined;

	if (!chan) {
		return;
	}

	chan.users = chan.namesBuffer ?? new Map();
	chan.namesBuffer = null;
	// The end of the JOIN burst: from here on the channel's lines are live,
	// and a topic that never came (none is set) is no longer waited for.
	chan.rejoining = false;
	chan.topicWanted = false;
	client.usersChanged(chan);

	// A held session's restoration says no one's avatar: one SYNC asks for
	// every member's (irc/avatars.ts). Elsewhere the lines the device kept
	// for the channel, on screen already, ask for their senders still here,
	// where the burst does not say them (a SYNC'd channel's are covered).
	if (client.restoring) {
		syncChannelAvatars(client, chan);
	}

	for (const line of client.conversations.restoredMessages(chan.name)) {
		const nick = line.from?.nick;

		if (nick && !line.self && line.type !== undefined && SPEAKING.has(line.type)) {
			onHistoryLineFrom(client, chan, nick);
		}
	}
};

export default {"353": namesReply, "355": namesReply, "366": endOfNames};
