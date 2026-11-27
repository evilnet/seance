<template>
	<!-- TODO: investigate -->
	<ChannelWrapper
		ref="wrapper"
		:network="network"
		:channel="channel"
		:active="active"
		:is-filtering="isFiltering"
		:in-favorites="inFavorites"
	>
		<Avatar
			v-if="channel.type === 'query' || hasChannelAvatar"
			:uuid="network.uuid"
			:nick="channel.name"
			size="list"
		/>
		<span class="name"
			><bdi>{{ channel.name }}</bdi></span
		>
		<span v-if="networkTag" class="network-tag" aria-hidden="true"
			><bdi>{{ networkTag }}</bdi></span
		>
		<span
			v-if="channel.unread"
			:class="{highlight: channel.highlight && !channel.muted}"
			class="badge"
			>{{ unreadCount }}</span
		>
		<template v-if="channel.type === 'channel'">
			<span
				v-if="channel.state === 0"
				class="parted-channel-tooltip tooltipped tooltipped-w"
				:aria-label="partedAria"
			>
				<span class="parted-channel-icon" />
			</span>
			<span class="close-tooltip tooltipped tooltipped-w" :data-tooltip="leaveLabel">
				<button class="close" :aria-label="leaveLabel" @click.stop="close" />
			</span>
		</template>
		<template v-else>
			<span class="close-tooltip tooltipped tooltipped-w" :data-tooltip="closeLabel">
				<button class="close" :aria-label="closeLabel" @click.stop="close" />
			</span>
		</template>
	</ChannelWrapper>
</template>

<script lang="ts">
import {PropType, defineComponent, computed} from "vue";
import {useI18n} from "../js/i18n";
import {useStore} from "../js/store";
import {viewFor} from "../js/avatars/view";
import {ChanType} from "../../shared/types/chan";
import roundBadgeNumber from "../js/helpers/roundBadgeNumber";
import useCloseChannel from "../js/hooks/use-close-channel";
import {ClientChan, ClientNetwork} from "../js/types";
import ChannelWrapper from "./ChannelWrapper.vue";
import Avatar from "./Avatar.vue";

export default defineComponent({
	name: "Channel",
	components: {
		ChannelWrapper,
		Avatar,
	},
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
		/** Drawn in the favorites block (FavoriteList.vue). */
		inFavorites: Boolean,
		/** The network's name beside the channel's: two favorites share the name. */
		networkTag: {
			type: String,
			default: "",
		},
	},
	setup(props) {
		const {t} = useI18n();
		const store = useStore();
		const partedAria = computed(() => t("channel.partedAria"));

		// A channel with an avatar (its draft/metadata-2 `avatar` key) draws
		// it in place of the icon: the picture, or the veiled tile when it is
		// not loaded (avatars/policy.ts). Without one, the topic's emoji
		// stands in (ChannelWrapper.vue), and without that the bubbles.
		const hasChannelAvatar = computed(
			() =>
				props.channel.type === ChanType.CHANNEL &&
				viewFor(store, {uuid: props.network.uuid, nick: props.channel.name}).kind !== "none"
		);
		const leaveLabel = computed(() => t("channel.leave"));
		const closeLabel = computed(() => t("channel.close"));
		const unreadCount = computed(() => roundBadgeNumber(props.channel.unread));
		const close = useCloseChannel(props.channel);

		return {
			t,
			hasChannelAvatar,
			partedAria,
			leaveLabel,
			closeLabel,
			unreadCount,
			close,
		};
	},
});
</script>
