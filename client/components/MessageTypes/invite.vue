<template>
	<span class="content">
		<Username :user="message.from" />
		invited
		<span v-if="message.invitedYou">you</span>
		<Username v-else :user="message.target" />
		to <ParsedMessage :network="network" :text="message.channel" />
	</span>
</template>

<script lang="ts">
import {defineComponent, PropType} from "vue";
import {ClientNetwork, MessageFrom} from "../../js/types";
import type {UserInMessage} from "../../../shared/types/msg";
import ParsedMessage from "../ParsedMessage.vue";
import Username from "../Username.vue";

export default defineComponent({
	name: "MessageTypeInvite",
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
