<template>
	<span :class="['content', 'wallops', 'wallops-' + kind]">
		<span class="snotice-badge">{{ badge }}</span>
		<template v-if="message.from && message.from.nick">
			<Username
				v-if="fromUser"
				:user="message.from"
				:network="network"
				class="wallops-from"
			/><span v-else class="oper-server wallops-from">{{ message.from.nick }}</span
			>&#32;</template
		><ParsedMessage :network="network" :message="message" />
	</span>
</template>

<script lang="ts">
import {computed, defineComponent, PropType} from "vue";
import type {ClientMessage, ClientNetwork} from "../../js/types";
import {wallopsBadge} from "../../js/helpers/operFormat";
import ParsedMessage from "../ParsedMessage.vue";
import Username from "../Username.vue";

/**
 * WALLOPS, WALLUSERS and DESYNCH (irc/snotice.ts tells them apart): a badge,
 * who sent it — a person or a server — and the text.
 */
export default defineComponent({
	name: "MessageTypeWallops",
	components: {ParsedMessage, Username},
	props: {
		network: {type: Object as PropType<ClientNetwork>, required: true},
		message: {type: Object as PropType<ClientMessage>, required: true},
	},
	setup(props) {
		const kind = computed(() => props.message.snotice?.kind ?? "wallops");
		const badge = computed(() => wallopsBadge(kind.value));
		const fromUser = computed(() => kind.value === "wallops" || kind.value === "wallusers");

		return {kind, badge, fromUser};
	},
});
</script>
