import socket from "../socket";
import storage from "../localStorage";
import {toClientChan} from "../chan";
import {onStandalonePage, switchToChannel} from "../router";
import {store} from "../store";
import {ClientNetwork, ClientChan} from "../types";
import {SharedNetwork, SharedNetworkChan} from "../../../shared/types/network";
import {applyStoredNetworkOrder, applyStoredChannelOrder} from "../sort";
import {collator} from "../i18n/collation";
import {applyStoredMuteStatus} from "../mute";

// `init` used to be the server's "here is everything you have" event after
// authentication. The app-loaded / routing / query-param parts of it now run
// at boot (see client/js/boot.ts); what is left is the network merge, which
// the IRC layer will reuse when it (re)connects.
socket.on("init", function (data) {
	store.commit("networks", mergeNetworkData(data.networks));
	applyStoredNetworkOrder(collator());

	for (const network of store.state.networks) {
		applyStoredChannelOrder(network, collator());
		applyStoredMuteStatus(network);
	}

	store.commit("isConnected", true);
	store.commit("currentUserVisibleError", null);

	// Open the channel the sender asked for, if we are not already somewhere:
	// neither in a conversation nor on a page the user opened (settings,
	// help, …), which a registration — boot's autoconnect, a reconnect —
	// leaves alone.
	const channel = store.getters.findChannel(data.active);

	if (channel && !store.state.activeChannel && !onStandalonePage()) {
		switchToChannel(channel.channel);
	}
});

function mergeNetworkData(newNetworks: SharedNetwork[]): ClientNetwork[] {
	const stored = storage.get("thelounge.networks.collapsed");
	const collapsedNetworks = stored ? new Set(JSON.parse(stored)) : new Set();
	const result: ReturnType<typeof mergeNetworkData> = [];

	for (const sharedNet of newNetworks) {
		const currentNetwork = store.getters.findNetwork(sharedNet.uuid);

		// If this network is new, set some default variables and initalize channel variables
		if (!currentNetwork) {
			const newNet: ClientNetwork = {
				...sharedNet,
				channels: sharedNet.channels.map(toClientChan),
				isJoinChannelShown: false,
				isCollapsed: collapsedNetworks.has(sharedNet.uuid),
			};
			result.push(newNet);
			continue;
		}

		// Merge received network object into existing network object on the client
		// so the object reference stays the same (e.g. for currentChannel state)
		for (const key in sharedNet) {
			if (!Object.prototype.hasOwnProperty.call(sharedNet, key)) {
				continue;
			}

			// Channels require extra care to be merged correctly
			if (key === "channels") {
				currentNetwork.channels = mergeChannelData(
					currentNetwork.channels,
					sharedNet.channels
				);
			} else {
				currentNetwork[key] = sharedNet[key];
			}
		}

		result.push(currentNetwork);
	}

	return result;
}

function mergeChannelData(
	oldChannels: ClientChan[],
	newChannels: SharedNetworkChan[]
): ClientChan[] {
	const result: ReturnType<typeof mergeChannelData> = [];

	for (const newChannel of newChannels) {
		const currentChannel = oldChannels.find((chan) => chan.id === newChannel.id);

		if (!currentChannel) {
			// This is a new channel that was joined while client was disconnected, initialize it
			const current = toClientChan(newChannel);
			result.push(current);
			emitNamesOrMarkUsersOudated(current); // TODO: this should not carry logic like that
			continue;
		}

		// Merge received channel object into existing currentChannel
		// so the object references are exactly the same (e.g. in store.state.activeChannel)

		emitNamesOrMarkUsersOudated(currentChannel); // TODO: this should not carry logic like that

		// Reconnection only sends new messages, so merge it on the client
		// Only concat if server sent us less than 100 messages so we don't introduce gaps
		if (currentChannel.messages && newChannel.messages.length < 100) {
			currentChannel.messages = currentChannel.messages.concat(newChannel.messages);
		} else {
			currentChannel.messages = newChannel.messages;
		}

		// TODO: this is copies more than what the compiler knows about
		for (const key in newChannel) {
			if (!Object.hasOwn(currentChannel, key)) {
				continue;
			}

			if (key === "messages") {
				// already handled
				continue;
			}

			currentChannel[key] = newChannel[key];
		}

		result.push(currentChannel);
	}

	return result;
}

function emitNamesOrMarkUsersOudated(chan: ClientChan) {
	if (store.state.activeChannel && store.state.activeChannel.channel === chan) {
		// For currently open channel, request the user list straight away
		socket.emit("names", {
			target: chan.id,
		});
		chan.usersOutdated = false;
		return;
	}

	// For all other channels, mark the user list as outdated
	// so an update will be requested whenever user switches to these channels
	chan.usersOutdated = true;
}
