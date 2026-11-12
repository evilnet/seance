<template>
	<div
		v-if="isOpen"
		id="mentions-popup-container"
		class="header-popover-container"
		v-backdrop="closeFromOutside"
		data-escape-close="mentions"
		@contextmenu.self="closePopup"
	>
		<div
			ref="popup"
			class="header-popover mentions-popup"
			role="dialog"
			aria-labelledby="mentions-popup-heading"
			tabindex="-1"
			:style="placement"
			@keydown.capture="onPaneKey"
			@keydown.tab="onTab"
			@keydown.down.exact.prevent="moveFocus($event, 1)"
			@keydown.up.exact.prevent="moveFocus($event, -1)"
		>
			<div class="header-popover-title mentions-popup-title">
				<h2 id="mentions-popup-heading">
					{{ t("mentions.title") }}
					<span
						v-if="total"
						class="header-popover-aside mentions-total"
						:aria-label="totalLabel"
						>{{ totalText }}</span
					>
				</h2>
				<button
					v-if="groups.length"
					class="oper-btn oper-btn-ghost"
					@click="dismissAllMentions()"
				>
					{{ t("mentions.dismissAll") }}
				</button>
				<!-- On the phone the pane is the whole screen: nothing outside it to tap. -->
				<button
					class="header-popover-close mentions-close"
					type="button"
					:aria-label="t('mentions.close')"
					@click="closePopup"
				>
					✕
				</button>
			</div>

			<div v-if="groups.length === 0" class="mentions-empty">
				<span class="mentions-empty-icon" aria-hidden="true"></span>
				<p class="mentions-empty-title">{{ t("mentions.empty") }}</p>
				<p class="mentions-empty-hint">
					{{ t("mentions.emptyHint") }}
				</p>
			</div>

			<div v-else class="mentions-list">
				<section
					v-for="group in groups"
					:key="group.key"
					class="mentions-group"
					:aria-label="group.label"
				>
					<div class="mentions-group-head">
						<button
							class="mentions-group-header"
							:disabled="!group.conversation"
							:title="
								group.conversation
									? t('mentions.open', {target: group.target})
									: group.missing
							"
							@click="openGroup(group)"
						>
							<span class="mentions-group-name">{{ group.target }}</span>
							<span v-if="group.networkName" class="mentions-group-network">{{
								group.networkName
							}}</span>
							<span
								v-if="!group.query && groups.length > 1 && group.unread"
								class="mentions-group-count"
								>{{ formatNumber(group.unread) }}</span
							>
						</button>
						<!-- A conversation this page no longer has: reading cannot mark it. While
						     offline it is only not back yet, and a row's × is still there. -->
						<button
							v-if="!group.conversation && group.network?.status.connected !== false"
							class="oper-btn oper-btn-ghost"
							@click="dismissGroup(group)"
						>
							{{ t("mentions.dismissGroup") }}
						</button>
					</div>
					<p v-if="group.missing" class="mentions-group-missing">{{ group.missing }}</p>
					<!-- A click opens the conversation; Enter on a focused row does too.
					     Vue's .delete is Delete and Backspace both. -->
					<div
						v-for="message in group.shown"
						:key="message.key"
						:class="[
							'msg',
							'mentions-entry',
							message.type,
							{
								'mentions-entry-openable': group.conversation,
								'mentions-entry-read': message.read,
							},
						]"
						tabindex="0"
						@click="openFromRow($event, group, message)"
						@keydown.enter.self.prevent="openGroup(group, message)"
						@keydown.delete.prevent="dismissRow($event, group, message)"
					>
						<div class="mentions-info">
							<!-- A private conversation's name is its header. The nick alone:
							     an op's @ would read like a mention. -->
							<span v-if="!group.query" class="from" @click.stop>
								<!-- A stored entry whose network is gone: plain text, since
								     its menus could only act on another network. -->
								<span v-if="!group.network">{{ message.from.nick }}</span>
								<Username
									v-else
									:user="(message.from as any)"
									:network="group.network"
									:channel="group.conversation?.channel"
									>{{ message.from.nick }}</Username
								>
							</span>
							<time class="time" :datetime="message.time" :title="message.fullTime">{{
								messageTime(message.time)
							}}</time>
							<span v-if="group.unreadLabel" class="mentions-group-unread">{{
								group.unreadLabel
							}}</span>
							<button
								class="msg-dismiss"
								:title="t('mentions.dismissOne')"
								:aria-label="t('mentions.dismissOne')"
								@click.stop="dismissRow($event, group, message)"
							></button>
						</div>
						<div class="content" dir="auto">
							<!-- In a box of its own: WebKit paints no ::highlight on text
							     directly inside a line clamp. -->
							<div>
								<template v-if="!group.network">{{
									cleanIrcMessage(message.text)
								}}</template>
								<ParsedMessage
									v-else
									:message="(message as any)"
									:network="group.network"
								/>
							</div>
						</div>
					</div>
					<!-- Below the rows: a group reads newest first, and what it brings is older. -->
					<button
						v-if="group.hidden"
						class="oper-btn oper-btn-ghost mentions-more"
						@click="showAll(group)"
					>
						{{
							group.hiddenUnread
								? tCount("mentions.showMoreUnread", group.hidden, {
										count: group.hidden,
										unread: group.hiddenUnread,
								  })
								: tCount("mentions.showMore", group.hidden, {count: group.hidden})
						}}
					</button>
				</section>
			</div>

			<!-- Dismiss all takes a lot at once, so it can be taken back until the pane closes. -->
			<div v-if="undoableMentions.length" class="mentions-undo" role="status">
				<span>{{ tCount("mentions.dismissedHere", undoableMentions.length) }}</span>
				<button class="btn btn-sm" @click="undoDismiss">{{ t("mentions.undo") }}</button>
			</div>
		</div>
	</div>
