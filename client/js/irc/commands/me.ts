/**
 * `/me <text>` and `/slap <nick>`: CTCP ACTION to the current channel or query.
 */

import {ChanType} from "../../../../shared/types/chan";
import {MessageType} from "../../../../shared/types/msg";
import {REPLY_TAG} from "../wire";
import {t} from "../../i18n/core";
import type {Command} from "../types";

const me: Command = {
	commands: ["slap", "me"],
	input({client, chan, cmd, args, opts}) {
		if (chan.type !== ChanType.CHANNEL && chan.type !== ChanType.QUERY) {
			client.pushMessage(chan, {
				type: MessageType.ERROR,
				text: t("cmd.channelsAndQueriesOnly", {cmd}),
			});
			return;
		}

		if (args.length === 0) {
			return;
		}

		const text =
			cmd === "slap" ? `slaps ${args[0]} around a bit with a large trout` : args.join(" ");

		if (text.length > 0) {
			// An action can be a reply; it cannot be an edit (bus-contract §1.4).
			const reply = opts?.reply;
			client.sendMessage(chan.name, text, {
				action: true,
				...(reply ? {tags: {[REPLY_TAG]: reply}} : {}),
			});
		}
	},
};

export default me;
