<template>
	<aside
		id="search-panel"
		ref="panel"
		class="window"
		:class="{
			'screen-overlay': phone,
			covering: !!coverBox,
			tucked: searchTucked,
			'time-seconds': store.state.settings.showSeconds,
			'time-12h': store.state.settings.use12hClock,
		}"
		:style="
			coverBox && {
				left: `${coverBox.left}px`,
				top: `${coverBox.top}px`,
				width: `${coverBox.width}px`,
				height: `${coverBox.height}px`,
			}
		"
		:aria-label="t('search.results.aria')"
	>
		<div class="chat-view" data-type="search-results">
			<template v-if="network && channel">
				<div class="search-head" :inert="filtersOpen" :data-tauri-drag-region="dragRegion">
					<!-- Covering the chat, the panel covers its header's toggle too. -->
					<SidebarToggle v-if="coverBox" />
					<form class="search-query" role="search" @submit.prevent="submit">
						<span class="search-icon search-icon-find" aria-hidden="true" />
						<!-- mousetrap: Escape closes the panel from the field too (App.vue). -->
						<input
							ref="queryField"
							v-model="draft"
							class="mousetrap"
							type="search"
							name="search"
							autocapitalize="off"
							autocomplete="off"
							enterkeyhint="search"
							:aria-label="t('search.window.field')"
							:placeholder="
								phone
									? t('search.window.placeholder', {scope: scopeLabel})
									: t('search.window.placeholderEsc', {scope: scopeLabel})
							"
						/>
						<button
							type="submit"
							class="oper-btn"
							:class="stale ? 'oper-btn-primary' : 'oper-btn-secondary'"
						>
							{{ t("search.window.submit") }}
						</button>
					</form>
					<button
						v-if="phone"
						class="oper-btn oper-btn-ghost search-cancel"
						@click="closeSearch"
					>
						{{ t("search.window.cancel") }}
					</button>
					<button
						v-else
						class="oper-icon-btn search-icon search-icon-remove search-close"
						:aria-label="t('search.window.close')"
						:title="t('search.window.close')"
						@click="closeSearch"
					/>
				</div>

				<div class="search-chips" :inert="filtersOpen">
					<button class="search-chip on" @click="filtersOpen = true">
						<span class="search-icon search-icon-in" aria-hidden="true" />
						<I18nFrame :text="t('search.window.inScope', {scope: KEEP})"
							><template #scope
								><b>{{ heldScopeLabel }}</b></template
							></I18nFrame
						>
					</button>
					<span v-for="chip in chips" :key="chip.id" class="search-chip on" data-filter>
						<button class="search-chip-open" @click="filtersOpen = true">
							{{ chip.label }} <b>{{ chip.value }}</b>
						</button>
						<button
							class="search-chip-remove search-icon search-icon-remove"
							:aria-label="t('search.window.removeFilter', {filter: chip.label})"
							@click="removeChip(chip.id)"
						/>
					</span>
					<button class="search-chip" @click="filtersOpen = true">
						<span class="search-icon search-icon-filter" aria-hidden="true" />
						{{ t("search.window.filters") }}
					</button>
				</div>

				<div v-if="banner" class="search-banner" role="status">
					<span class="search-icon search-icon-warn" aria-hidden="true" />
					<div>
						<b>{{ banner }}</b>
						<p>
							{{ tCount("search.window.loadedInstead", loadedCount) }}
						</p>
					</div>
					<button
						v-if="mode === 'offline'"
						class="oper-btn oper-btn-secondary"
						@click="run"
					>
						{{ t("search.window.retry") }}
					</button>
				</div>

				<p v-if="staleNote && criteria" class="search-stale" role="status">
					{{ t("search.window.stale") }}
				</p>

				<p v-if="hitError" class="search-stale" role="status">{{ hitError }}</p>

				<div class="search-panes">
					<div
						ref="list"
						class="search-list"
						:class="{stale: staleNote && criteria}"
						:inert="filtersOpen"
					>
						<div v-if="!criteria" class="search-start">
							<div v-if="recent.length" class="search-recent">
								<div class="search-recent-head">
									<b>{{ t("search.window.recent") }}</b>
									<button class="oper-btn oper-btn-ghost" @click="clearRecent">
										{{ t("search.window.clearRecent") }}
									</button>
								</div>
								<button
									v-for="q in recent"
									:key="q"
									class="search-recent-item"
									@click="useRecent(q)"
								>
									<span
										class="search-icon search-icon-recent"
										aria-hidden="true"
									/>
									<bdi>{{ q }}</bdi>
								</button>
							</div>
							<p>
								{{ t("search.window.start") }}
							</p>
							<div class="search-suggest">
								<button
									v-for="hint in HINTS"
									:key="hint"
									class="oper-chip"
									@click="useHint(hint)"
								>
									{{ hint }}
								</button>
							</div>
						</div>

						<div
							v-else-if="loading && !rows.length"
							class="search-center"
							role="status"
						>
							<p>{{ t("search.window.asking") }}</p>
						</div>

						<div v-else-if="error" class="search-center" role="alert">
							<b>{{ t("search.window.failed") }}</b>
							<p>{{ error }}</p>
							<button class="oper-btn oper-btn-secondary" @click="run">
								{{ t("search.window.retry") }}
							</button>
						</div>

						<div v-else-if="!rows.length" class="search-center" role="status">
							<b>{{ t("search.window.noMatches", {scope: scopeLabel}) }}</b>
							<p v-if="mode === 'server'">
								{{ t("search.window.noMatchesNote") }}
							</p>
							<button
								v-if="chips.length"
								class="oper-btn oper-btn-secondary"
								@click="filtersOpen = true"
							>
								{{ t("search.window.editFilters") }}
							</button>
							<button
								v-if="mode === 'server' && filters.in !== ALL_CHANNELS"
								class="oper-btn oper-btn-secondary"
								@click="searchEverywhere"
							>
								{{ t("search.window.everywhere") }}
							</button>
						</div>

						<div v-else-if="!visible.length" class="search-center">
							<b>{{ tCount("search.window.allHidden", rows.length) }}</b>
							<p>
								{{ t("search.window.allHiddenNote", {when: oldestLabel}) }}
							</p>
							<button
								v-if="canLoadOlder"
								class="oper-btn oper-btn-secondary"
								:disabled="loadingOlder"
								@click="loadOlder()"
							>
								{{ t("search.window.older") }}
							</button>
							<button class="oper-btn oper-btn-ghost" @click="filtersOpen = true">
								{{ t("search.window.editFilters") }}
							</button>
						</div>

						<template v-else>
							<template v-for="group in groups" :key="group.label">
								<div class="search-day">{{ group.label }}</div>
								<div
									v-for="hit in group.hits"
									:key="hit.msg.id"
									class="search-hit"
									:data-hit="hit.msg.id"
									role="button"
									tabindex="0"
									@click="clickHit($event, hit)"
									@keydown.enter.self="openHit(hit)"
									@keydown.space.self.prevent="openHit(hit)"
								>
									<div class="search-line">
										<div class="search-meta">
											<Username
												v-if="hit.msg.from"
												:user="hit.msg.from"
												:network="network"
												@click.stop
											/>
											<span class="search-chan">{{ hit.target }}</span>
											<span class="search-time">{{ hitTime(hit.msg) }}</span>
											<span
												v-if="hit.loaded"
												class="search-dim search-loaded"
												>{{ t("search.window.loadedRow") }}</span
											>
										</div>
										<div class="search-text">
											<ParsedMessage
												:network="network"
												:message="asClient(hit.msg)"
											/>
										</div>
									</div>
								</div>
							</template>
						</template>

						<div
							v-if="criteria && !loading && !error && rows.length"
							class="search-status"
						>
							<span role="status">{{
								tCount("search.window.matchCount", visible.length)
							}}</span>
							<span v-if="hiddenCount" class="search-dim">
								· {{ tCount("search.window.hiddenCount", hiddenCount) }}
							</span>
							<span class="search-dim"
								>· {{ t("search.window.backTo", {when: oldestLabel}) }}</span
							>
							<span class="search-spacer" />
							<span v-if="olderError" class="search-dim" role="alert">{{
								olderError
							}}</span>
							<button
								v-if="canLoadOlder"
								class="oper-btn oper-btn-secondary"
								:disabled="loadingOlder"
								@click="loadOlder()"
							>
								{{
									loadingOlder
										? t("search.window.searching")
										: t("search.window.older")
								}}
							</button>
							<span v-else-if="mode === 'server'" class="search-dim">
								{{ t("search.window.nothingOlder") }}
							</span>
						</div>
					</div>
				</div>

				<SearchFilterSheet
					v-if="filtersOpen"
					:filters="draftFilters"
					:scope-default="scopeDefault"
					:conversations="conversations"
					:suggestions="suggestions"
					@apply="applyFilters"
					@close="filtersOpen = false"
				/>
			</template>
		</div>
		<!-- 1rem wide: useSearchFit sees the text size change through it. -->
		<span ref="probe" class="search-fit-probe" aria-hidden="true" />
	</aside>
