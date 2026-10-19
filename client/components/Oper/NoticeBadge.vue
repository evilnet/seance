<template>
	<button
		v-if="routable"
		type="button"
		:class="['snotice-badge', 'snotice-' + badge.family]"
		title="Where these show…"
		:aria-label="`${badge.label} — where these show`"
		@click.stop="open"
	>
		{{ badge.label }}
	</button>
	<span
		v-else
		:class="['snotice-badge', 'snotice-' + badge.family]"
		:title="type === 'snoop' ? 'From the snoop channel' : 'From the services report channel'"
		>{{ badge.label }}</span
	>
</template>

<script lang="ts">
import {computed, defineComponent, PropType} from "vue";
import type {SnoticeInfo} from "../../../shared/types/oper";
import type {ClientNetwork} from "../../js/types";
import type {LoggedNotice} from "../../js/irc/noticelog";
import {noticeBadge, openNoticeRouteMenu} from "../../js/helpers/operMenu";

/**
 * The small category badge on a server notice or WALLOPS — in the chat,
 * and in the oper panel's timelines. A tap opens the "where these show"
 * menu for the notice's kind (helpers/operMenu.ts `noticeRouteItems`), so
 * routing is changed from the notice that annoyed you. A services feed
 * line (`snoop`, `audit`) is not routed anywhere, so its badge is plain.
 */
export default defineComponent({
	name: "NoticeBadge",
	props: {
		info: {type: Object as PropType<SnoticeInfo>, required: true},
		type: {type: String as PropType<LoggedNotice["type"]>, default: "snotice"},
		network: {type: Object as PropType<ClientNetwork>, required: true},
	},
	setup(props) {
		const badge = computed(() => noticeBadge(props.info, props.type));
		const routable = computed(() => props.type === "snotice" || props.type === "wallops");
		const open = (event: MouseEvent) => openNoticeRouteMenu(event, props.network, props.info);

		return {badge, routable, open};
	},
});
</script>
