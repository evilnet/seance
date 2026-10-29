import socket from "../socket";
import {getPendingTarget, isChannelTarget, takePendingTarget} from "../helpers/pendingTarget";
import {beginLanding, cancelLanding, pendingLanding, takeLanding} from "../helpers/lastChannel";
import {store} from "../store";
import {findChannelByName, onStandalonePage, switchToChannel} from "../router";
import {toClientChan} from "../chan";
import {ClientNetwork} from "../types";
import {ChanState, ChanType} from "../../../shared/types/chan";
import {applyStoredChannelOrder, applyStoredNetworkOrder} from "../sort";
import {collator} from "../i18n/collation";
import {applyStoredMuteStatus} from "../mute";

socket.on("network", function (data) {
	const network: ClientNetwork = {
		...data.network,
		channels: data.network.channels.map(toClientChan),
		isJoinChannelShown: false,
		isCollapsed: false,
	};

	applyStoredChannelOrder(network, collator());
	applyStoredMuteStatus(network);
	store.commit("networks", [...store.state.networks, network]);
	applyStoredNetworkOrder(collator());

	openOnAnnounce(network);
});

/**
 * Where the view goes while the network connects. In order: the conversation
 * a notification deep link is waiting for on it, the one the last page had
 * open on it (helpers/lastChannel.ts), else — as always — the last channel
 * of the join list. The autojoin channels are already here as placeholders,
 * so a deep link or a remembered channel that is one of them is shown at
 * once. One that is not (a private conversation, a channel a held session
 * will restore) is waited for in the lobby: the `network:status` handler
 * below reopens a query once registered, and socket-events/join.ts lands on
 * the join when it comes. Waiting in the lobby rather than on a placeholder
 * matters — what is shown is what gets remembered, and an automatic stop
 * must not overwrite the memory.
 *
 * None of that on a page the user opened on purpose (settings, help, …): the
 * networks boot dials there come up in the sidebar and the view stays put —
 * the remembered conversation is left for them to open, and no landing is
 * begun for it. A deep link is different: the user asked for it.
 */
function openOnAnnounce(network: ClientNetwork): void {
	const pending = getPendingTarget();
	const fromDeepLink = pending !== null && pending.network === network.uuid;

	if (!fromDeepLink && onStandalonePage()) {
		return;
	}

	const waitingFor = fromDeepLink ? pending : beginLanding(network.uuid);

	if (!waitingFor) {
		// The last of the join list — not a private conversation the query
		// log brought back, which sorts in among them (irc/querylog.ts).
		const joinList = network.channels.filter((c) => c.type === ChanType.CHANNEL);
		switchToChannel(joinList[joinList.length - 1] ?? network.channels[0]);
		return;
	}

	const hit = findChannelByName(network.uuid, waitingFor.target);

	if (!hit) {
		switchToChannel(network.channels[0]);
		return;
	}

	if (fromDeepLink) {
		takePendingTarget();
	} else {
		takeLanding();
	}

	switchToChannel(hit);
}

socket.on("network:options", function (data) {
	const network = store.getters.findNetwork(data.network);

	if (network) {
		network.serverOptions = data.serverOptions;
	}
});

/**
 * The connect was dropped before it registered and the lobby says why. The
 * connect flow lands on the last autojoin channel (`openOnAnnounce`), so
 * without this the user sits on an empty channel with the explanation a
 * badge away. Move to the lobby when the view is on that network or on
 * nothing in particular; leave a page opened on purpose alone, as the
 * announce does. Any landing still pending is called off: there is no
 * conversation coming to land on.
 */
socket.on("network:aborted", function (data) {
	const network = store.getters.findNetwork(data.network);

	if (!network || network.channels.length === 0) {
		return;
	}

	cancelLanding();

	const active = store.state.activeChannel?.network;

	if (onStandalonePage() || (active && active.uuid !== data.network)) {
		return;
	}

	switchToChannel(network.channels[0]);
});

socket.on("network:presence", function (data) {
	const network = store.getters.findNetwork(data.network);

	if (network) {
		network.presence = data.presence;
	}
});

socket.on("network:status", function (data) {
	const network = store.getters.findNetwork(data.network);

	if (!network) {
		return;
	}

	if (data.connected) {
		delete network.status.downSince;
	} else if (network.status.downSince === undefined) {
		network.status.downSince = Date.now();
	}

	network.status.connected = data.connected;
	network.status.connecting = data.connecting;
	network.status.secure = data.secure;

	// Only while a retry is pending; the key goes with the wait.
	if (data.retryAt !== undefined) {
		network.status.retryAt = data.retryAt;
	} else {
		delete network.status.retryAt;
	}

	// And whether that wait is the server's connection throttle.
	if (data.retryThrottled) {
		network.status.retryThrottled = true;
	} else {
		delete network.status.retryThrottled;
	}

	// A private conversation to reopen now that we are registered: the one
	// a notification deep link names, or the one the last page had open.
	// Channels arrive with the join burst, a query window only when opened —
	// do that now (the resulting `join` lands on it).
	const pending = getPendingTarget();
	const waitingFor =
		pending !== null && pending.network === data.network
			? pending
			: pendingLanding(data.network);

	if (
		data.connected &&
		waitingFor &&
		!isChannelTarget(waitingFor.target) &&
		network.channels.length > 0
	) {
		socket.emit("input", {
			target: network.channels[0].id,
			text: `/query ${waitingFor.target}`,
		});
	}

	if (!data.connected) {
		network.channels.forEach((channel) => {
			channel.users = []; // TODO: untangle this
			channel.state = ChanState.PARTED;
		});
	}
});

socket.on("channel:state", function (data) {
	const channel = store.getters.findChannel(data.chan);

	if (channel) {
		channel.channel.state = data.state;
	}
});

socket.on("network:info", function (data) {
	const network = store.getters.findNetwork(data.uuid);

	if (!network) {
		return;
	}

	for (const key in data) {
		network[key] = data[key];
	}
});

socket.on("network:name", function (data) {
	const network = store.getters.findNetwork(data.uuid);

	if (network) {
		network.name = network.channels[0].name = data.name;
	}
});
