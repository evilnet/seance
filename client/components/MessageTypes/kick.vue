<template>
	<span class="content">
		<Username :user="message.from" />
		has kicked
		<Username :user="message.target" />
		<i v-if="message.text" class="part-reason"
			>&#32;(<ParsedMessage :network="network" :message="message" />)</i
		>
	</span>
</template>

<script lang="ts">
import {defineComponent, PropType} from "vue";
import {ClientNetwork, MessageFrom} from "../../js/types";
import type {UserInMessage} from "../../../shared/types/msg";
import ParsedMessage from "../ParsedMessage.vue";
import Username from "../Username.vue";

export default defineComponent({
	name: "MessageTypeKick",
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
			type: Object as PropType<MessageFrom & {target: UserInMessage}>,
			required: true,
		},
	},
});
</script>
