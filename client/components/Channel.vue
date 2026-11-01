<template>
	<!-- TODO: investigate -->
	<ChannelWrapper ref="wrapper" v-bind="$props">
		<span class="name"
			><bdi>{{ channel.name }}</bdi></span
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
import roundBadgeNumber from "../js/helpers/roundBadgeNumber";
import useCloseChannel from "../js/hooks/use-close-channel";
import {ClientChan, ClientNetwork} from "../js/types";
import ChannelWrapper from "./ChannelWrapper.vue";

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
		channel: {
			type: Object as PropType<ClientChan>,
			required: true,
		},
		active: Boolean,
		isFiltering: Boolean,
	},
	setup(props) {
		const {t} = useI18n();
		const partedAria = computed(() => t("channel.partedAria"));
		const leaveLabel = computed(() => t("channel.leave"));
		const closeLabel = computed(() => t("channel.close"));
		const unreadCount = computed(() => roundBadgeNumber(props.channel.unread));
		const close = useCloseChannel(props.channel);

		return {
			t,
			partedAria,
			leaveLabel,
			closeLabel,
			unreadCount,
			close,
		};
	},
});
</script>
