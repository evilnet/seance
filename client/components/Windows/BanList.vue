<template>
	<div
		id="ban-browser"
		class="window browse-window"
		role="region"
		:aria-label="t('bans.aria', {channel})"
	>
		<div class="browse-head">
			<SidebarToggle />
			<div class="browse-title">
				<h1>{{ t("bans.title") }}</h1>
				<span class="browse-network"
					><bdi>{{ channel }}</bdi></span
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
			<form class="browse-query" role="search" @submit.prevent>
				<span class="browse-icon browse-icon-find" aria-hidden="true" />
				<input
					ref="queryField"
					v-model="query"
					class="mousetrap"
					type="search"
					name="bans"
					autocapitalize="off"
					autocomplete="off"
					spellcheck="false"
					enterkeyhint="search"
					:aria-label="t('bans.search')"
					:placeholder="t('bans.searchPlaceholder')"
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
				:disabled="!connected"
				:title="t('browse.refresh')"
				@click="ask"
			>
				<span
					class="browse-icon browse-icon-refresh"
					:class="{spinning: list.status === 'loading'}"
					aria-hidden="true"
				/>
				<span class="browse-refresh-label">{{ t("browse.refresh") }}</span>
			</button>
			<button
				v-if="canEdit"
				class="oper-btn oper-btn-primary ban-add"
				type="button"
				@click="add"
			>
				{{ t("bans.add") }}
			</button>
		</div>

		<div class="browse-chips" role="group" :aria-label="t('bans.filters')">
			<button
				v-for="f in filters"
				:key="f"
				type="button"
				class="browse-chip"
				:class="{on: filter === f}"
				:aria-pressed="filter === f"
				@click="filter = f"
			>
				{{ filterLabel(f) }}
				<span class="browse-chip-count">{{ counts[f] }}</span>
			</button>
			<span class="browse-spacer" />
			<label class="browse-sort">
				<span class="sr-only">{{ t("browse.sort") }}</span>
				<select v-model="sort">
					<option value="newest">{{ t("bans.sort.newest") }}</option>
					<option value="oldest">{{ t("bans.sort.oldest") }}</option>
					<option value="mask">{{ t("bans.sort.mask") }}</option>
					<option value="setter">{{ t("bans.sort.setter") }}</option>
				</select>
			</label>
		</div>

		<div class="browse-body">
			<div v-if="!network" class="browse-center" role="status">
				<b>{{ t("browse.noNetwork") }}</b>
			</div>
			<div v-else-if="!connected" class="browse-center" role="status">
				<b>{{ t("browse.offline") }}</b>
				<p>{{ t("bans.offlineNote") }}</p>
			</div>
			<div v-else-if="list.status === 'error'" class="browse-center" role="alert">
				<b>{{ t("bans.refused") }}</b>
				<pre class="browse-note">{{ list.note }}</pre>
				<button class="oper-btn oper-btn-secondary" type="button" @click="ask">
					{{ t("browse.retry") }}
				</button>
			</div>

			<section v-else class="browse-all" :aria-label="t('bans.title')">
				<div class="browse-section-head">
					<h2>{{ tCount("bans.count", shownRows.length) }}</h2>
					<span v-if="list.status === 'loading'" class="browse-dim" role="status">
						{{ t("bans.loading") }}
					</span>
					<span v-else-if="list.at" class="browse-dim">
						<template v-if="list.limit">
							<span :class="{'ban-limit-near': nearLimit}">{{
								t("bans.limit", {used: list.rows.length, limit: list.limit})
							}}</span>
							<span class="browse-dot" aria-hidden="true">·</span>
						</template>
						<span>{{ t("browse.updated", {when: updatedLabel}) }}</span>
					</span>
					<span class="browse-spacer" />
					<button
						v-if="canEdit && shownRows.length > 1"
						type="button"
						class="ban-unban-all"
						@click="unbanShown"
					>
						{{ tCount("bans.unbanAll", shownRows.length) }}
					</button>
				</div>

				<p v-if="!canEdit && network && list.rows.length" class="ban-read-only">
					{{ t("bans.readOnly") }}
				</p>

				<div
					v-if="list.status === 'loading' && !list.rows.length"
					class="browse-skeleton"
					aria-hidden="true"
				>
					<div v-for="n in 4" :key="n" class="browse-skeleton-row">
						<span class="browse-skeleton-name" />
						<span class="browse-skeleton-topic" />
					</div>
				</div>

				<div v-else-if="!shownRows.length" class="browse-center" role="status">
					<b v-if="query">{{ t("bans.noMatches", {query}) }}</b>
					<b v-else-if="list.rows.length">{{ t("bans.noneHere") }}</b>
					<template v-else>
						<b>{{ t("bans.empty", {channel}) }}</b>
						<button
							v-if="canEdit"
							class="oper-btn oper-btn-secondary"
							type="button"
							@click="add"
						>
							{{ t("bans.add") }}
						</button>
					</template>
				</div>

				<ul v-else class="browse-rows ban-rows">
					<li
						v-for="row in shownRows"
						:key="row.mask"
						class="ban-row"
						:class="{pending: pending.has(row.mask)}"
						@contextmenu.prevent="openRowMenu($event, row)"
					>
						<component
							:is="canEdit ? 'button' : 'div'"
							class="ban-row-main"
							:type="canEdit ? 'button' : undefined"
							:title="fullTime(row)"
							@click="canEdit && edit(row)"
						>
							<span class="ban-row-mask">
								<bdi dir="ltr">{{ row.mask }}</bdi>
								<span v-if="labelOf(row)" class="browse-tag ban-tag">{{
									labelOf(row)
								}}</span>
							</span>
							<span class="ban-row-meta">{{ setText(row) }}</span>
						</component>
						<button
							v-if="canEdit"
							type="button"
							class="oper-btn oper-btn-secondary ban-row-unban"
							:disabled="pending.has(row.mask)"
							:aria-label="t('bans.unbanMask', {mask: row.mask})"
							@click="unban([row])"
						>
							{{ t("bans.unban") }}
						</button>
					</li>
				</ul>
			</section>
		</div>

		<div v-if="notice" class="ban-notice" role="status">
			<span class="ban-notice-text">{{ notice.text }}</span>
			<button
				v-if="notice.undo"
				type="button"
				class="ban-notice-undo"
				@click="undo(notice.undo)"
			>
				{{ t("bans.undo") }}
			</button>
		</div>
	</div>
