<template>
	<div
		id="channel-browser"
		class="window browse-window"
		role="region"
		:aria-label="t('browse.aria', {network: networkName})"
	>
		<div class="browse-head">
			<SidebarToggle />
			<div class="browse-title">
				<h1>{{ t("browse.title") }}</h1>
				<span class="browse-network"
					><bdi>{{ networkName }}</bdi></span
				>
			</div>
			<button
				class="oper-icon-btn browse-icon browse-icon-close"
				type="button"
				:aria-label="t('browse.close')"
				:title="t('browse.close')"
				@click="close"
			/>
		</div>

		<div class="browse-tools">
			<form class="browse-query" role="search" @submit.prevent="submitQuery">
				<span class="browse-icon browse-icon-find" aria-hidden="true" />
				<input
					ref="queryField"
					v-model="query"
					class="mousetrap"
					type="search"
					name="browse"
					autocapitalize="off"
					autocomplete="off"
					enterkeyhint="search"
					:aria-label="t('browse.search')"
					:placeholder="t('browse.searchPlaceholder')"
				/>
				<button
					v-if="query"
					type="button"
					class="browse-clear browse-icon browse-icon-remove"
					:aria-label="t('browse.clear')"
					@click="clearQuery"
				/>
			</form>
			<button
				class="oper-btn oper-btn-secondary browse-refresh"
				type="button"
				:disabled="!canRefresh"
				:title="refreshTitle"
				@click="ask"
			>
				<span
					class="browse-icon browse-icon-refresh"
					:class="{spinning: list.status === 'loading'}"
					aria-hidden="true"
				/>
				<span class="browse-refresh-label">{{ t("browse.refresh") }}</span>
			</button>
		</div>

		<div class="browse-chips" role="group" :aria-label="t('browse.filters')">
			<button
				v-for="f in FILTERS"
				:key="f"
				type="button"
				class="browse-chip"
				:class="{on: filter === f}"
				:aria-pressed="filter === f"
				@click="filter = f"
			>
				{{ filterLabel(f) }}
				<span v-if="f === 'featured' && list.featured.length" class="browse-chip-count">{{
					list.featured.length
				}}</span>
			</button>
			<span class="browse-spacer" />
			<label class="browse-sort">
				<span class="sr-only">{{ t("browse.sort") }}</span>
				<select v-model="sort">
					<option value="people">{{ t("browse.sort.people") }}</option>
					<option value="name">{{ t("browse.sort.name") }}</option>
				</select>
			</label>
		</div>

		<div class="browse-body">
			<!-- The server's word on the list: a wait, a refusal, no connection. -->
			<div v-if="!network" class="browse-center" role="status">
				<b>{{ t("browse.noNetwork") }}</b>
			</div>
			<div v-else-if="!connected" class="browse-center" role="status">
				<b>{{ t("browse.offline") }}</b>
				<p>{{ t("browse.offlineNote") }}</p>
			</div>
			<div
				v-else-if="list.status === 'delayed' && waitLeft > 0"
				class="browse-center"
				role="status"
			>
				<span class="browse-wait-ring" aria-hidden="true">{{ waitLeft }}</span>
				<b>{{ t("browse.delayed") }}</b>
				<p>{{ tCount("browse.delayedNote", waitLeft) }}</p>
			</div>
			<div v-else-if="list.status === 'error'" class="browse-center" role="alert">
				<b>{{ t("browse.refused") }}</b>
				<pre class="browse-note">{{ list.note }}</pre>
				<button class="oper-btn oper-btn-secondary" type="button" @click="ask">
					{{ t("browse.retry") }}
				</button>
			</div>

			<template v-else>
				<!-- Featured: what the network itself puts forward. -->
				<section
					v-if="
						featuredRows.length && (filter === 'all' || filter === 'featured') && !query
					"
					class="browse-featured"
					:aria-label="t('browse.featured')"
				>
					<div class="browse-section-head">
						<h2>{{ t("browse.featured") }}</h2>
						<span class="browse-dim">{{ t("browse.featuredNote") }}</span>
					</div>
					<div class="browse-cards">
						<button
							v-for="row in featuredRows"
							:key="row.name"
							type="button"
							class="browse-card"
							:class="{joined: row.joined}"
							@click="open(row.name)"
						>
							<span class="browse-card-name"
								><bdi>{{ row.name }}</bdi></span
							>
							<span class="browse-card-blurb"
								><bdi>{{
									row.blurb || row.topic || t("browse.noTopic")
								}}</bdi></span
							>
							<span class="browse-card-foot">
								<span v-if="row.users !== undefined" class="browse-people">
									<span
										class="browse-icon browse-icon-people"
										aria-hidden="true"
									/>
									{{ tCount("browse.people", row.users) }}
								</span>
								<span class="browse-card-action">{{
									row.joined ? t("browse.open") : t("browse.join")
								}}</span>
							</span>
						</button>
					</div>
				</section>

				<section class="browse-all" :aria-label="t('browse.all')">
					<div class="browse-section-head">
						<h2>
							{{ filter === "featured" ? t("browse.featured") : t("browse.all") }}
						</h2>
						<span v-if="list.status === 'loading'" class="browse-dim" role="status">
							{{
								list.loaded
									? tCount("browse.loadingCount", list.loaded)
									: t("browse.loading")
							}}
						</span>
						<span v-else-if="list.at" class="browse-dim">
							<span>{{ tCount("browse.count", shownRows.length) }}</span>
							<span class="browse-dot" aria-hidden="true">·</span>
							<span>{{ t("browse.updated", {when: updatedLabel}) }}</span>
						</span>
					</div>

					<div
						v-if="list.status === 'loading' && !list.rows.length"
						class="browse-skeleton"
						aria-hidden="true"
					>
						<div v-for="n in 6" :key="n" class="browse-skeleton-row">
							<span class="browse-skeleton-name" />
							<span class="browse-skeleton-topic" />
						</div>
					</div>

					<div v-else-if="!shownRows.length" class="browse-center" role="status">
						<template v-if="query">
							<b>{{ t("browse.noMatches", {query}) }}</b>
							<button
								v-if="creatable"
								class="oper-btn oper-btn-primary"
								type="button"
								@click="open(creatable)"
							>
								{{ t("browse.create", {name: creatable}) }}
							</button>
						</template>
						<template v-else-if="list.status === 'done'">
							<b>{{ t("browse.empty") }}</b>
						</template>
						<template v-else>
							<b>{{ t("browse.idle") }}</b>
							<button class="oper-btn oper-btn-primary" type="button" @click="ask">
								{{ t("browse.ask") }}
							</button>
						</template>
					</div>

					<ul v-else class="browse-rows">
						<li v-for="row in visibleRows" :key="row.name">
							<button
								type="button"
								class="browse-row"
								:class="{joined: row.joined, featured: row.featured}"
								@click="open(row.name)"
							>
								<span class="browse-row-main">
									<span class="browse-row-name">
										<bdi>{{ row.name }}</bdi>
										<span
											v-if="row.featured"
											class="browse-tag"
											:title="t('browse.featured')"
											>★</span
										>
									</span>
									<span class="browse-row-topic"
										><bdi>{{ row.topic || t("browse.noTopic") }}</bdi></span
									>
								</span>
								<span class="browse-people">
									<span
										class="browse-icon browse-icon-people"
										aria-hidden="true"
									/>
									{{ tCount("browse.people", row.users) }}
								</span>
								<span class="browse-row-action" aria-hidden="true">{{
									row.joined ? t("browse.open") : t("browse.join")
								}}</span>
							</button>
						</li>
					</ul>

					<div v-if="shownRows.length > visibleRows.length" class="browse-more">
						<span class="browse-dim">{{
							t("browse.showing", {
								shown: visibleRows.length,
								total: shownRows.length,
							})
						}}</span>
						<button class="oper-btn oper-btn-secondary" type="button" @click="showMore">
							{{ t("browse.showMore") }}
						</button>
					</div>
				</section>
			</template>
		</div>
	</div>
