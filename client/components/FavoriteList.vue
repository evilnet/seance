<template>
	<!-- The favorites block (favorites.ts): the starred conversations of
	     every network, above the networks, in the order the user dragged
	     them to. Built as a network block with a lobby-shaped header, so
	     every theme's network styling (spacing, chevron, header face) is its
	     too; it sits outside the networks' Draggable, which cannot pick it up. -->
	<div
		:class="['network', 'favorites', {collapsed}]"
		role="region"
		:aria-label="title"
		@touchstart="onDraggableTouchStart"
		@touchmove="onDraggableTouchMove"
		@touchend="onDraggableTouchEnd"
		@touchcancel="onDraggableTouchEnd"
	>
		<div class="channel-list-item favorites-header" data-type="lobby" @click="toggle">
			<div class="lobby-wrap">
				<div class="lobby-title">
					<button
						type="button"
						class="collapse-network"
						aria-controls="favorites-list"
						:aria-expanded="!collapsed"
						:aria-label="collapseLabel"
						@click.stop="toggle"
					>
						<span class="collapse-network-icon" />
					</button>
					<span class="name">{{ title }}</span>
					<!-- Folded away, the block still says what is waiting in it. -->
					<span v-if="collapsed && unread" :class="['badge', {highlight}]">{{
						unreadCount
					}}</span>
				</div>
			</div>
		</div>
		<Draggable
			v-show="!collapsed"
			id="favorites-list"
			:list="items"
			:delay="LONG_TOUCH_DURATION"
			:delay-on-touch-only="true"
			:touch-start-threshold="10"
			draggable=".channel-list-item"
			ghost-class="ui-sortable-ghost"
			drag-class="ui-sortable-dragging"
			group="favorites"
			class="channels"
			item-key="key"
			@change="onSort"
			@choose="onDraggableChoose"
			@unchoose="onDraggableUnchoose"
		>
			<template v-slot:item="{element: item}">
				<Channel
					v-if="item.row.kind === 'live'"
					:key="item.key"
					:data-item="item.key"
					:channel="item.row.channel"
					:network="item.row.network"
					:active="store.state.activeChannel?.channel === item.row.channel"
					:in-favorites="true"
					:network-tag="item.tag"
				/>
				<FavoritePlaceholder
					v-else
					:key="item.key"
					:data-item="item.key"
					:row="item.row"
					:network-tag="item.tag"
				/>
			</template>
		</Draggable>
	</div>
</template>

<style>
/* The header folds the block; it is never a conversation to open. */
#sidebar .favorites-header {
	padding-block: 0.375rem;
}
</style>

<script lang="ts">
import {computed, defineComponent, PropType} from "vue";
import type Sortable from "sortablejs";
import Draggable from "./Draggable.vue";
import Channel from "./Channel.vue";
import FavoritePlaceholder from "./FavoritePlaceholder.vue";
import {useStore} from "../js/store";
import {useI18n} from "../js/i18n";
import roundBadgeNumber from "../js/helpers/roundBadgeNumber";
import useSidebarDrag from "../js/hooks/use-sidebar-drag";
import * as saved from "../js/irc/saved-networks";
import {
	favoriteKey,
	favorites,
	favoritesCollapsed,
	moveFavorite,
	setFavoritesCollapsed,
} from "../js/favorites";
import {clashingNames, foldedName, type FavoriteRow} from "../js/helpers/sidebarOrder";

export default defineComponent({
	name: "FavoriteList",
	components: {
		Draggable,
		Channel,
		FavoritePlaceholder,
	},
	props: {
		/** helpers/sidebarOrder.ts `favoriteRows`, as NetworkList.vue draws them. */
		rows: {
			type: Array as PropType<FavoriteRow[]>,
			required: true,
		},
	},
	setup(props) {
		const store = useStore();
		const {t} = useI18n();
		const title = computed(() => t("sidebar.favorites"));
		const collapsed = favoritesCollapsed;
		const collapseLabel = computed(() =>
			collapsed.value ? t("lobby.expand") : t("lobby.collapse")
		);

		const networkName = (row: FavoriteRow) =>
			row.kind === "dormant" ? saved.displayName(row.saved) : row.network.name;

		// Rows by key, which names one favorite across networks (a name alone
		// does not); a name two rows share carries its network's.
		const items = computed(() => {
			const clashes = clashingNames(props.rows);

			return props.rows.map((row) => ({
				key: favoriteKey(row.favorite.network, row.favorite.name),
				row,
				tag: clashes.has(foldedName(row)) ? networkName(row) : "",
			}));
		});

		const live = computed(() =>
			props.rows.flatMap((row) => (row.kind === "live" ? [row.channel] : []))
		);
		// A muted conversation's count stays out of the sum, as its
		// highlight stays out of the sidebar's red.
		const unread = computed(() =>
			live.value.reduce((sum, chan) => sum + (chan.muted ? 0 : chan.unread), 0)
		);
		const highlight = computed(() => live.value.some((c) => !c.muted && c.highlight > 0));
		const unreadCount = computed(() => roundBadgeNumber(unread.value));

		const toggle = () => setFavoritesCollapsed(!collapsed.value);

		/** The favorite row drawn beside `el` (`next` or previous). */
		const drawnSibling = (el: Element, next: boolean): HTMLElement | null => {
			let at = next ? el.nextElementSibling : el.previousElementSibling;

			while (at && !(at instanceof HTMLElement && at.dataset.item)) {
				at = next ? at.nextElementSibling : at.previousElementSibling;
			}

			return at as HTMLElement | null;
		};

		// Placed by its neighbours as drawn: the stored list can hold
		// favorites the block does not draw (a network neither on this page
		// nor saved), which keep their places.
		const onSort = (e: Sortable.SortableEvent) => {
			if (e.oldIndex === undefined || e.oldIndex === e.newIndex) {
				return;
			}

			const keys = favorites.value.map((f) => favoriteKey(f.network, f.name));
			const from = keys.indexOf(e.item.dataset.item ?? "");
			const before = drawnSibling(e.item, true);
			const after = drawnSibling(e.item, false);

			if (from === -1) {
				return;
			}

			// Just before the row now under it, or just after the one above.
			const neighbour = before ?? after;
			const at = neighbour ? keys.indexOf(neighbour.dataset.item ?? "") : -1;

			if (at === -1) {
				return;
			}

			// `at` counted with the moved one still in its old place.
			const to = before ? (at > from ? at - 1 : at) : at > from ? at : at + 1;
			moveFavorite(from, to);
		};

		return {
			store,
			title,
			collapsed,
			collapseLabel,
			items,
			unread,
			highlight,
			unreadCount,
			toggle,
			onSort,
			...useSidebarDrag(),
		};
	},
});
</script>
