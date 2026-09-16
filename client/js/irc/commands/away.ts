/**
 * `/away [reason]` and `/back`. An `/away` without a reason still sets away
 * (with a single space, as the old server did).
 */

import {formatLine} from "../message";
import {userAwayChanged} from "../presence";
import {trailingLine} from "../wire";
import type {Command} from "../types";

const away: Command = {
	commands: ["away", "back"],
	input({client, cmd, args}) {
		if (cmd === "away") {
			userAwayChanged(client, true);
			client.send(trailingLine("AWAY", [args.join(" ") || " "]));
			return;
		}

		userAwayChanged(client, false);
		client.send(formatLine({command: "AWAY", params: []}));
	},
};

export default away;
