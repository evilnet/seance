/**
 * `/who [mask] [flags]`. Without arguments, the current channel. With
 * `WHOX` in ISUPPORT the query asks for the fields `handlers/who.ts` lays
 * out (`%tcuhsnfdar,<token>`: account names included), unless the user
 * wrote a `%` spec of their own, which is sent as typed and answered as
 * plain text. The result is one `who` message in the channel the mask
 * names when we are in it, otherwise where the command was typed.
 */

import {ChanType} from "../../../../shared/types/chan";
import {MessageType} from "../../../../shared/types/msg";
import {beginWho, WHOX_FIELDS} from "../handlers/who";
import {formatLine} from "../message";
import type {Command} from "../types";

const tokens = new WeakMap<object, number>();

/** The next WHOX token for this client: nefarious2 keeps three digits at most. */
function nextToken(client: object): string {
	const next = ((tokens.get(client) ?? 0) % 999) + 1;
	tokens.set(client, next);
	return String(next);
}

const who: Command = {
	commands: ["who"],
	input({client, chan, args}) {
		const params = args.filter((arg) => arg.length > 0);

		if (params.length === 0) {
			if (chan.type !== ChanType.CHANNEL) {
				client.pushMessage(chan, {
					type: MessageType.ERROR,
					text: "Usage: /who [mask] [flags] (the current channel when no mask is given)",
				});
				return;
			}

			params.push(chan.name);
		}

		const target = params[0];
		const custom = params.some((param) => param.includes("%"));
		const whox = !custom && client.isupport.has("WHOX");
		const token = whox ? nextToken(client) : undefined;

		if (token !== undefined) {
			params.push(`%${WHOX_FIELDS},${token}`);
		}

		beginWho(client, {
			target,
			chan: client.findChannel(target) ?? chan,
			token,
			custom: custom || undefined,
		});
		client.send(formatLine({command: "WHO", params}));
	},
};

export default who;