</template>

<style>
#ban-browser {
	display: flex;
	flex-direction: column;
	overflow: hidden;
}

#ban-browser .browse-section-head {
	align-items: center;
}

.browse-section-head .browse-spacer {
	min-width: 0.5rem;
}

.ban-add {
	flex: none;
	height: 2.5rem;
}

.ban-unban-all {
	padding: 0.25rem 0;
	border: 0;
	background: none;
	color: var(--oper-red);
	font: inherit;
	font-size: 0.8125rem;
	font-weight: 500;
	cursor: pointer;
}

.ban-unban-all:hover,
.ban-unban-all:focus-visible {
	text-decoration: underline;
}

.ban-limit-near {
	color: var(--oper-amber);
}

.ban-read-only {
	margin: 0 0.75rem 0.5rem;
	color: var(--body-color-muted);
	font-size: 0.8125rem;
}

.ban-row {
	display: flex;
	align-items: center;
	gap: 0.5rem;
	padding-inline-end: 0.5rem;
	border-radius: 0.5rem;
}

.ban-row:hover,
.ban-row:focus-within {
	background: var(--oper-panel);
}

.ban-row.pending {
	opacity: 0.5;
}

.ban-row-main {
	flex: 1;
	display: grid;
	gap: 0.125rem;
	min-width: 0;
	padding: 0.625rem 0.5rem;
	border: 0;
	border-radius: 0.5rem;
	background: transparent;
	color: var(--body-color);
	font: inherit;
	text-align: start;
}