</template>

<style>
/* Beside the chat, whose lines a hit scrolls to, when both fit; otherwise
 * over it. The width is js/searchPanel.ts searchBesideWidth's; change the two
 * together. */
#search-panel {
	flex: 0 1 clamp(20rem, 34%, 30rem);
	min-width: 0;
	overflow: hidden;
	border-inline-start: 1px solid var(--oper-line);
}

/* Beside the chat the sidebar keeps its width. Should the window narrow
 * past the point where both fit, the panel gives way for the moment it takes
 * useSearchFit to see it and cover the chat instead; the sidebar giving way
 * there would make the room it measures look larger than it is. */
#viewport:has(> #search-panel:not(.covering, .screen-overlay)) #sidebar {
	flex-shrink: 0;
}

/* A desktop window without room for both (searchPanel.ts useSearchFit): the
 * panel takes the chat's box, given inline, and nothing beside it moves. */
#search-panel.covering {
	position: absolute;
	z-index: 2;
}

/* Tucked only while it covers the chat (a phone, a narrow window). */
#search-panel.tucked {
	display: none;
}

.search-fit-probe {
	position: absolute;
	width: 1rem;
	height: 0;
	visibility: hidden;
	pointer-events: none;
}

#viewport #search-panel .lt {
	position: relative;
	flex: none;
}

