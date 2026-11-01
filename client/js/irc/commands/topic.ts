/**
 * `/topic [#chan] [text]` (query or set, of the current or a named channel)
 * and `/cleartopic`.
 */

import {ChanType} from "../../../../shared/types/chan";
import {MessageType} from "../../../../shared/types/msg";
import {formatLine} from "../message";
import {trailingLine} from "../wire";
import {t} from "../../i18n/core";
import type {Command} from "../types";

const topic: Command = {
	commands: ["topic", "cleartopic"],
	input({client, chan, cmd, args, rest}) {
		// `/topic #chan …` names its target; anything else means "here".
		const first = args[0] ?? "";
		const named =
			cmd === "topic" && first !== "" && client.isupport.chantypes.includes(first[0]);

		if (!named && chan.type !== ChanType.CHANNEL) {
			client.pushMessage(chan, {
				type: MessageType.ERROR,
				text: t("cmd.channelsOnly", {cmd}),
			});
			return;
		}

		if (cmd === "cleartopic") {
			client.send(formatLine({command: "TOPIC", params: [chan.name, ""]}));
			return;
		}

		const targetName = named ? first : chan.name;
		const text = named ? rest.slice(first.length + 1) : rest;
		const textArgs = named ? args.slice(1) : args;

		if (textArgs.every((arg) => arg.trim() === "")) {
			// A query: show the reply even when it repeats the topic we
			// already display (handlers/topic.ts hides join-burst repeats),
			// and even for a channel we are not in (normally dropped).
			const target = named ? client.findChannel(targetName) : chan;

			if (target) {
				target.topicAsked = true;
			} else {
				client.markInfoAsked(targetName);
			}

			client.send(formatLine({command: "TOPIC", params: [targetName]}));
			return;
		}

		// Untrimmed on purpose: the user may have added whitespace deliberately.
		client.send(trailingLine("TOPIC", [targetName, text]));
	},
};

export default topic;
