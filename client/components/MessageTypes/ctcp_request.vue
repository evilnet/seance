<template>
	<span class="content">
		<I18nFrame :text="frame"
			><template v-slot:nick
				><bdi><Username :user="message.from" /></bdi></template
			><template v-slot:ctcp><abbr :title="ctcpTitle">CTCP</abbr></template
			><template v-slot:message
				><span class="ctcp-message"
					><ParsedMessage :text="message.ctcpMessage" /></span></template
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
	name: "MessageTypeRequestCTCP",
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
		const frame = computed(() =>
			t("system.ctcpRequest", {nick: KEEP, ctcp: KEEP, message: KEEP})
		);
		const ctcpTitle = computed(() => t("msg.ctcpTitle"));

		return {
			frame,
			t,
			ctcpTitle,
		};
	},
});
</script>
