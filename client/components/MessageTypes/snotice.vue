<template>
	<span :class="['content', 'snotice', 'snotice-' + badge.family]">
		<NoticeBadge v-if="message.snotice" :info="message.snotice" :network="network" />
		<span v-else class="snotice-badge">{{ badge.label }}</span>
		<SnoticeText
			v-if="message.snotice"
			:info="message.snotice"
			:text="message.text ?? ''"
			:network="network"
		/>
		<span
			v-if="message.snotice?.origin"
			class="snotice-origin"
			:title="`Relayed from ${message.snotice.origin}`"
			>{{ message.snotice.origin }}</span
		>
	</span>
</template>

<script lang="ts">
import {computed, defineComponent, PropType} from "vue";
import type {ClientMessage, ClientNetwork} from "../../js/types";
import {categoryBadge} from "../../js/helpers/operFormat";
import NoticeBadge from "../Oper/NoticeBadge.vue";
import SnoticeText from "../Oper/SnoticeText.vue";

/**
 * A server notice, classified and routed (irc/snotice.ts): a category badge
 * (a button: where this kind shows) and the notice in plain words. A global
 * notice relayed from another server names it at the end (irc/snotice.ts
 * sets `origin` only then).
 */
export default defineComponent({
	name: "MessageTypeSnotice",
	components: {NoticeBadge, SnoticeText},
	props: {
		network: {type: Object as PropType<ClientNetwork>, required: true},
		message: {type: Object as PropType<ClientMessage>, required: true},
	},
	setup(props) {
		const badge = computed(() => categoryBadge(props.message.snotice?.category ?? "OTHER"));

		return {badge};
	},
});
</script>
