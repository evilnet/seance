<template>
	<table class="ignore-list">
		<thead>
			<tr>
				<th class="hostmask">{{ t("special.ignored.hostmask") }}</th>
				<th class="when">{{ t("special.ignored.ignoredAt") }}</th>
			</tr>
		</thead>
		<tbody>
			<tr v-for="user in channel.data" :key="user.hostmask">
				<td class="hostmask"><ParsedMessage :network="network" :text="user.hostmask" /></td>
				<td class="when">{{ fullTime(user.when) }}</td>
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
	name: "ListIgnored",
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
			fullTime: formatDateTime,
		};
	},
});
</script>
