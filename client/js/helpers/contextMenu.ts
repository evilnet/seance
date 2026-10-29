import {t} from "../i18n/core";
import socket from "../socket";
import {clearHistory} from "../history";
import {setMuteStatus} from "../mute";
import eventbus from "../eventbus";
import type {ClientChan, ClientNetwork, ClientUser} from "../types";
import {switchToChannel} from "../router";
import {requestTranslationPanel, translationAvailable} from "../translate/reader";
import {TypedStore} from "../store";
import useCloseChannel from "../hooks/use-close-channel";
import {ChanType} from "../../../shared/types/chan";
import {isOperOn, operChannelItems, operUserItems} from "./operMenu";

type BaseContextMenuItem = {
	label: string;
	type: string;
	class: string;
	/**
	 * A choice that can be the current one: rendered as `menuitemradio`
	 * (`menuitemcheckbox` with `toggle`) with `aria-checked`, the check mark
	 * drawn by CSS. Left out for a plain action.
	 */
	checked?: boolean;
	toggle?: boolean;
};

type ContextMenuItemWithAction = BaseContextMenuItem & {
	action: () => void;
};

type ContextMenuItemWithLink = BaseContextMenuItem & {
	link?: string;
};

type ContextMenuDividerItem = {
	type: "divider";
};

export type ContextMenuItem =
	| ContextMenuItemWithAction
	| ContextMenuItemWithLink
	| ContextMenuDividerItem;

export function generateChannelContextMenu(
	channel: ClientChan,
	network: ClientNetwork
): ContextMenuItem[] {
	const closeChannel = useCloseChannel(channel);

	const typeMap = {
		lobby: "network",
		channel: "chan",
		query: "query",
		special: "chan",
	};

	const closeMap = {
		lobby: t("menu.closeLobby"),
		channel: t("menu.closeChannel"),
		query: t("menu.closeQuery"),
		special: t("menu.closeQuery"),
	};

	let items: ContextMenuItem[] = [
		{
			label: channel.name,
			type: "item",
			class: typeMap[channel.type],
			link: `/chan-${channel.id}`,
		},
		{
			type: "divider",
		},
	];

	// Add menu items for lobbies
	if (channel.type === ChanType.LOBBY) {
		items = [
			...items,
			{
				label: t("menu.editNetwork"),
				type: "item",
				class: "edit",
				link: `/settings/networks/${network.uuid}`,
			},
			{
				label: t("menu.joinChannel"),
				type: "item",
				class: "join",
				action: () => (network.isJoinChannelShown = true),
			},
			...(isOperOn(network)
				? [
						{
							label: t("menu.operPanel"),
							type: "item",
							class: "oper-panel",
							link: `/oper/${network.uuid}/notices`,
						},
				  ]
				: []),
			{
				label: t("menu.listChannels"),
				type: "item",
				class: "list",
				action: () =>
					socket.emit("input", {
						target: channel.id,
						text: "/list",
					}),
			},
			{
				label: t("menu.listIgnored"),
				type: "item",
				class: "list",
				action: () =>
					socket.emit("input", {
						target: channel.id,
						text: "/ignorelist",
					}),
			},
			network.status.connected
				? {
						label: t("menu.disconnect"),
						type: "item",
						class: "disconnect",
						action: () =>
							socket.emit("input", {
								target: channel.id,
								text: "/disconnect",
							}),
				  }
				: {
						label: t("menu.connect"),
						type: "item",
						class: "connect",
						action: () =>
							socket.emit("input", {
								target: channel.id,
								text: "/connect",
							}),
				  },
		];
	}

	// Add menu items for channels
	if (channel.type === ChanType.CHANNEL) {
		items.push(...operChannelItems(network, channel.name));
		items.push({
			label: t("menu.editTopic"),
			type: "item",
			class: "edit",
			action() {
				channel.editTopic = true;
				switchToChannel(channel);
			},
		});
		items.push({
			label: t("menu.listBanned"),
			type: "item",
			class: "list",
			action() {
				socket.emit("input", {
					target: channel.id,
					text: "/banlist",
				});
			},
		});
	}

	// Add menu items for queries
	if (channel.type === ChanType.QUERY) {
		items.push(
			{
				label: t("menu.whois"),
				type: "item",
				class: "action-whois",
				action() {
					switchToChannel(channel);
					socket.emit("input", {
						target: channel.id,
						text: "/whois " + channel.name,
					});
				},
			},
			{
				label: t("menu.ignore"),
				type: "item",
				class: "action-ignore",
				action() {
					socket.emit("input", {
						target: channel.id,
						text: "/ignore " + channel.name,
					});
				},
			}
		);
	}

	if (channel.type === ChanType.CHANNEL || channel.type === ChanType.QUERY) {
		items.push({
			label: t("menu.clearHistory"),
			type: "item",
			class: "clear-history",
			action() {
				eventbus.emit(
					"confirm-dialog",
					{
						title: t("menu.clearHistory"),
						text: t("menu.clearHistoryText", {channel: channel.name}),
						button: t("menu.clearHistory"),
					},
					(result) => {
						if (!result) {
							return;
						}

						clearHistory(channel.id);
					}
				);
			},
		});

		// Only where translation can actually run: a deploy with the feature
		// off, or a device whose probe found neither a GPU nor WASM SIMD,
		// offers no panel to open (translate/reader.ts translationAvailable).
		if (translationAvailable()) {
			items.push({
				label: t("translate.menu.panel"),
				type: "item",
				class: "translate",
				action() {
					// The panel belongs to the open conversation, so the menu
					// opens the channel first and leaves the ask in the store:
					// Chat.vue takes it once it shows that channel.
					switchToChannel(channel);
					requestTranslationPanel(channel);
				},
			});
		}
	}

	const humanFriendlyChanTypeMap: Record<string, string> = {
		lobby: t("menu.chanTypeNetwork"),
		channel: t("menu.chanTypeChannel"),
		query: t("menu.chanTypeQuery"),
	};

	// We don't allow the muting of ChanType.SPECIAL channels
	const mutableChanTypes = Object.keys(humanFriendlyChanTypeMap);

	if (mutableChanTypes.includes(channel.type)) {
		const chanType = humanFriendlyChanTypeMap[channel.type];

		items.push({
			label: channel.muted
				? t("menu.unmuteType", {type: chanType})
				: t("menu.muteType", {type: chanType}),
			type: "item",
			class: "mute",
			action() {
				setMuteStatus(channel.id, !channel.muted);
			},
		});
	}

	// Add close menu item
	items.push({
		label: closeMap[channel.type],
		type: "item",
		class: "close",
		action() {
			closeChannel();
		},
	});

	return items;
}

