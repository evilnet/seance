<template>
	<!-- The network's first line: its channel browser, which also joins a
	     channel by name. A sidebar row in looks (each theme's
	     .channel-list-item), a button in kind: not a conversation, so not a
	     tab, and nothing that walks the conversations counts it. -->
	<button
		type="button"
		class="channel-list-item browse-channels-row"
		data-type="browse"
		:class="{active, 'network-down': !network.status.connected}"
		:aria-current="active ? 'page' : undefined"
		@click="open"
	>
		<span class="name">{{ t("browse.title") }}</span>
	</button>
</template>

<style>
.channel-list-item[data-type="browse"]::before {
	content: "\f14e"; /* https://fontawesome.com/icons/compass?style=solid */
}

/* A button's own looks, at no weight, so the row rules and every theme's
 * take over as for any other line in the list. */
:where(.browse-channels-row) {
	width: 100%;
	border: 0;
	border-radius: 0;
	background: transparent;
	color: inherit;
	font: inherit;
	text-align: start;
}
</style>

<script lang="ts">
import {computed, defineComponent, PropType} from "vue";
import {useRoute, useRouter} from "vue-router";
import {useI18n} from "../js/i18n";
import type {ClientNetwork} from "../js/types";

export default defineComponent({
	name: "ChannelBrowserRow",
	props: {
		network: {type: Object as PropType<ClientNetwork>, required: true},
	},
	setup(props) {
		const {t} = useI18n();
		const route = useRoute();
		const router = useRouter();

		const active = computed(
			() => route.name === "ChannelBrowser" && route.params.uuid === props.network.uuid
		);

		const open = () => {
			void router.push(`/browse/${props.network.uuid}`);
		};

		return {t, active, open};
	},
});
</script>
