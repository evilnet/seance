/**
 * `/react <text> [msgid]` and `/unreact <text> [msgid]`: a `+draft/react` /
 * `+draft/unreact` TAGMSG on a message in the current channel or query.
 *
 * `text` is free text — an emoji, several of them, a `:shortcode:` (expanded
 * here the way it would be in a message) or a word or two — so everything up
 * to the optional trailing msgid is the reaction. A last argument only counts
 * as a msgid when it names a message loaded here, which is what keeps
 * `/react so cool` from losing its last word. The msgid defaults to the
 * newest message here that has one.
 */

import {ChanType} from "../../../../shared/types/chan";
import {MessageType} from "../../../../shared/types/msg";
import {normalizeReaction} from "../../helpers/emoji";
import type {Command} from "../types";

const react: Command = {
	commands: ["react", "unreact"],
	input({client, chan, cmd, args}) {
		if (chan.type !== ChanType.CHANNEL && chan.type !== ChanType.QUERY) {
			client.pushMessage(chan, {
				type: MessageType.ERROR,
				text: `${cmd} command can only be used in channels and queries.`,
			});
			return;
		}

		const words = args.filter((arg) => arg.length > 0);
		const last = words[words.length - 1];
		const explicit = words.length > 1 && chan.idOf(last) !== undefined ? last : undefined;
		const text = normalizeReaction(
			(explicit === undefined ? words : words.slice(0, -1)).join(" ")
		);

		if (text.length === 0) {
			client.pushMessage(chan, {
				type: MessageType.ERROR,
				text: `Usage: /${cmd} <text> [msgid]`,
			});
			return;
		}

		const msgid = explicit ?? chan.newestReactableMsgid();

		if (!msgid) {
			client.pushMessage(chan, {
				type: MessageType.ERROR,
				text: "No message to react to: none here carries a msgid.",
			});
			return;
		}

		client.react(chan, msgid, text, cmd === "unreact");
	},
};

export default react;
