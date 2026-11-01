/**
 * `/mute [#chan ...]`, `/unmute [#chan ...]`: flip the muted flag on the
 * current channel or the named ones. The flag itself is stored by
 * `client/js/mute.ts` (localStorage), reached through the client's
 * `setMuteStatus` option so this module stays free of store imports.
 */

import {ChanType} from "../../../../shared/types/chan";
import {t} from "../../i18n/core";
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
		const names = args.filter((arg) => arg.length > 0);

		if (names.length === 0) {
			setMuted(client, chan, muted);
			return;
		}

		const targets: Channel[] = [];
		const missing: string[] = [];

		for (const name of names) {
			const target = client.findChannel(name);

			if (target) {
				targets.push(target);
			} else {
				missing.push(name);
			}
		}

		if (missing.length > 0) {
			const missingList = missing.join(",");

			client.pushMessage(chan, {
				type: MessageType.ERROR,
				text:
					missing.length === 1
						? t("cmd.mute.noneSingular", {targets: missingList})
						: t("cmd.mute.nonePlural", {targets: missingList}),
			});
			return;
		}

		for (const target of targets) {
			setMuted(client, target, muted);
		}
	},
};

export default mute;
