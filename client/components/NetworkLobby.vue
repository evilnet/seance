<template>
	<ChannelWrapper v-bind="$props" :channel="channel">
		<!-- Two rows in one tab (see .lobby-wrap in style.css): the name gets
		     the whole first line; the tools sit left on the second, the nick
		     right. -->
		<div class="lobby-wrap">
			<div class="lobby-title">
				<button
					v-if="network.channels.length > 1"
					:aria-controls="'network-' + network.uuid"
					:aria-label="getExpandLabel(network)"
					:aria-expanded="!network.isCollapsed"
					class="collapse-network"
					@click.stop="onCollapseClick"
				>
					<span class="collapse-network-icon" />
				</button>
				<span v-else class="collapse-network" />
				<span :title="channel.name" class="name"
					><bdi>{{ channel.name }}</bdi></span
				>
				<span v-if="channel.unread" :class="{highlight: channel.highlight}" class="badge">{{
					unreadCount
				}}</span>
			</div>
			<div class="lobby-status">
				<div class="lobby-tools">
					<span
						:aria-label="statusLabel"
						class="connection-status-tooltip tooltipped tooltipped-e"
					>
						<button
							:class="['connection-status-icon', statusClass]"
							:aria-label="statusLabel"
							@click.stop="onStatusClick"
						/>
					</span>
					<span
						:aria-label="notifyState.label"
						:title="notifyState.label"
						class="notify-tooltip"
					>
						<span :class="['notify-status-icon', notifyState.cls]" />
					</span>
					<span
						:aria-label="editLabel"
						class="edit-network-tooltip tooltipped tooltipped-e tooltipped-no-touch"
					>
						<button
							class="edit-network"
							:aria-label="editLabel"
							@click.stop="editNetwork"
						/>
					</span>
					<span
						:aria-label="joinChannelLabel"
						class="add-channel-tooltip tooltipped tooltipped-e tooltipped-no-touch"
					>
						<button
							:class="['add-channel', {opened: isJoinChannelShown}]"
							:aria-controls="'join-channel-' + channel.id"
							:aria-label="joinChannelLabel"
							@click.stop="$emit('toggle-join-channel')"
						/>
					</span>
					<span
						v-if="opered"
						:aria-label="operPanelLabel"
						class="oper-panel-tooltip tooltipped tooltipped-e tooltipped-no-touch"
					>
						<button
							class="oper-panel"
							:aria-label="operPanelLabel"
							@click.stop="openOperPanel"
						/>
					</span>
				</div>
				<!-- The presence dot stands before the nick, and alone when there
				     is none; it never opens the row or starts a drag. -->
				<span class="lobby-presence"
					><button
						type="button"
						:class="['presence-dot', presenceClass]"
						:aria-label="presenceAria"
						:title="presenceText"
						aria-haspopup="menu"
						:aria-expanded="presenceMenuOpen ? 'true' : 'false'"
						@click.stop="openPresenceMenu"
						@contextmenu.stop.prevent="openPresenceMenu"
						@pointerdown.stop
						@mousedown.stop
						@touchstart.stop
					/><span v-if="network.nick" :title="nickLabel" class="lobby-nick"
						><span class="sr-only">{{ t("lobby.nickname") }}</span
						><bdi>{{ network.nick }}</bdi></span
					></span
				>
			</div>
		</div>
	</ChannelWrapper>
</template>

<script lang="ts">
import {computed, defineComponent, PropType} from "vue";
import {useRouter} from "vue-router";
import collapseNetwork from "../js/helpers/collapseNetwork";
import roundBadgeNumber from "../js/helpers/roundBadgeNumber";
import socket from "../js/socket";
import eventbus from "../js/eventbus";
import useMenuTrigger from "../js/hooks/use-menu-trigger";
import {isOperOn} from "../js/helpers/operMenu";
import webpush from "../js/webpush";
import {useI18n} from "../js/i18n";
import ChannelWrapper from "./ChannelWrapper.vue";

import type {ClientChan, ClientNetwork} from "../js/types";
import {modeLabel, NETWORK_MODES} from "../js/helpers/dnd";
import dnd from "../js/dnd";
import type {ContextMenuItem} from "../js/helpers/contextMenu";

