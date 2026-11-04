/**
 * `/whois <nick>`. With exactly one argument the nick is doubled
 * (`WHOIS nick nick`) so the query goes to the server the user is on, which
 * is the only one that knows their idle time (superuser.com/a/272069).
 * Replies are assembled by `handlers/whois.ts`.
 */

import {formatLine} from "../message";
import type {Command} from "../types";

const whois: Command = {
	commands: ["whois"],
	input({client, args}) {
		const params = [...args];

		if (params.length === 1) {
			params.push(params[0]);
		}

		client.send(formatLine({command: "WHOIS", params}));
	},
};

export default whois;
