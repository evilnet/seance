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
				:aria-label="t('search.results.aria')"
				role="tabpanel"
			>
				<template v-if="network && channel">
					<div class="search-head" :inert="filtersOpen">
						<button
							class="oper-icon-btn search-icon search-icon-back"
							:aria-label="t('search.window.back', {channel: channel.name})"
							:title="t('search.window.back', {channel: channel.name})"
							@click="closeSearch"
						/>
						<form class="search-query" role="search" @submit.prevent="submit">
							<span class="search-icon search-icon-find" aria-hidden="true" />
							<input
								ref="queryField"
								v-model="draft"
								type="search"
								name="search"
								autocapitalize="off"
								autocomplete="off"
								enterkeyhint="search"
								:aria-label="t('search.window.field')"
								:placeholder="t('search.window.placeholder', {scope: scopeLabel})"
							/>
							<button
								type="submit"
								class="oper-btn"
								:class="stale ? 'oper-btn-primary' : 'oper-btn-secondary'"
							>
								{{ t("search.window.submit") }}
							</button>
						</form>
					</div>

					<div class="search-chips" :inert="filtersOpen">
						<button class="search-chip on" @click="filtersOpen = true">
							<span class="search-icon search-icon-in" aria-hidden="true" />
							{{ inParts[0] }}<b>{{ scopeLabel }}</b
							>{{ inParts[1] }}
						</button>
						<span
							v-for="chip in chips"
							:key="chip.id"
							class="search-chip on"
							data-filter
						>
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

					<p v-if="stale && criteria" class="search-stale" role="status">
						{{ t("search.window.stale") }}
					</p>

					<div class="search-panes" :class="{'has-context': selected}">
						<div
							class="search-list"
							:class="{stale: stale && criteria}"
							:inert="filtersOpen || (isPhone && selected !== null)"
						>
							<div v-if="!criteria" class="search-start">
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

							<div v-else-if="loading" class="search-center" role="status">
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
										:class="{sel: selected === hit}"
										role="button"
										tabindex="0"
										@click="openHit(hit)"
										@keydown.enter.self="openHit(hit)"
										@keydown.space.self.prevent="openHit(hit)"
									>
										<span class="search-time">{{ timeOf(hit.msg) }}</span>
										<div class="search-line">
											<div class="search-meta">
												<Username
													v-if="hit.msg.from"
													:user="hit.msg.from"
													:network="network"
													@click.stop
												/>
												<span class="search-chan">{{ hit.target }}</span>
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

						<div
							v-if="selected"
							id="search-context-overlay"
							v-backdrop="closeContext"
							class="screen-overlay"
							data-escape-close="search-context"
						>
							<aside
								ref="contextPane"
								class="search-context"
								tabindex="-1"
								:aria-label="t('search.window.contextAria')"
								:role="isPhone ? 'dialog' : undefined"
								:aria-modal="isPhone ? 'true' : undefined"
								@keydown.tab="onContextTab"
							>
								<div class="search-context-head">
									<div>
										<b>{{ selected.target }}</b>
										<small>{{
											t("search.window.around", {
												day: dayOf(selected.msg),
												time: timeOf(selected.msg),
											})
										}}</small>
									</div>
									<button
										class="oper-icon-btn search-icon search-icon-remove"
										:aria-label="t('search.window.closeContext')"
										:title="t('search.window.closeContext')"
										@click="closeContext"
									/>
								</div>
								<div ref="contextList" class="search-context-lines">
									<p v-if="contextNote" class="search-dim search-context-note">
										{{ contextNote }}
									</p>
									<p
										v-if="contextLoading"
										class="search-dim search-context-note"
										role="status"
									>
										{{ t("search.window.contextLoading") }}
									</p>
									<div
										v-for="msg in contextShown"
										:key="msg.id"
										class="search-context-line"
										:class="{hit: isSelected(msg)}"
										@click="openFromLine($event, msg)"
									>
										<span class="search-time">{{ timeOf(msg) }}</span>
										<Username
											v-if="msg.from"
											:user="msg.from"
											:network="network"
										/>
										<span class="search-text">
											<ParsedMessage
												:network="network"
												:message="asClient(msg)"
											/>
										</span>
									</div>
								</div>
								<div class="search-context-foot">
									<template v-if="contextLive">
										<button
											class="oper-btn oper-btn-ghost"
											:disabled="contextLoading || !canEarlier"
											@click="contextPage('BEFORE')"
										>
											{{ t("search.window.earlier") }}
										</button>
										<button
											class="oper-btn oper-btn-ghost"
											:disabled="contextLoading || !canLater"
											@click="contextPage('AFTER')"
										>
											{{ t("search.window.later") }}
										</button>
									</template>
									<span class="search-spacer" />
									<button
										v-if="selectedChannel"
										class="oper-btn oper-btn-primary"
										@click="openInChannel"
									>
										{{
											selectedLoaded
												? t("search.window.openInChannel")
												: t("search.window.goTo", {
														channel: selected.target,
												  })
										}}
									</button>
								</div>
							</aside>
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
		</div>
	</div>