</template>

<style>
.mentions-list {
	flex: 1 1 auto;
	overflow-y: auto;
	overscroll-behavior: contain;
	padding-bottom: 0.375rem;
}

/* Why this row is here. Keeki sets the colour; every theme has the fallback. */
::highlight(mention) {
	background-color: color-mix(
		in oklab,
		var(--mention-mark-color, var(--highlight-border-color)) 35%,
		transparent
	);
}

.mentions-popup .oper-btn {
	height: 2rem;
	padding: 0 0.5rem;
	font-size: 0.8125rem;
}

/* One conversation: a header that opens it, then its mentions as it reads. */
.mentions-group + .mentions-group {
	margin-top: 0.25rem;
	border-top: 1px solid var(--oper-line);
	padding-top: 0.25rem;
}

.mentions-group-head {
	display: flex;
	align-items: center;
	padding-inline-end: 0.75rem;
}

.mentions-group-header {
	display: flex;
	flex: 1 1 auto;
	min-width: 0;
	align-items: baseline;
	gap: 0.5rem;
	width: 100%;
	padding: 0.5rem 0.75rem 0.25rem;
	background: none;
	border: 0;
	color: inherit;
	font: inherit;
	text-align: start;
	cursor: pointer;
}

.mentions-group-header:disabled {
	cursor: default;
}

.mentions-group-missing {
	margin: 0;
	padding: 0 0.75rem 0.25rem;
	color: var(--body-color-muted);
	font-size: 0.8125rem;
}

