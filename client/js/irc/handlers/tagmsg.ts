/**
 * TAGMSG: a line that is nothing but client tags. Seance acts on two kinds
 * of them; everything else (unknown tags) is ignored.
 *
 * Reactions (bus-contract §1.4): `+draft/react=<text>` or
 * `+draft/unreact=<text>` together with a `+draft/reply=<msgid>` (or
 * `+reply`) naming the message reacted to — the poxchat / nefarious2
 * convention, which the server also stores and replays inside chathistory
 * batches for channels (never for queries). The reaction becomes
 * `msg:react {chan, id, text, nick, remove}` for the loaded message the
 * msgid resolves to; without one it is dropped. Inside a history replay the
 * lookup waits until the batch's messages have ids (`IrcClient.afterReplay`).
 *
 * Typing notifications (bus-contract §1.5): `+typing=active|paused|done`
 * from someone else becomes `typing {chan, nick, state}` — never from our
 * own echo, never during a replay (the server does not store typing-only
 * TAGMSGs anyway). One TAGMSG may carry both a reaction and a typing tag.
 */

import {ChanType} from "../../../../shared/types/chan";
import {REACT_TAG, TYPING_TAG, typingStateOf, UNREACT_TAG} from "../wire";
import type {Channel} from "../channel";
import type {Handler} from "../types";
import {ignoreListFor} from "../../ignore";
import {replyTagOf, splitStatusTarget} from "./privmsg";

const tagmsg: Handler = (client, msg) => {
	const source = msg.source;

	if (!source) {
		return;
	}

	const nick = source.name;
	const react = msg.tags.get(REACT_TAG);
	const unreact = msg.tags.get(UNREACT_TAG);
	const text = react || unreact;
	const parent = replyTagOf(msg);
	const reaction = text && parent ? {text, parent, remove: !react} : undefined;
	const typing = typingStateOf(msg.tags.get(TYPING_TAG));

	if (!reaction && !typing) {
		return; // unknown tags, or a reaction without a reply tag
	}

	const self = client.isSelf(nick);

	if (!self && ignoreListFor(client.uuid).matches(nick, source.user, source.host)) {
		return;
	}

	let chan: Channel | undefined;

	if (client.replaying) {
		chan = client.replayTarget;
	} else {
		let {target} = splitStatusTarget(client, msg.params[0] ?? "");

		// A private TAGMSG belongs to the query with the other party: the
		// sender's, or the target's when the sender is us (echo-message).
		if (client.isSelf(target)) {
			target = nick;
		}

		chan = client.findChannel(target);
	}

	if (!chan || (chan.type !== ChanType.CHANNEL && chan.type !== ChanType.QUERY)) {
		return; // target not loaded: nothing to attach it to
	}

	const target = chan;

	if (typing && !self && !client.replaying) {
		client.dispatch("typing", {chan: target.id, nick, state: typing});
	}

	if (!reaction) {
		return;
	}

	if (!client.replaying) {
		client.dispatch("msg:changed", {
			chan: target.id,
			msgid: reaction.parent,
			react: {text: reaction.text, nick, remove: reaction.remove},
		});
	}

	client.afterReplay(() => {
		const id = target.idOf(reaction.parent);

		if (id !== undefined) {
			client.dispatch("msg:react", {
				chan: target.id,
				id,
				text: reaction.text,
				nick,
				remove: reaction.remove,
			});
		}
	});
};

export default {TAGMSG: tagmsg};
