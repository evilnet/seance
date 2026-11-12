/**
 * `/ban <mask>`, `/unban <mask>`, `/kickban <nick> [reason]`, `/banlist`,
 * `/exceptlist`. Ported from attic/server/plugins/inputs/ban.ts; `/exceptlist`
 * is new (MODE query using the EXCEPTS mode letter). `/banlist` opens the Bans
 * window; the 367/368 and 348/349 replies are handled in `handlers/lists.ts`.
 */

import {ChanType} from "../../../../shared/types/chan";
import {MessageType} from "../../../../shared/types/msg";
import {formatLine} from "../message";
import {trailingLine} from "../wire";
import {t} from "../../i18n/core";
import type {Command} from "../types";
import {textAfter} from "./words";

const ban: Command = {
	commands: ["ban", "unban", "banlist", "kickban", "exceptlist"],
	input({client, chan, cmd, args, rest}) {
		if (chan.type !== ChanType.CHANNEL) {
			client.pushMessage(chan, {
				type: MessageType.ERROR,
				text: t("cmd.channelsOnly", {cmd}),
			});
			return;
		}

		if (cmd !== "banlist" && cmd !== "exceptlist" && args.length === 0) {
			client.pushMessage(chan, {
				type: MessageType.ERROR,
				text: t("cmd.usageNick", {cmd}),
			});
			return;
		}

		switch (cmd) {
			case "kickban": {
				const reason = textAfter(rest, 1);
				client.send(
					reason
						? trailingLine("KICK", [chan.name, args[0], reason])
						: formatLine({command: "KICK", params: [chan.name, args[0]]})
				);
				client.send(formatLine({command: "MODE", params: [chan.name, "+b", args[0]]}));
				break;
			}

			case "ban":
				client.send(formatLine({command: "MODE", params: [chan.name, "+b", args[0]]}));
				break;

			case "unban":
				client.send(formatLine({command: "MODE", params: [chan.name, "-b", args[0]]}));
				break;

			case "banlist":
				client.requestBanList(chan.name, true);
				break;

			case "exceptlist": {
				// EXCEPTS may be advertised with an empty value, meaning the default "e".
				const excepts = client.isupport.get("EXCEPTS") || "e";
				client.send(formatLine({command: "MODE", params: [chan.name, excepts]}));
				break;
			}
		}
	},
};

export default ban;