</template>

<style>
.chat-view[data-type="search-results"] {
	display: flex;
	flex-direction: column;
	min-height: 0;
}

.search-icon::before {
	font: normal normal normal 1em/1 FontAwesome;
}

.search-icon-back::before {
	content: "\f053";
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
	margin-right: -0.5rem;
}

.search-chip:focus-visible,
.search-chip-open:focus-visible,
.search-chip-remove:focus-visible,
.search-hit:focus-visible {
	outline: 0.125rem solid var(--oper-amber);
	outline-offset: -0.125rem;
}

.search-context:focus {
	outline: none;
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

.search-panes.has-context {
	grid-template-columns: minmax(0, 1fr) minmax(0, 24rem);
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
	display: grid;
	grid-template-columns: 4rem minmax(0, 1fr);
	gap: 0.5rem;
	padding: 0.5rem 0.75rem;
	cursor: pointer;
}

.search-hit:hover,
.search-hit:focus-visible {
	background: var(--oper-panel);
}

.search-hit.sel,
.search-context-line.hit {
	cursor: pointer;
	background: var(--highlight-bg-color);
	box-shadow: inset 0.125rem 0 0 var(--highlight-border-color);
}

.search-time {
	color: var(--body-color-muted);
	font-size: 0.8125rem;
	font-variant-numeric: tabular-nums;
	white-space: nowrap;
}

.search-meta {
	display: flex;
	align-items: baseline;
	gap: 0.5rem;
	min-width: 0;
}

.search-chan,
.search-dim {
	color: var(--body-color-muted);
	font-size: 0.8125rem;
}

.search-text {
	overflow-wrap: anywhere;
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

#search-context-overlay {
	display: flex;
	min-width: 0;
	min-height: 0;
	border-left: 1px solid var(--oper-line);
}

.search-context {
	flex: 1;
	display: flex;
	flex-direction: column;
	min-width: 0;
	min-height: 0;
	background: var(--oper-panel);
}

.search-context-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 0.5rem;
	padding: 0.5rem 0.5rem 0.5rem 1rem;
	border-bottom: 1px solid var(--oper-line);
}

.search-context-head small {
	display: block;
	color: var(--body-color-muted);
	font-size: 0.75rem;
}

.search-context-lines {
	flex: 1;
	min-height: 0;
	overflow-y: auto;
	overscroll-behavior: contain;
	padding: 0.5rem 0;
}

.search-context-note {
	margin: 0;
	padding: 0.375rem 1rem;
}

.search-context-line {
	padding: 0.375rem 1rem;
	overflow-wrap: anywhere;
}

.search-context-line .search-time,
.search-context-line .user {
	margin-right: 0.375rem;
}

.search-context-foot {
	display: flex;
	align-items: center;
	gap: 0.25rem;
	padding: 0.5rem 0.75rem calc(0.5rem + var(--inset-inner-bottom, 0px));
	border-top: 1px solid var(--oper-line);
	background: var(--oper-sunk);
}

