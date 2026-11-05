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
			:title="t('oper.snotice.relayedFrom', {server: message.snotice.origin})"
			>{{ via[0] }}<bdi class="snotice-origin-server">{{ message.snotice.origin }}</bdi
			>{{ via[1] }}</span
		>
	</span>
</template>

<script lang="ts">
import {computed, defineComponent, PropType} from "vue";
import type {ClientMessage, ClientNetwork} from "../../js/types";
import {categoryBadge} from "../../js/helpers/operFormat";
import NoticeBadge from "../Oper/NoticeBadge.vue";
import SnoticeText from "../Oper/SnoticeText.vue";
import {useI18n} from "../../js/i18n";
import {frameSegments, KEEP} from "../../js/i18n/core";

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
		const {t, locale} = useI18n();
		const badge = computed(() => {
			void locale.value; // the badge's word is translated: follow the language
			return categoryBadge(props.message.snotice?.category ?? "OTHER");
		});

		// "via {server}" as one phrase; the server name keeps its own style.
		const via = computed(() =>
			frameSegments(t("oper.snotice.via", {server: KEEP}), ["server"])
		);

		return {t, badge, via};
	},
});
</script>
