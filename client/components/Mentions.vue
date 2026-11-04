<template>
	<div
		v-if="isOpen"
		id="mentions-popup-container"
		v-backdrop="closePopup"
		data-escape-close="mentions"
		@contextmenu.self="closePopup"
	>
		<div
			ref="popup"
			class="mentions-popup"
			role="dialog"
			aria-labelledby="mentions-popup-heading"
			tabindex="-1"
			:style="placement"
			@keydown.capture="onPaneKey"
			@keydown.tab="onTab"
			@keydown.down.exact.prevent="moveFocus($event, 1)"
			@keydown.up.exact.prevent="moveFocus($event, -1)"
		>
			<div class="mentions-popup-title">
				<h2 id="mentions-popup-heading">
					Mentions
					<span v-if="total" class="mentions-total" :aria-label="`${total} unread`">{{
						total
					}}</span>
				</h2>
				<button v-if="total" class="oper-btn oper-btn-ghost" @click="dismissAllMentions()">
					Dismiss all
				</button>
				<!-- On the phone the pane is the whole screen: nothing outside it to tap. -->
				<button
					class="mentions-close"
					type="button"
					aria-label="Close mentions"
					@click="closePopup"
				>
					✕
				</button>
			</div>

			<div v-if="groups.length === 0" class="mentions-empty">
				<span class="mentions-empty-icon" aria-hidden="true"></span>
				<p class="mentions-empty-title">You're all caught up</p>
				<p class="mentions-empty-hint">
					A mention leaves this list once you read it, here or on any other device.
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
							:title="group.conversation ? `Open ${group.target}` : group.missing"
							@click="openGroup(group)"
						>
							<span class="mentions-group-name">{{ group.target }}</span>
							<span v-if="group.networkName" class="mentions-group-network">{{
								group.networkName
							}}</span>
							<span
								v-if="!group.query && groups.length > 1"
								class="mentions-group-count"
								>{{ group.entries.length }}</span
							>
						</button>
						<!-- A conversation this page no longer has: reading cannot clear it. -->
						<button
							v-if="!group.conversation"
							class="oper-btn oper-btn-ghost"
							@click="dismissGroup(group)"
						>
							Dismiss
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
							{'mentions-entry-openable': group.conversation},
						]"
						tabindex="0"
						@click="openFromRow($event, group)"
						@keydown.enter.self.prevent="openGroup(group)"
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
							<time
								class="time"
								:datetime="message.time"
								:title="message.localetime"
								>{{ messageTime(message.time) }}</time
							>
							<span v-if="group.unreadLabel" class="mentions-group-unread">{{
								group.unreadLabel
							}}</span>
							<button
								class="msg-dismiss"
								title="Dismiss on this device"
								aria-label="Dismiss on this device"
								@click.stop="dismissRow($event, group, message)"
							></button>
						</div>
						<div class="content" dir="auto">
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
				</section>
			</div>

			<!-- Dismiss all takes a lot at once, so it can be taken back until the pane closes. -->
			<div v-if="undoableMentions.length" class="mentions-undo" role="status">
				<span>Dismissed {{ undoableMentions.length }} on this device</span>
				<button class="btn btn-sm" @click="undoDismiss">Undo</button>
			</div>

			<div v-if="groups.length" class="mentions-keys" aria-hidden="true">
				<span><kbd>↑</kbd><kbd>↓</kbd> move</span>
				<span><kbd>↵</kbd> open</span>
				<span
					><kbd>{{ isApple ? "⌫" : "Bksp" }}</kbd> dismiss</span
				>
				<span class="mentions-keys-close"
					><kbd>{{ isApple ? "⌥" : "Alt" }}</kbd
					><kbd>M</kbd> close</span
				>
			</div>
		</div>
	</div>
</template>

<style>
#mentions-popup-container {
	z-index: 8;
}

