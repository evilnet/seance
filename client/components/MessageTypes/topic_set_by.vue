<template>
	<span class="content">
		<I18nFrame :text="t('msg.topicSet', {nick: KEEP, time: messageTimeLocale})"
			><template v-slot:nick
				><bdi><Username :user="message.from" /></bdi></template
		></I18nFrame>
	</span>
</template>

<script lang="ts">
import {computed, defineComponent, PropType} from "vue";
import {ClientNetwork, ClientMessage} from "../../js/types";
import Username from "../Username.vue";
import {formatDateTime} from "../../js/i18n/dates";
import {useI18n} from "../../js/i18n";
import {KEEP} from "../../js/i18n/core";
import I18nFrame from "../I18nFrame.vue";

export default defineComponent({
	name: "MessageTypeTopicSetBy",
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
	setup(props) {
		const {t, locale} = useI18n();
		// locale.value is read so a language change re-renders the timestamp.
		// `when` is typed optional; the handler always sets it on these
		// messages, and the fallback keeps dayjs's old undefined → now shape.
		const messageTimeLocale = computed(() => {
			void locale.value;
			return formatDateTime(props.message.when ?? new Date());
		});

		return {
			t,
			KEEP,
			messageTimeLocale,
		};
	},
});
</script>