</template>

<style>
#channel-browser {
	display: flex;
	flex-direction: column;
	overflow: hidden;
}

.browse-icon::before {
	font: normal normal normal 1em/1 FontAwesome;
}

.browse-icon-find::before {
	content: "\f002";
}
.browse-icon-remove::before {
	content: "\f00d";
}
.browse-icon-close::before {
	content: "\f00d";
}
.browse-icon-refresh::before {
	content: "\f021";
	display: inline-block;
}
.browse-icon-people::before {
	content: "\f0c0";
}

.browse-icon-refresh.spinning::before {
	animation: browse-spin 1s linear infinite;
}

html[data-reduce-motion] .browse-icon-refresh.spinning::before {
	animation: none;
}

@keyframes browse-spin {
	to {
		transform: rotate(360deg);
	}
}

.browse-head {
	display: flex;
	align-items: center;
	gap: 0.5rem;
	flex: none;
	min-height: 3.125rem;
	padding: 0.5rem 0.75rem 0;
}

#viewport .browse-window .lt {
	position: relative;
	flex: none;
}

.browse-dot {
	margin: 0 0.25em;
}

.browse-title {
	flex: 1;
	display: flex;
	align-items: baseline;
	gap: 0.5rem;
	min-width: 0;
}

.browse-title h1 {
	margin: 0;
	font-size: 1.25rem;
	font-weight: 600;
	white-space: nowrap;
}