export function generateInlineChannelContextMenu(
	store: TypedStore,
	chan: string,
	network: ClientNetwork
): ContextMenuItem[] {
	const join = () => {
		const channel = network.channels.find((c) => c.name === chan);

		if (channel) {
			switchToChannel(channel);
		}

		if (store.state.activeChannel) {
			socket.emit("input", {
				target: store.state.activeChannel.channel.id,
				text: "/join " + chan,
			});
		} else {
			// eslint-disable-next-line no-console
			console.error("Unable to join channel: activeChannel is undefined");
		}
	};

	const channel = network.channels.find((c) => c.name === chan);

	if (channel) {
		return [
			{
				label: t("menu.goToChannel"),
				type: "item",
				class: "chan",
				link: `/chan-${channel.id}`,
			},
			...operChannelItems(network, chan),
		];
	}

	return [
		{
			label: t("menu.joinInline"),
			type: "item",
			class: "join",
			action: join,
		},
		...operChannelItems(network, chan),
	];
}

export function generateUserContextMenu(
	store: TypedStore,
	channel: ClientChan,
	network: ClientNetwork,
	user: Pick<ClientUser, "nick" | "modes">
): ContextMenuItem[] {
	const currentChannelUser: ClientUser | Record<string, never> = channel
		? channel.users.find((u) => u.nick === network.nick) || {}
		: {};

	const whois = () => {
		const chan = network.channels.find((c) => c.name === user.nick);

		if (chan) {
			switchToChannel(chan);
		}

		socket.emit("input", {
			target: channel.id,
			text: "/whois " + user.nick,
		});
	};

	const items: ContextMenuItem[] = [
		{
			label: user.nick,
			type: "item",
			class: "user",
			action: whois,
		},
		{
			type: "divider",
		},
		{
			label: t("menu.whois"),
			type: "item",
			class: "action-whois",
			action: whois,
		},
		{
			label: t("menu.ignore"),
			type: "item",
			class: "action-ignore",
			action() {
				socket.emit("input", {
					target: channel.id,
					text: "/ignore " + user.nick,
				});
			},
		},
		{
			label: t("menu.directMessages"),
			type: "item",
			class: "action-query",
			action() {
				const chan = store.getters.findChannelOnCurrentNetwork(user.nick);

				if (chan) {
					switchToChannel(chan);
				}

				socket.emit("input", {
					target: channel.id,
					text: "/query " + user.nick,
				});
			},
		},
	];

	// An opered network's oper actions close every user menu.
	const operItems = operUserItems(network, channel.id, user.nick);

	// Bail because we're in a query or we don't have a special mode.
	if (!currentChannelUser.modes || currentChannelUser.modes.length < 1) {
		return [...items, ...operItems];
	}

	// Names of the standard modes we are able to change
	const modeCharToName = {
		"~": t("menu.modeOwner"),
		"&": t("menu.modeAdmin"),
		"@": t("menu.modeOperator"),
		"%": t("menu.modeHalfOp"),
		"+": t("menu.modeVoice"),
	};

	// Labels for the mode changes.  For example .rev({mode: "a", symbol: "&"}) => 'Revoke admin (-a)'
	const modeTextTemplate = {
		revoke(m: {symbol: string; mode: string}) {
			const name = modeCharToName[m.symbol];

			if (typeof name !== "string") {
				return "";
			}

			const res = name
				? t("menu.revokeMode", {name, mode: m.mode})
				: t("menu.revokeModeUnknown", {mode: m.mode});
			return res;
		},
		give(m: {symbol: string; mode: string}) {
			const name = modeCharToName[m.symbol];

			if (typeof name !== "string") {
				return "";
			}

			const res = name
				? t("menu.giveMode", {name, mode: m.mode})
				: t("menu.giveModeUnknown", {mode: m.mode});
			return res;
		},
	};

	const networkModeSymbols = network.serverOptions.PREFIX.symbols;

	/**
	 * Determine whether the prefix of mode p1 has access to perform actions on p2.
	 *
	 * EXAMPLE:
	 *    compare('@', '@') => true
	 *    compare('&', '@') => true
	 *    compare('+', '~') => false
	 * @param {string} p1 The mode performing an action
	 * @param {string} p2 The target mode
	 *
	 * @return {boolean} whether p1 can perform an action on p2
	 */
	function compare(p1: string, p2: string): boolean {
		// The modes ~ and @ can perform actions on their own mode.  The others on modes below.
		return "~@".indexOf(p1) > -1
			? networkModeSymbols.indexOf(p1) <= networkModeSymbols.indexOf(p2)
			: networkModeSymbols.indexOf(p1) < networkModeSymbols.indexOf(p2);
	}

	network.serverOptions.PREFIX.prefix.forEach((mode) => {
		if (!compare(currentChannelUser.modes[0], mode.symbol)) {
			// Our highest mode is below the current mode.  Bail.
			return;
		}

		if (!user.modes.includes(mode.symbol)) {
			// The target doesn't already have this mode, therefore we can set it.
			items.push({
				label: modeTextTemplate.give(mode),
				type: "item",
				class: "action-set-mode",
				action() {
					socket.emit("input", {
						target: channel.id,
						text: "/mode +" + mode.mode + " " + user.nick,
					});
				},
			});
		} else {
			items.push({
				label: modeTextTemplate.revoke(mode),
				type: "item",
				class: "action-revoke-mode",
				action() {
					socket.emit("input", {
						target: channel.id,
						text: "/mode -" + mode.mode + " " + user.nick,
					});
				},
			});
		}
	});

	// Determine if we are half-op or op depending on the network modes so we can kick.
	if (!compare(networkModeSymbols.indexOf("%") > -1 ? "%" : "@", currentChannelUser.modes[0])) {
		// Check if the target user has no mode or a mode lower than ours.
		if (user.modes.length === 0 || compare(currentChannelUser.modes[0], user.modes[0])) {
			items.push({
				label: t("menu.kick"),
				type: "item",
				class: "action-kick",
				action() {
					socket.emit("input", {
						target: channel.id,
						text: "/kick " + user.nick,
					});
				},
			});
		}
	}

	return [...items, ...operItems];
}