.chat-view[data-type="search-results"] {
	display: flex;
	flex-direction: column;
	flex: 1;
	min-height: 0;
}

@media (max-width: 480px),
	(max-width: 768px) and (pointer: coarse),
	(max-height: 500px) and (hover: none) and (pointer: coarse) {
	#search-panel {
		position: absolute;
		inset: 0;
		z-index: 2;
		border: 0;
	}
}

.search-icon::before {
	font: normal normal normal 1em/1 FontAwesome;
}

.search-icon-recent::before {
	content: "\f1da";
}
.search-icon-find::before {
	content: "\f002";
}
.search-icon-in::before {
	content: "\f292";
}
.search-icon-filter::before {
	content: "\f0b0";
}
.search-icon-remove::before {
	content: "\f00d";
}
.search-icon-warn::before {
	content: "\f071";
}

.search-head {
	display: flex;
	align-items: center;
	gap: 0.5rem;
	padding: 0.5rem 0.75rem 0.25rem;
}

.search-query {
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

.search-query input {
	flex: 1;
	min-width: 0;
	border: 0;
	outline: 0;
	background: transparent;
	color: var(--body-color);
	font-size: 1rem;
	appearance: none;
}

.search-query:focus-within {
	border-color: var(--oper-amber);
	box-shadow: 0 0 0 1px var(--oper-amber);
}

.search-query .oper-btn {
	flex: none;
	height: 2rem;
	margin-inline-end: -0.5rem;
}

.search-close,
.search-cancel {
	flex: none;
}

.search-close {
	width: 2.5rem;
	height: 2.5rem;
}

.search-recent {
	display: grid;
	gap: 0.125rem;
	margin-bottom: 1rem;
}

.search-recent-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	color: var(--body-color);
}

.search-recent-item {
	display: flex;
	align-items: center;
	gap: 0.625rem;
	min-height: 2.5rem;
	padding: 0 0.5rem;
	border-radius: 0.375rem;
	color: var(--body-color);
	font: inherit;
	text-align: start;
	overflow-wrap: anywhere;
}

.search-recent-item:hover,
.search-recent-item:focus-visible {
	background: var(--oper-panel);
}

.search-recent-item .search-icon {
	color: var(--body-color-muted);
}

.search-chip:focus-visible,
.search-chip-open:focus-visible,
.search-chip-remove:focus-visible,
.search-hit:focus-visible {
	outline: 0.125rem solid var(--oper-amber);
	outline-offset: -0.125rem;
}

.search-stale {
	margin: 0;
	padding: 0.5rem 0.75rem;
	border-bottom: 1px solid var(--oper-line);
	color: var(--body-color-muted);
	font-size: 0.8125rem;
}

.search-list.stale {
	opacity: 0.55;
}

.search-chips {
	display: flex;
	flex-wrap: wrap;
	gap: 0.375rem;
	padding: 0.375rem 0.75rem 0.625rem;
	border-bottom: 1px solid var(--oper-line);
}

.search-chip {
	display: inline-flex;
	align-items: center;
	gap: 0.3rem;
	flex: none;
	height: 2rem;
	padding: 0 0.625rem;
	border: 1px solid var(--oper-line-2);
	border-radius: 999px;
	color: var(--body-color-muted);
	font-size: 0.8125rem;
	font-weight: 500;
	white-space: nowrap;
	cursor: pointer;
}

.search-chip b {
	color: var(--body-color);
	font-weight: 600;
}

.search-chip.on {
	border-color: color-mix(in oklab, var(--oper-amber) 45%, transparent);
	background: var(--oper-raised);
}

.search-chip[data-filter] {
	padding-right: 0.25rem;
}

.search-chip-open {
	color: inherit;
	font: inherit;
}

.search-chip-remove {
	width: 1.5rem;
	height: 1.5rem;
	color: var(--body-color-muted);
}

.search-banner {
	display: flex;
	align-items: center;
	gap: 0.625rem;
	margin: 0.625rem 0.75rem 0;
	padding: 0.625rem 0.75rem;
	border: 1px solid color-mix(in oklab, var(--oper-amber) 45%, transparent);
	border-radius: 0.5rem;
	color: var(--oper-amber);
}

.search-banner b {
	color: var(--body-color);
}

.search-banner p {
	margin: 0.125rem 0 0;
	color: var(--body-color-muted);
	font-size: 0.8125rem;
}

.search-banner > div {
	flex: 1;
	min-width: 0;
}

.search-panes {
	flex: 1;
	display: grid;
	grid-template-columns: minmax(0, 1fr);
	min-height: 0;
}

.search-list {
	min-width: 0;
	overflow-y: auto;
	overscroll-behavior: contain;
	padding-bottom: var(--inset-inner-bottom, 0px);
}

.search-start,
.search-center {
	display: grid;
	gap: 0.625rem;
	padding: 2rem 1.25rem;
	color: var(--body-color-muted);
}

.search-center {
	justify-items: center;
	text-align: center;
}

