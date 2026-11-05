<template>
	<span class="content">
		<template v-if="message.from && message.from.nick"
			><bdi><Username :user="message.from" /></bdi> {{ t("msg.topicChanged") }}</template
		>
		<template v-else>{{ t("msg.topicIs") }}</template>
		<span v-if="message.text" class="new-topic"
			><ParsedMessage :network="network" :message="message"
		/></span>
	</span>
</template>

<script lang="ts">
import {defineComponent, PropType} from "vue";
import type {ClientMessage, ClientNetwork} from "../../js/types";
import ParsedMessage from "../ParsedMessage.vue";
import Username from "../Username.vue";
import {useI18n} from "../../js/i18n";

export default defineComponent({
	name: "MessageTypeTopic",
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
			type: Object as PropType<ClientMessage>,
			required: true,
		},
	},
	setup() {
		const {t} = useI18n();

		return {
			t,
		};
	},
});
</script>
