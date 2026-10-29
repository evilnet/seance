<template>
	<span v-if="group" :aria-label="markerLabel" class="msg-statusmsg tooltipped tooltipped-e"
		><span>{{ group }}</span></span
	>
</template>

<script lang="ts">
import {computed, defineComponent, PropType} from "vue";
import {useI18n} from "../js/i18n";

export default defineComponent({
	name: "StatusmsgMarker",
	props: {
		group: {type: String, required: false, default: undefined},
	},
	setup(props) {
		const {t} = useI18n();

		// {mode} is the raw mode character (e.g. "+") the message was
		// restricted to; it is inserted verbatim.
		const markerLabel = computed(() => t("message.statusmsg", {mode: props.group ?? ""}));

		return {markerLabel};
	},
});
</script>
