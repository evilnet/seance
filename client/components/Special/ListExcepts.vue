<template>
	<table class="ban-list">
		<thead>
			<tr>
				<th class="hostmask">{{ t("special.excepts.exempted") }}</th>
				<th class="banned_by">{{ t("special.excepts.exemptedBy") }}</th>
				<th class="banned_at">{{ t("special.excepts.exemptedAt") }}</th>
			</tr>
		</thead>
		<tbody>
			<tr v-for="except in channel.data" :key="except.hostmask">
				<td class="hostmask">
					<ParsedMessage :network="network" :text="except.hostmask" />
				</td>
				<td class="banned_by">{{ except.banned_by }}</td>
				<td class="banned_at">{{ fullTime(except.banned_at) }}</td>
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

/**
 * Ban-exception (+e) list. Rows share `BanEntry` from `handlers/lists.ts`
 * (hence the `banned_*` field names and `ban-list` styling); only the
 * headers differ from `ListBans.vue`.
 */
export default defineComponent({
	name: "ListExcepts",
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
