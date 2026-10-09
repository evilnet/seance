<template>
	<span :class="['content', 'snotice', 'snotice-' + badge.family]">
		<span class="snotice-badge" :title="kindLabel">{{ badge.label }}</span>
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
import {findNoticeKind} from "../../js/irc/snotice";
import SnoticeText from "../Oper/SnoticeText.vue";

/**
 * A server notice, classified and routed (irc/snotice.ts): a category badge
 * and the notice in plain words. A global notice relayed from another server
 * names it at the end (irc/snotice.ts sets `origin` only then).
 */
export default defineComponent({
	name: "MessageTypeSnotice",
	components: {SnoticeText},
	props: {
		network: {type: Object as PropType<ClientNetwork>, required: true},
		message: {type: Object as PropType<ClientMessage>, required: true},
	},
	setup(props) {
		const badge = computed(() => categoryBadge(props.message.snotice?.category ?? "OTHER"));
		const kindLabel = computed(() => {
			const info = props.message.snotice;
			return info
				? findNoticeKind(info.kind, props.network.oper?.profile)?.label ?? info.kind
				: "";
		});

		return {badge, kindLabel};
	},
});
</script>
