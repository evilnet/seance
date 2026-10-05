/**
 * JOIN (with `extended-join`: `JOIN #chan account :realname`).
 * Ported from attic/server/plugins/irc-events/join.ts.
 */

import {ChanState, ChanType} from "../../../../shared/types/chan";
import {MessageType, SharedMsg} from "../../../../shared/types/msg";
import {newUser} from "../channel";
import {msgidOf} from "../message";
import {noteRestorationActivity} from "../persistence";
import type {Handler} from "../types";

const join: Handler = (client, msg) => {
	const [name, account, gecos] = msg.params;
	const nick = msg.source?.name ?? "";

	if (!name || !nick) {
		return;
	}

	const self = client.isSelf(nick);
	let chan = client.findChannel(name);

	if (client.replaying) {
		// History (draft/event-playback): a message only, no state changes.
		chan = chan ?? client.replayTarget;

		if (chan) {
			client.pushMessage(chan, {
				type: MessageType.JOIN,
				time: client.timeOf(msg),
				from: chan.userRef(nick),
				hostmask: `${msg.source?.user ?? ""}@${msg.source?.host ?? ""}`,
				self,
				...msgidOf(msg),
			});
		}

		return;
	}

	// Already in it: the server is repeating our membership (a session
	// restore, or its answer to a JOIN for a channel we never left).
	const wasJoined = self && chan?.state === ChanState.JOINED;

	// Did the user type a `/join` for it? Consumed either way, so a later
	// JOIN nobody asked for (a forced join, a restore) is not mistaken for it.
	const requested = self && client.takeRequestedJoin(name);

	if (!chan) {
		if (!self) {
			return; // a JOIN for a channel we are not in: nothing to attach it to
		}

		// A channel the user asked for opens its window; anything else
		// (a held session restoring one, a forced join) is state.
		chan = client.announceChannel(name, ChanType.CHANNEL, {
			state: ChanState.JOINED,
			shouldOpen: requested,
		});
	} else if (self && chan.state !== ChanState.JOINED) {
		chan.state = ChanState.JOINED;
		chan.users.clear();
		client.dispatch("channel:state", {chan: chan.id, state: chan.state});
	}

	// Re-joining after a drop, the server restoring a held session
	// (draft/persistence), or a membership we already have: state, not
	// something that happened.
	const quiet = self && (wasJoined || chan.rejoining || client.restoring);

	if (self) {
		chan.autoJoin = true;

		if (!wasJoined) {
			// The channel modes are asked for lazily, the first time the
			// channel is opened (IrcClient.open): one MODE per autojoined
			// channel at connect time is part of the burst that trips the
			// server's flood penalty (see catchup.ts).
			chan.modesKnown = false;
		}

		// A restoration burst is arriving: keep the autojoin waiting for it.
		noteRestorationActivity(client);
	}

	const message: Partial<SharedMsg> = {
		type: MessageType.JOIN,
		time: client.timeOf(msg),
		from: chan.userRef(nick),
		hostmask: `${msg.source?.user ?? ""}@${msg.source?.host ?? ""}`,
		self,
		...msgidOf(msg),
	};

	if (account && account !== "*") {
		// The shared type says boolean but join.vue prints it as text.
		(message as {account?: string}).account = account;
	}

	// A realname the user never set is the nick again (nefarious2 fills it
	// from the nick when USER's is empty); printing "dave (dave)" says nothing.
	if (gecos && !client.namesEqual(gecos, nick)) {
		message.gecos = gecos;
	}

	if (!quiet) {
		client.pushMessage(chan, message);
	}

	if (!chan.findUser(nick)) {
		chan.setUser(newUser(nick));
	}

	client.usersChanged(chan);
};

export default {JOIN: join};