.mentions-group-name {
	font-weight: 700;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.mentions-group-header:not(:disabled):hover .mentions-group-name,
.mentions-group-header:focus-visible .mentions-group-name {
	color: var(--link-color);
	text-decoration: underline;
}

.mentions-group-network {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-size: 0.8125rem;
	color: var(--body-color-muted);
}

.mentions-group-count {
	margin-inline-start: auto;
	flex-shrink: 0;
	min-width: 1.25rem;
	padding: 0.125rem 0.375rem;
	border-radius: 999rem;
	background: var(--highlight-bg-color);
	font-size: 0.75rem;
	text-align: center;
	color: var(--body-color);
}

.mentions-group-unread {
	flex-shrink: 0;
	font-size: 0.75rem;
	color: var(--body-color-muted);
}

.mentions-popup .mentions-entry {
	margin: 0 0.375rem;
	padding: 0.375rem;
	border-radius: 0.375rem;
	user-select: text;
}

.mentions-popup .mentions-entry-openable {
	cursor: pointer;
}

.mentions-popup .mentions-entry:hover,
.mentions-popup .mentions-entry:focus-visible {
	background: var(--highlight-bg-color);
}

.mentions-popup .mentions-entry:focus-visible {
	outline: 0.125rem solid var(--link-color);
	outline-offset: -0.125rem;
}

/* Read: still here to go back to, no longer asking for anything. */
.mentions-popup .mentions-entry-read:not(:hover, :focus-visible) > * {
	opacity: 0.55;
}

html[data-contrast="more"] .mentions-popup .mentions-entry-read > * {
	opacity: 1;
}

.mentions-popup .mentions-more {
	display: block;
	margin: 0 0.375rem;
}

.mentions-popup .mentions-info {
	display: flex;
	align-items: baseline;
	gap: 0.5rem;
	min-width: 0;
}

.mentions-popup .mentions-info .from {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.mentions-popup .mentions-info .time {
	flex-shrink: 0;
	font-size: 0.75rem;
	color: var(--body-color-muted);
}

.mentions-popup .msg .content {
	margin-top: 0.125rem;
	display: -webkit-box;
	-webkit-box-orient: vertical;
	-webkit-line-clamp: 3;
	line-clamp: 3;
	overflow: hidden;
	word-wrap: break-word;
	word-break: break-word; /* Webkit-specific */
}

.mentions-popup .msg-dismiss {
	margin-inline-start: auto;
	flex-shrink: 0;
	width: 1.5rem;
	height: 1.5rem;
	padding: 0;
	border: 0;
	border-radius: 50%;
	background: none;
	color: var(--body-color-muted);
	opacity: 0;
	transition: opacity 0.15s;
}

/* Hidden until the row is hovered or focused, except where the last pointer
 * was a finger: nothing hovers there. */
.mentions-popup .mentions-entry:hover .msg-dismiss,
.mentions-popup .mentions-entry:focus-within .msg-dismiss,
:where(html[data-input="touch"]) .mentions-popup .msg-dismiss {
	opacity: 1;
}

/* A finger's target: about 44pt at the default text size. */
:where(html[data-input="touch"]) .mentions-popup .msg-dismiss {
	width: 2.25rem;
	height: 2.25rem;
	margin-block: -0.5rem;
}

.mentions-popup .msg-dismiss::before {
	font-size: 1.125rem;
	line-height: 1.5rem;
	content: "×";
}

.mentions-popup .msg-dismiss:hover,
.mentions-popup .msg-dismiss:focus-visible {
	color: var(--link-color);
	background: var(--highlight-bg-color);
}

.mentions-undo {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 0.75rem;
	margin: 0.375rem;
	padding: 0.25rem 0.25rem 0.25rem 0.625rem;
	border-radius: 0.3125rem;
	background: var(--highlight-bg-color);
	font-size: 0.8125rem;
}

.mentions-undo .btn {
	margin: 0;
}

.mentions-empty {
	padding: 1.5rem 1.5rem 1.25rem;
	text-align: center;
}

.mentions-empty-icon::before {
	display: inline-block;
	width: 2.75rem;
	height: 2.75rem;
	line-height: 2.75rem;
	border-radius: 50%;
	background: var(--highlight-bg-color);
	color: var(--body-color-muted);
	font: normal normal normal 1.25rem/2.75rem FontAwesome;
	content: "\f00c"; /* https://fontawesome.com/icons/check?style=solid */
}

.mentions-empty-title {
	margin: 0.75rem 0 0.25rem;
	font-weight: 700;
}

.mentions-empty-hint {
	margin: 0 auto;
	max-width: 18rem;
	font-size: 0.875rem;
	color: var(--body-color-muted);
}
</style>

<script lang="ts">
import Username from "./Username.vue";
import {cleanIrcMessage} from "../../shared/irc";
import ParsedMessage from "./ParsedMessage.vue";
import {
	dismissAllMentions as dismissAll,
	dismissMentions,
	markMentionOpened,
	undoDismissAll,
	undoableMentions,
} from "../js/mentions";
import eventbus from "../js/eventbus";
import {switchToChannel} from "../js/router";
import {setReadHold} from "../js/helpers/readHold";
import {entryKey, groupByConversation} from "../js/helpers/inbox";
import {formatDateTime} from "../js/i18n/dates";
import {formatNumber} from "../js/i18n/numbers";
import {isTouchInput} from "../js/helpers/inputModality";
import {recentTime} from "../js/helpers/messageTime";
import {clearHighlight, paintHighlight, rangesIn} from "../js/helpers/paintHighlight";
import {trapTab} from "../js/helpers/trapTab";
import {placeUnder} from "../js/helpers/headerPopover";
import {mentionSpans, parseKeywordList} from "../js/highlight";
import {computed, defineComponent, nextTick, ref, onMounted, onUnmounted, watch} from "vue";
import {useStore} from "../js/store";
import {useI18n} from "../js/i18n";
import type {InboxEntry} from "../../shared/types/mention";
import type {ClientNetwork, NetChan} from "../js/types";
import {ChanType} from "../../shared/types/chan";

/** Rows a conversation shows before "Show more", so one cannot fill the pane. */
const ROWS_PER_GROUP = 3;

type MentionWithContext = InboxEntry & {
	key: string;
	fullTime: string;
};

type GroupWithContext = {
	key: string;
	target: string;
	networkName: string;
	/** Where a nick or a channel in a row belongs, whatever the page underneath. */
	network?: ClientNetwork;
	label: string;
	conversation: NetChan | null;
	/** Why a group without a conversation cannot be opened. */
	missing: string;
	/** A private conversation: one row, its newest line, and how much is unread. */
	query: boolean;
	unreadLabel: string;
	entries: MentionWithContext[];
	/** The rows: its newest mentions, or a private conversation's newest line. */
	shown: MentionWithContext[];
	/** Not read yet, of `entries`. */
	unread: number;
	/** Behind "Show more", and how many of those are not read yet. */
	hidden: number;
	hiddenUnread: number;
};

export default defineComponent({
	name: "Mentions",
	components: {
		Username,
		ParsedMessage,
	},
	setup() {
		const store = useStore();
		const {t, tCount, locale} = useI18n();
		const isOpen = ref(false);
		/** Conversations showing every row, until the pane closes. */
		const expanded = ref(new Set<string>());
		/** Moves the focus for a keyboard: left alone, a finger's raises none. */
		let keyboard = false;

		const rowsOf = (key: string, query: boolean, entries: MentionWithContext[]) => {
			// Newest first, as the groups are: the latest mention is on top
			// whether the group shows its first rows or all of them.
			const newest = [...entries].reverse();
			const shown = query
				? newest.slice(0, 1)
				: expanded.value.has(key)
				? newest
				: newest.slice(0, ROWS_PER_GROUP);
			const behind = query ? [] : newest.slice(shown.length);
			return {
				shown,
				unread: entries.filter((e) => !e.read).length,
				hidden: behind.length,
				hiddenUnread: behind.filter((e) => !e.read).length,
			};
		};

		const groups = computed((): GroupWithContext[] => {
			// locale.value is read so a language change redoes the
			// Intl-formatted times (Intl itself is not reactive).
			void locale.value;
			const several = store.state.networks.length > 1;

			return groupByConversation(store.getters.visibleMentions).map((group) => {
				const conversation = store.getters.findConversation(group.network, group.target);
				const target = conversation?.channel.name ?? group.target;
				const networkName =
					several || !conversation ? conversation?.network.name ?? "" : "";
				const query = conversation
					? conversation.channel.type === ChanType.QUERY
					: !!group.entries[0]?.query;
				const entries = group.entries.map((entry) => ({
					...entry,
					key: entryKey(entry),
					fullTime: formatDateTime(new Date(entry.time)),
				}));
				const unread = query ? conversation?.channel.unread ?? 0 : 0;
				const network = store.getters.findNetwork(group.network);
				let missing = "";

				if (!conversation) {
					const on = several && network ? network.name : "";
					missing = !network
						? t("mentions.missingNetwork")
						: !network.status.connected
						? query
							? t("mentions.notConnected")
							: t("mentions.notConnectedIn", {target})
						: query
						? on
							? t("mentions.missingQueryOn", {target, network: on})
							: t("mentions.missingQuery", {target})
						: on
						? t("mentions.missingChannelOn", {target, network: on})
						: t("mentions.missingChannel", {target});
				}

				return {
					key: group.key,
					target,
					networkName,
					network: network ?? undefined,
					label: networkName
						? t("mentions.targetOn", {target, network: networkName})
						: target,
					conversation,
					missing,
					query,
					unreadLabel:
						unread > 1 ? tCount("mentions.unread", unread, {count: unread}) : "",
					entries,
					...rowsOf(group.key, query, entries),
				};
			});
		});

		const total = computed(() => store.getters.mentionCount);
		const totalText = computed(() => formatNumber(total.value));
		const totalLabel = computed(() =>
			tCount("mentions.unread", total.value, {count: total.value})
		);

		const messageTime = (time: string) => {
			void locale.value;
			return recentTime(time, store.state.settings);
		};

		// Under the @ button, measured against the container the pane is
		// placed in; the phone layout's rule ignores both.
		const popup = ref<HTMLElement | null>(null);
		const placement = ref<Record<string, string>>({});

		const place = () => {
			placement.value = placeUnder(
				document.querySelector("#chat button.mentions"),
				popup.value
			);
		};

		/** Focus, for a keyboard, what `next` names once the list has changed, or the pane. */
		const refocus = (next?: () => HTMLElement | null | undefined) => {
			void nextTick(() => {
				if (keyboard) {
					(next?.() ?? popup.value)?.focus();
				}
			});
		};

		// Where a keyboard's focus goes when the pane closes.
		let returnFocus: HTMLElement | null = null;

		watch(isOpen, (open) => {
			window.removeEventListener("resize", place);

			if (open) {
				returnFocus = keyboard ? (document.activeElement as HTMLElement) : null;
				window.addEventListener("resize", place);
				void nextTick(place);
				refocus();
				return;
			}

			undoableMentions.value = [];
			expanded.value = new Set();

			// Before the pane goes: only if focus has not gone elsewhere already.
			const active = document.activeElement;

			if (active === document.body || popup.value?.contains(active)) {
				void nextTick(() => returnFocus?.focus());
			}
		});

		const paintMentions = () => {
			if (!isOpen.value) {
				clearHighlight("mention");
				return;
			}

			const keywords = parseKeywordList(store.state.settings.highlights);
			const sections = popup.value?.querySelectorAll(".mentions-group") ?? [];

			paintHighlight(
				"mention",
				groups.value.flatMap(({network}, i) =>
					rangesIn(sections[i].querySelectorAll(".content"), (text) =>
						mentionSpans(text, network?.nick ?? "", keywords)
					)
				)
			);

			// The row it was on is gone, by a dismiss or from elsewhere: the keys
			// answer on the pane, so the focus stays in it.
			if (keyboard && document.activeElement === document.body) {
				popup.value?.focus();
			}
		};

		// Not `groups` while closed: it would be worked out for nobody.
		watch(() => isOpen.value && groups.value, paintMentions, {flush: "post"});

		const rows = () => [
			...(popup.value?.querySelectorAll<HTMLElement>(".mentions-entry") ?? []),
		];

		const dismissGroup = (group: GroupWithContext) => {
			dismissMentions(group.entries);
		};

		const dismissRow = (event: Event, group: GroupWithContext, message: MentionWithContext) => {
			// A held key would go on down the list, with no Undo for a single row.
			if ((event as KeyboardEvent).repeat) {
				return;
			}

			const list = rows();
			const at = list.indexOf(
				(event.currentTarget as HTMLElement).closest(".mentions-entry") as HTMLElement
			);
			const next = list[at + 1] ?? list[at - 1];
			dismissMentions(group.query ? group.entries : [message]);
			refocus(() => next);
		};

		// It opens at the mention (MessageList.vue's jump): the one clicked, or
		// the header's oldest unread. That mention dims; the conversation is not
		// read until the list reaches its bottom, so the others stay as they are.
		// A group without a conversation says why in its head.
		const openGroup = (
			group: GroupWithContext,
			entry = group.entries.find((e) => !e.read) ?? group.entries[0]
		) => {
			if (!group.conversation) {
				return;
			}

			const channel = group.conversation.channel;
			setReadHold(channel, true);

			if (entry) {
				markMentionOpened(entry);
			}

			store.commit("jumpTarget", {
				chanId: channel.id,
				...(entry?.msgid ? {msgid: entry.msgid} : {}),
			});
			isOpen.value = false;
			switchToChannel(channel);
		};

		const showAll = (group: GroupWithContext) => {
			const section = (document.activeElement as HTMLElement | null)?.closest(
				".mentions-group"
			);
			const before = group.shown.length;
			expanded.value = new Set([...expanded.value, group.key]);
			// The button is gone: on to the first row it brought, under those shown before.
			refocus(() => section?.querySelectorAll<HTMLElement>(".mentions-entry")[before]);
		};

		// A click on the row opens the conversation; one on a link, a nick
		// or a channel in the text, or a selection being made, does not.
		const openFromRow = (
			event: MouseEvent,
			group: GroupWithContext,
			entry: MentionWithContext
		) => {
			const target = event.target as HTMLElement | null;

			if (target?.closest("a, button, .user, .inline-channel")) {
				return;
			}

			if (window.getSelection()?.toString()) {
				return;
			}

			openGroup(group, entry);
		};

		// What is shown: a muted conversation's entries stay out of it.
		const dismissAllMentions = () => {
			dismissAll(store.getters.visibleMentions);
			refocus(() => popup.value?.querySelector<HTMLElement>(".mentions-undo button"));
		};

		const undoDismiss = () => {
			undoDismissAll();
			refocus(() => rows()[0]);
		};

		// A key here is a keyboard, however the pane was opened. A held Enter
		// presses once: each press moves the focus to what the next would press.
		const onPaneKey = (event: KeyboardEvent) => {
			keyboard = true;

			if (event.key === "Enter" && event.repeat) {
				event.preventDefault();
				event.stopPropagation();
			}
		};

		const onTab = (event: KeyboardEvent) => trapTab(event, popup.value as HTMLElement);

		const moveFocus = (event: KeyboardEvent, by: 1 | -1) => {
			const list = rows();
			const row = (event.target as HTMLElement).closest<HTMLElement>(".mentions-entry");
			const at = row ? list.indexOf(row) : -1;
			list[at < 0 && by < 0 ? list.length - 1 : at + by]?.focus();
		};

		// Alt+M comes with no event, and is a keyboard whatever last touched the
		// screen; a press of the @ button is whatever pressed it.
		const togglePopup = (press?: unknown) => {
			keyboard = !press || !isTouchInput();
			isOpen.value = !isOpen.value;
		};

		const closePopup = () => {
			isOpen.value = false;
		};

		// A press on a control beside the pane closes it and does what the control
		// says, or the header's buttons would each need a second press. The @ button
		// is the exception: it toggles, so it would only open the pane again.
		const closeFromOutside = (event: MouseEvent) => {
			returnFocus = null; // the press decides where the focus goes
			closePopup();
			void nextTick(() => {
				document
					.elementFromPoint(event.clientX, event.clientY)
					?.closest<HTMLElement>("button:not(.mentions)")
					?.click();
			});
		};

		const onEscape = (layer: string | null) => {
			if (layer === "mentions") {
				closePopup();
			}
		};

		onMounted(() => {
			eventbus.on("mentions:toggle", togglePopup);
			eventbus.on("escapekey", onEscape);
		});

		onUnmounted(() => {
			window.removeEventListener("resize", place);
			clearHighlight("mention");
			eventbus.off("mentions:toggle", togglePopup);
			eventbus.off("escapekey", onEscape);
		});

		return {
			tCount,
			formatNumber,
			isOpen,
			popup,
			placement,
			groups,
			cleanIrcMessage,
			total,
			totalText,
			totalLabel,
			t,
			undoableMentions,
			messageTime,
			dismissGroup,
			dismissRow,
			dismissAllMentions,
			undoDismiss,
			onPaneKey,
			onTab,
			moveFocus,
			openGroup,
			openFromRow,
			showAll,
			closePopup,
			closeFromOutside,
		};
	},
});
</script>
