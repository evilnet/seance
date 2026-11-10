<template>
	<div id="chat-container" class="window" :data-current-channel="channel.name" lang="">
		<div
			id="chat"
			ref="chatPane"
			:class="{
				'hide-motd': !store.state.settings.motd,
				'time-seconds': store.state.settings.showSeconds,
				'time-12h': store.state.settings.use12hClock,
				'colored-nicks': true, // TODO temporarily fixes themes, to be removed in next major version
				disconnected: isDisconnected,
			}"
		>
			<div
				:id="'chan-' + channel.id"
				class="chat-view"
				:data-type="channel.type"
				:aria-label="channel.name"
				role="tabpanel"
			>
				<div class="header" :data-tauri-drag-region="dragRegion">
					<SidebarToggle />
					<span class="title" :aria-label="openTitle"
						><bdi>{{ channel.name }}</bdi></span
					>
					<div
						v-if="channel.editTopic === true"
						class="topic-container"
						data-tauri-drag-region="false"
					>
						<input
							ref="topicInput"
							dir="auto"
							:value="channel.topic"
							class="topic-input"
							:placeholder="topicPlaceholder"
							enterkeyhint="done"
							@keyup.enter="saveTopic"
							@keyup.esc="channel.editTopic = false"
						/>
						<span :aria-label="saveTopicLabel" class="save-topic" @click="saveTopic">
							<span :aria-label="saveTopicLabel"></span>
						</span>
					</div>
					<span
						v-else
						:title="topicTitle"
						:class="{topic: true, empty: !channel.topic}"
						data-tauri-drag-region="false"
						@dblclick="editTopic"
						><button
							v-if="topicTranslation"
							type="button"
							class="topic-flip"
							:class="{original: topicTranslation.hidden}"
							:aria-label="topicFlipLabel"
							:title="topicFlipLabel"
							:aria-pressed="!topicTranslation.hidden"
							@click.stop="flipTopic"
							@dblclick.stop
						>
							<i class="fas fa-language" aria-hidden="true" /></button
						><ParsedMessage v-if="channel.topic" :network="network" :text="topicShown"
					/></span>
					<MessageSearchForm
						v-if="['channel', 'query'].includes(channel.type)"
						:channel="channel"
					/>
					<span
						v-if="network.status.connecting"
						class="connecting-tooltip tooltipped tooltipped-w tooltipped-no-touch"
						:data-tooltip="connectingLabel"
					>
						<span
							class="connecting-indicator"
							role="status"
							:aria-label="connectingLabel"
						/>
					</span>
					<button class="mentions" :aria-label="mentionsLabel" @click="openMentions">
						<span v-if="mentionCount" class="mentions-badge" aria-hidden="true">{{
							mentionBadge
						}}</span>
					</button>
					<button class="menu" :aria-label="contextMenuLabel" @click="openContextMenu" />
					<span
						v-if="channel.type === 'channel'"
						class="rt-tooltip tooltipped tooltipped-w"
						:aria-label="toggleUserlistLabel"
					>
						<button
							class="rt"
							:aria-label="toggleUserlistLabel"
							@click="store.commit('toggleUserlist')"
						/>
					</span>
				</div>
				<div v-if="channel.type === 'special'" class="chat-content">
					<div class="chat">
						<div class="messages">
							<div class="msg">
								<component
									:is="specialComponent"
									:network="network"
									:channel="channel"
								/>
							</div>
						</div>
					</div>
				</div>
				<div v-else class="chat-content">
					<button
						:class="[
							'scroll-down tooltipped tooltipped-w tooltipped-no-touch',
							{'scroll-down-shown': !channel.scrolledToBottom && !channel.past},
						]"
						:aria-label="jumpToRecentLabel"
						@click="messageList?.jumpToBottom()"
					>
						<div class="scroll-down-arrow" />
					</button>
					<ChatUserList v-if="channel.type === 'channel'" :channel="channel" />
					<MessageList
						ref="messageList"
						:network="network"
						:channel="channel"
						:focused="focused"
					/>
				</div>
				<p class="sr-only" role="status">{{ pastStatus }}</p>
				<div v-if="channel.past || channel.pastOpening" class="past-bar">
					<span v-if="pastStatus" class="past-bar-text">{{ pastStatus }}</span>
					<button
						v-if="channel.past"
						class="btn btn-sm past-bar-present"
						@click="leavePast"
					>
						{{ t("chat.past.jumpToPresent") }}
					</button>
				</div>
			</div>
		</div>
		<div
			v-if="store.state.currentUserVisibleError"
			id="user-visible-error"
			@click="hideUserVisibleError"
		>
			{{ store.state.currentUserVisibleError }}
		</div>
		<ChatInput :network="network" :channel="channel" />
	</div>
