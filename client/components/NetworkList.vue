<template>
	<div
		v-if="store.state.networks.length === 0 && dormantNetworks.length === 0"
		class="empty"
		role="navigation"
		:aria-label="listLabel"
	>
		{{ t("sidebar.empty") }}
	</div>
	<div v-else ref="networklist" role="navigation" :aria-label="listLabel">
		<div class="jump-to-input">
			<label for="channel-search-input" class="sr-only">{{ t("sidebar.searchLabel") }}</label>
			<input
				id="channel-search-input"
				ref="searchInput"
				dir="auto"
				:value="searchText"
				:placeholder="jumpToPlaceholder"
				type="search"
				class="search input mousetrap"
				tabindex="-1"
				@input="setSearchText"
				@keydown.up="navigateResults($event, -1)"
				@keydown.down="navigateResults($event, 1)"
				@keydown.page-up="navigateResults($event, -10)"
				@keydown.page-down="navigateResults($event, 10)"
				@keydown.enter="onSearchEnter"
				@keydown.escape="deactivateSearch"
				@focus="activateSearch"
			/>
		</div>
		<FavoriteList v-if="!searchText && favoriteRows.length" :rows="favoriteRows" />
		<div v-if="searchText" class="jump-to-results">
			<div v-if="results.length">
				<div
					v-for="item in results"
					:key="item.channel.id"
					@mouseenter="setActiveSearchItem(item.channel)"
					@click.prevent="selectResult"
				>
					<Channel
						v-if="item.channel.type !== 'lobby'"
						:channel="item.channel"
						:network="item.network"
						:active="item.channel === activeSearchItem"
						:is-filtering="true"
					/>
					<NetworkLobby
						v-else
						:network="item.network"
						:active="item.channel === activeSearchItem"
						:is-filtering="true"
					/>
				</div>
			</div>
			<div v-else class="no-results">{{ t("sidebar.noResults") }}</div>
		</div>
		<Draggable
			v-else
			:list="store.state.networks"
			:delay="LONG_TOUCH_DURATION"
			:delay-on-touch-only="true"
			:touch-start-threshold="10"
			handle=".channel-list-item[data-type='lobby']"
			draggable=".network"
			ghost-class="ui-sortable-ghost"
			drag-class="ui-sortable-dragging"
			group="networks"
			class="networks"
			item-key="uuid"
			@change="onNetworkSort"
			@choose="onDraggableChoose"
			@unchoose="onDraggableUnchoose"
		>
			<template v-slot:item="{element: network}">
				<div
					:id="'network-' + network.uuid"
					:key="network.uuid"
					:class="{
						collapsed: network.isCollapsed,
						'not-connected': !network.status.connected,
					}"
					class="network"
					role="region"
					aria-live="polite"
					@touchstart="onDraggableTouchStart"
					@touchmove="onDraggableTouchMove"
					@touchend="onDraggableTouchEnd"
					@touchcancel="onDraggableTouchEnd"
				>
					<NetworkLobby
						:network="network"
						:active="
							store.state.activeChannel &&
							network.channels[0] === store.state.activeChannel.channel
						"
					/>
					<ChannelBrowserRow v-if="!network.isCollapsed" :network="network" />

					<Draggable
						draggable=".channel-list-item"
						ghost-class="ui-sortable-ghost"
						drag-class="ui-sortable-dragging"
						:group="network.uuid"
						:list="network.channels"
						:delay="LONG_TOUCH_DURATION"
						:delay-on-touch-only="true"
						:touch-start-threshold="10"
						class="channels"
						item-key="name"
						@change="onChannelSort"
						@choose="onDraggableChoose"
						@unchoose="onDraggableUnchoose"
					>
						<template v-slot:item="{element: channel, index}">
							<!-- The lobby is the header above; a favorite is in
							     the favorites block (FavoriteList.vue). -->
							<Channel
								v-if="index > 0 && !starredIds.has(channel.id)"
								:key="channel.id"
								:data-item="channel.id"
								:channel="channel"
								:network="network"
								:active="
									store.state.activeChannel &&
									channel === store.state.activeChannel.channel
								"
							/>
						</template>
					</Draggable>
				</div>
			</template>
		</Draggable>
		<div v-if="!searchText && dormantNetworks.length" class="dormant-networks">
			<DormantNetwork
				v-for="network in dormantNetworks"
				:key="network.uuid"
				:network="network"
			/>
		</div>
	</div>
