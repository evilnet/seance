/**
 * `/ctcp <nick> <type> [args]`: send a CTCP request and note it locally.
 * `/ver <nick>` is the everyday one, a CTCP VERSION request.
 */

import {MessageType} from "../../../../shared/types/msg";
import {trailingLine} from "../wire";
import {t} from "../../i18n/core";
import type {Command} from "../types";

const ctcp: Command = {
	commands: ["ctcp", "ver"],
	input({client, chan, cmd, args}) {
		const words = args.filter((arg) => arg.length > 0);

		// `/ver bob` is `/ctcp bob VERSION`
		const params = cmd === "ver" ? [words[0], "VERSION"] : words;

		if (cmd === "ver" ? words.length !== 1 : params.length < 2) {
			client.pushMessage(chan, {
				type: MessageType.ERROR,
				text: cmd === "ver" ? t("cmd.usageVer") : t("cmd.usageCtcp"),
			});
			return;
		}

		const [target, rawType, ...rest] = params;
		const type = rawType.toUpperCase();

		client.pushMessage(chan, {
			type: MessageType.CTCP_REQUEST,
			ctcpMessage: `"${type}" to ${target}`,
			from: chan.userRef(client.nick),
		});

		client.send(trailingLine("PRIVMSG", [target, `\x01${[type, ...rest].join(" ")}\x01`]));
	},
};

export default ctcp;
