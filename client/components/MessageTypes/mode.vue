<template>
	<span class="content">
		<I18nFrame :text="frame"
			><template v-slot:nick
				><bdi><Username :user="message.from" /></bdi></template
			><template v-slot:modes><ParsedMessage :message="message" /></template
		></I18nFrame>
	</span>
</template>

<script lang="ts">
import {computed, defineComponent, PropType} from "vue";
import {ClientNetwork, ClientMessage} from "../../js/types";
import ParsedMessage from "../ParsedMessage.vue";
import Username from "../Username.vue";
import {useI18n} from "../../js/i18n";
import {KEEP} from "../../js/i18n/core";
import I18nFrame from "../I18nFrame.vue";

export default defineComponent({
	name: "MessageTypeMode",
	components: {
		ParsedMessage,
		Username,
		I18nFrame,
	},
	props: {
		network: {
			type: Object as PropType<ClientNetwork>,
			required: true,
		},
		message: {
			type: Object as PropType<ClientMessage>,
			required: true,
		},
	},
	setup() {
		const {t} = useI18n();
		const frame = computed(() => t("system.mode", {nick: KEEP, modes: KEEP}));

		return {
			frame,
			t,
		};
	},
});
</script>
