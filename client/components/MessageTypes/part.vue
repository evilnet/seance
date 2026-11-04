<template>
	<span class="content">
		<Username :user="message.from" />
		<i class="hostmask"> (<ParsedMessage :network="network" :text="message.hostmask" />)</i> has
		left the channel
		<i v-if="message.text" class="part-reason"
			>(<ParsedMessage :network="network" :message="message" />)</i
		>
	</span>
</template>

<script lang="ts">
import {defineComponent, PropType} from "vue";
import {ClientNetwork, MessageFrom} from "../../js/types";
import ParsedMessage from "../ParsedMessage.vue";
import Username from "../Username.vue";

export default defineComponent({
	name: "MessageTypePart",
	components: {
		ParsedMessage,
		Username,
	},
	props: {
		network: {
			type: Object as PropType<ClientNetwork>,
			required: true,
		},
		message: {
			type: Object as PropType<MessageFrom>,
			required: true,
		},
	},
});
</script>
