// Local-only message history operations.
//
// TheLounge asked the server to clear a channel's log (`history:clear`) and
// waited for the echo. Messages now only live in the client, so this acts on
// the store directly.

import {store} from "./store";
import {forgetTranslations} from "./translate/reader";

export function clearHistory(target: number): void {
	const netChan = store.getters.findChannel(target);

	if (!netChan) {
		return;
	}

	const channel = netChan.channel;
	const ids = channel.messages.map((m) => m.id);

	store.commit("translationRemoveMany", ids);
	forgetTranslations(ids);
	channel.messages = [];
	channel.unread = 0;
	channel.highlight = 0;
	channel.firstUnread = 0;
	channel.moreHistoryAvailable = false;
}
