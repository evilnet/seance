/**
 * `/join #chan[,#chan2] [key[,key2]]` (also `/j`). With no argument, re-joins
 * the current channel. Keys are remembered on the placeholder so a reconnect
 * can re-JOIN.
 */

import {ChanType} from "../../../../shared/types/chan";
import {MessageType} from "../../../../shared/types/msg";
import {formatLine} from "../message";
import type {Command} from "../types";

const join: Command = {
	commands: ["join", "j"],
	input({client, chan, args}) {
		let names: string[];
		let keys: string[];

		if (args.length === 0 || args[0].length === 0) {
			if (chan.type !== ChanType.CHANNEL) {
				client.pushMessage(chan, {
					type: MessageType.ERROR,
					text: "Usage: /join <channel> [key]",
				});
				return;
			}

			names = [chan.name];
			keys = chan.shared.key ? [chan.shared.key] : [];
		} else {
			names = args[0].split(",").filter((name) => name.length > 0);
			keys = (args[1] ?? "").split(",");
		}

		const chantypes = client.isupport.chantypes;

		names = names.map((name) =>
			chantypes.includes(name[0]) ? name : `${chantypes[0]}${name}`
		);

		names.forEach((name, i) => {
			// The user wants to see this channel: its JOIN opens the window.
			client.requestJoin(name);
			const existing = client.findChannel(name);

			if (existing && existing.type === ChanType.CHANNEL) {
				existing.autoJoin = true;

				if (keys[i]) {
					existing.shared.key = keys[i];
				}
			}
		});

		const keyList = keys.join(",").replace(/,+$/, "");
		client.send(
			formatLine({
				command: "JOIN",
				params: keyList ? [names.join(","), keyList] : [names.join(",")],
			})
		);
	},
};

export default join;
