<template>
	<div class="oper-activity">
		<div class="oper-activity-bar">
			<div class="oper-seg" role="group" :aria-label="t('oper.activity.period')">
				<button
					v-for="p in periods"
					:key="p.id"
					type="button"
					:aria-pressed="period === p.id"
					@click="period = p.id"
				>
					{{ p.label }}
				</button>
			</div>
			<div
				class="oper-seg oper-activity-view"
				role="group"
				:aria-label="t('oper.activity.view')"
			>
				<button type="button" :aria-pressed="view === 'oper'" @click="setView('oper')">
					{{ t("oper.activity.byOper") }}
				</button>
				<button type="button" :aria-pressed="view === 'kind'" @click="setView('kind')">
					{{ t("oper.activity.byKind") }}
				</button>
			</div>
		</div>

		<!-- Services support, without the report channel: what the audit
		     lines would add (docs/projects/oper-tools.md, "Graceful
		     degradation"), with Join. The snoop channel is not this tab's
		     business: its lines count for nothing here (the cards say when
		     it is missing). -->
		<p v-if="missingReport" class="oper-muted oper-activity-missing oper-missing-report">
			<span
				>{{ missingFrame[0] }}<bdi>{{ missingReport }}</bdi
				>{{ missingFrame[1] }}</span
			>
			<button
				type="button"
				class="btn btn-small oper-join-channel"
				@click="join(missingReport)"
			>
				{{ t("oper.activity.join") }}
			</button>
		</p>

		<p v-if="!rows.length" class="oper-muted oper-activity-empty">
			{{ t("oper.activity.empty") }}
		</p>

		<!-- By oper: actor → coarse kind → the notices. -->
		<ul v-else-if="view === 'oper'" class="oper-rollup">
			<li
				v-for="row in byOper"
				:key="row.key"
				:class="['oper-rollup-row', 'oper-actor-' + row.actor.type]"
			>
				<button
					type="button"
					class="oper-row"
					:aria-expanded="isOpen(row.key)"
					@click="toggle($event, row.key)"
				>
					<span class="oper-row-name">
						<Username
							v-if="row.actor.type === 'nick'"
							:user="{nick: row.actor.name, mode: ''}"
							:network="network"
						/>
						<span v-else class="oper-server">{{
							row.actor.type === "service"
								? t("oper.activity.services")
								: t("oper.activity.servers")
						}}</span>
					</span>
					<span :class="['oper-row-count', {hot: row.hot}]">{{
						tCount("oper.activity.actions", row.count)
					}}</span>
					<time class="oper-row-time" :title="absolute(row.last)">{{
						clock(row.last)
					}}</time>
				</button>
				<ul v-if="isOpen(row.key)" class="oper-rollup oper-tier2">
					<li
						v-for="g in row.groups"
						:key="g.coarse"
						:class="['oper-rollup-row', 'oper-coarse-' + g.coarse]"
					>
						<button
							type="button"
							class="oper-row"
							:aria-expanded="isOpen(row.key + '/' + g.coarse)"
							@click="toggle($event, row.key + '/' + g.coarse)"
						>
							<span class="oper-row-name">{{ countLabel(g.coarse, g.count) }}</span>
							<span class="oper-row-time">{{ span(g) }}</span>
						</button>
						<ol v-if="isOpen(row.key + '/' + g.coarse)" class="oper-timeline">
							<li v-for="(e, i) in g.entries" :key="i" class="oper-timeline-row">
								<time class="oper-timeline-time" :title="absolute(e.time)">{{
									seconds(e.time)
								}}</time>
								<NoticeBadge :info="e.snotice" :type="e.type" :network="network" />
								<span v-if="e.type === 'wallops'" class="oper-timeline-text"
									><strong>{{ e.from }}</strong> {{ e.text }}</span
								>
								<SnoticeText
									v-else
									:info="e.snotice"
									:text="e.text"
									:network="network"
								/>
							</li>
						</ol>
					</li>
				</ul>
			</li>
		</ul>

		<!-- By kind: coarse kind → the timeline, with who did each one. -->
		<ul v-else class="oper-rollup">
			<li
				v-for="g in byKind"
				:key="g.coarse"
				:class="['oper-rollup-row', 'oper-coarse-' + g.coarse]"
			>
				<button
					type="button"
					class="oper-row"
					:aria-expanded="isOpen('kind/' + g.coarse)"
					@click="toggle($event, 'kind/' + g.coarse)"
				>
					<span class="oper-row-name">{{ g.label }}</span>
					<span class="oper-row-count">{{ g.count }}</span>
					<time class="oper-row-time" :title="absolute(g.last)">{{ clock(g.last) }}</time>
				</button>
				<ol v-if="isOpen('kind/' + g.coarse)" class="oper-timeline">
					<li v-for="(e, i) in g.entries" :key="i" class="oper-timeline-row">
						<time class="oper-timeline-time" :title="absolute(e.time)">{{
							seconds(e.time)
						}}</time>
						<NoticeBadge :info="e.snotice" :type="e.type" :network="network" />
						<span v-if="actorOf(e)" class="oper-timeline-actor">
							<Username
								v-if="actorOf(e)!.type === 'nick'"
								:user="{nick: actorOf(e)!.name, mode: ''}"
								:network="network"
							/>
							<span v-else class="oper-server">{{ actorOf(e)!.name }}</span>
						</span>
						<span v-if="e.type === 'wallops'" class="oper-timeline-text">{{
							e.text
						}}</span>
						<SnoticeText v-else :info="e.snotice" :text="e.text" :network="network" />
					</li>
				</ol>
			</li>
		</ul>

		<p v-if="recent.length" class="oper-muted oper-activity-foot">
			{{ tCount("oper.activity.foot", recent.length, {since: keptSince}) }}
		</p>
	</div>
</template>

<style>
.oper-activity-bar {
	display: flex;
	flex-wrap: wrap;
	gap: 0.5rem 1rem;
	margin-bottom: 0.75rem;
}

.oper-activity-view {
	margin-left: auto;
}

.oper-activity-missing {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0.35rem 0.75rem;
	margin: 0 0 0.6rem;
	font-size: 0.9375em;
}

.oper-activity-missing .btn {
	margin: 0;
	width: auto;
	padding: 0.25em 0.8em;
	font-size: 0.8125em;
}

.oper-rollup {
	list-style: none;
	margin: 0;
	padding: 0;
}

.oper-rollup-row {
	border-bottom: 1px solid color-mix(in srgb, var(--body-color-muted) 25%, transparent);
}

.oper-tier2 {
	margin-left: 1.25rem;
	margin-bottom: 0.4rem;
}

.oper-tier2 .oper-rollup-row:last-child {
	border-bottom: 0;
}

.oper-row {
	display: flex;
	align-items: baseline;
	gap: 0.6rem;
	width: 100%;
	padding: 0.5rem 0.25rem;
	text-align: left;
	color: var(--body-color);
	border-radius: 0.25rem;
}

.oper-row:hover,
.oper-row:focus-visible {
	background: color-mix(in srgb, var(--body-color-muted) 10%, transparent);
}

/* The fold mark: a FontAwesome caret (the font comes from style.css's
 * icon list), turned when the row is open. */
.oper-row::before {
	content: "\f0da"; /* https://fontawesome.com/icons/caret-right?style=solid */
	display: inline-block;
	width: 0.8em;
	flex: 0 0 auto;
	color: var(--body-color-muted);
}

.oper-row[aria-expanded="true"]::before {
	content: "\f0d7"; /* https://fontawesome.com/icons/caret-down?style=solid */
}

.oper-row-name {
	flex: 1 1 auto;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
}

.oper-tier2 .oper-row-name {
	font-size: 0.9375em;
}

.oper-row-count {
	flex: 0 0 auto;
	color: var(--body-color-muted);
	font-variant-numeric: tabular-nums;
}

.oper-row-count.hot {
	color: var(--oper-amber);
	font-weight: 600;
}

.oper-row-time {
	flex: 0 0 auto;
	color: var(--body-color-muted);
	font-variant-numeric: tabular-nums;
	font-size: 0.875em;
}

.oper-timeline {
	list-style: none;
	margin: 0 0 0.5rem 1.25rem;
	padding: 0;
	font-size: 0.9375em;
}

.oper-timeline-row {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	gap: 0.3rem 0.5rem;
	padding: 0.15rem 0;
}

.oper-timeline-time {
	color: var(--body-color-muted);
	font-variant-numeric: tabular-nums;
	flex-shrink: 0;
}

.oper-timeline-row .snotice-badge {
	flex-shrink: 0;
	margin-right: 0;
}

.oper-timeline-row .snotice-text,
.oper-timeline-text {
	flex: 1 1 12rem;
	min-width: 0;
	overflow-wrap: anywhere;
}

.oper-activity-foot {
	font-size: 0.875em;
	margin-top: 0.75rem;
}
</style>

<script lang="ts">
import {computed, defineComponent, onMounted, onUnmounted, PropType, ref} from "vue";
import dayjs from "dayjs";
import type {ClientNetwork} from "../../js/types";
import type {LoggedNotice} from "../../js/irc/noticelog";
import socket from "../../js/socket";
import storage from "../../js/localStorage";
import {formatDateTime, formatTime} from "../../js/i18n/dates";
import {useI18n} from "../../js/i18n";
import {frameSegments, KEEP} from "../../js/i18n/core";
import useNow from "../../js/hooks/use-now";
import {
	actorOf as actorOfEntry,
	countLabel,
	isCounted,
	periodStart,
	rollupByKind,
	rollupByOper,
	type ActivityOptions,
	type KindGroup,
	type Period,
} from "../../js/helpers/operActivity";
import {serviceNicksOf} from "../../js/irc/services/index";
import {ChanState, ChanType} from "../../../shared/types/chan";
import NoticeBadge from "./NoticeBadge.vue";
import SnoticeText from "./SnoticeText.vue";
import Username from "../Username.vue";

const VIEW_KEY = "thelounge.oper.activityView";

/**
 * The Opers tab (docs/projects/oper-tools.md, "The panel, redrawn"): what
 * the opers have been doing, rolled up from the notice log
 * (helpers/operActivity.ts). Everything closed by default; a row opens on
 * a tap or Enter.
 */
export default defineComponent({
	name: "OperActivity",
	components: {NoticeBadge, SnoticeText, Username},
	props: {
		network: {type: Object as PropType<ClientNetwork>, required: true},
	},
	setup(props) {
		const now = useNow();
		const {t, tCount, locale} = useI18n();
		const periods = computed((): {id: Period; label: string}[] => [
			{id: "today", label: t("oper.activity.today")},
			{id: "24h", label: t("oper.activity.last24h")},
			{id: "reload", label: t("oper.activity.sinceReload")},
		]);
		const missingFrame = computed(() =>
			frameSegments(t("oper.activity.missingReport", {channel: KEEP}), ["channel"])
		);
		const period = ref<Period>("today");
		const view = ref<"oper" | "kind">(storage.get(VIEW_KEY) === "kind" ? "kind" : "oper");
		const recent = ref<LoggedNotice[]>([]);
		const open = ref<Record<string, boolean>>({});

		const setView = (next: "oper" | "kind") => {
			view.value = next;
			storage.set(VIEW_KEY, next);
		};

		const since = computed(() => periodStart(period.value, now.value));
		// Which nicks are the services bots is the network's setting.
		const opts = computed<ActivityOptions>(() => ({
			serviceNicks: serviceNicksOf(props.network.services),
		}));
		const byOper = computed(() => rollupByOper(recent.value, since.value, opts.value));
		const byKind = computed(() => rollupByKind(recent.value, since.value));
		const rows = computed(() => (view.value === "oper" ? byOper.value : byKind.value));
		const actorOf = (entry: LoggedNotice) => actorOfEntry(entry, opts.value);

		/** The configured report channel when this client is not in it (its audit lines are what the tab counts). */
		const missingReport = computed(() => {
			const report = props.network.services?.bots.report ?? "";
			const joined = props.network.channels.some(
				(c) =>
					c.type === ChanType.CHANNEL &&
					c.state === ChanState.JOINED &&
					c.name.toLowerCase() === report.toLowerCase()
			);

			return report && !joined ? report : "";
		});

		const join = (channel: string) => {
			const lobby = props.network.channels[0];

			if (lobby) {
				socket.emit("input", {target: lobby.id, text: `/join ${channel}`});
			}
		};

		const isOpen = (key: string) => open.value[key] === true;

		const toggle = (event: MouseEvent, key: string) => {
			// A tap on the nick inside the row is the nick's (its menu), not the fold's.
			if ((event.target as HTMLElement | null)?.closest(".user")) {
				return;
			}

			open.value = {...open.value, [key]: !isOpen(key)};
		};

		const onNotices = (data: {network: string; entries: LoggedNotice[]}) => {
			if (data.network === props.network.uuid) {
				// The snoop channel's lines are the cards' source, not oper actions:
				// not in the rollups, not in the footer's count.
				recent.value = data.entries.filter(isCounted);
			}
		};

		onMounted(() => {
			socket.on("oper:notices", onNotices);
			socket.emit("oper:notices:get", {network: props.network.uuid});
		});

		onUnmounted(() => {
			socket.off("oper:notices", onNotices);
		});

		// The app's language and its 12/24-hour setting, like every other
		// time in the app (dayjs's "HH:mm" was always 24-hour).
		const clock = (ms: number) => formatTime(ms, false);
		const seconds = (ms: number) => formatTime(ms, true);
		const span = (g: KindGroup) =>
			clock(g.first) === clock(g.last)
				? clock(g.last)
				: `${clock(g.first)} – ${clock(g.last)}`;
		const keptSince = computed(() => {
			const first = recent.value[0]?.time;

			if (first === undefined) {
				return "";
			}

			return dayjs(first).isSame(dayjs(now.value), "day")
				? clock(first)
				: new Intl.DateTimeFormat(locale.value, {
						day: "numeric",
						month: "long",
						hour: "2-digit",
						minute: "2-digit",
						hourCycle: "h23",
				  }).format(first);
		});

		return {
			t,
			tCount,
			periods,
			missingFrame,
			period,
			view,
			setView,
			recent,
			rows,
			byOper,
			byKind,
			isOpen,
			toggle,
			actorOf,
			countLabel,
			missingReport,
			join,
			clock,
			seconds,
			span,
			keptSince,
			absolute: (ms: number) => formatDateTime(new Date(ms)),
		};
	},
});
</script>
