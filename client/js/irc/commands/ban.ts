/**
 * `/ban <mask>`, `/unban <mask>`, `/kickban <nick> [reason]`, `/banlist`,
 * `/exceptlist`. Ported from attic/server/plugins/inputs/ban.ts; `/exceptlist`
 * is new (MODE query using the EXCEPTS mode letter). The 367/368 and 348/349
 * replies to `/banlist` and `/exceptlist` are handled in `handlers/lists.ts`.
 */

import {ChanType} from "../../../../shared/types/chan";
import {MessageType} from "../../../../shared/types/msg";
import {formatLine} from "../message";
import {trailingLine} from "../wire";
import {t} from "../../i18n/core";
import type {Command} from "../types";

const ban: Command = {
	commands: ["ban", "unban", "banlist", "kickban", "exceptlist"],
	input({client, chan, cmd, args}) {
		if (chan.type !== ChanType.CHANNEL) {
			client.pushMessage(chan, {
				type: MessageType.ERROR,
				text: t("cmd.channelsOnly", {cmd}),
			});
			return;
		}

		if (
			cmd !== "banlist" &&
			cmd !== "exceptlist" &&
			(args.length === 0 || args[0].length === 0)
		) {
			client.pushMessage(chan, {
				type: MessageType.ERROR,
				text: t("cmd.usageNick", {cmd}),
			});
			return;
		}

		switch (cmd) {
			case "kickban": {
				const reason = args.slice(1).join(" ");
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
				client.send(formatLine({command: "MODE", params: [chan.name, "b"]}));
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
