/**
 * `/mute [#chan ...]`, `/unmute [#chan ...]`: flip the muted flag on the
 * current channel or the named ones. The flag itself is stored by
 * `client/js/mute.ts` (localStorage), reached through the client's
 * `setMuteStatus` option so this module stays free of store imports.
 */

import {ChanType} from "../../../../shared/types/chan";
import {MessageType} from "../../../../shared/types/msg";
import type {Channel} from "../channel";
import type {IrcClient} from "../client";
import type {Command} from "../types";

function setMuted(client: IrcClient, target: Channel, muted: boolean): void {
	if (target.type === ChanType.SPECIAL) {
		return;
	}

	target.shared.muted = muted;
	client.options.setMuteStatus?.(target.id, muted);
}

const mute: Command = {
	commands: ["mute", "unmute"],
	allowDisconnected: true,
	input({client, chan, cmd, args}) {
		const muted = cmd === "mute";

		if (args.length === 0) {
			setMuted(client, chan, muted);
			return;
		}

		const targets: Channel[] = [];
		const missing: string[] = [];

		for (const name of args) {
			const target = client.findChannel(name);

			if (target) {
				targets.push(target);
			} else {
				missing.push(name);
			}
		}

		if (missing.length > 0) {
			client.pushMessage(chan, {
				type: MessageType.ERROR,
				text: `No open ${
					missing.length === 1 ? "channel or user" : "channels or users"
				} found for ${missing.join(",")}`,
			});
			return;
		}

		for (const target of targets) {
			setMuted(client, target, muted);
		}
	},
};

export default mute;
