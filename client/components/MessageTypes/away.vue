<template>
	<span class="content">
		<ParsedMessage v-if="message.self" :network="network" :message="message" />
		<template v-else>
			{{ parts[0] }}<bdi><Username :user="message.from" /></bdi>{{ parts[1] }}
			<i v-if="message.text" class="away-message"
				>(<ParsedMessage :network="network" :message="message" />)</i
			>
		</template>
	</span>
</template>

<script lang="ts">
import {computed, defineComponent, PropType} from "vue";
import type {ClientNetwork, ClientMessage} from "../../js/types";
import ParsedMessage from "../ParsedMessage.vue";
import Username from "../Username.vue";
import {useI18n} from "../../js/i18n";
import {frameSegments, KEEP} from "../../js/i18n/core";

export default defineComponent({
	name: "MessageTypeAway",
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
		const parts = computed(() => frameSegments(t("system.away", {nick: KEEP}), ["nick"]));

		return {
			parts,
			t,
		};
	},
});
</script>