</template>

<script lang="ts">
import socket from "../js/socket";
import eventbus from "../js/eventbus";
import ParsedMessage from "./ParsedMessage.vue";
import MessageList from "./MessageList.vue";
import {closePast} from "../js/pastView";
import ChatInput from "./ChatInput.vue";
import ChatUserList from "./ChatUserList.vue";
import SidebarToggle from "./SidebarToggle.vue";
import MessageSearchForm from "./MessageSearchForm.vue";
import ListBans from "./Special/ListBans.vue";
import ListInvites from "./Special/ListInvites.vue";
import ListExcepts from "./Special/ListExcepts.vue";
import ListIgnored from "./Special/ListIgnored.vue";
import {
	defineComponent,
	PropType,
	ref,
	computed,
	watch,
	nextTick,
	onMounted,
	onBeforeUnmount,
	Component,
} from "vue";
import {watchUserlistOverlay} from "../js/userlistOverlay";
import {macDragRegion} from "../js/helpers/shell";
import {channelOpened} from "../js/helpers/lastChannel";
import {prefetchEmojiCatalog} from "../js/helpers/emoji";
import type {ClientNetwork, ClientChan} from "../js/types";
import {useStore} from "../js/store";
import {SpecialChanType, ChanType} from "../../shared/types/chan";
import {layout, toPlainText} from "../js/helpers/ircmessageparser/layout";
import {useI18n} from "../js/i18n";
import {formatNumber} from "../js/i18n/numbers";
import {channelTranslation, readTopic, readingLanguage, showOriginal} from "../js/translate/reader";
import {topicEntryId} from "../js/translate/topic";