.browse-network {
	color: var(--body-color-muted);
	font-size: 0.9375rem;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.browse-head .oper-icon-btn {
	width: 2.5rem;
	height: 2.5rem;
	flex: none;
}

.browse-tools {
	display: flex;
	align-items: center;
	gap: 0.5rem;
	flex: none;
	padding: 0.5rem 0.75rem 0.25rem;
}

.browse-query {
	flex: 1;
	display: flex;
	align-items: center;
	gap: 0.5rem;
	min-width: 0;
	height: 2.5rem;
	padding: 0 0.75rem;
	border: 1px solid var(--oper-line-2);
	border-radius: 0.5rem;
	background: var(--oper-sunk);
	color: var(--body-color-muted);
}

.browse-query input {
	flex: 1;
	min-width: 0;
	border: 0;
	outline: 0;
	background: transparent;
	color: var(--body-color);
	font-size: 1rem;
	appearance: none;
}

/* The field sits on the window surface, not the chat's, so its placeholder
 * takes the window's muted ink: the app-wide rule is black at 35%, and a dark
 * theme that restyles placeholders only inside #chat-container (morning) left
 * this one near-invisible. */
.browse-query input::placeholder {
	color: var(--body-color-muted);
	opacity: 1;
}

.browse-query input::-webkit-search-cancel-button {
	display: none;
}

.browse-query:focus-within {
	border-color: var(--oper-amber);
	box-shadow: 0 0 0 1px var(--oper-amber);
}

.browse-clear {
	width: 1.75rem;
	height: 1.75rem;
	margin-inline-end: -0.375rem;
	color: var(--body-color-muted);
}

.browse-refresh {
	flex: none;
	height: 2.5rem;
}

.browse-chips {
	display: flex;
	align-items: center;
	gap: 0.375rem;
	flex: none;
	padding: 0.375rem 0.75rem 0.625rem;
	border-bottom: 1px solid var(--oper-line);
	overflow-x: auto;
	scrollbar-width: none;
}

.browse-chip {
	display: inline-flex;
	align-items: center;
	gap: 0.3rem;
	flex: none;
	height: 2rem;
	padding: 0 0.75rem;
	border: 1px solid var(--oper-line-2);
	border-radius: 999px;
	color: var(--body-color-muted);
	font-size: 0.8125rem;
	font-weight: 500;
	white-space: nowrap;
	cursor: pointer;
}

.browse-chip.on {
	border-color: color-mix(in oklab, var(--oper-amber) 45%, transparent);
	background: var(--oper-raised);
	color: var(--body-color);
}

.browse-chip-count {
	padding: 0 0.4em;
	border-radius: 999px;
	background: color-mix(in oklab, var(--oper-amber) 25%, transparent);
	font-size: 0.75rem;
	font-variant-numeric: tabular-nums;
}

.browse-spacer {
	flex: 1;
}

.browse-sort select {
	height: 2rem;
	padding: 0 0.5rem;
	border: 1px solid var(--oper-line-2);
	border-radius: 0.4rem;
	background: var(--oper-sunk);
	color: var(--body-color);
	font: inherit;
	font-size: 0.8125rem;
}

.browse-body {
	flex: 1;
	min-height: 0;
	overflow-y: auto;
	overscroll-behavior: contain;
	padding-bottom: var(--inset-inner-bottom, 0px);
}

.browse-section-head {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	gap: 0 0.625rem;
	padding: 1rem 0.75rem 0.5rem;
}

.browse-window .browse-section-head h2 {
	margin: 0;
	padding: 0;
	border: 0;
	color: var(--body-color);
	font-size: 0.8125rem;
	font-weight: 700;
	letter-spacing: 0.06em;
	text-transform: uppercase;
}

.browse-dim {
	color: var(--body-color-muted);
	font-size: 0.8125rem;
}

/* Featured: cards, a row that scrolls sideways on a narrow pane. */
.browse-cards {
	display: grid;
	grid-auto-flow: column;
	grid-auto-columns: minmax(14rem, 1fr);
	gap: 0.625rem;
	padding: 0 0.75rem 0.5rem;
	overflow-x: auto;
	scroll-snap-type: x proximity;
	scrollbar-width: thin;
}

@container (min-width: 60rem) {
	.browse-cards {
		grid-auto-flow: row;
		grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
		overflow: visible;
	}
}

.browse-window .browse-body {
	container-type: inline-size;
}

.browse-card {
	display: flex;
	flex-direction: column;
	gap: 0.375rem;
	min-height: 7rem;
	padding: 0.75rem 0.875rem;
	border: 1px solid var(--oper-line);
	border-radius: 0.75rem;
	background: linear-gradient(
		160deg,
		color-mix(in oklab, var(--oper-amber) 14%, var(--oper-panel)),
		var(--oper-panel) 70%
	);
	color: var(--body-color);
	font: inherit;
	text-align: start;
	scroll-snap-align: start;
	cursor: pointer;
	transition: border-color 0.12s, transform 0.12s;
}

.browse-card:hover,
.browse-card:focus-visible {
	border-color: color-mix(in oklab, var(--oper-amber) 55%, transparent);
	transform: translateY(-0.0625rem);
}

html[data-reduce-motion] .browse-card,
html[data-reduce-motion] .browse-card:hover {
	transition: none;
	transform: none;
}

.browse-card-name {
	font-size: 1.0625rem;
	font-weight: 600;
	overflow-wrap: anywhere;
}

.browse-card-blurb {
	flex: 1;
	color: var(--body-color-muted);
	font-size: 0.875rem;
	line-height: 1.35;
	display: -webkit-box;
	-webkit-box-orient: vertical;
	-webkit-line-clamp: 2;
	line-clamp: 2;
	overflow: hidden;
	overflow-wrap: anywhere;
}

.browse-card-foot {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 0.5rem;
	margin-top: 0.25rem;
}

.browse-card-action,
.browse-row-action {
	padding: 0.25rem 0.625rem;
	border-radius: 999px;
	background: var(--oper-amber);
	color: var(--window-bg-color);
	font-size: 0.75rem;
	font-weight: 700;
	letter-spacing: 0.04em;
	text-transform: uppercase;
	white-space: nowrap;
}

.browse-card.joined .browse-card-action,
.browse-row.joined .browse-row-action {
	background: var(--oper-raised);
	color: var(--body-color);
}

.browse-people {
	display: inline-flex;
	align-items: center;
	gap: 0.35rem;
	color: var(--body-color-muted);
	font-size: 0.8125rem;
	font-variant-numeric: tabular-nums;
	white-space: nowrap;
}

/* Every channel: one row each, the whole row a button. */
.browse-rows {
	list-style: none;
	margin: 0;
	padding: 0 0.375rem;
}

.browse-row {
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto auto;
	align-items: center;
	gap: 0.75rem;
	width: 100%;
	padding: 0.625rem 0.5rem;
	border: 0;
	border-radius: 0.5rem;
	background: transparent;
	color: var(--body-color);
	font: inherit;
	text-align: start;
	cursor: pointer;
}

.browse-row:hover,
.browse-row:focus-visible {
	background: var(--oper-panel);
}

.browse-row:focus-visible,
.browse-card:focus-visible,
.browse-chip:focus-visible {
	outline: 0.125rem solid var(--oper-amber);
	outline-offset: -0.125rem;
}

.browse-row-main {
	display: grid;
	gap: 0.125rem;
	min-width: 0;
}

.browse-row-name {
	display: flex;
	align-items: center;
	gap: 0.375rem;
	font-weight: 600;
	min-width: 0;
}

.browse-row-name bdi {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.browse-tag {
	color: var(--oper-amber);
	font-size: 0.75rem;
}

.browse-row-topic {
	color: var(--body-color-muted);
	font-size: 0.875rem;
	line-height: 1.35;
	display: -webkit-box;
	-webkit-box-orient: vertical;
	-webkit-line-clamp: 2;
	line-clamp: 2;
	overflow: hidden;
	overflow-wrap: anywhere;
}

.browse-row-action {
	opacity: 0;
	transition: opacity 0.12s;
}

.browse-row:hover .browse-row-action,
.browse-row:focus-visible .browse-row-action,
.browse-row.joined .browse-row-action {
	opacity: 1;
}

/* No hover on a touch screen: the action is always there. */
@media (hover: none) {
	.browse-row-action {
		opacity: 1;
	}
}

.browse-more {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 0.75rem;
	padding: 1rem 0.75rem 1.5rem;
}

.browse-center {
	display: grid;
	justify-items: center;
	gap: 0.625rem;
	padding: 2.5rem 1.25rem;
	color: var(--body-color-muted);
	text-align: center;
}

.browse-center b {
	color: var(--body-color);
}

.browse-center p {
	margin: 0;
	max-width: 26rem;
}

.browse-note {
	max-width: 100%;
	margin: 0;
	padding: 0.5rem 0.75rem;
	border-radius: 0.5rem;
	background: var(--oper-sunk);
	font-size: 0.8125rem;
	text-align: start;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}

.browse-wait-ring {
	display: grid;
	place-items: center;
	width: 3.5rem;
	height: 3.5rem;
	border: 0.1875rem solid color-mix(in oklab, var(--oper-amber) 45%, transparent);
	border-top-color: var(--oper-amber);
	border-radius: 50%;
	color: var(--body-color);
	font-size: 1.125rem;
	font-weight: 700;
	font-variant-numeric: tabular-nums;
}

/* While the first list loads: the shape of what is coming. */
.browse-skeleton {
	display: grid;
	gap: 0.25rem;
	padding: 0.25rem 0.875rem;
}

.browse-skeleton-row {
	display: grid;
	gap: 0.375rem;
	padding: 0.625rem 0;
}

.browse-skeleton-name,
.browse-skeleton-topic {
	display: block;
	height: 0.875rem;
	border-radius: 0.25rem;
	background: var(--oper-raised);
	animation: browse-pulse 1.4s ease-in-out infinite;
}

.browse-skeleton-name {
	width: 9rem;
}

.browse-skeleton-topic {
	width: min(32rem, 80%);
	opacity: 0.6;
}

html[data-reduce-motion] .browse-skeleton-name,
html[data-reduce-motion] .browse-skeleton-topic {
	animation: none;
}

@keyframes browse-pulse {
	50% {
		opacity: 0.45;
	}
}

@media (max-width: 768px) {
	.browse-refresh-label {
		display: none;
	}

	.browse-refresh {
		width: 2.5rem;
		padding: 0;
	}

	.browse-row {
		grid-template-columns: minmax(0, 1fr) auto;
		grid-template-areas:
			"main people"
			"main action";
		row-gap: 0.25rem;
	}

	.browse-row-main {
		grid-area: main;
	}

	.browse-row .browse-people {
		grid-area: people;
		justify-self: end;
	}

	.browse-row-action {
		grid-area: action;
		justify-self: end;
	}
}
</style>

<script lang="ts">
import {computed, defineComponent, onMounted, onUnmounted, ref, watch} from "vue";
import {useRoute} from "vue-router";

import socket from "../../js/socket";
import {leavePage, switchToChannel} from "../../js/router";
import {useStore} from "../../js/store";
import {useI18n} from "../../js/i18n";
import {formatRelativeTime} from "../../js/i18n/dates";
import {BUSY_USERS, REFRESH_AFTER_MS, STALE_AFTER_MS} from "../../js/irc/channelList";
import {ChanState, ChanType} from "../../../shared/types/chan";
import type {SharedChannelList} from "../../../shared/types/channel-list";
import SidebarToggle from "../SidebarToggle.vue";

type Filter = "all" | "featured" | "busy" | "topic";
type Sort = "people" | "name";

const FILTERS: Filter[] = ["all", "featured", "busy", "topic"];
const PAGE = 150;

const EMPTY: SharedChannelList = {
	status: "idle",
	rows: [],
	at: 0,
	loaded: 0,
	waitSeconds: 0,
	note: "",
	featured: [],
};

interface Row {
	name: string;
	users: number;
	topic: string;
	joined: boolean;
	featured: boolean;
}

export default defineComponent({
	name: "ChannelBrowser",
	components: {SidebarToggle},
	setup() {
		const store = useStore();
		const route = useRoute();
		const {t, tCount} = useI18n();

		const queryField = ref<HTMLInputElement>();
		const query = ref("");
		const filter = ref<Filter>("all");
		const sort = ref<Sort>("people");
		const shown = ref(PAGE);
		const now = ref(Date.now());
		let clock: ReturnType<typeof setInterval> | undefined;

		const network = computed(() => store.getters.findNetwork(String(route.params.uuid)));
		const networkName = computed(() => network.value?.name ?? "");
		const connected = computed(() => network.value?.status.connected ?? false);
		const list = computed<SharedChannelList>(
			() => (network.value && store.state.channelLists[network.value.uuid]) ?? EMPTY
		);

		const joinedNames = computed(() => {
			const names = new Set<string>();

			for (const chan of network.value?.channels ?? []) {
				if (chan.type === ChanType.CHANNEL && chan.state === ChanState.JOINED) {
					names.add(chan.name.toLowerCase());
				}
			}

			return names;
		});

		const featuredNames = computed(
			() => new Set(list.value.featured.map((f) => f.name.toLowerCase()))
		);

		const byName = computed(() => {
			const map = new Map<string, Row>();

			for (const r of list.value.rows) {
				const key = r.name.toLowerCase();
				map.set(key, {
					name: r.name,
					users: r.users,
					topic: r.topic,
					joined: joinedNames.value.has(key),
					featured: featuredNames.value.has(key),
				});
			}

			return map;
		});

		/** Featured cards: the MOTD's blurb, the list's count and topic when it has them. */
		const featuredRows = computed(() =>
			list.value.featured.map((f) => {
				const row = byName.value.get(f.name.toLowerCase());
				return {
					name: f.name,
					blurb: f.blurb,
					topic: row?.topic ?? "",
					users: row?.users,
					joined: joinedNames.value.has(f.name.toLowerCase()),
				};
			})
		);

		const words = computed(() => query.value.trim().toLowerCase().split(/\s+/).filter(Boolean));

		const shownRows = computed<Row[]>(() => {
			const rows: Row[] = [];

			for (const row of byName.value.values()) {
				if (filter.value === "featured" && !row.featured) {
					continue;
				}

				if (filter.value === "busy" && row.users < BUSY_USERS) {
					continue;
				}

				if (filter.value === "topic" && !row.topic) {
					continue;
				}

				if (words.value.length) {
					const hay = `${row.name} ${row.topic}`.toLowerCase();

					if (!words.value.every((w) => hay.includes(w))) {
						continue;
					}
				}

				rows.push(row);
			}

			if (sort.value === "name") {
				rows.sort((a, b) => a.name.localeCompare(b.name));
			} else {
				// The list comes sorted by users; a name match goes first.
				if (words.value.length === 1) {
					const w = words.value[0];
					rows.sort(
						(a, b) =>
							Number(b.name.toLowerCase().includes(w)) -
								Number(a.name.toLowerCase().includes(w)) || b.users - a.users
					);
				}
			}

			return rows;
		});

		const visibleRows = computed(() => shownRows.value.slice(0, shown.value));

		/** A query that is one channel name with no match: offer to start it. */
		const creatable = computed(() => {
			const q = query.value.trim();
			const types = network.value?.serverOptions.CHANTYPES ?? ["#"];

			if (!q || /[\s,]/.test(q) || shownRows.value.length) {
				return "";
			}

			return types.includes(q[0]) ? q : types[0] + q;
		});

		const delayedAt = ref(0);
		const waitLeft = computed(() =>
			Math.max(
				0,
				Math.ceil((list.value.waitSeconds * 1000 - (now.value - delayedAt.value)) / 1000)
			)
		);

		watch(
			() => list.value.status,
			(status) => {
				if (status === "delayed") {
					delayedAt.value = Date.now();
				}
			},
			{immediate: true}
		);

		const canRefresh = computed(
			() =>
				connected.value &&
				list.value.status !== "loading" &&
				(list.value.status !== "delayed" || waitLeft.value === 0) &&
				now.value - list.value.at >= REFRESH_AFTER_MS
		);
		const refreshTitle = computed(() =>
			list.value.at && now.value - list.value.at < REFRESH_AFTER_MS
				? t("browse.refreshSoon")
				: t("browse.refresh")
		);
		const updatedLabel = computed(() => {
			void now.value; // redrawn by the clock
			return formatRelativeTime(list.value.at);
		});

		const ask = () => {
			if (!network.value || !connected.value) {
				return;
			}

			socket.emit("channel:list:ask", {network: network.value.uuid});
		};

		/** Ask on opening when there is nothing, or what there is has aged. */
		const askIfStale = () => {
			const l = list.value;

			if (
				connected.value &&
				(l.status === "idle" || (l.status === "done" && Date.now() - l.at > STALE_AFTER_MS))
			) {
				ask();
			}
		};

		const open = (name: string) => {
			const net = network.value;

			if (!net) {
				return;
			}

			const existing = net.channels.find(
				(c) => c.type === ChanType.CHANNEL && c.name.toLowerCase() === name.toLowerCase()
			);

			if (existing && existing.state === ChanState.JOINED) {
				switchToChannel(existing);
				return;
			}

			socket.emit("input", {target: net.channels[0].id, text: `/join ${name}`});
		};

		const filterLabel = (f: Filter) => {
			switch (f) {
				case "featured":
					return t("browse.filter.featured");
				case "busy":
					return t("browse.filter.busy", {count: BUSY_USERS});
				case "topic":
					return t("browse.filter.topic");
				default:
					return t("browse.filter.all");
			}
		};

		const submitQuery = () => {
			if (creatable.value) {
				open(creatable.value);
			}
		};
		const clearQuery = () => {
			query.value = "";
			queryField.value?.focus();
		};
		const showMore = () => {
			shown.value += PAGE;
		};
		const close = () => {
			leavePage();
		};

		watch([query, filter, sort], () => {
			shown.value = PAGE;
		});

		watch(connected, (up) => {
			if (up) {
				askIfStale();
			}
		});

		watch(network, (net) => {
			if (!net) {
				leavePage();
			}
		});

		onMounted(() => {
			askIfStale();
			clock = setInterval(() => {
				now.value = Date.now();
			}, 1000);

			if (window.matchMedia("(hover: hover)").matches) {
				queryField.value?.focus();
			}
		});

		onUnmounted(() => {
			if (clock) {
				clearInterval(clock);
			}
		});

		return {
			FILTERS,
			t,
			tCount,
			network,
			networkName,
			connected,
			list,
			query,
			queryField,
			filter,
			sort,
			featuredRows,
			shownRows,
			visibleRows,
			creatable,
			waitLeft,
			canRefresh,
			refreshTitle,
			updatedLabel,
			ask,
			open,
			filterLabel,
			submitQuery,
			clearQuery,
			showMore,
			close,
		};
	},
});
</script>
