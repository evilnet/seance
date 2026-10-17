<script lang="ts">
import {defineComponent, PropType} from "vue";
import parse from "../js/helpers/parse";
import {useStore} from "../js/store";
import type {ClientMessage, ClientNetwork} from "../js/types";

export default defineComponent({
	name: "ParsedMessage",
	functional: true,
	props: {
		text: String,
		message: {type: Object as PropType<ClientMessage | string>, required: false},
		network: {type: Object as PropType<ClientNetwork>, required: false},
		// Opt out of Markdown for text that must render verbatim (the MOTD, see
		// MessageTypes/monospace_block.vue). The setting can only turn it off.
		markdown: {type: Boolean, default: true},
	},
	setup(props) {
		const store = useStore();

		return () =>
			parse(
				typeof props.text !== "undefined"
					? props.text
					: (props.message as ClientMessage).text,
				props.message as ClientMessage,
				props.network,
				// Optional: mounted without a store, no store means no Markdown.
				{markdown: props.markdown && store?.state.settings.markdown}
			);
	},
});
</script>
