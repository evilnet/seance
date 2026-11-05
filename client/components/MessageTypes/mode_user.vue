<template>
	<span class="content">
		<I18nFrame :text="t('msg.modeUserIs', {modes: KEEP})"
			><template v-slot:modes
				><b>{{ message.raw_modes }}</b></template
			></I18nFrame
		>
	</span>
</template>

<script lang="ts">
import {defineComponent, PropType} from "vue";
import {ClientNetwork, ClientMessage} from "../../js/types";
import {useI18n} from "../../js/i18n";
import {KEEP} from "../../js/i18n/core";
import I18nFrame from "../I18nFrame.vue";

export default defineComponent({
	name: "MessageChannelMode",
	components: {
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

		return {
			t,
			KEEP,
		};
	},
});
</script>
