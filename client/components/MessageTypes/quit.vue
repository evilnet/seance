<template>
	<span class="content">
		{{ parts[0] }}<bdi><Username :user="message.from" /></bdi>
		<i class="hostmask"> (<ParsedMessage :network="network" :text="message.hostmask" />)</i>
		{{ parts[1] }}
		<i v-if="message.text" class="quit-reason"
			>(<ParsedMessage :network="network" :message="message" />)</i
		>
	</span>
</template>

<script lang="ts">
import {computed, defineComponent, PropType} from "vue";
import type {ClientMessage, ClientNetwork} from "../../js/types";
import ParsedMessage from "../ParsedMessage.vue";
import Username from "../Username.vue";
import {useI18n} from "../../js/i18n";
import {frameSegments, KEEP} from "../../js/i18n/core";

export default defineComponent({
	name: "MessageTypeQuit",
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
		const parts = computed(() => frameSegments(t("system.quit", {nick: KEEP}), ["nick"]));

		return {
			parts,
			t,
		};
	},
});
</script>