.search-center b {
	color: var(--body-color);
}

.search-start p,
.search-center p {
	margin: 0;
	max-width: 26rem;
}

.search-day {
	padding: 0.875rem 0.75rem 0.25rem;
	color: var(--body-color-muted);
	font-size: 0.75rem;
	font-weight: 600;
	letter-spacing: 0.06em;
	text-transform: uppercase;
}

.search-hit {
	padding: 0.5rem 0.75rem;
	cursor: pointer;
}

.search-hit:hover,
.search-hit:focus-visible {
	background: var(--oper-panel);
}

.search-time {
	color: var(--body-color-muted);
	font-size: 0.8125rem;
	font-variant-numeric: tabular-nums;
	white-space: nowrap;
}

.search-meta {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	gap: 0 0.5rem;
	min-width: 0;
}

.search-chan,
.search-dim {
	color: var(--body-color-muted);
	font-size: 0.8125rem;
}

/* Selectable: WebKit paints no ::highlight on text with user-select: none. A long
   line shows four lines, the ones with the match (showMatches), faded where it is cut. */
.search-text {
	max-height: 4lh;
	overflow: hidden;
	overflow-wrap: anywhere;
	user-select: text;
}

.search-text[data-cut="end"] {
	mask-image: linear-gradient(to bottom, #000 calc(100% - 1lh), transparent);
}

.search-text[data-cut="start"] {
	mask-image: linear-gradient(to top, #000 calc(100% - 1lh), transparent);
}

.search-text[data-cut="both"] {
	mask-image: linear-gradient(
		to bottom,
		transparent,
		#000 1lh,
		#000 calc(100% - 1lh),
		transparent
	);
}

::highlight(search-hit) {
	background-color: color-mix(in oklab, var(--oper-amber) 35%, transparent);
}

.search-status {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0.375rem;
	margin-top: 0.5rem;
	padding: 0.75rem;
	border-top: 1px solid var(--oper-line);
	font-size: 0.8125rem;
}

.search-spacer {
	flex: 1;
}

@media (max-width: 480px),
	(max-width: 768px) and (pointer: coarse),
	(max-height: 500px) and (hover: none) and (pointer: coarse) {
	.search-chips {
		flex-wrap: nowrap;
		overflow-x: auto;
		scrollbar-width: none;
	}
}
</style>

<script lang="ts">
import dayjs from "dayjs";
import {computed, defineComponent, nextTick, onMounted, onUnmounted, ref, watch} from "vue";
import {useRoute, useRouter} from "vue-router";

import eventbus from "../../js/eventbus";
import socket from "../../js/socket";
import {navigate, switchToChannel} from "../../js/router";
import {phoneLayout as phone, searchCovers, searchTucked, useSearchFit} from "../../js/searchPanel";
import {macDragRegion} from "../../js/helpers/shell";
import {forgetSearches, recentSearches, rememberSearch} from "../../js/helpers/searchRecents";
import {
	ALL_CHANNELS,
	dayStart,
	formatSearchQuery,
	hasCriteria,
	matchesFilters,
	matchSpans,
	addFilters,
	filtersOnly,
	parseSearchQuery,
	readyToSearch,
	takeFinishedFilters,
	wordsOnly,
	resolveScope,
	rowKey,
	serverAttrs,
	type SearchFilters,
} from "../../js/searchQuery";
import {clockTime, dayLabel, datedTime, shortDay} from "../../js/helpers/messageTime";
import {clearHighlight, paintHighlight, rangesIn} from "../../js/helpers/paintHighlight";
import {setReadHold} from "../../js/helpers/readHold";
import {useStore} from "../../js/store";
import {useI18n} from "../../js/i18n";
import {KEEP} from "../../js/i18n/core";
import I18nFrame from "../I18nFrame.vue";
import {hasLabel} from "../../js/helpers/searchLabels";
import type {ClientChan, ClientMessage} from "../../js/types";
import type {SharedMsg} from "../../../shared/types/msg";
import type {SearchHit, SearchStatus} from "../../../shared/types/search";
import ParsedMessage from "../ParsedMessage.vue";
import SearchFilterSheet from "../SearchFilterSheet.vue";
import SidebarToggle from "../SidebarToggle.vue";
import Username from "../Username.vue";

const PAGE_SIZE = 100;
const HINTS = ["from:nick", "in:#channel", "has:link", "-word", "after:2026-10-01"];

let nextRequestId = 1;

/** The pause in typing that starts a search. */
const LIVE_DELAY_MS = 800;
/** Between searches typing starts: one command's fake lag, so the clock never climbs. */
const LIVE_GAP_MS = 2000;
/** How soon to look again while an answer is on its way. */
const LIVE_RETRY_MS = 500;

type Mode = "server" | "unsupported" | "offline" | "partial";

interface Chip {
	id: "from" | "account" | "date" | "has" | "without";
	label: string;
	value: string;
}

export default defineComponent({
	name: "SearchResults",
	components: {I18nFrame, ParsedMessage, SearchFilterSheet, SidebarToggle, Username},
	setup() {
		const store = useStore();
		const route = useRoute();
		const router = useRouter();
		const {t, tCount, locale} = useI18n();

		const queryField = ref<HTMLInputElement>();
		const panel = ref<HTMLElement>();
		const probe = ref<HTMLElement>();
		const coverBox = useSearchFit(panel, probe);

		// The field holds the words; every filter is a chip. The route's q has both.
		const opened = parseSearchQuery(String(route.query.q ?? ""));
		const draft = ref(wordsOnly(opened));
		const held = ref(filtersOnly(opened));
		let liveTimer: ReturnType<typeof setTimeout> | undefined;
		let lastAskedAt = 0;
		/** The route change coming is a search typing started. */
		let liveRoute = false;
		const filtersOpen = ref(false);
		const rows = ref<SearchHit[]>([]);
		const mode = ref<Mode>("server");
		const loading = ref(false);
		const loadingOlder = ref(false);
		const reachedEnd = ref(false);
		const error = ref("");
		const olderError = ref("");
		const hitError = ref("");
		const list = ref<HTMLElement>();
		let requestId = 0;
		/** What the last ask was for, its scope spelt out: a hit's chat beside asks nothing new. */
		let askedFor = "";
		const recent = ref(recentSearches());

		const found = computed(() =>
			store.getters.findChannel(parseInt(String(route.params.id ?? ""), 10))
		);
		const network = computed(() => found.value?.network ?? null);
		const channel = computed(() => found.value?.channel ?? null);

		const chats = computed<ClientChan[]>(() =>
			(network.value?.channels ?? []).filter(
				(c) => c.type === "channel" || c.type === "query"
			)
		);
		const conversations = computed(() => chats.value.map((c) => c.name));
		const findChat = (name: string) =>
			chats.value.find((c) => c.name.toLowerCase() === name.toLowerCase());

		const query = computed(() => String(route.query.q ?? "").trim());
		const filters = computed<SearchFilters>(() =>
			resolveScope(parseSearchQuery(query.value), (name) => !!findChat(name))
		);
		const criteria = computed(() => hasCriteria(filters.value));
		// A filter changed while the field is edited keeps the edit: the field is
		// what the next search will be, whatever the results below came from.
		const draftFilters = computed<SearchFilters>(() =>
			resolveScope(
				addFilters(held.value, parseSearchQuery(draft.value)),
				(name) => !!findChat(name)
			)
		);
		const fullDraft = computed(() => formatSearchQuery(draftFilters.value));
		const stale = computed(() => fullDraft.value !== formatSearchQuery(filters.value));

		// The network window has no history of its own: it searches everything.
		const scopeDefault = computed(() =>
			channel.value && findChat(channel.value.name) ? channel.value.name : ALL_CHANNELS
		);
		const scope = computed(() => filters.value.in ?? scopeDefault.value);
		const scopeName = (target: string) =>
			target === ALL_CHANNELS ? t("search.window.allChannels") : target;
		const scopeLabel = computed(() => scopeName(scope.value));
		const heldScopeLabel = computed(() =>
			scopeName(resolveScope(held.value, (name) => !!findChat(name)).in ?? scopeDefault.value)
		);

		const suggestions = computed(() => {
			const target = scope.value === ALL_CHANNELS ? channel.value : findChat(scope.value);
			return (target?.users ?? []).slice(0, 6).map((user) => user.nick);
		});

		const chips = computed<Chip[]>(() => {
			const {from, account, after, before, has, without} = held.value;
			const result: Chip[] = [];

			if (from) {
				result.push({id: "from", label: t("search.window.chip.from"), value: from});
			}

			if (account) {
				result.push({
					id: "account",
					label: t("search.window.chip.account"),
					value: account,
				});
			}

			if (after || before) {
				const parts = [
					after &&
						t("search.window.chip.dateFrom", {day: shortDay(dayStart(after) as Date)}),
				];
				// `before:` stops at that day's start, so the last day searched is the one before.
				parts.push(
					before &&
						t("search.window.chip.dateTo", {
							day: shortDay(dayjs(dayStart(before)).subtract(1, "day").toDate()),
						})
				);
				result.push({
					id: "date",
					label: t("search.window.chip.date"),
					value: parts.filter(Boolean).join(t("oper.list.separator")),
				});
			}

			if (has.length) {
				result.push({
					id: "has",
					label: t("search.window.chip.has"),
					value: has.map(hasLabel).join(t("oper.list.separator")),
				});
			}

			if (without.length) {
				result.push({
					id: "without",
					label: t("search.window.chip.without"),
					value: without.join(t("oper.list.separator")),
				});
			}

			return result;
		});

		const visible = computed(() =>
			rows.value.filter((hit) => matchesFilters(hit.msg, filters.value))
		);
		const hiddenCount = computed(() => rows.value.length - visible.value.length);
		const canLoadOlder = computed(() => mode.value === "server" && !reachedEnd.value);
		const loadedCount = computed(() =>
			chats.value.reduce((sum, chat) => sum + chat.messages.length, 0)
		);
		const banner = computed(() => {
			if (!criteria.value) {
				return "";
			}

			if (mode.value === "unsupported") {
				return t("search.window.unsupported");
			}

			if (mode.value === "partial") {
				return t("search.window.scopeEmpty", {scope: scopeLabel.value});
			}

			return mode.value === "offline" ? t("search.window.offline") : "";
		});

		const dayOf = (msg: SharedMsg) => dayLabel(msg.time);
		const timeOf = (msg: SharedMsg) => clockTime(msg.time, store.state.settings);
		// Each hit carries its day too, though the day's header is above it.
		const hitTime = (msg: SharedMsg) => datedTime(msg.time, store.state.settings);

		// How far the server has answered. A loaded row says nothing about that, and
		// paging from one would skip the server's rows between the two.
		const oldestAnswered = () => rows.value.findLast((hit) => !hit.loaded);

		const oldestLabel = computed(() => {
			void locale.value;
			const last = oldestAnswered();
			return last
				? t("search.window.dayAndTime", {
						day: shortDay(last.msg.time),
						time: timeOf(last.msg),
				  })
				: "";
		});

		const groups = computed(() => {
			// The day labels are Intl's, in the interface language.
			void locale.value;
			const result: {label: string; hits: SearchHit[]}[] = [];

			for (const hit of visible.value) {
				const label = `${dayOf(hit.msg)}`;
				const last = result[result.length - 1];

				if (last?.label === label) {
					last.hits.push(hit);
				} else {
					result.push({label, hits: [hit]});
				}
			}

			return result;
		});

		const newestFirst = (a: SearchHit, b: SearchHit) =>
			new Date(b.msg.time).getTime() - new Date(a.msg.time).getTime();

		const loadedHits = (from: ClientChan[]) => {
			const hits: SearchHit[] = [];

			for (const chat of from) {
				for (const msg of chat.messages) {
					// An edit's old text and a deleted line stay out, as in the channel.
					if (
						msg.supersededBy === undefined &&
						!msg.redacted &&
						matchesFilters(msg, filters.value)
					) {
						hits.push({target: chat.name, msg});
					}
				}
			}

			return hits.reverse();
		};

		const searchLoaded = () => {
			rows.value = loadedHits(
				chats.value.filter(
					(chat) => scope.value === ALL_CHANNELS || chat === findChat(scope.value)
				)
			).sort(newestFirst);
		};

		const searchKey = () =>
			`${network.value?.uuid ?? ""} ${formatSearchQuery({
				...filters.value,
				in: scope.value,
			})}`;

		// keepRows: typing on, what is showing stays until the answer replaces it.
		const ask = (keepRows: boolean) => {
			requestId = 0;
			askedFor = searchKey();

			if (!keepRows) {
				rows.value = [];
			}

			hitError.value = "";
			error.value = "";
			olderError.value = "";
			reachedEnd.value = false;
			loadingOlder.value = false;
			mode.value = "server";
			loading.value = false;

			if (!network.value || !criteria.value) {
				return;
			}

			loading.value = true;
			lastAskedAt = Date.now();
			requestId = nextRequestId++;
			socket.emit("search:request", {
				network: network.value.uuid,
				requestId,
				attrs: serverAttrs(filters.value, scopeDefault.value, undefined, PAGE_SIZE),
			});
		};

		const run = () => ask(false);

		const loadOlder = () => {
			const last = oldestAnswered();

			if (!network.value || !last || loadingOlder.value) {
				return;
			}

			loadingOlder.value = true;
			olderError.value = "";
			requestId = nextRequestId++;
			socket.emit("search:request", {
				network: network.value.uuid,
				requestId,
				attrs: serverAttrs(
					filters.value,
					scopeDefault.value,
					new Date(last.msg.time),
					PAGE_SIZE
				),
			});
		};

		const failureText = (status: SearchStatus, text?: string) => {
			if (status === "timeout") {
				return t("search.window.errorTimeout");
			}

			return text ? t("search.window.errorServer", {text}) : t("search.window.errorFailed");
		};

		const onResults = (data: {
			network: string;
			requestId: number;
			status: SearchStatus;
			error?: string;
			hits: SearchHit[];
		}) => {
			if (data.network !== network.value?.uuid || data.requestId !== requestId) {
				return;
			}

			const older = loadingOlder.value;
			loading.value = false;
			loadingOlder.value = false;

			if (data.status === "unsupported" || data.status === "offline") {
				if (older) {
					olderError.value = t("search.window.errorOffline");
					return;
				}

				mode.value = data.status;
				searchLoaded();
				return;
			}

			if (data.status === "invalid") {
				error.value = data.error ?? t("search.window.errorInvalid");
				return;
			}

			if (data.status !== "ok") {
				if (older) {
					olderError.value = failureText(data.status, data.error);
				} else {
					error.value = failureText(data.status, data.error);
				}

				return;
			}

			if (!older) {
				rows.value = [];

				if (list.value) {
					list.value.scrollTop = 0;
				}
			}

			// An empty answer may only be the server's: a scan can run out, a private
			// conversation may not be stored, case folds in ASCII alone. Loaded lines
			// still count.
			if (!older && !data.hits.length) {
				searchLoaded();

				if (rows.value.length) {
					mode.value = "partial";
				}

				return;
			}

			// `before` includes that very moment, so a page repeats its edge.
			const seen = new Set(rows.value.map((hit) => rowKey(hit.msg)));
			const fresh = data.hits.filter((hit) => !seen.has(rowKey(hit.msg)));

			if (older && fresh.length === 0) {
				reachedEnd.value = true;
				return;
			}

			// Oldest first on the wire: reversed, so a stable sort keeps same-moment
			// rows newest first too.
			rows.value = [...rows.value, ...fresh.reverse()].sort(newestFirst);

			// Every channel leaves out private conversations on the server; what is
			// loaded of them still counts, marked as such.
			if (!older && scope.value === ALL_CHANNELS) {
				const known = new Set(rows.value.map((hit) => rowKey(hit.msg)));
				const loaded = loadedHits(chats.value.filter((chat) => chat.type === "query"))
					.filter((hit) => !known.has(rowKey(hit.msg)))
					.map((hit) => ({...hit, loaded: true}));
				rows.value = [...rows.value, ...loaded].sort(newestFirst);
			}
		};

		const remember = (q: string) => {
			if (hasCriteria(parseSearchQuery(q))) {
				recent.value = rememberSearch(q);
			}
		};

		// The chat beside goes to the message; the results stay. A hit in another
		// conversation moves the route there, its scope spelt out so the search is
		// the same one. Over the chat (a phone, a narrow window) the panel tucks
		// away until the magnifier.
		const openHit = (hit: SearchHit) => {
			const chat = findChat(hit.target);

			if (!chat) {
				hitError.value = hit.target.startsWith("#")
					? t("search.window.joinToRead", {target: hit.target})
					: t("search.window.openToRead", {target: hit.target});
				return;
			}

			const twin = hit.msg.msgid
				? undefined
				: chat.messages.find((msg) => msg.id === hit.msg.id);

			setReadHold(chat, true);
			store.commit("jumpTarget", {
				chanId: chat.id,
				...(twin ? {id: twin.id} : {}),
				...(hit.msg.msgid ? {msgid: hit.msg.msgid} : {}),
			});
			remember(query.value);

			// Covering the chat, the panel tucks away once the chat beside is
			// the hit's (RoutedChat would otherwise mark the one it leaves read),
			// and the keyboard goes to the composer rather than to nothing.
			const tuck = () => {
				if (!searchCovers.value) {
					return;
				}

				searchTucked.value = true;

				// The composer's own way in: no keyboard raised on a touch screen,
				// the caret after any draft (ChatInput.vue focusForTyping).
				void nextTick(() => eventbus.emit("input:focus"));
			};

			if (chat !== channel.value) {
				clearTimeout(liveTimer);
				void router
					.replace({
						name: "SearchResults",
						params: {id: chat.id},
						query: {q: formatSearchQuery({...filters.value, in: scope.value})},
					})
					.then(tuck);
			} else {
				tuck();
			}
		};

		// A link or a spoiler in the line does its own thing.
		const clickHit = (event: MouseEvent, hit: SearchHit) => {
			if (
				!(event.target as Element).closest(
					"a, button, .user, .inline-channel, .md-spoiler"
				) &&
				!window.getSelection()?.toString()
			) {
				openHit(hit);
			}
		};

		const closeSearch = () => {
			if (channel.value) {
				switchToChannel(channel.value);
				eventbus.emit("input:focus");
			} else {
				void navigate("Connect");
			}
		};

		const showQuery = (q: string) => {
			const parsed = parseSearchQuery(q);
			held.value = filtersOnly(parsed);
			draft.value = wordsOnly(parsed);
		};

		const setQuery = (q: string) => {
			clearTimeout(liveTimer);
			showQuery(q);

			if (q.trim() === query.value) {
				// The same search again: its answer is already on the way.
				if (!loading.value) {
					run();
				}

				return;
			}

			void router.replace({
				name: "SearchResults",
				params: {id: route.params.id},
				query: {q},
			});
		};

		const submit = () => {
			remember(fullDraft.value);
			setQuery(fullDraft.value);
		};

		const useRecent = (q: string) => {
			remember(q);
			setQuery(q);
		};

		const clearRecent = () => {
			forgetSearches();
			recent.value = [];
			queryField.value?.focus();
		};

		const useHint = (hint: string) => {
			draft.value = draft.value ? `${draft.value.trimEnd()} ${hint}` : hint;
			queryField.value?.focus();
		};

		const applyFilters = (next: SearchFilters) => {
			filtersOpen.value = false;
			setQuery(formatSearchQuery(next));
		};

		const removeChip = (id: Chip["id"]) => {
			const next: SearchFilters = {...draftFilters.value};

			switch (id) {
				case "date":
					delete next.after;
					delete next.before;
					break;
				case "has":
					next.has = [];
					break;
				case "without":
					next.without = [];
					break;
				default:
					delete next[id];
			}

			setQuery(formatSearchQuery(next));
		};

		// Typing searches once it pauses. A search costs the server a scan and about
		// 2 s of fake lag, so one at a time, and never faster than that lag drains.
		const liveReady = computed(() => {
			const target = draftFilters.value.in;

			return (
				readyToSearch(draft.value, draftFilters.value) &&
				(!target || target === ALL_CHANNELS || !!findChat(target))
			);
		});
		const staleNote = computed(() => stale.value && !liveReady.value);

		const searchLive = () => {
			if (!stale.value) {
				return;
			}

			const wait = Math.max(
				lastAskedAt + LIVE_GAP_MS - Date.now(),
				loading.value || loadingOlder.value ? LIVE_RETRY_MS : 0
			);

			if (wait > 0) {
				liveTimer = setTimeout(searchLive, wait);
				return;
			}

			liveRoute = true;
			void router.replace({
				name: "SearchResults",
				params: {id: route.params.id},
				query: {q: fullDraft.value},
			});
		};

		watch(draft, (value) => {
			clearTimeout(liveTimer);
			const finished = takeFinishedFilters(value);

			if (finished) {
				held.value = addFilters(held.value, finished.filters);
				draft.value = finished.text; // here again, with the rest
			} else if (hasCriteria(filters.value) && !hasCriteria(draftFilters.value)) {
				setQuery(fullDraft.value);
			} else if (liveReady.value) {
				liveTimer = setTimeout(searchLive, LIVE_DELAY_MS);
			}
		});

		// Asked before the network was up (a reload on a search): ask again once it
		// is, rather than leave the loaded lines, few or none, standing in for it.
		watch(
			() => network.value?.status.connected,
			(connected) => {
				if (connected && mode.value === "offline" && criteria.value && !loading.value) {
					run();
				}
			}
		);

		const searchEverywhere = () => {
			setQuery(formatSearchQuery({...draftFilters.value, in: ALL_CHANNELS}));
		};

		const textBoxes = () =>
			document.querySelectorAll<HTMLElement>(
				".chat-view[data-type='search-results'] .search-text"
			);

		// A line cut to its box shows its first match, on whole lines.
		const showMatch = (box: HTMLElement, words: string[]) => {
			box.scrollTop = 0;

			if (box.scrollHeight <= box.clientHeight) {
				delete box.dataset.cut;
				return;
			}

			const match = rangesIn([box], (text) => matchSpans(text, words))[0];
			const lineHeight = box.clientHeight / 4;
			const below = match
				? match.getBoundingClientRect().bottom - box.getBoundingClientRect().top
				: 0;

			if (below > box.clientHeight) {
				box.scrollTop = Math.ceil((below - box.clientHeight) / lineHeight) * lineHeight;
			}

			const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 1;
			box.dataset.cut = box.scrollTop === 0 ? "end" : atEnd ? "start" : "both";
		};

		const showMatches = () => {
			textBoxes().forEach((box) => showMatch(box, filters.value.words));
		};

		const paintMatches = () => {
			const words = filters.value.words;

			paintHighlight(
				"search-hit",
				rangesIn(textBoxes(), (text) => matchSpans(text, words))
			);
			showMatches();
		};

		watch(visible, paintMatches, {flush: "post"});

		watch(
			() => [route.params.id, route.query.q],
			() => {
				// What the field holds by now is newer than the search this was for.
				if (liveRoute) {
					liveRoute = false;
					ask(true);
					return;
				}

				showQuery(String(route.query.q ?? ""));

				// Only the chat beside changed (a hit elsewhere): the results stand.
				if (searchKey() !== askedFor || !criteria.value) {
					run();
				}
			}
		);

		// Only with no overlay up: Escape over a context menu closes the menu.
		// Tucked away, Escape is the chat's (ChatInput.vue leaves the older
		// lines a hit opened); the magnifier brings search back first.
		const onEscape = (layer: string | null) => {
			if (layer === null && !searchTucked.value) {
				closeSearch();
			}
		};

		onMounted(() => {
			socket.on("search:results", onResults);
			eventbus.on("escapekey", onEscape);
			window.addEventListener("resize", showMatches);
			run();

			if (!query.value) {
				queryField.value?.focus();
			}
		});

		onUnmounted(() => {
			socket.off("search:results", onResults);
			eventbus.off("escapekey", onEscape);
			window.removeEventListener("resize", showMatches);
			clearTimeout(liveTimer);
			clearHighlight("search-hit");
		});

		return {
			t,
			tCount,
			KEEP,
			ALL_CHANNELS,
			HINTS,
			applyFilters,
			asClient: (msg: SharedMsg) => msg as ClientMessage,
			banner,
			canLoadOlder,
			channel,
			chips,
			closeSearch,
			draftFilters,
			stale,
			staleNote,
			heldScopeLabel,
			conversations,
			criteria,
			draft,
			error,
			filters,
			filtersOpen,
			groups,
			hiddenCount,
			loadOlder,
			loadedCount,
			loading,
			loadingOlder,
			mode,
			network,
			oldestLabel,
			olderError,
			clickHit,
			clearRecent,
			hitError,
			phone,
			panel,
			probe,
			coverBox,
			dragRegion: macDragRegion(),
			recent,
			searchTucked,
			useRecent,
			list,
			openHit,
			queryField,
			removeChip,
			rows,
			run,
			scopeDefault,
			scopeLabel,
			searchEverywhere,
			store,
			submit,
			suggestions,
			timeOf,
			hitTime,
			useHint,
			visible,
		};
	},
});
</script>
