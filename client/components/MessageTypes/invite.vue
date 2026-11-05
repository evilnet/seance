<template>
	<span class="content">
		<I18nFrame :text="frame"
			><template v-slot:nick
				><bdi><Username :user="message.from" /></bdi></template
			><template v-if="!message.invitedYou" v-slot:target
				><bdi><Username :user="message.target" /></bdi></template
			><template v-slot:channel
				><ParsedMessage :network="network" :text="message.channel"
			/></template>
		</I18nFrame>
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
	name: "MessageTypeInvite",
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
		// Two whole sentences: the invite aimed at the reader or at someone
		// else. The target slot is the reader's name in one and the
		// interactive username element in the other.
		const frame = computed(() =>
			props.message.invitedYou
				? t("system.inviteYou", {nick: KEEP, channel: KEEP})
				: t("system.inviteTarget", {nick: KEEP, target: KEEP, channel: KEEP})
		);

		return {
			frame,
			t,
		};
	},
});
</script>