export default defineComponent({
	name: "Chat",
	components: {
		ParsedMessage,
		MessageList,
		ChatInput,
		ChatUserList,
		SidebarToggle,
		MessageSearchForm,
	},
	props: {
		network: {type: Object as PropType<ClientNetwork>, required: true},
		channel: {type: Object as PropType<ClientChan>, required: true},
		focused: Number,
	},
	setup(props) {
		const store = useStore();
		const {t, tCount} = useI18n();

		const messageList = ref<typeof MessageList>();
		const topicInput = ref<HTMLInputElement | null>(null);

		const pastStatus = computed(() => {
			if (props.channel.pastOpening) {
				return t("chat.past.loading");
			}

			if (!props.channel.past) {
				return "";
			}

			return props.channel.past.failed ? t("chat.past.loadFailed") : t("chat.past.viewing");
		});
		// The button goes with the view: the focus goes where the reader types.
		const leavePast = () => {
			closePast(props.channel);
			eventbus.emit("input:focus");
		};

		const plainTopic = computed(() => {
			const topic = props.channel.topic;

			if (!topic) {
				return "";
			}

			return toPlainText(layout(topic, {markdown: store.state.settings.markdown}));
		});

		// Screen-reader frame around the conversation name in the header;
		// {type} is the app's internal kind ("channel", "query", "lobby",
		// "special") and is inserted as-is.
		const openTitle = computed(() => t("chat.currentlyOpen", {type: props.channel.type}));

		const topicPlaceholder = computed(() => t("chat.topicPlaceholder"));
		const saveTopicLabel = computed(() => t("chat.saveTopic"));

		// The topic, read like the channel's lines (reader.ts `readTopic`,
		// topic.ts): a finished translation takes the topic's place in the
		// header rather than a row of its own, and the flipper before it
		// swaps the two. The tooltip carries whichever is not shown.
		const topicTranslation = computed(() => {
			const entry = store.state.translations[topicEntryId(props.channel.id)];

			return entry && entry.status === "done" && entry.text ? entry : undefined;
		});
		const topicShown = computed(() =>
			topicTranslation.value && !topicTranslation.value.hidden
				? topicTranslation.value.text
				: props.channel.topic
		);
		const topicTitle = computed(() => {
			const entry = topicTranslation.value;

			if (!entry || entry.hidden) {
				return entry
					? toPlainText(layout(entry.text, {markdown: store.state.settings.markdown}))
					: plainTopic.value;
			}

			return plainTopic.value;
		});
		const topicFlipLabel = computed(() =>
			topicTranslation.value?.hidden
				? t("translate.topic.showTranslation")
				: t("translate.topic.showOriginal")
		);

		const flipTopic = () => {
			const entry = topicTranslation.value;

			if (entry) {
				showOriginal(topicEntryId(props.channel.id), !entry.hidden);
			}
		};

		watch(
			() => [
				props.channel.id,
				props.channel.topic,
				channelTranslation(props.network, props.channel).exclude,
				readingLanguage(),
			],
			() => void readTopic(props.network, props.channel),
			{immediate: true}
		);
		const contextMenuLabel = computed(() => t("chat.contextMenu"));
		const toggleUserlistLabel = computed(() => t("chat.toggleUserlist"));
		const jumpToRecentLabel = computed(() => t("chat.jumpToRecent"));

		const connectingLabel = computed(() =>
			props.network.name
				? t("chat.connectingTo", {network: props.network.name})
				: t("chat.connecting")
		);

		// A conversation whose network is down is faded (like a pending
		// message) until it registers again; the lobby reads as usual, it is
		// where the connection reports.
		const isDisconnected = computed(
			() =>
				!props.network.status.connected &&
				(props.channel.type === ChanType.CHANNEL || props.channel.type === ChanType.QUERY)
		);

		const specialComponent = computed(() => {
			switch (props.channel.special) {
				case SpecialChanType.BANLIST:
					return ListBans as Component;
				case SpecialChanType.INVITELIST:
					return ListInvites as Component;
				case SpecialChanType.EXCEPTLIST:
					return ListExcepts as Component;
				case SpecialChanType.IGNORELIST:
					return ListIgnored as Component;
			}

			return undefined;
		});

		const channelChanged = () => {
			// Triggered when active channel is set or changed
			socket.emit("open", props.channel.id);

			// Where the user is, for the next page load to come back to
			// (helpers/lastChannel.ts); the lobby and special windows do
			// not count, and this calls off a restore the user got ahead of.
			channelOpened(props.network.uuid, props.channel.name, props.channel.type);

			// A conversation is where reactions happen: the emoji catalog
			// chunk is fetched now, at idle, so the picker never waits for it
			// (helpers/emoji.ts). Not from the lobby — nothing there reacts.
			if (props.channel.type !== ChanType.LOBBY) {
				prefetchEmojiCatalog();
			}

			if (props.channel.usersOutdated) {
				props.channel.usersOutdated = false;

				socket.emit("names", {
					target: props.channel.id,
				});
			}
		};

		const hideUserVisibleError = () => {
			store.commit("currentUserVisibleError", null);
		};

		const editTopic = () => {
			if (props.channel.type === ChanType.CHANNEL) {
				props.channel.editTopic = true;
			}
		};

		const saveTopic = () => {
			props.channel.editTopic = false;

			if (!topicInput.value) {
				return;
			}

			const newTopic = topicInput.value.value;

			if (props.channel.topic !== newTopic) {
				const target = props.channel.id;
				const text = `/topic ${newTopic}`;
				socket.emit("input", {target, text});
			}
		};

		const openContextMenu = (event: any) => {
			eventbus.emit("contextmenu:channel", {
				event: event,
				channel: props.channel,
				network: props.network,
			});
		};

		// Unread mentions on every network: the @ button's badge.
		const mentionCount = computed(() => store.getters.mentionCount);
		const mentionBadge = computed(() =>
			mentionCount.value > 99
				? t("chat.mentionsBadgeOver", {count: 99})
				: formatNumber(mentionCount.value)
		);
		const mentionsLabel = computed(() =>
			mentionCount.value
				? tCount("chat.mentionsUnread", mentionCount.value, {count: mentionCount.value})
				: t("chat.mentions")
		);

		const openMentions = (event: any) => {
			eventbus.emit("mentions:toggle", {
				event: event,
			});
		};

		watch(
			() => props.channel,
			() => {
				channelChanged();
			}
		);

		watch(
			() => props.channel.editTopic,
			(newTopic) => {
				if (newTopic) {
					void nextTick(() => {
						topicInput.value?.focus();
					});
				}
			}
		);

		const chatPane = ref<HTMLElement | null>(null);
		let stopUserlistOverlay: (() => void) | null = null;

		onBeforeUnmount(() => {
			stopUserlistOverlay?.();
		});

		onMounted(() => {
			if (chatPane.value) {
				stopUserlistOverlay = watchUserlistOverlay(chatPane.value);
			}

			channelChanged();

			if (props.channel.editTopic) {
				void nextTick(() => {
					topicInput.value?.focus();
				});
			}
		});

		return {
			chatPane,
			dragRegion: macDragRegion(),
			leavePast,
			pastStatus,
			store,
			t,
			messageList,
			topicInput,
			plainTopic,
			openTitle,
			topicPlaceholder,
			saveTopicLabel,
			topicTranslation,
			topicShown,
			topicTitle,
			topicFlipLabel,
			flipTopic,
			mentionsLabel,
			contextMenuLabel,
			toggleUserlistLabel,
			jumpToRecentLabel,
			connectingLabel,
			isDisconnected,
			specialComponent,
			hideUserVisibleError,
			editTopic,
			saveTopic,
			openContextMenu,
			openMentions,
			mentionCount,
			mentionBadge,
		};
	},
});
</script>
