<template>
	<div id="chat-container" class="window">
		<div
			id="chat"
			:class="{
				'time-seconds': store.state.settings.showSeconds,
				'time-12h': store.state.settings.use12hClock,
			}"
		>
			<div
				class="chat-view"
				data-type="search-results"
				aria-label="Search results"
				role="tabpanel"
			>
				<div v-if="network && channel" class="header">
					<SidebarToggle />
					<span class="title"
						>Searching in <span class="channel-name">{{ channel.name }}</span> for</span
					>
					<span class="topic">{{ route.query.q }}</span>
					<MessageSearchForm :network="network" :channel="channel" />
					<button
						class="close"
						aria-label="Close search window"
						title="Close search window"
						@click="closeSearch"
					/>
				</div>
				<div v-if="network && channel" class="chat-content">
					<div ref="chat" class="chat" tabindex="-1">
						<div v-show="moreResultsAvailable" class="show-more">
							<button ref="loadMoreButton" class="btn" @click="onShowMoreClick">
								Show older results ({{ total - messages.length }} more)
							</button>
						</div>

						<div v-if="!query" class="search-status">Type something to search for.</div>
						<div v-else-if="!messages.length" class="search-status">
							No results found.
						</div>
						<div
							class="messages"
							role="log"
							aria-live="polite"
							aria-relevant="additions"
						>
							<div
								v-for="(message, id) in messages"
								:key="message.id"
								class="result"
								@click="jump(message)"
							>
								<DateMarker
									v-if="shouldDisplayDateMarker(message, id)"
									:key="message.id + '-date'"
									:message="message"
								/>
								<Message
									:key="message.id"
									:channel="channel"
									:network="network"
									:message="message"
									:data-id="message.id"
								/>
							</div>
						</div>
						<div class="search-scope-note">
							Only messages loaded in this session are searched — older history is not
							searched.
						</div>
					</div>
				</div>
			</div>
		</div>
	</div>
</template>

<style>
.channel-name {
	font-weight: 700;
}

.chat-view[data-type="search-results"] .search-scope-note {
	padding: 10px;
	font-size: 0.8125rem;
	text-align: center;
	opacity: 0.6;
}

.chat-view[data-type="search-results"] .result {
	cursor: pointer;
}
</style>

<script lang="ts">
import eventbus from "../../js/eventbus";

import SidebarToggle from "../SidebarToggle.vue";
import Message from "../Message.vue";
import MessageSearchForm from "../MessageSearchForm.vue";
import DateMarker from "../DateMarker.vue";
import {watch, computed, defineComponent, nextTick, ref, onMounted, onUnmounted} from "vue";

import {useStore} from "../../js/store";
import {useRoute} from "vue-router";
import {switchToChannel, navigate} from "../../js/router";
import {DEFAULT_SEARCH_LIMIT, searchMessages, type SearchResult} from "../../js/search";

export default defineComponent({
	name: "SearchResults",
	components: {
		SidebarToggle,
		Message,
		DateMarker,
		MessageSearchForm,
	},
	setup() {
		const store = useStore();
		const route = useRoute();

		const chat = ref<HTMLDivElement>();
		const loadMoreButton = ref<HTMLButtonElement>();

		// Oldest first for display (newest at the bottom, like a channel).
		const messages = ref<SearchResult[]>([]);
		const total = ref(0);
		const pageSize = DEFAULT_SEARCH_LIMIT;
		const loaded = ref(0);
		const oldScrollTop = ref(0);
		const oldChatHeight = ref(0);

		const query = computed(() => String(route.query.q || "").trim());

		const chan = computed(() => {
			const chanId = parseInt(String(route.params.id || ""), 10);
			return store.getters.findChannel(chanId);
		});

		const network = computed(() => chan.value?.network ?? null);
		const channel = computed(() => chan.value?.channel ?? null);

		const moreResultsAvailable = computed(() => messages.value.length < total.value);

		const setActiveChannel = () => {
			if (chan.value) {
				store.commit("activeChannel", chan.value);
			}
		};

		const closeSearch = () => {
			if (channel.value) {
				switchToChannel(channel.value);
			} else {
				void navigate("Connect");
			}
		};

		const shouldDisplayDateMarker = (message: SearchResult, id: number) => {
			const previousMessage = messages.value[id - 1];

			if (!previousMessage) {
				return true;
			}

			return new Date(previousMessage.time).getDay() !== new Date(message.time).getDay();
		};

		const runSearch = (count: number) => {
			if (!network.value || !channel.value || !query.value) {
				messages.value = [];
				total.value = 0;
				loaded.value = 0;
				return;
			}

			const response = searchMessages(store.state, {
				networkUuid: network.value.uuid,
				channelId: channel.value.id,
				query: query.value,
				limit: count,
				offset: 0,
			});

			total.value = response.total;
			loaded.value = count;
			messages.value = response.results.slice().reverse();
		};

		const jumpToBottom = async () => {
			await nextTick();

			const el = chat.value;

			if (el) {
				el.scrollTop = el.scrollHeight;
			}
		};

		const doSearch = async () => {
			runSearch(pageSize);
			await jumpToBottom();
		};

		const onShowMoreClick = async () => {
			if (!chat.value) {
				return;
			}

			oldScrollTop.value = chat.value.scrollTop;
			oldChatHeight.value = chat.value.scrollHeight;

			runSearch(loaded.value + pageSize);

			await nextTick();

			const el = chat.value;

			if (el) {
				el.scrollTop = oldScrollTop.value + el.scrollHeight - oldChatHeight.value;
			}
		};

		const jump = async (message: SearchResult) => {
			if (!channel.value) {
				return;
			}

			// Results come from the channel's loaded messages, so the message
			// is normally still rendered once we switch back to the channel.
			switchToChannel(channel.value);
			await nextTick();

			const el = document.getElementById(`msg-${message.id}`);

			if (el) {
				el.scrollIntoView({block: "center"});
			}
		};

		const onReSearch = () => {
			void doSearch();
		};

		watch(
			() => [route.params.id, route.query.q],
			() => {
				setActiveChannel();
				void doSearch();
			}
		);

		// Only with no overlay up: Escape over a context menu closes the menu.
		const onEscape = (layer: string | null) => {
			if (layer === null) {
				closeSearch();
			}
		};

		onMounted(() => {
			setActiveChannel();
			void doSearch();

			eventbus.on("escapekey", onEscape);
			eventbus.on("re-search", onReSearch);
		});

		onUnmounted(() => {
			eventbus.off("escapekey", onEscape);
			eventbus.off("re-search", onReSearch);
		});

		return {
			chat,
			loadMoreButton,
			messages,
			total,
			query,
			moreResultsAvailable,
			network,
			channel,
			route,
			store,
			closeSearch,
			shouldDisplayDateMarker,
			doSearch,
			onShowMoreClick,
			jump,
		};
	},
});
</script>
