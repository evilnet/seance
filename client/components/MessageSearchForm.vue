<template>
	<!-- Opens the search panel beside the chat, and closes it again; on a phone,
	     where the panel covers the chat, it brings back a panel a hit tucked away. -->
	<button
		class="search"
		type="button"
		:aria-label="label"
		:title="label"
		:aria-expanded="shown"
		@click="toggleSearch"
	/>
</template>

<script lang="ts">
import {computed, defineComponent, nextTick, PropType} from "vue";
import {useRoute} from "vue-router";
import {ClientChan} from "../js/types";
import {useI18n} from "../js/i18n";
import {navigate, switchToChannel} from "../js/router";
import {searchTucked} from "../js/searchPanel";

export default defineComponent({
	name: "MessageSearchForm",
	props: {
		channel: {type: Object as PropType<ClientChan>, required: true},
	},
	setup(props) {
		const {t} = useI18n();
		const route = useRoute();

		const shown = computed(() => route.name === "SearchResults" && !searchTucked.value);
		const label = computed(() =>
			shown.value ? t("search.window.close") : t("search.openForm")
		);

		const toggleSearch = () => {
			if (route.name !== "SearchResults") {
				void navigate("SearchResults", {id: props.channel.id});
				return;
			}

			if (searchTucked.value) {
				searchTucked.value = false;
				void nextTick(() =>
					document.querySelector<HTMLInputElement>(".search-query input")?.focus()
				);
				return;
			}

			switchToChannel(props.channel);
		};

		return {label, shown, toggleSearch};
	},
});
</script>
