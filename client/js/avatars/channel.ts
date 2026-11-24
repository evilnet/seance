/**
 * A channel's avatar on the page (irc/avatars.ts has the wire side): the
 * same `avatar` key, on the channel's name, drawn in the sidebar row and
 * the channel's header when it has a picture, and changed by the channel's
 * half-ops and ops through ChannelAvatarDialog.vue (the channel's menu).
 */

import eventbus from "../eventbus";
import {canSetBans} from "../helpers/banMenu";
import {clientForNetwork} from "../irc/manager";
import type {TypedStore} from "../store";
import type {ClientNetwork} from "../types";
import {avatarsEnabled} from "./prefs";
import {viewFor} from "./view";

export type ChannelAvatarRequest = {
	/** The network's uuid. */
	network: string;
	channel: string;
};

export const CHANNEL_AVATAR_DIALOG = "channel-avatar:dialog";

export function openChannelAvatarDialog(request: ChannelAvatarRequest): void {
	eventbus.emit(CHANNEL_AVATAR_DIALOG, request);
}

/** Whether `channel` has a picture to draw (loaded or veiled), not just an initial. */
export function channelHasAvatar(store: TypedStore, uuid: string, channel: string): boolean {
	return viewFor(store, {uuid, nick: channel}).kind !== "none";
}

/**
 * Whether we may change `channel`'s avatar: avatars on for the network, the
 * server speaks draft/metadata-2, and we are a half-op or op there (what
 * nefarious2 asks of a channel SET; an oper may too, and gets the same
 * answer from the server, so the dialog does not need to know).
 */
export function canSetChannelAvatar(network: ClientNetwork, channel: string): boolean {
	const client = clientForNetwork(network.uuid);
	return (
		!!client?.isWelcomed &&
		client.caps.hasCapability("draft/metadata-2") &&
		avatarsEnabled(network.uuid) &&
		canSetBans(network, channel)
	);
}
