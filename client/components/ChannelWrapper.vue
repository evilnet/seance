<template>
	<!-- TODO: move closed style to it's own class -->
	<div
		v-if="isChannelVisible"
		ref="element"
		:class="[
			'channel-list-item',
			{active: active},
			{'parted-channel': channel.type === 'channel' && channel.state === 0},
			{'has-draft': channel.pendingMessage},
			{'has-unread': channel.unread},
			{'has-highlight': channel.highlight},
			{'not-connected': channel.type === 'lobby' && !network.status.connected},
			{'network-down': channel.type !== 'lobby' && !network.status.connected},
			{'is-muted': channel.muted},
			{'is-typing': isTyping},
			{'has-activity': hasActivity},
		]"
		:aria-label="getAriaLabel()"
		:title="getAriaLabel()"
		:data-name="channel.name"
		:data-type="channel.type"
		:aria-controls="'#chan-' + channel.id"
		:aria-selected="active"
		:style="channel.closed ? {transition: 'none', opacity: 0.4} : undefined"
		role="tab"
		@click="click"
		@contextmenu.prevent="openContextMenu"
	>
		<slot :network="network" :channel="channel" :active-channel="activeChannel" />
	</div>
</template>

<script lang="ts">
import eventbus from "../js/eventbus";
import isChannelCollapsed from "../js/helpers/isChannelCollapsed";
import {ClientNetwork, ClientChan} from "../js/types";
import {computed, defineComponent, PropType} from "vue";
import {useStore} from "../js/store";
import {useI18n} from "../js/i18n";
import {ChanType} from "../../shared/types/chan";
import {switchToChannel} from "../js/router";

export default defineComponent({
	name: "ChannelWrapper",
	props: {
		network: {
			type: Object as PropType<ClientNetwork>,
			required: true,
		},
		channel: {
			type: Object as PropType<ClientChan>,
			required: true,
		},
		active: Boolean,
		isFiltering: Boolean,
	},
	setup(props) {
		const store = useStore();
		// The row's aria-label/title speaks through the plural-aware counter.
		const {t, tCount} = useI18n();
		const activeChannel = computed(() => store.state.activeChannel);
		const isChannelVisible = computed(
			() => props.isFiltering || !isChannelCollapsed(props.network, props.channel)
		);

		// Someone else is composing here: pulse the row's icon (see
		// .channel-list-item.is-typing::before in style.css). Only `active`
		// entries count — `paused` lives for 30 s, far too long to keep a sidebar
		// icon moving — and muted channels stay still, as they do for unread
		// counts and notifications. The shared sweep in helpers/typingExpiry.ts
		// drops stale entries, so this needs no timer of its own to stay honest.
		const isTyping = computed(
			() =>
				!props.channel.muted &&
				props.channel.typing.some((entry) => entry.state === "active")
		);

		// Somebody just spoke here: pulse the row's icon for a few seconds (see
		// .channel-list-item.has-activity::before in style.css). The deadline is
		// set by socket-events/activity.ts — which is also where the "messages,
		// not joins and modes" filter and the muted/active-channel rules live —
		// and cleared by the shared sweep in helpers/activityPulse.ts, so a
		// non-zero value here always means a pulse that is still running.
		const hasActivity = computed(() => props.channel.activityUntil > 0);

		// The row's label is one whole phrase: the kind of window, its name
		// and — at most — one count. Two tCount results are never glued
		// together, so a row with both mentions and unread messages names
		// the mentions, which is what the reader is being told about.
		const typeLabel = () => {
			switch (props.channel.type) {
				case ChanType.LOBBY:
					return t("channel.type.lobby");
				case ChanType.QUERY:
					return t("channel.type.query");
				case ChanType.SPECIAL:
					return t("channel.type.special");
				default:
					return t("channel.type.channel");
			}
		};

		const getAriaLabel = () => {
			const vars = {type: typeLabel(), name: props.channel.name};

			if (props.channel.highlight > 0) {
				return t("channel.rowLabelCount", {
					...vars,
					extra: tCount("sidebar.mentions", props.channel.highlight),
				});
			}

			if (props.channel.unread > 0) {
				return t("channel.rowLabelCount", {
					...vars,
					extra: tCount("sidebar.unread", props.channel.unread),
				});
			}

			return t("channel.rowLabel", vars);
		};

		const click = () => {
			if (props.isFiltering) {
				return;
			}

			// The row of the conversation already open: the route does not
			// change, so ChatInput's channel watch — what puts the caret in
			// the input on a switch — never runs. Selecting it again means
			// "let me type here": ask for the caret directly.
			const alreadyOpen = activeChannel.value?.channel.id === props.channel.id;

			switchToChannel(props.channel);

			if (alreadyOpen) {
				eventbus.emit("input:focus");
			}
		};

		const openContextMenu = (event: MouseEvent) => {
			eventbus.emit("contextmenu:channel", {
				event: event,
				channel: props.channel,
				network: props.network,
			});
		};

		return {
			activeChannel,
			isChannelVisible,
			isTyping,
			hasActivity,
			getAriaLabel,
			click,
			openContextMenu,
		};
	},
});
</script>
