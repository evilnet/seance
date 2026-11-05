<template>
	<span v-if="channel.data.text">{{ channel.data.text }}</span>
	<table v-else class="channel-list">
		<thead>
			<tr>
				<th class="channel">{{ t("special.channels.channel") }}</th>
				<th class="users">{{ t("special.channels.users") }}</th>
				<th class="topic">{{ t("special.channels.topic") }}</th>
			</tr>
		</thead>
		<tbody>
			<tr v-for="chan in channel.data" :key="chan.channel">
				<td class="channel"><ParsedMessage :network="network" :text="chan.channel" /></td>
				<td class="users">{{ chan.num_users }}</td>
				<td class="topic"><ParsedMessage :network="network" :text="chan.topic" /></td>
			</tr>
		</tbody>
	</table>
</template>

<script lang="ts">
import {defineComponent, PropType} from "vue";
import {ClientChan, ClientNetwork} from "../../js/types";
import ParsedMessage from "../ParsedMessage.vue";
import {useI18n} from "../../js/i18n";

export default defineComponent({
	name: "ListChannels",
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
		};
	},
});
</script>
