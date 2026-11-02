/**
 * `/ctcp <nick> <type> [args]`: send a CTCP request and note it locally.
 * `/ver <nick>` is the everyday one, a CTCP VERSION request.
 */

import {MessageType} from "../../../../shared/types/msg";
import {trailingLine} from "../wire";
import type {Command} from "../types";
import {textAfter} from "./words";

const ctcp: Command = {
	commands: ["ctcp", "ver"],
	input({client, chan, cmd, args, rest}) {
		// `/ver bob` is `/ctcp bob VERSION`
		const params = cmd === "ver" ? [args[0], "VERSION"] : args;

		if (cmd === "ver" ? args.length !== 1 : params.length < 2) {
			client.pushMessage(chan, {
				type: MessageType.ERROR,
				text: cmd === "ver" ? "Usage: /ver <nick>" : "Usage: /ctcp <nick> <ctcp_type>",
			});
			return;
		}

		const [target, rawType] = params;
		const type = rawType.toUpperCase();
		// What follows the type is the request's own text, spaces as typed.
		const text = cmd === "ver" ? "" : textAfter(rest, 2);

		client.pushMessage(chan, {
			type: MessageType.CTCP_REQUEST,
			ctcpMessage: `"${type}" to ${target}`,
			from: chan.userRef(client.nick),
		});

		client.send(
			trailingLine("PRIVMSG", [target, `\x01${text ? `${type} ${text}` : type}\x01`])
		);
	},
};

export default ctcp;