</template>

<style>
.jump-to-input {
	margin: 8px;
	position: relative;
}

.jump-to-input .input {
	margin: 0;
	width: 100%;
	border: 0;
	color: #fff;
	background-color: rgba(255, 255, 255, 0.1);
	padding-inline-end: 2.5rem;
	appearance: none;
}

.jump-to-input .input::placeholder {
	color: rgba(255, 255, 255, 0.35);
}

.jump-to-input::before {
	content: "\f002"; /* http://fontawesome.io/icon/search/ */
	color: rgba(255, 255, 255, 0.35);
	position: absolute;
	inset-inline-end: 8px;
	top: 0;
	bottom: 0;
	pointer-events: none;
	line-height: 2.5rem !important;
}

.jump-to-results {
	margin: 0;
	padding: 0;
	list-style: none;
	overflow: auto;
}

.jump-to-results .no-results {
	margin: 14px 8px;
	text-align: center;
}

.jump-to-results .channel-list-item.active {
	cursor: pointer;
}

.jump-to-results .channel-list-item .close-tooltip {
	display: none;
}

.jump-to-results .channel-list-item[data-type="lobby"] {
	padding: 8px 14px;
}

.jump-to-results .channel-list-item[data-type="lobby"]::before {
	content: "\f233";
}
</style>

<script lang="ts">
import {computed, watch, defineComponent, nextTick, onBeforeUnmount, onMounted, ref} from "vue";

import Mousetrap from "mousetrap";
import Draggable from "./Draggable.vue";
import {filter as fuzzyFilter} from "fuzzy";
import NetworkLobby from "./NetworkLobby.vue";
import ChannelBrowserRow from "./ChannelBrowserRow.vue";
import Channel from "./Channel.vue";
import DormantNetwork from "./DormantNetwork.vue";
import FavoriteList from "./FavoriteList.vue";
import useSavedNetworks from "../js/hooks/use-saved-networks";
import {autoconnectPending} from "../js/irc/manager";

import {sortNetworks, sortChannels} from "../js/sort";
import {favorites} from "../js/favorites";
import {favoriteRows as rowsOf, favoriteChannelIds} from "../js/helpers/sidebarOrder";
import collapseNetworkHelper from "../js/helpers/collapseNetwork";
import isIgnoredKeybind from "../js/helpers/isIgnoredKeybind";
import {isImeComposing} from "../js/helpers/ime";
import useSidebarDrag from "../js/hooks/use-sidebar-drag";
import {ClientChan, NetChan} from "../js/types";
import {useStore} from "../js/store";
import {useI18n} from "../js/i18n";
import {switchToChannel} from "../js/router";
import Sortable from "sortablejs";

