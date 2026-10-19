<template>
	<span :class="['content', 'wallops', 'wallops-' + kind]">
		<NoticeBadge :info="info" type="wallops" :network="network" />
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
import type {SnoticeInfo} from "../../../shared/types/oper";
import type {ClientMessage, ClientNetwork} from "../../js/types";
import NoticeBadge from "../Oper/NoticeBadge.vue";
import ParsedMessage from "../ParsedMessage.vue";
import Username from "../Username.vue";

/**
 * WALLOPS, WALLUSERS and DESYNCH (irc/snotice.ts tells them apart): a badge
 * (a button: where this kind shows), who sent it — a person or a server —
 * and the text.
 */
export default defineComponent({
	name: "MessageTypeWallops",
	components: {NoticeBadge, ParsedMessage, Username},
	props: {
		network: {type: Object as PropType<ClientNetwork>, required: true},
		message: {type: Object as PropType<ClientMessage>, required: true},
	},
	setup(props) {
		const info = computed<SnoticeInfo>(
			() => props.message.snotice ?? {kind: "wallops", category: "WALLOPS", fields: {}}
		);
		const kind = computed(() => info.value.kind);
		const fromUser = computed(() => kind.value === "wallops" || kind.value === "wallusers");

		return {info, kind, fromUser};
	},
});
</script>
