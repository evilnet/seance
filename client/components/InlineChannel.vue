<template>
	<span
		class="inline-channel"
		dir="auto"
		role="button"
		tabindex="0"
		@click.prevent="openContextMenu"
		@contextmenu.prevent="openContextMenu"
		><slot></slot
	></span>
</template>

<script lang="ts">
import {defineComponent, PropType} from "vue";
import eventbus from "../js/eventbus";
import type {ClientNetwork} from "../js/types";

export default defineComponent({
	name: "InlineChannel",
	props: {
		channel: String,
		network: {type: Object as PropType<ClientNetwork>, required: false},
	},
	setup(props) {
		const openContextMenu = (event) => {
			eventbus.emit("contextmenu:inline-channel", {
				event: event,
				channel: props.channel,
				network: props.network,
			});
		};

		return {
			openContextMenu,
		};
	},
});
</script>
