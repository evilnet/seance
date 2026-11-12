<template>
	<span class="content">
		{{ parts[0] }}<bdi><Username :user="message.from" :address="message.hostmask" /></bdi>
		<i class="hostmask"
			>&#32;(<HostAddress
				:network="network"
				:address="message.hostmask"
				:nick="message.from?.nick"
			/>)</i
		>
		<template v-if="message.account">
			<i class="account">&#32;[{{ message.account }}]</i>
		</template>
		<template v-if="message.gecos">
			<i class="realname">&#32;({{ message.gecos }})</i>
		</template>
		{{ parts[1] }}
	</span>
</template>

<script lang="ts">
import {computed, defineComponent, PropType} from "vue";
import {ClientNetwork, ClientMessage} from "../../js/types";
import HostAddress from "../HostAddress.vue";
import Username from "../Username.vue";
import {useI18n} from "../../js/i18n";
import {frameSegments, KEEP} from "../../js/i18n/core";

export default defineComponent({
	name: "MessageTypeJoin",
	components: {
		HostAddress,
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
		const parts = computed(() => frameSegments(t("system.join", {nick: KEEP}), ["nick"]));

		return {
			parts,
			t,
		};
	},
});
</script>
