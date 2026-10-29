<template>
	<table class="invite-list">
		<thead>
			<tr>
				<th class="hostmask">{{ t("special.invites.invited") }}</th>
				<th class="invitened_by">{{ t("special.invites.invitedBy") }}</th>
				<th class="invitened_at">{{ t("special.invites.invitedAt") }}</th>
			</tr>
		</thead>
		<tbody>
			<tr v-for="invite in channel.data" :key="invite.hostmask">
				<td class="hostmask">
					<ParsedMessage :network="network" :text="invite.hostmask" />
				</td>
				<td class="invitened_by">{{ invite.invited_by }}</td>
				<td class="invitened_at">{{ fullTime(invite.invited_at) }}</td>
			</tr>
		</tbody>
	</table>
</template>

<script lang="ts">
import ParsedMessage from "../ParsedMessage.vue";
import {formatDateTime} from "../../js/i18n/dates";
import {defineComponent, PropType} from "vue";
import type {ClientNetwork, ClientChan} from "../../js/types";
import {useI18n} from "../../js/i18n";

export default defineComponent({
	name: "ListInvites",
	components: {
		ParsedMessage,
	},
	props: {
		network: {type: Object as PropType<ClientNetwork>, required: true},
		channel: {type: Object as PropType<ClientChan>, required: true},
	},
	setup() {
		const {t} = useI18n();

		return {
			t,
			fullTime: (date: number | Date) => formatDateTime(date),
		};
	},
});
</script>