button.ban-row-main {
	cursor: pointer;
}

button.ban-row-main:focus-visible {
	outline: 0.125rem solid var(--oper-amber);
	outline-offset: -0.125rem;
}

.ban-row-mask {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	gap: 0 0.5rem;
	min-width: 0;
	font-size: 0.9375rem;
	overflow-wrap: anywhere;
}

.ban-row-mask bdi {
	min-width: 0;
	font-family: monospace;
}

.ban-row-meta {
	color: var(--body-color-muted);
	font-size: 0.8125rem;
	overflow-wrap: anywhere;
}

.ban-row-unban {
	flex: none;
	height: 2rem;
}

.ban-notice {
	display: flex;
	align-items: center;
	gap: 0.75rem;
	flex: none;
	padding: 0.625rem 0.75rem calc(0.625rem + var(--inset-inner-bottom, 0px));
	border-top: 1px solid var(--oper-line);
	background: var(--oper-sunk);
	font-size: 0.875rem;
}

.ban-notice-text {
	flex: 1;
	min-width: 0;
	overflow-wrap: anywhere;
}

.ban-notice-undo {
	flex: none;
	padding: 0.25rem 0;
	border: 0;
	background: none;
	color: var(--link-color);
	font: inherit;
	font-weight: 600;
	cursor: pointer;
}

@container (max-width: 30rem) {
	.ban-row-unban {
		padding: 0 0.6rem;
	}
}
</style>

<script lang="ts">
import {computed, defineComponent, onMounted, onUnmounted, ref, watch} from "vue";
import {useRoute} from "vue-router";

import eventbus from "../../js/eventbus";
import {banSetText, canSetBans, changeChannelBans, openBanDialog} from "../../js/helpers/banMenu";
import {
	banAnswersQuery,
	banSetter,
	type BanSort,
	isExtendedBan,
	sortBans,
} from "../../js/helpers/channelBans";
import type {ContextMenuItem} from "../../js/helpers/contextMenu";
import {useI18n} from "../../js/i18n";
import {formatDateTime, formatRelativeTime} from "../../js/i18n/dates";
import {BANS_STALE_AFTER_MS} from "../../js/irc/banList";
import {clientForNetwork} from "../../js/irc/manager";
import {leavePage} from "../../js/router";
import socket from "../../js/socket";
import {banListKey, useStore} from "../../js/store";
import {ChanType} from "../../../shared/types/chan";
import type {BanEntry, SharedBanList} from "../../../shared/types/ban-list";
import SidebarToggle from "../SidebarToggle.vue";

type Filter = "all" | "mine" | "address" | "account" | "other";

const FILTERS: Filter[] = ["all", "mine", "address", "account", "other"];

/** How long "Removed …" and its Undo stay. */
const UNDO_MS = 12_000;

interface Notice {
	text: string;
	undo?: string[];
}

/**
 * A channel's bans: searched, filtered and sorted on the device, added,
 * edited and removed here, kept current from the channel's MODE lines
 * (irc/banList.ts). docs/resources/client-features.md § Channel bans.
 */
