<template>
	<!-- A favorite with no window (FavoriteList.vue): its window was closed
	     or parted away, or its network is saved but not on this page. The
	     row's shape, muted, with what a tap does at its end: join or open it
	     again (+), or connect its network (plug). -->
	<div
		:class="[
			'channel-list-item',
			'favorite-placeholder',
			{'is-opening': opening || (row.kind === 'dormant' && row.dialling)},
		]"
		:data-type="row.favorite.type"
		:data-name="row.favorite.name"
		:title="label"
		@click="open"
		@contextmenu.prevent="openMenu"
	>
		<button
			type="button"
			class="name favorite-placeholder-open"
			:aria-label="label"
			@click.stop="open"
		>
			<bdi>{{ row.favorite.name }}</bdi>
		</button>
		<span v-if="networkTag" class="network-tag" aria-hidden="true"
			><bdi>{{ networkTag }}</bdi></span
		>
		<span :class="['favorite-open-icon', row.kind]" aria-hidden="true" />
	</div>
</template>

<style>
/* Muted by the rail's own muted colour, not by opacity: muted, network-down
and closing rows already fade, and the token is tuned per theme (lifted under
high contrast). Where a theme's muted is its normal colour (ps), the glyph at
the end says it alone, which is why it never waits for a hover. */
.channel-list-item.favorite-placeholder,
.channel-list-item.favorite-placeholder::before {
	color: var(--rail-fg-muted, rgb(183 197 209 / 75%));
}

.channel-list-item.favorite-placeholder:hover,
.channel-list-item.favorite-placeholder:focus-within {
	color: var(--rail-fg-active, #fff);
}

.favorite-placeholder .favorite-placeholder-open {
	padding: 0;
	border: 0;
	background: none;
	color: inherit;
	font: inherit;
	text-align: start;
	cursor: pointer;
	min-inline-size: 0;
}

.channel-list-item .favorite-open-icon {
	flex-shrink: 0;
	inline-size: 1.5rem;
	text-align: center;
	line-height: 1.2;
	font-size: 0.75em;
	opacity: 0.8;
}

.channel-list-item .favorite-open-icon::before {
	content: "\f067"; /* https://fontawesome.com/v5.15/icons/plus?style=solid */
	display: inline-block;
}

.channel-list-item .favorite-open-icon.dormant::before {
	content: "\f1e6"; /* https://fontawesome.com/v5.15/icons/plug?style=solid */
}

.channel-list-item.is-opening .favorite-open-icon::before {
	content: "\f021"; /* https://fontawesome.com/v5.15/icons/sync?style=solid */
	animation: connection-status-spin 1.5s linear infinite;
}

html[data-reduce-motion] .channel-list-item.is-opening .favorite-open-icon::before {
	animation: none;
}
</style>

<script lang="ts">
import {computed, defineComponent, onBeforeUnmount, PropType, ref} from "vue";
import {useI18n} from "../js/i18n";
import eventbus from "../js/eventbus";
import * as saved from "../js/irc/saved-networks";
import {openFavorite} from "../js/favoriteActions";
import {favoriteItem, type ContextMenuItem} from "../js/helpers/contextMenu";
import type {FavoriteRow} from "../js/helpers/sidebarOrder";

/** How long the row shows it is opening before it stops waiting: a join the
 * server refused (banned, a key) leaves the placeholder, its error in the
 * lobby. */
const OPENING_MS = 15_000;

export default defineComponent({
	name: "FavoritePlaceholder",
	props: {
		row: {
			type: Object as PropType<Exclude<FavoriteRow, {kind: "live"}>>,
			required: true,
		},
		/** The network's name beside the favorite's: two favorites share the name. */
		networkTag: {
			type: String,
			default: "",
		},
	},
	setup(props) {
		const {t} = useI18n();
		const opening = ref(false);
		let openingTimer: ReturnType<typeof setTimeout> | null = null;

		const networkName = computed(() =>
			props.row.kind === "closed"
				? props.row.network.name
				: saved.displayName(props.row.saved)
		);

		// What a tap does, as one phrase: the row's tooltip and its button's name.
		const label = computed(() => {
			const vars = {name: props.row.favorite.name, network: networkName.value};

			if (props.row.kind === "dormant") {
				return t("favorites.connect", vars);
			}

			return props.row.favorite.type === "query"
				? t("favorites.openQuery", vars)
				: t("favorites.join", vars);
		});

		const stopOpening = () => {
			if (openingTimer !== null) {
				clearTimeout(openingTimer);
				openingTimer = null;
			}

			opening.value = false;
		};

		const open = () => {
			if (!openFavorite(props.row)) {
				return;
			}

			// The window's arrival replaces this row with its channel row;
			// until then it says it is on its way.
			stopOpening();
			opening.value = true;
			openingTimer = setTimeout(stopOpening, OPENING_MS);
		};

		const openMenu = (event: MouseEvent) => {
			const {name, type} = props.row.favorite;
			const items: ContextMenuItem[] = [
				{
					label: name,
					type: "item",
					class: type === "query" ? "query" : "chan",
					action: open,
				},
				{type: "divider"},
				{
					label: label.value,
					type: "item",
					class:
						props.row.kind === "dormant"
							? "connect"
							: type === "query"
							? "action-query"
							: "join",
					action: open,
				},
				favoriteItem(props.row.favorite.network, name, type, props.row.favorite),
			];

			eventbus.emit("contextmenu:items", {event, items});
		};

		onBeforeUnmount(stopOpening);

		return {opening, label, open, openMenu};
	},
});
</script>
