<template>
	<span class="content">
		{{ parts[0] }}<bdi><Username :user="message.from" :address="message.hostmask" /></bdi>
		<i class="hostmask">
			(<HostAddress
				:network="network"
				:address="message.hostmask"
				:nick="message.from?.nick"
			/>)</i
		>
		{{ parts[1] }}
		<i v-if="message.text" class="part-reason"
			>(<ParsedMessage :network="network" :message="message" />)</i
		>
	</span>
</template>

<script lang="ts">
import {computed, defineComponent, PropType} from "vue";
import {ClientNetwork, ClientMessage} from "../../js/types";
import HostAddress from "../HostAddress.vue";
import ParsedMessage from "../ParsedMessage.vue";
import Username from "../Username.vue";
import {useI18n} from "../../js/i18n";
import {frameSegments, KEEP} from "../../js/i18n/core";

export default defineComponent({
	name: "MessageTypePart",
	components: {
		HostAddress,
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
		const parts = computed(() => frameSegments(t("system.part", {nick: KEEP}), ["nick"]));

		return {
			parts,
			t,
		};
	},
});
</script>
