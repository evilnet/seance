<template>
	<button class="lt" :aria-label="label" @click="store.commit('toggleSidebar')" />
</template>

<script lang="ts">
import {computed, defineComponent} from "vue";
import {useStore} from "../js/store";
import {useI18n} from "../js/i18n";

export default defineComponent({
	name: "SidebarToggle",
	setup() {
		const store = useStore();
		const {t} = useI18n();
		const label = computed(() => t("sidebar.toggle"));

		return {
			store,
			label,
		};
	},
});
</script>
