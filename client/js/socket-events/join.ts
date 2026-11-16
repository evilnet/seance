import socket from "../socket";
import {store} from "../store";
import {switchToChannel} from "../router";
import {ClientChan} from "../types";
import {toClientChan} from "../chan";
import {matchesPendingTarget, takePendingTarget} from "../helpers/pendingTarget";
import {matchesLanding, takeLanding} from "../helpers/lastChannel";
import {applyStoredChannelOrder} from "../sort";
import {applyStoredMute} from "../mute";

socket.on("join", function (data) {
	const network = store.getters.findNetwork(data.network);

	if (!network) {
		return;
	}

	const clientChan: ClientChan = toClientChan(data.chan);
	// Muted before it went (or before the page did): muted again, before
	// any message in it can alert or reach the inbox.
	applyStoredMute(data.network, clientChan);
	// The index is the IRC layer's, whose array never sees a drag: snap the
	// remembered names to place (a stable sort keeps the rest where they are).
	network.channels.splice(data.index || -1, 0, clientChan);
	applyStoredChannelOrder(network);

	// A notification deep link is waiting for exactly this conversation.
	if (matchesPendingTarget(data.network, clientChan.name)) {
		takePendingTarget();
		switchToChannel(clientChan);
		return;
	}

	// The conversation the last page had open, arriving now: a query
	// reopened once registered, a channel a held session restores
	// (helpers/lastChannel.ts).
	if (matchesLanding(data.network, clientChan.name)) {
		takeLanding();
		switchToChannel(clientChan);
		return;
	}

	// The user asked for this window (/join, /query, whois): show it.
	// Anything else — a held session restoring its channels
	// (draft/persistence), a forced join, an incoming private message — is
	// state, not navigation: the view stays where it is. The autojoin
	// channels never get here (they are placeholders from the network's
	// announce), and a restore burst would otherwise walk the view through
	// every channel it brings, away from the one just landed on.
	if (data.shouldOpen) {
		switchToChannel(clientChan);
	}
});
