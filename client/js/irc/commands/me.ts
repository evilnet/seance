/**
 * `/me <text>` and `/slap <nick>`: CTCP ACTION to the current channel or query.
 */

import {ChanType} from "../../../../shared/types/chan";
import {MessageType} from "../../../../shared/types/msg";
import {inputTags} from "../wire";
import {t} from "../../i18n/core";
import type {Command} from "../types";
import {textAfter} from "./words";

const me: Command = {
	commands: ["slap", "me"],
	input({client, chan, cmd, args, rest, opts}) {
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
			cmd === "slap"
				? `slaps ${args[0]} around a bit with a large trout`
				: textAfter(rest, 0);

		if (text.length > 0) {
			// An action can be a reply, and the replacement in an edit
			// (dispatchInput hands an edit whose body starts `/me ` here).
			const reply = opts?.reply;

			if (opts?.edit && cmd === "me") {
				client.editMessage(chan, opts.edit, text, reply, true);
				return;
			}

			// A translated action carries its language tags as a message does.
			const tags = cmd === "me" ? inputTags(opts ?? {}) : inputTags({reply});

			client.sendMessage(chan.name, text, {
				action: true,
				...(tags ? {tags} : {}),
			});
		}
	},
};

export default me;
