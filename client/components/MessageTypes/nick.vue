<template>
	<span class="content">
		<I18nFrame :text="frame"
			><template v-slot:nick
				><bdi><Username :user="message.from" /></bdi></template
			><template v-slot:newNick
				><bdi
					><Username
						:user="{nick: message.new_nick, mode: message.from.mode}" /></bdi></template
		></I18nFrame>
	</span>
</template>

<script lang="ts">
import {computed, defineComponent, PropType} from "vue";
import {ClientNetwork, ClientMessage} from "../../js/types";
import Username from "../Username.vue";
import {useI18n} from "../../js/i18n";
import {KEEP} from "../../js/i18n/core";
import I18nFrame from "../I18nFrame.vue";

export default defineComponent({
	name: "MessageTypeNick",
	components: {
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
		const frame = computed(() => t("system.nick", {nick: KEEP, newNick: KEEP}));

		return {
			frame,
			t,
		};
	},
});
</script>
