<template>
	<Chat
		v-if="activeChannel"
		:network="activeChannel.network"
		:channel="activeChannel.channel"
		:focused="parseInt(String(route.query.focused), 10)"
	/>
	<!-- Search sits beside the chat it jumps (Windows/SearchResults.vue); the
	     same instance stays while a hit moves the route to another channel. -->
	<SearchResults v-if="activeChannel && route.name === 'SearchResults'" />
</template>

<script lang="ts">
import {watch, computed, defineComponent, onMounted} from "vue";
import {useRoute} from "vue-router";
import {useStore} from "../js/store";
import {searchTucked} from "../js/searchPanel";

// Temporary component for routing channels and lobbies
import Chat from "./Chat.vue";
import SearchResults from "./Windows/SearchResults.vue";

export default defineComponent({
	name: "RoutedChat",
	components: {
		Chat,
		SearchResults,
	},
	setup() {
		const route = useRoute();
		const store = useStore();

		const activeChannel = computed(() => {
			const chanId = parseInt(String(route.params.id || ""), 10);
			const channel = store.getters.findChannel(chanId);
			return channel;
		});

		const setActiveChannel = () => {
			if (activeChannel.value) {
				store.commit("activeChannel", activeChannel.value);
			}
		};

		watch(activeChannel, () => {
			setActiveChannel();
		});

		// Any way out of search ends the tucked state with it.
		watch(
			() => route.name,
			(name) => {
				if (name !== "SearchResults") {
					searchTucked.value = false;
				}
			}
		);

		onMounted(() => {
			setActiveChannel();
		});

		return {
			route,
			activeChannel,
		};
	},
});
</script>
