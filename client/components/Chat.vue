<template>
	<div id="chat-container" class="window" :data-current-channel="channel.name" lang="">
		<div
			id="chat"
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
				<div class="header">
					<SidebarToggle />
					<span class="title" :aria-label="openTitle"
						><bdi>{{ channel.name }}</bdi></span
					>
					<div v-if="channel.editTopic === true" class="topic-container">
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
							<span type="button" :aria-label="saveTopicLabel"></span>
						</span>
					</div>
					<span
						v-else
						:title="topicTitle"
						:class="{topic: true, empty: !channel.topic}"
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
						:network="network"
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
					<span
						v-if="translationAvailable"
						class="translate-tooltip tooltipped tooltipped-w tooltipped-no-touch"
						:data-tooltip="translateLabel"
					>
						<button
							class="translate"
							:class="{on: translationOn, unavailable: translationBlocked}"
							:aria-label="translateLabel"
							:aria-pressed="touch ? undefined : translationOn"
							:aria-expanded="translationPanelOpen"
							@click="onTranslateClick"
							@contextmenu.prevent="openTranslationPanel"
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
				<TranslationPanel
					v-if="translationPanelOpen"
					:channel="channel"
					:network="network"
					@close="translationPanelOpen = false"
				/>
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
							{'scroll-down-shown': !channel.scrolledToBottom},
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
import ChatInput from "./ChatInput.vue";
import ChatUserList from "./ChatUserList.vue";
import SidebarToggle from "./SidebarToggle.vue";
import MessageSearchForm from "./MessageSearchForm.vue";
import ListBans from "./Special/ListBans.vue";
import ListInvites from "./Special/ListInvites.vue";
import ListExcepts from "./Special/ListExcepts.vue";
import ListChannels from "./Special/ListChannels.vue";
import ListIgnored from "./Special/ListIgnored.vue";
import TranslationPanel from "./TranslationPanel.vue";
import {defineComponent, PropType, ref, computed, watch, nextTick, onMounted, Component} from "vue";
import {channelOpened} from "../js/helpers/lastChannel";
import {prefetchEmojiCatalog} from "../js/helpers/emoji";
import type {ClientNetwork, ClientChan} from "../js/types";
import {useStore} from "../js/store";
import {SpecialChanType, ChanType} from "../../shared/types/chan";
import {layout, toPlainText} from "../js/helpers/ircmessageparser/layout";
import {useI18n} from "../js/i18n";
import {formatNumber} from "../js/i18n/numbers";
import {
	channelTranslation,
	readTopic,
	readingLanguage,
	setReading,
	showOriginal,
	translationAvailable as translationAvailableNow,
	currentTranslationBlock,
} from "../js/translate/reader";
import {topicEntryId} from "../js/translate/topic";
import {languageName} from "../js/translate/languages";
import {hasVirtualKeyboard} from "../js/helpers/device";

export default defineComponent({
	name: "Chat",
	components: {
		ParsedMessage,
		MessageList,
		ChatInput,
		ChatUserList,
		SidebarToggle,
		MessageSearchForm,
		TranslationPanel,
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
				channelTranslation(props.network, props.channel).read,
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
				case SpecialChanType.CHANNELLIST:
					return ListChannels as Component;
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

		const translationPanelOpen = ref(false);
		const translationState = computed(() => channelTranslation(props.network, props.channel));
		const translationAvailable = computed(
			() =>
				(props.channel.type === ChanType.CHANNEL ||
					props.channel.type === ChanType.QUERY) &&
				translationAvailableNow()
		);
		// The light means reading; a write target shows in the tooltip.
		const translationOn = computed(() => translationState.value.read);
		// A touch device has no right-click, so the tap is what opens the
		// panel there and the button says so; the click keeps toggling
		// reading where there is a pointer.
		const touch = hasVirtualKeyboard();
		// Nothing here can translate (router.ts `translationBlock`): the button
		// stays, says so, and opens the panel, whose banner gives the reason.
		const translationBlocked = computed(() => !!currentTranslationBlock());
		const translateLabel = computed(() => {
			// Before the touch label: a tap opens the panel either way, but
			// the button's name should not promise settings when nothing
			// here can translate.
			if (translationBlocked.value) {
				return t("translate.unavailable.lead");
			}

			if (touch) {
				return t("translate.header.settings");
			}

			// Every language the tooltip names is named in the language the
			// reader reads this channel in (F40), like every other label.
			const name = (code: string) => languageName(code, readingLanguage());
			const {read, write} = translationState.value;
			const paused = store.state.translation.paused;
			// One whole phrase per state (reading on/off × a write target ×
			// paused): the tooltip is never assembled from translated pieces,
			// and every key is a literal the pot check can see.
			const vars = {
				reading: name(readingLanguage()),
				writing: write ? name(write) : "",
				// The engine's own text: a verbatim value, never translated.
				reason: paused ? paused.message : "",
			};

			if (paused) {
				if (read) {
					return write
						? t("translate.header.readWritePaused", vars)
						: t("translate.header.readPaused", vars);
				}

				return write
					? t("translate.header.offWritePaused", vars)
					: t("translate.header.offPaused", vars);
			}

			if (read) {
				return write
					? t("translate.header.readWrite", vars)
					: t("translate.header.read", vars);
			}

			return write ? t("translate.header.offWrite", vars) : t("translate.header.off", vars);
		});

		const openTranslationPanel = () => {
			translationPanelOpen.value = true;
		};

		const toggleTranslation = () => {
			const wasOn = translationState.value.read;

			setReading(props.network, props.channel, !wasOn);

			// Switching a channel on opens its panel with it: the reader sees
			// which languages they just asked for and can adjust them at once,
			// where the click alone would silently pick the global target.
			// Switching off is the whole of what switching off means.
			if (!wasOn) {
				openTranslationPanel();
			}
		};

		const onTranslateClick = () => {
			if (touch || translationBlocked.value) {
				openTranslationPanel();
			} else {
				toggleTranslation();
			}
		};

		watch(
			() => props.channel.id,
			() => {
				translationPanelOpen.value = false;
			}
		);

		// The channel menu's "Translation…" switches to the channel and
		// leaves its id in the store, so the ask survives the switch: open
		// the panel once this view is the channel that was asked for, and
		// clear it. Registered after the watcher above, which closes the
		// panel on a channel change and would otherwise undo this one.
		const openPanelIfAsked = () => {
			if (store.state.translation.panelFor === props.channel.id) {
				translationPanelOpen.value = true;
				store.commit("translationPanelFor", null);
			}
		};

		watch(() => [props.channel.id, store.state.translation.panelFor], openPanelIfAsked);

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

		onMounted(() => {
			channelChanged();
			openPanelIfAsked();

			if (props.channel.editTopic) {
				void nextTick(() => {
					topicInput.value?.focus();
				});
			}
		});

		return {
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
			translationPanelOpen,
			translationAvailable,
			translationOn,
			translationBlocked,
			translateLabel,
			touch,
			onTranslateClick,
			openTranslationPanel,
			mentionCount,
			mentionBadge,
		};
	},
});
</script>
