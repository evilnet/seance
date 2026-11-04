<template>
	<span class="content">
		Topic set by
		<Username :user="message.from" />
		on {{ messageTimeLocale }}
	</span>
</template>

<script lang="ts">
import localetime from "../../js/helpers/localetime";
import {computed, defineComponent, PropType} from "vue";
import {ClientNetwork, MessageFrom} from "../../js/types";
import Username from "../Username.vue";

export default defineComponent({
	name: "MessageTypeTopicSetBy",
	components: {
		Username,
	},
	props: {
		network: {
			type: Object as PropType<ClientNetwork>,
			required: true,
		},
		message: {
			type: Object as PropType<MessageFrom & {when: Date}>,
			required: true,
		},
	},
	setup(props) {
		const messageTimeLocale = computed(() => localetime(props.message.when));

		return {
			messageTimeLocale,
		};
	},
});
</script>
