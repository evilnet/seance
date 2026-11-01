/**
 * `/kill <nick> [reason]` (operators only; the server answers 481 otherwise).
 */

import {trailingLine} from "../wire";
import type {Command} from "../types";
import {textAfter} from "./words";

const kill: Command = {
	commands: ["kill"],
	input({client, args, rest}) {
		if (args.length === 0 || args[0].length === 0) {
			return;
		}

		client.send(trailingLine("KILL", [args[0], textAfter(rest, 1)]));
	},
};

export default kill;