export default defineComponent({
	name: "NetworkList",
	components: {
		DormantNetwork,
		FavoriteList,
		NetworkLobby,
		ChannelBrowserRow,
		Channel,
		Draggable,
	},
	setup() {
		const store = useStore();
		// The sidebar's own copy, reactive on a locale change.
		const {t} = useI18n();
		const listLabel = computed(() => t("sidebar.networkList"));
		const jumpToPlaceholder = computed(() => t("sidebar.jumpTo"));
		const searchText = ref("");
		// Saved networks this page has no client for (autoconnect off, a
		// password to type, a /quit): greyed under the live ones, one tap
		// to connect, so a network that did not dial by itself is still here.
		// One boot is about to dial is not shown: its live row comes at once
		// (the dials announce it in the same pass that ends the wait).
		const savedNetworks = useSavedNetworks();
		const dormantNetworks = computed(() =>
			savedNetworks.value.filter(
				(net) => !store.getters.findNetwork(net.uuid) && !autoconnectPending(net)
			)
		);
		// The favorites block's rows (placeholders included: a network
		// saved but not on this page still shows its favorites), and the
		// windows it shows, which their networks' lists leave out.
		// A network boot is about to dial keeps its favorites' rows, as
		// placeholders on their way (`dialling`): left out, the block would
		// jump under a finger as the networks arrive.
		const favoriteRows = computed(() =>
			rowsOf(favorites.value, store.state.networks, savedNetworks.value, autoconnectPending)
		);
		const starredIds = computed(() => favoriteChannelIds(favoriteRows.value));
		const activeSearchItem = ref<ClientChan | null>();
		const {
			LONG_TOUCH_DURATION,
			onDraggableChoose,
			onDraggableUnchoose,
			onDraggableTouchStart,
			onDraggableTouchMove,
			onDraggableTouchEnd,
		} = useSidebarDrag();
		const searchInput = ref<HTMLInputElement | null>(null);
		const networklist = ref<HTMLDivElement | null>(null);

		const sidebarWasClosed = ref(false);

		const moveItemInArray = <T>(array: T[], from: number, to: number) => {
			const item = array.splice(from, 1)[0];
			array.splice(to, 0, item);
		};

		const items = computed(() => {
			const newItems: NetChan[] = [];

			for (const network of store.state.networks) {
				for (const channel of network.channels) {
					if (
						store.state.activeChannel &&
						channel === store.state.activeChannel.channel
					) {
						continue;
					}

					newItems.push({network, channel});
				}
			}

			return newItems;
		});

		const results = computed(() => {
			const newResults = fuzzyFilter(searchText.value, items.value, {
				extract: (item) => item.channel.name,
			}).map((item) => item.original);

			return newResults;
		});

		const collapseNetwork = (event: Mousetrap.ExtendedKeyboardEvent) => {
			if (isIgnoredKeybind(event)) {
				return true;
			}

			if (store.state.activeChannel) {
				collapseNetworkHelper(store.state.activeChannel.network, true);
			}

			return false;
		};

		const expandNetwork = (event: Mousetrap.ExtendedKeyboardEvent) => {
			if (isIgnoredKeybind(event)) {
				return true;
			}

			if (store.state.activeChannel) {
				collapseNetworkHelper(store.state.activeChannel.network, false);
			}

			return false;
		};

		const onNetworkSort = (e: Sortable.SortableEvent) => {
			const {oldIndex, newIndex} = e;

			if (oldIndex === undefined || newIndex === undefined || oldIndex === newIndex) {
				return;
			}

			moveItemInArray(store.state.networks, oldIndex, newIndex);

			sortNetworks(store.state.networks.map((n) => n.uuid));
		};

		/** The channel row drawn beside `el` (`next` or previous), skipping
		 * anything else Sortable may have put there. */
		const drawnSibling = (el: Element, next: boolean): HTMLElement | null => {
			let at = next ? el.nextElementSibling : el.previousElementSibling;

			while (at && !(at instanceof HTMLElement && at.dataset.item)) {
				at = next ? at.nextElementSibling : at.previousElementSibling;
			}

			return at as HTMLElement | null;
		};

		const onChannelSort = (e: Sortable.SortableEvent) => {
			const {oldIndex, newIndex} = e;

			if (oldIndex === undefined || newIndex === undefined || oldIndex === newIndex) {
				return;
			}

			const id = Number(e.item.dataset.item);
			const netChan = store.getters.findChannel(id);

			if (!netChan) {
				return;
			}

			// Placed by its neighbours as drawn, not by Sortable's indexes:
			// those count the drawn rows only, and the array also holds rows
			// this list does not draw (the lobby, the favorites), which keep
			// their places.
			const channels = netChan.network.channels;
			const from = channels.findIndex((c) => c.id === id);
			const [moved] = channels.splice(from, 1);
			const before = drawnSibling(e.item, true);
			const after = drawnSibling(e.item, false);
			const indexOf = (el: HTMLElement) =>
				channels.findIndex((c) => c.id === Number(el.dataset.item));
			let to = before ? indexOf(before) : after ? indexOf(after) + 1 : channels.length;

			if (to < 1) {
				// Not found, or ahead of the lobby, which stays first: put it back.
				to = from;
			}

			channels.splice(to, 0, moved);
			sortChannels(
				netChan.network.uuid,
				channels.map((c) => c.id)
			);
		};

		const activateSearch = () => {
			if (searchInput.value === document.activeElement) {
				return;
			}

			sidebarWasClosed.value = store.state.sidebarOpen ? false : true;
			store.commit("sidebarOpen", true);

			void nextTick(() => {
				searchInput.value?.focus();
			});
		};

		const deactivateSearch = () => {
			activeSearchItem.value = null;
			searchText.value = "";
			searchInput.value?.blur();

			if (sidebarWasClosed.value) {
				store.commit("sidebarOpen", false);
			}
		};

		const toggleSearch = (event: Mousetrap.ExtendedKeyboardEvent) => {
			if (isIgnoredKeybind(event)) {
				return true;
			}

			if (searchInput.value === document.activeElement) {
				deactivateSearch();
				return false;
			}

			activateSearch();
			return false;
		};

		const setSearchText = (e: Event) => {
			searchText.value = (e.target as HTMLInputElement).value;
		};

		const setActiveSearchItem = (channel?: ClientChan) => {
			if (!results.value.length) {
				return;
			}

			if (!channel) {
				channel = results.value[0].channel;
			}

			activeSearchItem.value = channel;
		};

		const scrollToActive = () => {
			// Scroll the list if needed after the active class is applied
			void nextTick(() => {
				const el = networklist.value?.querySelector(".channel-list-item.active");

				if (el) {
					el.scrollIntoView({block: "nearest", inline: "nearest"});
				}
			});
		};

		const selectResult = () => {
			if (!searchText.value || !results.value.length) {
				return;
			}

			if (activeSearchItem.value) {
				switchToChannel(activeSearchItem.value);
				deactivateSearch();
				scrollToActive();
			}
		};

		// The Return that commits an IME candidate is the composition's.
		const onSearchEnter = (event: KeyboardEvent) => {
			if (!isImeComposing(event)) {
				selectResult();
			}
		};

		const navigateResults = (event: Event, direction: number) => {
			// Prevent propagation to stop global keybind handler from capturing pagedown/pageup
			// and redirecting it to the message list container for scrolling
			event.stopImmediatePropagation();
			event.preventDefault();

			if (!searchText.value) {
				return;
			}

			const channels = results.value.map((r) => r.channel);

			// Bail out if there's no channels to select
			if (!channels.length) {
				activeSearchItem.value = null;
				return;
			}

			let currentIndex = activeSearchItem.value
				? channels.indexOf(activeSearchItem.value)
				: -1;

			// If there's no active channel select the first or last one depending on
			// direction: down from the top, up (a negative step) from the bottom.
			if (!activeSearchItem.value || currentIndex === -1) {
				activeSearchItem.value =
					direction > 0 ? channels[0] : channels[channels.length - 1];
				scrollToActive();
				return;
			}

			currentIndex += direction;

			// Wrap around the list if necessary. Normaly each loop iterates once at most,
			// but might iterate more often if pgup or pgdown are used in a very short list
			while (currentIndex < 0) {
				currentIndex += channels.length;
			}

			while (currentIndex > channels.length - 1) {
				currentIndex -= channels.length;
			}

			activeSearchItem.value = channels[currentIndex];
			scrollToActive();
		};

		watch(searchText, () => {
			setActiveSearchItem();
		});

		onMounted(() => {
			Mousetrap.bind("alt+shift+right", expandNetwork);
			Mousetrap.bind("alt+shift+left", collapseNetwork);
			Mousetrap.bind("alt+j", toggleSearch);
		});

		onBeforeUnmount(() => {
			Mousetrap.unbind("alt+shift+right");
			Mousetrap.unbind("alt+shift+left");
			Mousetrap.unbind("alt+j");
		});

		const networkContainerRef = ref<HTMLDivElement>();
		const channelRefs = ref<{[key: string]: HTMLDivElement}>({});

		return {
			store,
			t,
			listLabel,
			jumpToPlaceholder,
			dormantNetworks,
			favoriteRows,
			starredIds,
			networklist,
			searchInput,
			searchText,
			results,
			activeSearchItem,
			LONG_TOUCH_DURATION,

			activateSearch,
			deactivateSearch,
			toggleSearch,
			setSearchText,
			setActiveSearchItem,
			scrollToActive,
			selectResult,
			onSearchEnter,
			navigateResults,
			onChannelSort,
			onNetworkSort,
			onDraggableTouchStart,
			onDraggableTouchMove,
			onDraggableTouchEnd,
			onDraggableChoose,
			onDraggableUnchoose,
		};
	},
});
</script>
