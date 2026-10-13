<template>
	<span class="content report">
		<ReportView v-if="message.report" :report="message.report" :network="network" />
	</span>
</template>

<script lang="ts">
import {defineComponent, PropType} from "vue";
import type {ClientMessage, ClientNetwork} from "../../js/types";
import ReportView from "../Oper/ReportView.vue";

/** A structured answer to an oper command (`/stats`, `/check`, `/privs`): irc/commands/oper.ts. */
export default defineComponent({
	name: "MessageTypeReport",
	components: {ReportView},
	props: {
		network: {type: Object as PropType<ClientNetwork>, required: true},
		message: {type: Object as PropType<ClientMessage>, required: true},
	},
});
</script>
