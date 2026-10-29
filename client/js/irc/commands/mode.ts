/**
 * `/mode [target] <modes> [args]`, `/umode <modes>` and the prefix shortcuts
 * `/op /deop /hop /dehop /voice /devoice <nick> [...nick]` (batched per the
 * server's MODES limit). Ported from attic/server/plugins/inputs/mode.ts.
 */

import {ChanType} from "../../../../shared/types/chan";
import {MessageType} from "../../../../shared/types/msg";
import {formatLine} from "../message";
import {t} from "../../i18n/core";
import type {Command} from "../types";

const shortcuts: Record<string, string> = {
	op: "+o",
	hop: "+h",
	voice: "+v",
	deop: "-o",
	dehop: "-h",
	devoice: "-v",
};

const mode: Command = {
	commands: ["mode", "umode", "op", "deop", "hop", "dehop", "voice", "devoice"],
	input({client, chan, cmd, args}) {
		const params = args.filter((arg) => arg.length > 0);

		if (cmd === "umode") {
			client.send(formatLine({command: "MODE", params: [client.nick, ...params]}));
			return;
		}

		if (cmd !== "mode") {
			if (chan.type !== ChanType.CHANNEL) {
				client.pushMessage(chan, {
					type: MessageType.ERROR,
					text: t("cmd.channelsOnly", {cmd}),
				});
				return;
			}

			if (params.length === 0) {
				client.pushMessage(chan, {
					type: MessageType.ERROR,
					text: t("cmd.usageNickMulti", {cmd}),
				});
				return;
			}

			const change = shortcuts[cmd];
			const limit = parseInt(client.isupport.get("MODES") ?? "", 10) || params.length;

			for (let i = 0; i < params.length; i += limit) {
				const targets = params.slice(i, i + limit);
				const modes = `${change[0]}${change[1].repeat(targets.length)}`;
				client.send(formatLine({command: "MODE", params: [chan.name, modes, ...targets]}));
			}

			return;
		}

		if (params.length === 0 || params[0][0] === "+" || params[0][0] === "-") {
			params.unshift(
				chan.type === ChanType.CHANNEL || chan.type === ChanType.QUERY
					? chan.name
					: client.nick
			);
		}

		if (params.length === 1) {
			// A query: show the reply even when it repeats the modes we
			// already display (handlers/mode.ts hides join-burst repeats),
			// and even for a channel we are not in (normally dropped).
			const target = client.findChannel(params[0]);

			if (target) {
				target.modesAsked = true;
			} else if (client.isupport.chantypes.includes(params[0][0])) {
				client.markInfoAsked(params[0]);
			}
		}

		client.send(formatLine({command: "MODE", params}));
	},
};

export default mode;
