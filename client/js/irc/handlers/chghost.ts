/**
 * CHGHOST (`chghost` cap): `:nick!old@old CHGHOST newident newhost`.
 */

import {MessageType} from "../../../../shared/types/msg";
import type {Handler} from "../types";
import {forgetBot} from "../bottrust";

const chghost: Handler = (client, msg) => {
	const nick = msg.source?.name ?? "";
	const [newIdent = "", newHost = ""] = msg.params;
	const oldIdent = msg.source?.user ?? "";
	const oldHost = msg.source?.host ?? "";
	const self = client.isSelf(nick);

	if (!nick) {
		return;
	}

	if (!client.replaying) {
		forgetBot(client, nick);
	}

	if (self) {
		client.ident = newIdent;
		client.host = newHost;
	}

	const time = client.timeOf(msg);

	for (const chan of client.channels) {
		const user = chan.findUser(nick);

		if (!user) {
			continue;
		}

		client.pushMessage(chan, {
			type: MessageType.CHGHOST,
			time,
			from: chan.userRef(nick),
			new_ident: newIdent !== oldIdent ? newIdent : "",
			new_host: newHost !== oldHost ? newHost : "",
			self,
		});
	}
};

export default {CHGHOST: chghost};