/* Over a modal window, or Alt+M would open it out of reach; under everything
 * else, as the sidebar and what a nick's menu opens must be over it. */
#viewport:has(> .window.screen-overlay) #mentions-popup-container {
	z-index: 21;
}

.mentions-popup {
	background-color: var(--window-bg-color);
	position: absolute;
	box-sizing: border-box;
	width: min(26rem, calc(100vw - 1rem));
	/* Under the @ button (--mentions-right/-top, set on open), kept on screen. */
	right: clamp(
		0.5rem,
		var(--mentions-right, 5rem),
		calc(100% - min(26rem, 100vw - 1rem) - 0.5rem)
	);
	top: var(--mentions-top, 3.4rem);
	max-height: 25rem;
	display: flex;
	flex-direction: column;
	overflow: hidden;
	z-index: 2;
	padding: 0;
}

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

.mentions-popup > .mentions-popup-title {
	display: flex;
	align-items: center;
	gap: 0.25rem;
	padding: 0.625rem 0.75rem 0.375rem;
}

.mentions-popup-title h2 {
	flex: 1 1 auto;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	margin: 0;
	font-size: 1.125rem;
	font-weight: 700;
	color: var(--window-heading-color, inherit);
}

.mentions-popup .mentions-total {
	margin-inline-start: 0.375rem;
	font-size: 0.8125rem;
	font-weight: normal;
	color: var(--body-color-muted);
}

.mentions-popup .mentions-close {
	flex-shrink: 0;
	min-width: 2.25rem;
	min-height: 2.25rem;
	margin: -0.375rem -0.375rem -0.375rem 0;
	padding: 0;
	border: 0;
	background: none;
	color: var(--body-color-muted);
	font-size: 1.125rem;
	line-height: 1;
}

