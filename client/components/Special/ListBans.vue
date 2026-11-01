<template>
	<table class="ban-list">
		<thead>
			<tr>
				<th class="hostmask">{{ t("special.bans.banned") }}</th>
				<th class="banned_by">{{ t("special.bans.bannedBy") }}</th>
				<th class="banned_at">{{ t("special.bans.bannedAt") }}</th>
			</tr>
		</thead>
		<tbody>
			<tr v-for="ban in channel.data" :key="ban.hostmask">
				<td class="hostmask"><ParsedMessage :network="network" :text="ban.hostmask" /></td>
				<td class="banned_by">{{ ban.banned_by }}</td>
				<td class="banned_at">{{ fullTime(ban.banned_at) }}</td>
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
	name: "ListBans",
	components: {
		ParsedMessage,
	},
	props: {
		network: {type: Object as PropType<ClientNetwork>, required: true},
		channel: {type: Object as PropType<ClientChan>, required: true},
	},
	setup() {
		const {t} = useI18n();

		const fullTime = (date: number | Date) => {
			return formatDateTime(date);
		};

		return {
			t,
			fullTime,
		};
	},
});
</script>