export default defineComponent({
	name: "Channel",
	components: {
		ChannelWrapper,
	},
	props: {
		network: {
			type: Object as PropType<ClientNetwork>,
			required: true,
		},
		isJoinChannelShown: Boolean,
		active: Boolean,
		isFiltering: Boolean,
	},
	emits: ["toggle-join-channel"],
	setup(props) {
		const router = useRouter();
		const {t} = useI18n();

		const channel = computed(() => {
			return props.network.channels[0];
		});

		const editNetwork = () => {
			void router.push(`/settings/networks/${props.network.uuid}`);
		};

		// The oper panel (Windows/OperPanel.vue): only while opered here.
		const opered = computed(() => isOperOn(props.network));

		const openOperPanel = () => {
			void router.push(`/oper/${props.network.uuid}/opers`);
		};

		// Notification state for this network (bell icon): subscribed,
		// enabled-but-not-yet, or off. Reactive over webpush's maps + the
		// notify flag it mirrors from storage on saves.
		const notifyState = computed(() => {
			const info = webpush.networkPushInfo(props.network.uuid);
			const enabled = webpush.notifyOn(props.network.uuid);

			if (!enabled) {
				return {cls: "off", label: t("lobby.notificationsOff")};
			}

			if (info.enabled && info.subscribed) {
				return {cls: "on", label: t("lobby.notificationsSubscribed")};
			}

			return {cls: "enabled", label: t("lobby.notificationsOn")};
		});

		// Waiting for a retry (the backoff or the server's throttle), not
		// dialling: there is nothing to cancel, and a click dials now.
		const retryPending = computed(
			() =>
				props.network.status.connecting === true &&
				props.network.status.retryAt !== undefined
		);

		const statusClass = computed(() =>
			props.network.status.connected
				? "is-connected"
				: props.network.status.connecting
				? "is-connecting"
				: "is-disconnected"
		);

		const statusLabel = computed(() =>
			props.network.status.connected
				? t("lobby.connected")
				: retryPending.value
				? t("lobby.reconnectingSoon")
				: props.network.status.connecting
				? t("lobby.connectingCancel")
				: t("lobby.disconnectedConnect")
		);

		const onStatusClick = () => {
			if (props.network.status.connected) {
				return; // no accidental disconnects; that lives on the edit page
			}

			// A retry waiting its turn is not a dial to cancel: the click
			// dials now, as the strip's Connect now does.
			socket.emit("input", {
				target: channel.value.id,
				text:
					props.network.status.connecting && !retryPending.value
						? "/disconnect"
						: "/connect",
			});
		};

		const joinChannelLabel = computed(() => {
			return props.isJoinChannelShown ? t("lobby.cancel") : t("lobby.joinChannel");
		});

		// The nick under the network name is the one this connection uses;
		// before the first connect it is the configured one.
		const nickLabel = computed(() =>
			props.network.status.connected
				? t("lobby.nickOn", {network: props.network.name})
				: t("lobby.nickOffline", {network: props.network.name})
		);

		// The presence dot before the nick: what this network shows now, and
		// a menu of the four modes (network:presence-mode, irc/bus.ts).
		const presence = computed(() => props.network.presence);
		const {expanded: presenceMenuOpen, opened: presenceMenuOpened} = useMenuTrigger();
		// A network that is not connected tells its server nothing: grey,
		// whatever was last said (starSent resets on close).
		const offline = computed(() => !props.network.status.connected);
		const presenceClass = computed(() =>
			offline.value
				? "is-offline"
				: presence.value?.dnd
				? "is-dnd"
				: presence.value?.away
				? "is-away"
				: "is-online"
		);
		const presenceText = computed(() => {
			const p = presence.value;
			const mode = modeLabel(p?.effective ?? "auto", t);
			// A network following the pill says so; one set on its own does not.
			const global = p?.mode === "global";

			if (offline.value) {
				return global ? t("presence.globalOffline", {mode}) : t("presence.offline", {mode});
			}

			if (p?.dnd) {
				return modeLabel("dnd", t);
			}

			// Away mode is away already: "Away", never "Away · away".
			if (p?.away && p.effective !== "away") {
				return global ? t("presence.globalAway", {mode}) : t("presence.away", {mode});
			}

			return global ? t("presence.global", {mode}) : mode;
		});
		const presenceAria = computed(() =>
			t("presence.networkAria", {network: props.network.name, state: presenceText.value})
		);
		const operPanelLabel = computed(() => t("lobby.operPanel"));

		const openPresenceMenu = (event: MouseEvent) => {
			const current = presence.value?.mode ?? "global";
			// "Same as global (Away)": what following the pill means right now.
			const globalLabel = t("presence.sameAsGlobalNow", {
				mode: modeLabel(dnd.state.mode.value, t),
			});
			const items: ContextMenuItem[] = NETWORK_MODES.flatMap((mode): ContextMenuItem[] => {
				const item: ContextMenuItem = {
					label: mode === "global" ? globalLabel : modeLabel(mode, t),
					type: "item",
					class: `presence-${mode}`,
					checked: mode === current,
					action: () =>
						socket.emit("network:presence-mode", {
							network: props.network.uuid,
							mode,
						}),
				};
				return mode === "global" ? [item, {type: "divider"}] : [item];
			});
			eventbus.emit("contextmenu:items", {event, items});
			// After the emit: opening it closed any other menu first.
			presenceMenuOpened();
		};

		const unreadCount = computed(() => {
			return roundBadgeNumber(channel.value.unread);
		});

		const onCollapseClick = () => {
			collapseNetwork(props.network, !props.network.isCollapsed);
		};

		const getExpandLabel = (network: ClientNetwork) => {
			return network.isCollapsed ? t("lobby.expand") : t("lobby.collapse");
		};

		const editLabel = computed(() => t("lobby.edit"));

		return {
			t,
			presenceMenuOpen,
			presenceClass,
			presenceText,
			presenceAria,
			operPanelLabel,
			openPresenceMenu,
			notifyState,
			channel,
			editNetwork,
			editLabel,
			opered,
			openOperPanel,
			statusClass,
			statusLabel,
			onStatusClick,
			joinChannelLabel,
			nickLabel,
			unreadCount,
			onCollapseClick,
			getExpandLabel,
		};
	},
});
</script>