@media (max-width: 768px), (max-height: 500px) and (hover: none) and (pointer: coarse) {
	.search-chips {
		flex-wrap: nowrap;
		overflow-x: auto;
		scrollbar-width: none;
	}

	.search-panes.has-context {
		grid-template-columns: minmax(0, 1fr);
	}

	#search-context-overlay {
		position: fixed;
		inset: 0;
		z-index: 110;
		align-items: flex-end;
		padding-top: 2rem;
		border: 0;
		background: var(--overlay-bg-color);
	}

	.search-context {
		max-height: 75%;
		border-top: 1px solid var(--oper-line-2);
		border-radius: 1.25rem 1.25rem 0 0;
		background: var(--window-bg-color);
		overflow: hidden;
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
import {
	ALL_CHANNELS,
	dayStart,
	formatSearchQuery,
	hasCriteria,
	matchesFilters,
	matchSpans,
	parseSearchQuery,
	rowKey,
	SEARCHABLE_MESSAGE_TYPES,
	serverAttrs,
	type SearchFilters,
} from "../../js/searchQuery";
import {clockTime, dayLabel, shortDay} from "../../js/helpers/messageTime";
import {clearHighlight, paintHighlight, rangesIn} from "../../js/helpers/paintHighlight";
import {trapTab} from "../../js/helpers/trapTab";
import {useStore} from "../../js/store";
import {useI18n} from "../../js/i18n";
import {frameSegments, KEEP} from "../../js/i18n/core";
import {hasLabel} from "../../js/helpers/searchLabels";
import type {ClientChan, ClientMessage} from "../../js/types";
import type {SharedMsg} from "../../../shared/types/msg";
import type {SearchContextDirection, SearchHit, SearchStatus} from "../../../shared/types/search";
import {PHONE_LAYOUT_QUERY} from "../../js/helpers/device";
import ParsedMessage from "../ParsedMessage.vue";
import SearchFilterSheet from "../SearchFilterSheet.vue";
import Username from "../Username.vue";

const PAGE_SIZE = 100;
const CONTEXT_SIZE = 21;
/** Long enough that hits clicked through quickly ask only for the last. */
const CONTEXT_DELAY_MS = 250;
const CONTEXT_PAGE = 20;
const HINTS = ["from:nick", "in:#channel", "has:link", "-word", "after:2026-10-01"];

let nextRequestId = 1;

/** Where the rows come from: the server, or what is loaded and why. */
type Mode = "server" | "unsupported" | "offline";

interface Chip {
	id: "from" | "account" | "date" | "has" | "without";
	label: string;
	value: string;
}

export default defineComponent({
	name: "SearchResults",
	components: {ParsedMessage, SearchFilterSheet, Username},
	setup() {
		const store = useStore();
		const route = useRoute();
		const router = useRouter();
		const {t, tCount, locale} = useI18n();
		// The scope chip's "In {scope}", the scope bold inside the sentence.
		const inParts = computed(() =>
			frameSegments(t("search.window.inScope", {scope: KEEP}), ["scope"])
		);

		const queryField = ref<HTMLInputElement>();
		const contextList = ref<HTMLElement>();

		const draft = ref(String(route.query.q ?? ""));
		const filtersOpen = ref(false);
		const contextPane = ref<HTMLElement>();
		const layout = window.matchMedia(PHONE_LAYOUT_QUERY);
		const isPhone = ref(layout.matches);
		const onLayout = () => {
			isPhone.value = layout.matches;
		};
		let contextOpener: HTMLElement | null = null;

		const rows = ref<SearchHit[]>([]);
		const mode = ref<Mode>("server");
		const loading = ref(false);
		const loadingOlder = ref(false);
		const reachedEnd = ref(false);
		const error = ref("");
		const olderError = ref("");
		let requestId = 0;

		const selected = ref<SearchHit | null>(null);
		const contextRows = ref<SharedMsg[]>([]);
		const contextLoading = ref(false);
		let contextTimer: ReturnType<typeof setTimeout> | undefined;
		const contextLive = ref(false);
		const contextNote = ref("");
		const canEarlier = ref(true);
		const canLater = ref(true);
		let contextRequest = 0;
		let contextDirection: SearchContextDirection = "AROUND";

		const query = computed(() => String(route.query.q ?? "").trim());
		const filters = computed<SearchFilters>(() => parseSearchQuery(query.value));
		const criteria = computed(() => hasCriteria(filters.value));
		const stale = computed(() => draft.value.trim() !== query.value);
		// A filter changed while the field is edited keeps the edit: the field is
		// what the next search will be, whatever the results below came from.
		const draftFilters = computed<SearchFilters>(() => parseSearchQuery(draft.value));

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

		// The network window has no history of its own: it searches everything.
		const scopeDefault = computed(() =>
			channel.value && findChat(channel.value.name) ? channel.value.name : ALL_CHANNELS
		);
		const scope = computed(() => filters.value.in ?? scopeDefault.value);
		const scopeLabel = computed(() =>
			scope.value === ALL_CHANNELS ? t("search.window.allChannels") : scope.value
		);

		const suggestions = computed(() => {
			const target = scope.value === ALL_CHANNELS ? channel.value : findChat(scope.value);
			return (target?.users ?? []).slice(0, 6).map((user) => user.nick);
		});

		const chips = computed<Chip[]>(() => {
			const {from, account, after, before, has, without} = filters.value;
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

			return mode.value === "offline" ? t("search.window.offline") : "";
		});

		const dayOf = (msg: SharedMsg) => dayLabel(msg.time);
		const timeOf = (msg: SharedMsg) => clockTime(msg.time, store.state.settings);

		const oldestLabel = computed(() => {
			void locale.value;
			const last = rows.value[rows.value.length - 1];
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

		// AROUND brings the channel's joins and parts too (event-playback): kept
		// as paging edges, but this pane reads the conversation.
		const contextShown = computed(() =>
			contextRows.value.filter((msg) => SEARCHABLE_MESSAGE_TYPES.has(msg.type))
		);

		const resetContext = () => {
			clearTimeout(contextTimer);
			contextRequest = 0;
			selected.value = null;
			contextRows.value = [];
			contextLoading.value = false;
		};

		const closeContext = async () => {
			const opener = contextOpener;

			contextOpener = null;
			resetContext();

			// After the render: on a phone the list is inert until the sheet is gone.
			await nextTick();

			if (opener?.isConnected) {
				opener.focus({preventScroll: true});
			}
		};

		const onContextTab = (event: KeyboardEvent) => {
			if (isPhone.value && contextPane.value) {
				trapTab(event, contextPane.value);
			}
		};

		const searchLoaded = () => {
			const hits: SearchHit[] = [];

			for (const chat of chats.value) {
				if (scope.value !== ALL_CHANNELS && chat !== findChat(scope.value)) {
					continue;
				}

				for (const msg of chat.messages) {
					if (matchesFilters(msg, filters.value)) {
						hits.push({target: chat.name, msg});
					}
				}
			}

			rows.value = hits.reverse().sort(newestFirst);
		};

		const run = () => {
			contextOpener = null;
			resetContext();
			requestId = 0;
			rows.value = [];
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
			requestId = nextRequestId++;
			socket.emit("search:request", {
				network: network.value.uuid,
				requestId,
				attrs: serverAttrs(filters.value, scopeDefault.value, undefined, PAGE_SIZE),
			});
		};

		const loadOlder = () => {
			const last = rows.value[rows.value.length - 1];

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
		};

		const isSelected = (msg: SharedMsg) => {
			const hit = selected.value?.msg;

			if (!hit) {
				return false;
			}

			return hit.msgid ? hit.msgid === msg.msgid : hit.id === msg.id;
		};

		const showHitInContext = async () => {
			await nextTick();
			contextList.value?.querySelector(".search-context-line.hit")?.scrollIntoView({
				block: "center",
			});
		};

		const openHit = (hit: SearchHit) => {
			if (selected.value === hit && contextLoading.value) {
				return; // already on its way
			}

			clearTimeout(contextTimer);

			if (!selected.value) {
				contextOpener = document.activeElement as HTMLElement | null;
			}

			selected.value = hit;
			void nextTick(() => contextPane.value?.focus({preventScroll: true}));
			contextRows.value = [hit.msg];
			contextNote.value = "";
			canEarlier.value = true;
			canLater.value = true;
			contextRequest = 0;

			const chat = findChat(hit.target);

			// Nothing to ask for: the neighbours are the ones already loaded.
			if (mode.value !== "server" || !hit.msg.msgid) {
				contextLive.value = false;
				contextLoading.value = false;

				if (chat) {
					const index = chat.messages.findIndex((msg) => msg.id === hit.msg.id);

					if (index >= 0) {
						contextRows.value = chat.messages.slice(
							Math.max(0, index - 10),
							index + 11
						);
					}
				}

				void showHitInContext();
				return;
			}

			contextLive.value = true;
			contextLoading.value = true;
			contextDirection = "AROUND";

			// Every command costs fake lag, and one answered for a hit already
			// left behind is only a delay for what the user types next.
			const uuid = network.value!.uuid;
			const msgid = hit.msg.msgid;

			contextTimer = setTimeout(() => {
				contextRequest = nextRequestId++;
				socket.emit("search:context", {
					network: uuid,
					requestId: contextRequest,
					target: hit.target,
					direction: "AROUND",
					msgid,
					limit: CONTEXT_SIZE,
				});
			}, CONTEXT_DELAY_MS);
		};

		const contextPage = (direction: "BEFORE" | "AFTER") => {
			const edge =
				direction === "BEFORE"
					? contextRows.value[0]
					: contextRows.value[contextRows.value.length - 1];

			if (!selected.value || !edge?.msgid || contextLoading.value) {
				return;
			}

			contextLoading.value = true;
			contextDirection = direction;
			contextRequest = nextRequestId++;
			socket.emit("search:context", {
				network: network.value!.uuid,
				requestId: contextRequest,
				target: selected.value.target,
				direction,
				msgid: edge.msgid,
				limit: CONTEXT_PAGE,
			});
		};

		const onContext = (data: {
			network: string;
			requestId: number;
			status: SearchStatus;
			error?: string;
			messages: SharedMsg[];
		}) => {
			if (data.network !== network.value?.uuid || data.requestId !== contextRequest) {
				return;
			}

			contextLoading.value = false;

			if (data.status !== "ok") {
				contextNote.value = t("search.window.contextFailed");

				if (contextDirection === "AROUND") {
					contextLive.value = false;
				}

				return;
			}

			const seen = new Set(contextRows.value.map((msg) => msg.msgid));
			const fresh = data.messages.filter((msg) => !seen.has(msg.msgid));

			if (contextDirection === "BEFORE") {
				canEarlier.value = fresh.length > 0;
				contextRows.value = [...fresh, ...contextRows.value];
			} else if (contextDirection === "AFTER") {
				canLater.value = fresh.length > 0;
				contextRows.value = [...contextRows.value, ...fresh];
			} else {
				// The answer holds the hit itself, unless the server's window does not.
				contextRows.value = data.messages.some(isSelected)
					? data.messages
					: [selected.value!.msg];
				void showHitInContext();
			}
		};

		const selectedChannel = computed(() =>
			selected.value ? findChat(selected.value.target) : undefined
		);
		const loadedTwin = computed(() => {
			const hit = selected.value?.msg;

			if (!hit || !selectedChannel.value) {
				return undefined;
			}

			return selectedChannel.value.messages.find((msg) =>
				hit.msgid ? msg.msgid === hit.msgid : msg.id === hit.id
			);
		});
		const selectedLoaded = computed(() => loadedTwin.value !== undefined);

		const openInChannel = () => {
			const chat = selectedChannel.value;
			const twin = loadedTwin.value;

			if (!chat) {
				return;
			}

			const hit = selected.value?.msg;

			// Not loaded: pages back for it, and if it is too far, the channel
			// opens as usual rather than at some other line.
			if (twin) {
				store.commit("jumpTarget", {chanId: chat.id, id: twin.id});
			} else if (hit) {
				store.commit("jumpTarget", {
					chanId: chat.id,
					...(hit.msgid ? {msgid: hit.msgid} : {}),
					time: new Date(hit.time).toISOString(),
					exact: true,
				});
			}

			switchToChannel(chat);
		};

		// The hit's line is the button's other half; a link, a nick or a spoiler in it is its own.
		const openFromLine = (event: MouseEvent, msg: SharedMsg) => {
			const target = event.target as HTMLElement | null;

			if (
				isSelected(msg) &&
				!target?.closest("a, button, [role='button'], .user, .inline-channel") &&
				!window.getSelection()?.toString()
			) {
				openInChannel();
			}
		};

		const closeSearch = () => {
			if (channel.value) {
				switchToChannel(channel.value);
			} else {
				void navigate("Connect");
			}
		};

		const setQuery = (q: string) => {
			draft.value = q;

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

		const submit = () => setQuery(draft.value.trim());

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

		const searchEverywhere = () => {
			setQuery(formatSearchQuery({...draftFilters.value, in: ALL_CHANNELS}));
		};

		const paintMatches = () => {
			const words = filters.value.words;

			paintHighlight(
				"search-hit",
				rangesIn(
					document.querySelectorAll(
						".chat-view[data-type='search-results'] .search-text"
					),
					(text) => matchSpans(text, words)
				)
			);
		};

		watch([visible, contextRows], paintMatches, {flush: "post"});

		watch(
			() => [route.params.id, route.query.q],
			() => {
				draft.value = String(route.query.q ?? "");

				if (found.value) {
					store.commit("activeChannel", found.value);
				}

				run();
			}
		);

		// Only with no overlay up: Escape over a context menu closes the menu.
		const onEscape = (layer: string | null) => {
			if (layer === "search-context") {
				void closeContext();
			} else if (layer === null) {
				closeSearch();
			}
		};

		onMounted(() => {
			if (found.value) {
				store.commit("activeChannel", found.value);
			}

			layout.addEventListener("change", onLayout);
			socket.on("search:results", onResults);
			socket.on("search:context", onContext);
			eventbus.on("escapekey", onEscape);
			run();

			if (!query.value) {
				queryField.value?.focus();
			}
		});

		onUnmounted(() => {
			clearTimeout(contextTimer);
			layout.removeEventListener("change", onLayout);
			socket.off("search:results", onResults);
			socket.off("search:context", onContext);
			eventbus.off("escapekey", onEscape);
			clearHighlight("search-hit");
		});

		return {
			t,
			tCount,
			inParts,
			ALL_CHANNELS,
			HINTS,
			applyFilters,
			asClient: (msg: SharedMsg) => msg as ClientMessage,
			banner,
			canEarlier,
			canLater,
			canLoadOlder,
			channel,
			chips,
			closeContext,
			closeSearch,
			contextList,
			contextPane,
			isPhone,
			onContextTab,
			draftFilters,
			stale,
			contextLive,
			contextLoading,
			contextNote,
			contextPage,
			contextShown,
			conversations,
			criteria,
			dayOf,
			draft,
			error,
			filters,
			filtersOpen,
			groups,
			hiddenCount,
			isSelected,
			loadOlder,
			loadedCount,
			loading,
			loadingOlder,
			mode,
			network,
			oldestLabel,
			olderError,
			openHit,
			openInChannel,
			queryField,
			removeChip,
			rows,
			run,
			scopeDefault,
			scopeLabel,
			searchEverywhere,
			selected,
			selectedChannel,
			selectedLoaded,
			openFromLine,
			store,
			submit,
			suggestions,
			timeOf,
			useHint,
			visible,
		};
	},
});
</script>
