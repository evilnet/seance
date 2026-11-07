import {navigate} from "../router";
import {store} from "../store";

/**
 * `/list [args]` opens the channel browser for the active network; the IRC
 * layer's own `/list` (irc/commands/list.ts) then asks the server, with the
 * arguments as given. Returns false so the line goes on to it.
 */
export function input(): boolean {
	const network = store.state.activeChannel?.network;

	if (network) {
		void navigate("ChannelBrowser", {uuid: network.uuid});
	}

	return false;
}
