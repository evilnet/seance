<template>
	<!-- The search page has the field, and typing there searches as it pauses. -->
	<button class="search" type="button" :aria-label="t('search.openForm')" @click="openSearch" />
</template>

<script lang="ts">
import {defineComponent, PropType} from "vue";
import {useRouter} from "vue-router";
import {ClientChan} from "../js/types";
import {useI18n} from "../js/i18n";

export default defineComponent({
	name: "MessageSearchForm",
	props: {
		channel: {type: Object as PropType<ClientChan>, required: true},
	},
	setup(props) {
		const {t} = useI18n();
		const router = useRouter();

		const openSearch = () => {
			void router.push({name: "SearchResults", params: {id: props.channel.id}});
		};

		return {t, openSearch};
	},
});
</script>
