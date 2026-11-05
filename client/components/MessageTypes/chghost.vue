<template>
	<span class="content">
		<I18nFrame :text="frame"
			><template v-slot:nick
				><bdi><Username :user="message.from" /></bdi></template
			><template v-slot:ident
				><b
					><bdi>{{ message.new_ident }}</bdi></b
				></template
			><template v-slot:host
				><i class="hostmask"
					><ParsedMessage :network="network" :text="message.new_host" /></i></template
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
	name: "MessageTypeChangeHost",
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
	setup(props) {
		const {t} = useI18n();
		// One whole sentence per shape: ident only, host only, both, or
		// neither — the translator writes each variant with the values where
		// they belong; I18nFrame renders each value where the frame puts it.
		const frame = computed(() => {
			const {new_ident: ident, new_host: host} = props.message;

			if (ident && host) {
				return t("system.chghostBoth", {nick: KEEP, ident: KEEP, host: KEEP});
			}

			if (ident) {
				return t("system.chghostIdent", {nick: KEEP, ident: KEEP});
			}

			if (host) {
				return t("system.chghostHost", {nick: KEEP, host: KEEP});
			}

			return t("system.chghost", {nick: KEEP});
		});

		return {
			frame,
			t,
		};
	},
});
</script>
