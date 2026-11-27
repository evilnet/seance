/**
 * `/raw`, `/quote`, `/send`: the rest of the line goes to the server verbatim.
 */

import type {Command} from "../types";
import {noteTypedLine} from "../avatars";

const raw: Command = {
	commands: ["raw", "send", "quote"],
	input({client, rest}) {
		if (rest.trim().length > 0 && client.send(rest)) {
			noteTypedLine(client, rest); // a METADATA naming the avatar key (irc/avatars.ts)
		}
	},
};

export default raw;
