/**
 * `/ignorelist`: show the network's ignore list in the "Ignored users"
 * special window (`client/components/Special/ListIgnored.vue`).
 */

import {SpecialChanType} from "../../../../shared/types/chan";
import {MessageType} from "../../../../shared/types/msg";
import {ignoreListFor} from "../../ignore";
import {showSpecial} from "../handlers/list";
import {formatHostmask} from "../hostmask";
import {t} from "../../i18n/core";
import type {Command} from "../types";

const ignorelist: Command = {
	commands: ["ignorelist"],
	allowDisconnected: true,
	input({client, chan}) {
		const list = ignoreListFor(client.uuid);

		if (list.list.length === 0) {
			client.pushMessage(chan, {type: MessageType.ERROR, text: t("cmd.ignorelistEmpty")});
			return;
		}

		const data = list.list.map((entry) => ({
			hostmask: formatHostmask(entry),
			when: entry.when,
		}));

		showSpecial(client, t("cmd.ignorelistTitle"), SpecialChanType.IGNORELIST, data);
	},
};

export default ignorelist;
