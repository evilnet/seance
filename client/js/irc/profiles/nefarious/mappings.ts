/**
 * `STATS R`: the server's service pseudo-commands (its `Pseudo` blocks —
 * what makes `/AUTHSERV` work), one 276 per command and target:
 * `<me> <Command> <Name> <Prepend|*> <nick@server>`, after a header row of
 * the column names (s_stats.c `stats_mapping`, nefarious2-oper.md § STATS).
 * It is how an oper's client learns which nicks are the network's services
 * without being told (services/detect.ts).
 */

import type {IrcMessage} from "../../message";
import type {ServiceMapping} from "../types";

export function parseMappings(lines: IrcMessage[]): ServiceMapping[] {
	const out: ServiceMapping[] = [];

	for (const msg of lines) {
		if (msg.command !== "276" || msg.params.length < 3) {
			continue;
		}

		// The prepend may hold spaces: the command is the first field and
		// the target the last, whatever sits between.
		const command = msg.params[1];
		const target = msg.params[msg.params.length - 1];
		const at = target.indexOf("@");

		if (at <= 0 || (command === "Command" && target === "Target")) {
			continue;
		}

		out.push({
			command: command.toUpperCase(),
			nick: target.slice(0, at),
			server: target.slice(at + 1),
		});
	}

	return out;
}