export default defineComponent({
	name: "BanList",
	components: {SidebarToggle},
	setup() {
		const store = useStore();
		const route = useRoute();
		const {t, tCount} = useI18n();

		const queryField = ref<HTMLInputElement>();
		const query = ref("");
		const filter = ref<Filter>("all");
		const sort = ref<BanSort>("newest");
		const now = ref(Date.now());
		const pending = ref(new Set<string>());
		const notice = ref<Notice | null>(null);
		let clock: ReturnType<typeof setInterval> | undefined;
		let noticeTimer: ReturnType<typeof setTimeout> | undefined;

		const channel = computed(() => String(route.params.channel ?? ""));
		const network = computed(() => store.getters.findNetwork(String(route.params.uuid)));
		const connected = computed(() => network.value?.status.connected ?? false);
		const list = computed<SharedBanList>(
			() =>
				(network.value &&
					store.state.banLists[banListKey(network.value.uuid, channel.value)]) ?? {
					channel: channel.value,
					status: "idle",
					rows: [],
					at: 0,
					note: "",
				}
		);
		const canEdit = computed(
			() => !!network.value && connected.value && canSetBans(network.value, channel.value)
		);
		const nearLimit = computed(
			() => !!list.value.limit && list.value.rows.length >= list.value.limit * 0.9
		);

		const meaningOf = (row: BanEntry) =>
			network.value
				? clientForNetwork(network.value.uuid)?.profile.describeBan?.(row.mask)
				: undefined;
		const labelOf = (row: BanEntry) => meaningOf(row)?.label ?? "";
		const kindOf = (row: BanEntry): Filter =>
			meaningOf(row)?.kind ?? (isExtendedBan(row.mask) ? "other" : "address");
		const isMine = (row: BanEntry) =>
			banSetter(row.by).toLowerCase() === network.value?.nick.toLowerCase();
		const inFilter = (row: BanEntry, f: Filter) =>
			f === "all" || (f === "mine" ? isMine(row) : kindOf(row) === f);

		const counts = computed(() => {
			const out = {} as Record<Filter, number>;

			for (const f of FILTERS) {
				out[f] = list.value.rows.filter((row) => inFilter(row, f)).length;
			}

			return out;
		});
		/** Only the views that have something in them; All is always there. */
		const filters = computed(() => FILTERS.filter((f) => f === "all" || counts.value[f] > 0));

		const shownRows = computed(() =>
			sortBans(
				list.value.rows.filter(
					(row) => inFilter(row, filter.value) && banAnswersQuery(row, query.value)
				),
				sort.value
			)
		);

		const updatedLabel = computed(() => {
			void now.value; // redrawn by the clock
			return formatRelativeTime(list.value.at);
		});
		const setText = (row: BanEntry) => {
			void now.value;
			return banSetText(row);
		};
		const fullTime = (row: BanEntry) => (row.at ? formatDateTime(row.at) : undefined);

		const ask = () => {
			if (network.value && connected.value) {
				socket.emit("channel:bans:ask", {
					network: network.value.uuid,
					channel: channel.value,
				});
			}
		};

		const askIfStale = () => {
			const l = list.value;

			if (
				l.status === "idle" ||
				l.status === "error" ||
				Date.now() - l.at > BANS_STALE_AFTER_MS
			) {
				ask();
			}
		};

		/** Our modes in a channel not opened yet are not in: the same ask the chat makes. */
		const loadUsers = () => {
			const lower = channel.value.toLowerCase();
			const chan = network.value?.channels.find(
				(c) => c.type === ChanType.CHANNEL && c.name.toLowerCase() === lower
			);

			if (chan?.usersOutdated) {
				chan.usersOutdated = false;
				socket.emit("names", {target: chan.id});
			}
		};

		const say = (next: Notice) => {
			notice.value = next;
			clearTimeout(noticeTimer);
			noticeTimer = setTimeout(() => {
				notice.value = null;
			}, UNDO_MS);
		};

		const unban = async (rows: BanEntry[]) => {
			const net = network.value;

			if (!net) {
				return;
			}

			const masks = rows.map((row) => row.mask);
			pending.value = new Set([...pending.value, ...masks]);
			const reply = await changeChannelBans(net.uuid, {
				channel: channel.value,
				remove: masks,
				add: [],
			});
			const left = new Set(pending.value);
			masks.forEach((mask) => left.delete(mask));
			pending.value = left;

			switch (reply.outcome) {
				case "ok":
					say({
						text:
							masks.length === 1
								? t("bans.removedOne", {mask: masks[0]})
								: tCount("bans.removedMany", masks.length),
						undo: masks,
					});
					break;
				case "unchanged":
					// The list was out of date: someone took it off first.
					say({text: t("bans.alreadyGone")});
					ask();
					break;
				case "refused":
					say({text: reply.text ?? t("bans.alreadyGone")});
					break;
				case "timeout":
					say({text: t("ban.silent")});
					break;
				default:
					say({text: t("ban.notConnected")});
			}
		};

		const undo = async (masks: string[]) => {
			const net = network.value;

			if (!net) {
				return;
			}

			notice.value = null;
			const reply = await changeChannelBans(net.uuid, {
				channel: channel.value,
				remove: [],
				add: masks,
			});

			if (reply.outcome === "refused") {
				say({text: reply.text ?? t("ban.unchanged")});
			} else if (reply.outcome !== "ok") {
				say({text: t("ban.unchanged")});
			}
		};

		const unbanShown = () => {
			const rows = shownRows.value;

			eventbus.emit(
				"confirm-dialog",
				{
					title: tCount("bans.unbanAll", rows.length),
					text: tCount("bans.unbanAllText", rows.length, {channel: channel.value}),
					button: tCount("bans.unbanAll", rows.length),
				},
				(confirmed: boolean) => {
					if (confirmed) {
						void unban(rows);
					}
				}
			);
		};

		const add = () => {
			if (network.value) {
				openBanDialog({network: network.value.uuid, channel: channel.value});
			}
		};

		const edit = (row: BanEntry) => {
			if (network.value) {
				openBanDialog({network: network.value.uuid, channel: channel.value, edit: row});
			}
		};

		const openRowMenu = (event: MouseEvent, row: BanEntry) => {
			const items: ContextMenuItem[] = [
				{label: row.mask, type: "item", class: "oper-target"},
				{type: "divider"},
			];

			if (canEdit.value) {
				items.push(
					{
						label: t("bans.edit"),
						type: "item",
						class: "edit",
						action: () => edit(row),
					},
					{
						label: t("bans.unban"),
						type: "item",
						class: "action-unban",
						action: () => void unban([row]),
					}
				);
			}

			items.push({
				label: t("oper.menu.copy"),
				type: "item",
				class: "oper-copy",
				action: () => void navigator.clipboard?.writeText(row.mask).catch(() => undefined),
			});
			eventbus.emit("contextmenu:items", {event, items});
		};

		const filterLabel = (f: Filter) => {
			switch (f) {
				case "mine":
					return t("bans.filter.mine");
				case "address":
					return t("bans.filter.address");
				case "account":
					return t("bans.filter.account");
				case "other":
					return t("bans.filter.other");
				default:
					return t("bans.filter.all");
			}
		};

		const clearQuery = () => {
			query.value = "";
			queryField.value?.focus();
		};

		const close = () => {
			leavePage();
		};

		// The view emptied (its last ban went): back to everything.
		watch(filters, (views) => {
			if (!views.includes(filter.value)) {
				filter.value = "all";
			}
		});

		// Bans may have changed while the connection was down.
		watch(connected, (up) => {
			if (up) {
				ask();
				loadUsers();
			}
		});

		watch(network, (net) => {
			if (!net) {
				leavePage();
			}
		});

		watch(channel, () => {
			askIfStale();
			loadUsers();
		});

		onMounted(() => {
			askIfStale();
			loadUsers();
			clock = setInterval(() => {
				now.value = Date.now();
			}, 30_000);

			if (window.matchMedia("(hover: hover)").matches) {
				queryField.value?.focus();
			}
		});

		onUnmounted(() => {
			clearInterval(clock);
			clearTimeout(noticeTimer);
		});

		return {
			t,
			tCount,
			channel,
			network,
			connected,
			list,
			canEdit,
			nearLimit,
			query,
			queryField,
			filter,
			filters,
			counts,
			sort,
			shownRows,
			updatedLabel,
			pending,
			notice,
			labelOf,
			setText,
			fullTime,
			filterLabel,
			ask,
			add,
			edit,
			unban,
			unbanShown,
			undo,
			openRowMenu,
			clearQuery,
			close,
		};
	},
});
</script>
