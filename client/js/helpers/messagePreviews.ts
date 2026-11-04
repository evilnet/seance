// Attaches the client-side media previews (helpers/mediaPreview.ts) to a
// message coming off the bus. Both live messages (socket-events/msg.ts) and
// chathistory batches (socket-events/more.ts) go through here, so scrollback
// previews look exactly like live ones.
import {store} from "../store";
import {buildMediaPreviews} from "./mediaPreview";
import {accountKey, channelKey} from "./mediaTrust";
import type {SharedMsg} from "../../../shared/types/msg";
import {ChanType} from "../../../shared/types/chan";
import type {ClientChan, ClientNetwork} from "../types";

export function attachMediaPreviews(
	msg: SharedMsg,
	network: ClientNetwork,
	channel: ClientChan
): void {
	if (!msg.text || msg.previews?.length) {
		return;
	}

	const previews = buildMediaPreviews(msg.text, {
		media: store.state.settings.media,
		allowHttp: window.location.protocol === "http:",
	});

	// Where the links were posted, for "always show in #chan" / "from alice"
	// (helpers/mediaTrust.ts). Queries and the lobby have no channel scope;
	// senders without an `account-tag` have no account scope.
	const scope: NonNullable<(typeof previews)[number]["scope"]> = {};

	if (channel.type === ChanType.CHANNEL) {
		scope.channel = channelKey(network.uuid, channel.name);
		scope.channelName = channel.name;
	}

	if (msg.fromAccount) {
		scope.account = accountKey(network.uuid, msg.fromAccount);
		scope.accountName = msg.fromAccount;
	}

	for (const preview of previews) {
		preview.scope = scope;

		// The reader posted these links themselves (or their echo came back):
		// nothing to protect them from, so skip the click-to-reveal veil.
		if (msg.self) {
			preview.revealed = true;
		}
	}

	msg.previews = previews;
}
