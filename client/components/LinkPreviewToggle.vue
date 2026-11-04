<template>
	<button
		v-if="link.type !== 'loading'"
		:class="['toggle-button', 'toggle-preview', {opened: link.shown}]"
		:aria-label="ariaLabel"
		@click="onClick"
	/>
</template>

<script lang="ts">
import {computed, defineComponent, PropType} from "vue";
import {ClientLinkPreview} from "../js/types";

export default defineComponent({
	name: "LinkPreviewToggle",
	props: {
		link: {type: Object as PropType<ClientLinkPreview>, required: true},
	},
	setup(props) {
		const ariaLabel = computed(() => {
			return props.link.shown ? "Collapse preview" : "Expand preview";
		});

		const onClick = () => {
			props.link.shown = !props.link.shown;
		};

		return {
			ariaLabel,
			onClick,
		};
	},
});
</script>