.mentions-popup .mentions-close:hover,
.mentions-popup .mentions-close:focus-visible {
	color: var(--body-color);
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

.mentions-keys {
	display: flex;
	flex-wrap: wrap;
	gap: 0.25rem 0.75rem;
	padding: 0.4375rem 0.75rem;
	border-top: 1px solid var(--oper-line);
	color: var(--body-color-muted);
	font-size: 0.75rem;
}

.mentions-keys-close {
	margin-inline-start: auto;
}

.mentions-keys kbd {
	min-width: 1.125rem;
	margin: 0 0.125rem 0 0;
	padding: 0 0.1875rem;
	border-color: var(--oper-line-2);
	background: none;
	box-shadow: none;
	color: inherit;
	font-size: 0.6875rem;
	line-height: 1.0625rem;
	text-shadow: none;
}

/* A finger has no keys to be told about. */
:where(html[data-input="touch"]) .mentions-keys {
	display: none;
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

@media (min-height: 500px) {
	.mentions-popup {
		max-height: 60vh;
	}
}

@media (max-width: 768px), (max-height: 500px) and (hover: none) and (pointer: coarse) {
	.mentions-popup {
		border-radius: 0;
		border: 0;
		box-shadow: none;
		width: 100%;
		max-height: none;
		right: 0;
		left: 0;
		bottom: 0;
		top: 3rem; /* header height */
	}

	/* Placed against #viewport's padding box, which in the shell runs under
	 * the status bar and the navigation bar: start under the header where it
	 * really is, and stop above the bars. */
	html[data-shell="native"] .mentions-popup {
		top: calc(var(--inset-top) + 3rem);
		bottom: var(--inset-outer-bottom);
		left: var(--inset-left);
		right: var(--inset-right);
		width: auto;
	}
}
</style>

<script lang="ts">
import Username from "./Username.vue";
import {cleanIrcMessage} from "../../shared/irc";
import ParsedMessage from "./ParsedMessage.vue";
import {
	dismissAllMentions as dismissAll,
	dismissMentions,
	undoDismissAll,
	undoableMentions,
} from "../js/mentions";
import eventbus from "../js/eventbus";
import {switchToChannel} from "../js/router";
import {isApplePlatform} from "../js/helpers/device";
import {entryKey, groupByConversation} from "../js/helpers/inbox";
import {isTouchInput} from "../js/helpers/inputModality";
import localetime from "../js/helpers/localetime";
import {recentTime} from "../js/helpers/messageTime";
import {clearHighlight, paintHighlight, rangesIn} from "../js/helpers/paintHighlight";
import {trapTab} from "../js/helpers/trapTab";
import {mentionSpans, parseKeywordList} from "../js/highlight";
import {computed, defineComponent, nextTick, ref, onMounted, onUnmounted, watch} from "vue";
import {useStore} from "../js/store";
import type {InboxEntry} from "../../shared/types/mention";
import type {ClientNetwork, NetChan} from "../js/types";
import {ChanType} from "../../shared/types/chan";

type MentionWithContext = InboxEntry & {
	key: string;
	localetime: string;
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
	/** The rows: every mention, or a private conversation's newest line. */
	shown: MentionWithContext[];
};

export default defineComponent({
	name: "Mentions",
	components: {
		Username,
		ParsedMessage,
	},
	setup() {
		const store = useStore();
		const isOpen = ref(false);
		/** Moves the focus for a keyboard: left alone, a finger's raises none. */
		let keyboard = false;

		const groups = computed((): GroupWithContext[] => {
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
					localetime: localetime(new Date(entry.time)),
				}));
				const unread = query ? conversation?.channel.unread ?? 0 : 0;
				const network = store.getters.findNetwork(group.network);
				let missing = "";

				if (!conversation) {
					const where = several && network ? ` on ${network.name}` : "";
					missing = !network
						? "Its network isn't on this page: dismiss these."
						: query
						? `No conversation with ${target}${where} open: open one to read these, or dismiss them.`
						: `Not in ${target}${where}: join it to read these, or dismiss them.`;
				}

				return {
					key: group.key,
					target,
					networkName,
					network: network ?? undefined,
					label: networkName ? `${target} on ${networkName}` : target,
					conversation,
					missing,
					query,
					unreadLabel: unread > 1 ? `${unread} unread` : "",
					entries,
					shown: query ? entries.slice(-1) : entries,
				};
			});
		});

		const total = computed(() => store.getters.mentionCount);

		const messageTime = (time: string) => recentTime(time, store.state.settings);

		// Under the @ button, measured against the container the pane is
		// placed in; the phone layout's rule ignores both.
		const popup = ref<HTMLElement | null>(null);
		const placement = ref<Record<string, string>>({});

		const place = () => {
			const button = document.querySelector("#chat button.mentions");
			const container = popup.value?.offsetParent;

			if (!button || !container) {
				placement.value = {};
				return;
			}

			const b = button.getBoundingClientRect();
			const c = container.getBoundingClientRect();
			placement.value = {
				"--mentions-top": `${b.bottom - c.top}px`,
				"--mentions-right": `${c.right - b.right}px`,
			};
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

		// Opening it reads it, and reading it clears its mentions (inbox:read).
		// A group without a conversation says why in its head.
		const openGroup = (group: GroupWithContext) => {
			if (!group.conversation) {
				return;
			}

			isOpen.value = false;
			switchToChannel(group.conversation.channel);
		};

		// A click on the row opens the conversation; one on a link, a nick
		// or a channel in the text, or a selection being made, does not.
		const openFromRow = (event: MouseEvent, group: GroupWithContext) => {
			const target = event.target as HTMLElement | null;

			if (target?.closest("a, button, .user, .inline-channel")) {
				return;
			}

			if (window.getSelection()?.toString()) {
				return;
			}

			openGroup(group);
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
			isOpen,
			popup,
			placement,
			groups,
			cleanIrcMessage,
			total,
			undoableMentions,
			isApple: isApplePlatform(),
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
			closePopup,
		};
	},
});
</script>
