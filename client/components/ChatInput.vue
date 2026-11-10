<template>
	<form id="form" method="post" action="" @submit.prevent="onSubmit()">
		<TypingIndicator :channel="channel" />
		<div v-if="showConnectionBar" class="connection-bar" role="status" aria-live="polite">
			<span
				:class="[
					'connection-bar-icon',
					{spinning: network.status.connecting && retryInSeconds === 0},
				]"
				aria-hidden="true"
			></span>
			<span :class="['connection-bar-label', {throttled: throttledWait}]">{{
				connectionLabel
			}}</span>
			<button
				v-if="canConnectNow"
				type="button"
				class="connection-bar-connect"
				@click="connectNetwork"
			>
				{{ network.status.connecting ? t("composer.connectNow") : t("composer.connect") }}
			</button>
		</div>
		<div
			v-if="store.state.uploadProgress"
			class="upload-bar"
			role="status"
			aria-live="polite"
			:aria-label="uploadLabel"
		>
			<span class="upload-bar-label">
				<span class="upload-bar-icon" aria-hidden="true"></span>
				{{ uploadLabel }}
			</span>
			<span :class="['upload-bar-track', {indeterminate: uploadPercent === null}]">
				<span
					class="upload-bar-fill"
					:style="{width: (uploadPercent === null ? 100 : uploadPercent) + '%'}"
				></span>
			</span>
			<span class="upload-bar-percent">{{
				uploadPercent === null ? "" : uploadPercent + "%"
			}}</span>
			<button
				type="button"
				class="compose-bar-cancel"
				:aria-label="cancelUploadLabel"
				:title="cancelUploadLabel"
				@click="cancelUpload"
			>
				✕
			</button>
		</div>
		<div v-if="channel.editing || channel.replyTo" class="compose-bar" role="status">
			<span v-if="channel.editing" class="compose-bar-label">
				<span class="compose-bar-icon" aria-hidden="true">✎</span>
				{{ t("composer.editing") }}
				<span class="compose-bar-preview"
					><QuotePreview :text="composeTarget?.text ?? ''"
				/></span>
			</span>
			<span v-else class="compose-bar-label">
				<span class="compose-bar-icon" aria-hidden="true">↩</span>
				{{ replyingParts.prefix
				}}<strong v-if="replyingParts.nick" class="compose-bar-nick">{{
					replyingParts.nick
				}}</strong
				>{{ replyingParts.suffix }}
				<span class="compose-bar-preview"
					><QuotePreview :text="composeTarget?.text ?? ''"
				/></span>
			</span>
			<button
				type="button"
				class="compose-bar-cancel"
				:aria-label="cancelComposeLabel"
				:title="cancelComposeTitle"
				@click="cancelCompose(channel)"
			>
				✕
			</button>
		</div>
		<!-- A one-time translation note (translate/reader.ts `showNote`):
		     what switching translation on changed when nothing on screen
		     showed it, or, after an upgrade, that every conversation now
		     reads. Same card as the suggestion below. -->
		<div
			v-if="translationNote"
			class="translate-suggest translate-note"
			role="region"
			aria-labelledby="translate-note-lead"
		>
			<p id="translate-note-lead" class="translate-suggest-lead">{{ translationNote }}</p>
			<div class="translate-suggest-actions">
				<button
					v-if="store.state.translation.note === 'everywhere'"
					type="button"
					class="btn btn-sm translate-note-choose"
					@click="chooseConversations"
				>
					{{ t("translate.note.choose") }}
				</button>
				<button
					type="button"
					class="btn btn-sm translate-suggest-accept translate-note-dismiss"
					@click="dismissNote"
				>
					{{ t("translate.note.dismiss") }}
				</button>
			</div>
		</div>
		<TranslationDiscovery :network="network" :channel="channel" />
		<!-- The translate panel: typed in the user's language, inserted into
		     the composer as its translation. The composer is never
		     translated on its own; what is sent is what the box holds. -->
		<TranslatePanel
			v-if="panelOpen && translateOnceAvailable"
			:network="network"
			:channel="channel"
			:to="panelTo"
			:from="panelFrom"
			@choose="choosePanelLanguage"
			@insert="insertTranslation"
			@close="closePanel"
		/>
		<span id="nick">{{ network.nick }}</span>
		<label for="input" class="sr-only">{{ t("composer.inputLabel") }}</label>
		<textarea
			id="input"
			ref="input"
			dir="auto"
			class="mousetrap"
			enterkeyhint="send"
			autocomplete="off"
			:value="channel.pendingMessage"
			:placeholder="getInputPlaceholder(channel)"
			@input="setPendingMessage"
			@keydown="onComposerKeydown"
			@keypress.enter.exact="onEnterKey"
			@blur="onBlur"
		/>
		<!-- Typing `:name` opens the message toolbar's emoji picker over the
		     composer (helpers/emojiTrigger.ts); the emoji picked replaces it. -->
		<ReactionPicker
			v-if="emojiPick"
			ref="emojiPicker"
			:anchor="input ?? null"
			insert
			:search="emojiPick.term"
			@pick="insertEmoji"
			@close="closeEmojiPick"
		/>
		<span
			v-if="translateOnceAvailable"
			id="translate-once-tooltip"
			class="tooltipped tooltipped-w tooltipped-no-touch"
			:aria-label="translateOnceLabel"
		>
			<!-- Opens the translate panel. Dashed while a reply suggests a
			     language (a French line: "FR"), solid while this conversation
			     has one it last wrote in. -->
			<button
				id="translate-once"
				ref="translateOnceButton"
				type="button"
				:class="{on: !!buttonCode, suggested: !!suggestedCode}"
				:aria-label="translateOnceLabel"
				:aria-expanded="panelOpen"
				aria-controls="translate-panel-input"
				:disabled="!canSend"
				@mousedown.prevent
				@click="togglePanel"
			>
				<span v-if="buttonCode" class="translate-once-target" aria-hidden="true">{{
					buttonCode
				}}</span>
			</button>
		</span>
		<!-- The conversation's translation sheet: from the chip above, or the
		     channel menu's "Translation…" (anchored on the ⋮ then), which
		     also opens it while the user's switch has translation off. -->
		<TranslationSheet
			v-if="translateOncePickerOpen && (translateOnceAvailable || translationOffByUser())"
			:anchor="sheetAnchor"
			:network="network"
			:channel="channel"
			:target="sendTarget"
			:initial-to="translateOncePreselected"
			:initial-from="translateOnceFrom"
			:once-offered="false"
			:once-first="sheetOnceFirst"
			:list-first="sheetListFirst"
			@pick="translateOnce"
			@off="turnTranslateOff"
			@reset="resetChoices"
			@close="translateOncePickerOpen = false"
		/>
		<span
			v-if="store.state.serverConfiguration?.fileUpload || networkFilehost"
			id="upload-tooltip"
			class="tooltipped tooltipped-w tooltipped-no-touch"
			:aria-label="uploadFileLabel"
			@click="openFileUpload"
		>
			<input
				id="upload-input"
				ref="uploadInput"
				type="file"
				aria-labelledby="upload"
				multiple
				:accept="uploadAccept"
				@change="onUploadInputChange"
			/>
			<button
				id="upload"
				type="button"
				:aria-label="uploadFileLabel"
				:disabled="!network.status.connected"
			/>
		</span>
		<span
			id="submit-tooltip"
			class="tooltipped tooltipped-w tooltipped-no-touch"
			:data-tooltip="sendTooltip"
		>
			<!-- `mousedown.prevent` keeps focus in the textarea: a tap that blurs
			it drops the keyboard, the viewport grows and the button moves out
			from under the finger before the click lands. -->
			<button
				id="submit"
				type="submit"
				:aria-label="sendLabel"
				:disabled="!canSend"
				@mousedown.prevent
			/>
		</span>
	</form>
</template>

<script lang="ts">
import {closePast} from "../js/pastView";
import Mousetrap from "mousetrap";
import getCaretCoordinates from "textarea-caret";
import {wrapCursor} from "undate";
import autocompletion from "../js/autocompletion";
import {commands} from "../js/commands/index";
import {expandAlias} from "../js/helpers/aliases";
import socket from "../js/socket";
import {clientForNetwork} from "../js/irc/manager";
import upload from "../js/upload";
import eventbus from "../js/eventbus";
import {
	watch,
	computed,
	defineComponent,
	nextTick,
	onMounted,
	PropType,
	reactive,
	ref,
	onUnmounted,
} from "vue";
import type {ClientNetwork, ClientChan} from "../js/types";
import {useStore} from "../js/store";
import {ChanType} from "../../shared/types/chan";
import {
	cancelCompose,
	findEditableAfter,
	findEditableBefore,
	findLastEditable,
	editText,
	startEdit,
} from "../js/helpers/compose";
import {hasVirtualKeyboard} from "../js/helpers/device";
import {useI18n} from "../js/i18n";
import {SUPPORTED_LANGUAGES, languageName} from "../js/translate/languages";
import {draftGate, onceTargetDefault, sendableTranslation} from "../js/translate/outgoing";
import {translationOn} from "../js/translate";
import {
	channelTranslation,
	pairVerdict,
	readingLanguage,
	requestTranslationSheet,
	resetChannelChoices,
	setChannelOptions,
	translationMayRun,
	translationOffByUser,
} from "../js/translate/reader";
import TranslationSheet from "./TranslationSheet.vue";
import TranslatePanel, {type PanelInsert} from "./TranslatePanel.vue";
import TranslationDiscovery from "./TranslationDiscovery.vue";
import {recentLanguages} from "../js/translate/recent";
import {composerOffer} from "../js/translate/offer";
import {
	cancelOutgoing,
	lastOnceTarget,
	noteOutgoingSent,
	recordSentReadBack,
	writeTarget,
} from "../js/translate/writer";

/** How long after a Return its late-arriving newline is still recognised. */
const ENTER_NEWLINE_WINDOW_MS = 500;

import {TypingReporter} from "../js/helpers/typingReporter";
import TypingIndicator from "./TypingIndicator.vue";
import QuotePreview from "./QuotePreview.vue";
import ReactionPicker from "./ReactionPicker.vue";
import {
	closedShortcode,
	emojiToken,
	replaceToken,
	type EmojiToken,
} from "../js/helpers/emojiTrigger";
import {emojiForName} from "../js/helpers/emoji";

// How long a conversation's network has to be down before the strip above
// the composer says so.
const CONNECTION_BAR_GRACE_MS = 10_000;

const formattingHotkeys = {
	"mod+k": "\x03",
	"mod+b": "\x02",
	"mod+u": "\x1F",
	"mod+i": "\x1D",
	"mod+o": "\x0F",
	"mod+s": "\x1e",
	"mod+m": "\x11",
};

// Autocomplete bracket and quote characters like in a modern IDE
// For example, select `text`, press `[` key, and it becomes `[text]`
const bracketWraps = {
	'"': '"',
	"'": "'",
	"(": ")",
	"<": ">",
	"[": "]",
	"{": "}",
	"*": "*",
	"`": "`",
	"~": "~",
	_: "_",
};

export default defineComponent({
	name: "ChatInput",
	components: {
		TranslatePanel,
		TranslationSheet,
		TranslationDiscovery,
		TypingIndicator,
		QuotePreview,
		ReactionPicker,
	},
	props: {
		network: {type: Object as PropType<ClientNetwork>, required: true},
		channel: {type: Object as PropType<ClientChan>, required: true},
	},
	setup(props) {
		const store = useStore();
		const {t, tCount} = useI18n();
		const input = ref<HTMLTextAreaElement>();
		const uploadInput = ref<HTMLInputElement>();
		const autocompletionRef = ref<ReturnType<typeof autocompletion>>();

		/**
		 * Until when an `input` event holding nothing but newlines is the
		 * Return that already sent (see onEnterKey). iOS applies that Return
		 * some 70 ms after the keypress, into a composer the send has emptied;
		 * left there, the next message goes out as a multiline batch with an
		 * empty first line (ERR_NOTEXTTOSEND).
		 */
		let enterNewlineDeadline = 0;

		/**
		 * Plain assignment on purpose. iOS's stuck shift key (see onEnterKey)
		 * is not fixable from here: focus(), blur()+focus(), a deferred clear,
		 * execCommand("delete") and setRangeText were all tried.
		 */
		const clearInput = () => {
			if (input.value) {
				input.value.value = "";
			}
		};

		const setInputSize = () => {
			void nextTick(() => {
				if (!input.value) {
					return;
				}

				const style = window.getComputedStyle(input.value);
				const lineHeight = parseFloat(style.lineHeight) || 1;

				// Measuring means collapsing the box to one line first, since
				// scrollHeight never shrinks below the box. Hold the form's height
				// meanwhile: the list above is sized by it, and WebKit clamps the
				// list's scroll position to the taller box it sees during that
				// moment, leaving the newest rows under the composer afterwards.
				const form = input.value.form!;

				form.style.minHeight = `${form.offsetHeight}px`;
				input.value.style.height = "";

				// scrollHeight is an integer and the line height is 1.4 × the font
				// size, fractional at every font step but the default: two lines of
				// 22.4px report 45, and ceil would give a third, blank line. Round.
				input.value.style.height = `${
					Math.round(input.value.scrollHeight / lineHeight) * lineHeight
				}px`;
				form.style.minHeight = "";
			});
		};

		// Own typing activity → client→server `typing` (bus-contract §1.5).
		// The reporter tracks what was announced and the 5 s idle timer; the
		// IRC layer throttles to the spec's 3 s rule. Never for the lobby, and
		// silenced entirely by the sendTypingNotifications setting.
		const typing = new TypingReporter((target, state) => {
			if (store.state.settings.sendTypingNotifications) {
				socket.emit("typing", {target, state});
			}
		});

		const reportTyping = () => {
			if (props.channel.type !== ChanType.LOBBY) {
				typing.input(props.channel.id, props.channel.pendingMessage);
			}
		};

		// ---- The emoji picker over the composer ------------------------
		// Typing `:` and two letters of a name opens the message toolbar's
		// picker with its search seeded (helpers/emojiTrigger.ts). The
		// composer keeps the keyboard, so typing on is never lost to the
		// picker (`:wq then` stays text): each keystroke follows into the
		// picker's search, and ArrowUp/Down, Enter, Tab and Escape are handed
		// to it (`onComposerKeydown`); Enter with nothing to insert sends as
		// typed, and Shift+Enter stays the composer's line break. A space, or
		// the colon gone, closes it; so do sending and another channel. Escape
		// or a click away leaves the `:name` as typed, and that same token does
		// not open it again; the emoji picked replaces it. Typing the closing
		// colon of a shortcode (`:tada:`) puts its emoji there at once. Only
		// typing opens it: a paste that ends in `:name` does not.
		const emojiPick = ref<EmojiToken | null>(null);
		const emojiPicker = ref<{navigate(key: string, shift?: boolean): boolean} | null>(null);
		let emojiDismissedAt = -1;
		let emojiPicked = false;

		const followEmojiToken = (el: HTMLTextAreaElement, typed: boolean) => {
			const closed =
				typed && el.selectionStart === el.selectionEnd
					? closedShortcode(el.value, el.selectionStart)
					: null;
			const emoji = closed ? emojiForName(closed.term) : undefined;

			if (closed && emoji) {
				const next = replaceToken(el.value, closed, emoji);

				el.value = next.text;
				el.setSelectionRange(next.caret, next.caret);
				props.channel.pendingMessage = next.text;
				setInputSize();
				emojiDismissedAt = -1;
				emojiPick.value = null;
				return;
			}

			const token =
				el.selectionStart === el.selectionEnd
					? emojiToken(el.value, el.selectionStart)
					: null;

			if (!token) {
				emojiDismissedAt = -1;
				emojiPick.value = null;
				return;
			}

			if (token.start === emojiDismissedAt || (!typed && !emojiPick.value)) {
				emojiPick.value = null;
				return;
			}

			emojiPick.value = token;
		};

		const onComposerKeydown = (e: KeyboardEvent) => {
			const picker = emojiPicker.value;

			if (
				!emojiPick.value ||
				!picker ||
				e.isComposing ||
				e.altKey ||
				e.ctrlKey ||
				e.metaKey
			) {
				return;
			}

			if (!["ArrowUp", "ArrowDown", "Enter", "Escape", "Tab"].includes(e.key)) {
				return;
			}

			// Shift+Enter is the composer's line break, never a pick.
			if (e.shiftKey) {
				return;
			}

			if (picker.navigate(e.key)) {
				// Not Mousetrap's arrows (input history), not the Return that
				// sends, not the Escape that blurs the composer.
				e.preventDefault();
				e.stopImmediatePropagation();
			}
		};

		const insertEmoji = (emoji: string) => {
			const token = emojiPick.value;
			const el = input.value;

			if (!token || !el) {
				return;
			}

			const next = replaceToken(props.channel.pendingMessage, token, emoji);

			emojiPicked = true;
			props.channel.pendingMessage = next.text;
			el.value = next.text;
			setInputSize();

			// After the picker has gone and handed the focus back.
			void nextTick(() => {
				el.focus();
				el.setSelectionRange(next.caret, next.caret);
			});
		};

		const closeEmojiPick = () => {
			if (!emojiPicked && emojiPick.value) {
				emojiDismissedAt = emojiPick.value.start;
			}

			emojiPicked = false;
			emojiPick.value = null;
		};

		// Set by real typing (the input event), so only typing previews: a
		// channel switch restoring a saved draft, or ArrowUp through the
		// history, costs no translation run nobody asked for.

		const setPendingMessage = (e: Event) => {
			const el = e.target as HTMLTextAreaElement;

			// The Return that already sent, or translated, landing late (see onEnterKey).
			if (
				enterNewlineDeadline > performance.now() &&
				(/^\n+$/.test(el.value) || el.value === `${props.channel.pendingMessage}\n`)
			) {
				enterNewlineDeadline = 0;
				el.value = props.channel.pendingMessage;
				setInputSize();
				return;
			}

			enterNewlineDeadline = 0;

			props.channel.pendingMessage = el.value;
			props.channel.inputHistoryPosition = 0;
			props.channel.editDismissed = false; // typing re-arms ArrowUp-to-edit
			setInputSize();
			reportTyping();
			const kind = (e as InputEvent).inputType ?? "";
			followEmojiToken(el, kind === "insertText" || kind === "insertCompositionText");
		};

		const getInputPlaceholder = (channel: ClientChan) => {
			if (channel.type === ChanType.CHANNEL || channel.type === ChanType.QUERY) {
				// The send target is on the translate button ("EN → PT"), not
				// here: a language name made the placeholder wrap on a phone.
				return t("composer.placeholder", {name: channel.name});
			}

			return "";
		};

		// A conversation (channel or query) on a network that is down: the
		// draft can be typed but not sent — only a slash command goes, so
		// `/connect` and friends still work from here — and a strip above the
		// input says what the network is doing. The lobby is left alone: its
		// input is for commands, and it is where the connection reports.
		const isConversation = computed(
			() => props.channel.type === ChanType.CHANNEL || props.channel.type === ChanType.QUERY
		);

		const isDown = computed(() => isConversation.value && !props.network.status.connected);

		// The strip waits until the network has been down for
		// CONNECTION_BAR_GRACE_MS: a resume or a dropped socket usually
		// reconnects within seconds, and a strip for that is noise. With
		// nothing retrying (a /disconnect, a failed SASL login) there is no
		// quick reconnect to wait for, and a message the composer kept
		// because the network is down shows it at once too.
		const now = ref(Date.now());
		const sendRefused = ref(false);

		const showConnectionBar = computed(() => {
			if (!isDown.value) {
				return false;
			}

			const {downSince: since, connecting, retryAt} = props.network.status;

			return (
				sendRefused.value ||
				(!connecting && retryAt === undefined) ||
				(since !== undefined && now.value - since >= CONNECTION_BAR_GRACE_MS)
			);
		});

		const canSend = computed(
			() =>
				props.network.status.connected ||
				!isConversation.value ||
				props.channel.pendingMessage.startsWith("/")
		);

		// The wait before the transport's next retry (`status.retryAt`) counts
		// down here — a tick every half second while the network is down — and
		// "Connect now" skips it (`/connect` restarts the schedule).
		let ticker: ReturnType<typeof setInterval> | null = null;

		const retryInSeconds = computed(() => {
			const at = props.network.status.retryAt;

			if (!props.network.status.connecting || at === undefined) {
				return 0;
			}

			return Math.max(0, Math.ceil((at - now.value) / 1000));
		});

		// The server said the wait is its connection throttle (irc/handlers/error.ts).
		const throttledWait = computed(
			() => retryInSeconds.value > 0 && props.network.status.retryReason === "throttled"
		);

		const connectionLabel = computed(() => {
			const name = props.network.name || t("composer.fallbackNetwork");

			if (!props.network.status.connecting) {
				return t("composer.disconnectedFrom", {network: name});
			}

			if (props.network.status.retryReason === "offline" && retryInSeconds.value > 0) {
				return t("composer.offlineWaiting", {network: name});
			}

			if (throttledWait.value) {
				return tCount("composer.reconnectInThrottled", retryInSeconds.value, {
					network: name,
					seconds: retryInSeconds.value,
				});
			}

			return retryInSeconds.value > 0
				? tCount("composer.reconnectIn", retryInSeconds.value, {
						network: name,
						seconds: retryInSeconds.value,
				  })
				: t("composer.connectingTo", {network: name});
		});

		// Idle, or waiting for a retry: a dial in flight offers nothing.
		const canConnectNow = computed(
			() => !props.network.status.connecting || retryInSeconds.value > 0
		);

		watch(
			isDown,
			(down) => {
				if (!down) {
					sendRefused.value = false;
				}

				if (down && ticker === null) {
					now.value = Date.now();
					ticker = setInterval(() => {
						now.value = Date.now();
					}, 500);
				} else if (!down && ticker !== null) {
					clearInterval(ticker);
					ticker = null;
				}
			},
			{immediate: true}
		);

		watch(
			() => props.network.status.retryAt,
			() => {
				now.value = Date.now();
			}
		);

		// A refused send speaks for the conversation it was typed in, not for
		// the next one opened in this composer.
		watch(
			() => props.channel.id,
			() => {
				sendRefused.value = false;
				// The picker's token is a place in the other channel's draft.
				emojiPick.value = null;
				emojiDismissedAt = -1;
			}
		);

		// The same `/connect` the sidebar's status icon sends; any window of
		// the network routes to its client.
		const connectNetwork = () => {
			socket.emit("input", {target: props.channel.id, text: "/connect"});
		};

		// Reply/edit compose bar (channel.replyTo / channel.editing).
		const composeTarget = computed(() => props.channel.editing || props.channel.replyTo);

		const composeNick = computed(() => composeTarget.value?.from?.nick ?? "");

		// "Replying to {nick}:" keeps the nick emphasized across translations:
		// the translated sentence is split around the substituted nick so it
		// can stay inside its <strong> whatever word order the locale picks.
		const replyingParts = computed(() => {
			const nick = composeNick.value;
			const label = t("composer.replyingTo", {nick});
			const at = nick ? label.indexOf(nick) : -1;

			if (at < 0) {
				return {prefix: label, nick: "", suffix: ""};
			}

			return {
				prefix: label.slice(0, at),
				nick,
				suffix: label.slice(at + nick.length),
			};
		});

		// The strip's labels name their languages in the language the user
		// reads this channel in, not the browser's (reader.ts readingLanguage).
		const readerName = (code: string) => languageName(code, readingLanguage());

		// What Insert put in the composer, per conversation: sent unchanged,
		// it goes as the translation it is (tagged, read back, "sent in
		// French"); edited, it is the user's own message.
		const insertedFor = reactive(new Map<number, PanelInsert>());

		const sendTooltip = computed(() =>
			canSend.value ? t("composer.send") : t("composer.notConnected")
		);

		/**
		 * Run `line` as a UI-only command (`/collapse`, `/search`, …).
		 * True when the line is consumed here and must not reach the bus —
		 * also for a bare `/`, which is not a command at all.
		 */
		const runClientCommand = (line: string): boolean => {
			if (line[0] !== "/" || line[1] === "/") {
				return false;
			}

			const args = line.substring(1).split(" ");
			const cmd = args.shift()?.toLowerCase();

			if (!cmd) {
				return true;
			}

			return (
				Object.prototype.hasOwnProperty.call(commands, cmd) && commands[cmd](args) === true
			);
		};

		/**
		 * Ship `text` as the message; `original` is what the input history
		 * remembers (the draft, when `text` is its translation). Everything
		 * a send does lives here so the plain path, the translated path and
		 * the "send as written" path cannot drift apart. `language` is the
		 * language tags' fields (irc/langtag.ts), given only for a finished
		 * translation into a language the user picked.
		 */
		const deliver = (
			text: string,
			original: string,
			language?: {language: string; machineTranslated: boolean}
		) => {
			const target = props.channel.id;
			const editing = props.channel.editing;
			const replyTo = props.channel.replyTo;

			if (autocompletionRef.value) {
				autocompletionRef.value.hide();
			}

			// What this brings lands in the present, so that is where to be.
			closePast(props.channel);

			props.channel.inputHistoryPosition = 0;
			props.channel.pendingMessage = "";
			insertedFor.delete(target);
			clearInput();
			setInputSize();

			// No `done` on submit: the `input` emit below makes the IRC layer
			// reset its typing state when it sends the PRIVMSG (the message
			// itself ends typing on the receiver), so only forget the
			// announcement here. Slash commands were already `done` when the
			// leading "/" was typed.
			typing.sent(target);

			// Store new message in history if last message isn't already equal
			if (props.channel.inputHistory[1] !== original) {
				props.channel.inputHistory.splice(1, 0, original);
			}

			// Limit input history to a 100 entries
			if (props.channel.inputHistory.length > 100) {
				props.channel.inputHistory.pop();
			}

			// A user-defined alias replaces the line before anything looks at
			// it, so its expansion reaches the UI-only commands below as well
			// as the IRC layer. Never while editing: the edit body is text.
			if (!editing) {
				const expanded = expandAlias(text, {
					chan: props.channel.name,
					me: props.network.nick,
				});

				if (expanded) {
					for (const line of expanded) {
						if (!runClientCommand(line)) {
							socket.emit("input", {target, text: line});
						}
					}

					props.channel.replyTo = null;
					props.channel.editing = null;
					return;
				}
			}

			if (text[0] === "/" && runClientCommand(text)) {
				return false;
			}

			// An edit keeps the parent of the message it replaces; the IRC layer
			// honours `reply`/`edit` for plain text and /me.
			const reply = editing ? editing.replyTo : replyTo?.msgid;
			const edit = editing?.msgid;

			socket.emit("input", {
				target,
				text,
				...(reply ? {reply} : {}),
				...(edit ? {edit} : {}),
				...(language && !edit ? language : {}),
			});

			props.channel.replyTo = null;
			props.channel.editing = null;
		};

		const onSubmit = (fromEnterKey = false, queued = false) => {
			if (!input.value) {
				return;
			}

			// Sending ends a `:name` being picked for (a phone's Return, the
			// send button): it goes as typed.
			emojiPick.value = null;
			emojiDismissedAt = -1;

			// Triggering click event opens the virtual keyboard on mobile
			// This can only be called from another interactive event (e.g. button click)
			// -- which a send waiting for its preview is not: it leaves the
			// focus wherever the user has gone meanwhile.
			if (!queued) {
				input.value.click();
				input.value.focus();
			}

			// No global gate: `/connect` and friends must work from a
			// disconnected network. Plain text in a conversation on a
			// network that is down stays as the draft (`canSend`, the same
			// rule that disables the send button); elsewhere the IRC layer
			// answers it with the `send.notConnected` error.

			// A keyboard that inserts the Return's newline before the keypress
			// fires has already put it in the draft.
			let text = props.channel.pendingMessage;

			if (fromEnterKey && text.endsWith("\n")) {
				text = text.slice(0, -1);
				props.channel.pendingMessage = text;
			}

			if (text.length === 0 || !canSend.value) {
				// Return on an empty composer inserts a newline; an offline
				// composer keeps its draft.
				if (text.length === 0 && fromEnterKey) {
					clearInput();
					setInputSize();
				}

				if (text.length > 0) {
					sendRefused.value = true;
				}

				return false;
			}

			const editing = props.channel.editing;

			// Editing to the identical text is a no-op: just leave edit mode.
			if (editing && text === editText(editing)) {
				cancelCompose(props.channel);
				clearInput();
				setInputSize();
				reportTyping(); // nothing was sent, so this is a real `done`
				return false;
			}

			// A translation Insert put here, sent as it was inserted: it goes
			// as a translation -- tagged with its language and as
			// machine-translated, read back, and "sent in French" on the line.
			// Changed by so much as a character, it is the user's own line.
			const inserted = insertedFor.get(props.channel.id);
			// Matched before the command check: a translation that begins with
			// "/" is still text (sendableTranslation escapes it below).
			if (inserted?.translated && !editing && text === inserted.line) {
				const done = inserted.translated;
				// A corrected line (from and to the same) is the user's own
				// words: not marked machine-made, nothing to read back.
				const polished = done.from !== null && done.from === done.to;
				if (!polished) {
					recordSentReadBack(props.channel, done.entry);
				}

				// A translation is text, never a command, on every line of it
				// (outgoing.ts sendableTranslation): the model wrote it, from a
				// prompt quoting other people's lines.
				const splitsLines =
					clientForNetwork(props.network.uuid)?.multilineLimits() === undefined;
				const line = sendableTranslation(draftGate(done.typed, false), text, splitsLines);

				cancelOutgoing(props.channel);
				deliver(line, text, {language: done.to, machineTranslated: !polished});

				if (!polished) {
					noteOutgoingSent(
						props.network,
						props.channel,
						done.typed,
						text,
						done.to,
						done.from
					);
				}

				return;
			}

			deliver(text, text);
		};

		/**
		 * Return sends. On a touch device the keypress is not cancelled:
		 * cancelling it leaves iOS's shift key down, so every message after the
		 * first starts lowercase. The newline is let through and taken back out
		 * by setPendingMessage when it arrives.
		 *
		 * A held Return sends nothing: the press began elsewhere (on a row of the
		 * Mentions pane, say) and only its repeat reached a saved draft here.
		 */
		const onEnterKey = (e: KeyboardEvent) => {
			if (e.repeat) {
				e.preventDefault();
				return;
			}

			if (!hasVirtualKeyboard()) {
				e.preventDefault();
				onSubmit();
				return;
			}

			enterNewlineDeadline = performance.now() + ENTER_NEWLINE_WINDOW_MS;
			onSubmit(true);
		};

		const onUploadInputChange = () => {
			if (!uploadInput.value || !uploadInput.value.files) {
				return;
			}

			const files = Array.from(uploadInput.value.files);
			upload.triggerUpload(files);
			uploadInput.value.value = ""; // Reset <input> element so you can upload the same file
		};

		const openFileUpload = () => {
			uploadInput.value?.click();
		};

		// The network's own upload host (`draft/FILEHOST` ISUPPORT, kept on
		// the network's serverOptions by `network:options`); it takes
		// precedence over the deploy's uploader (`upload.ts`).
		const networkFilehost = computed(
			() => store.state.activeChannel?.network.serverOptions?.FILEHOST !== undefined
		);

		// The file dialog offers what the uploader takes; the drop and paste
		// paths check the same list in `Uploader.triggerUpload`. A FILEHOST
		// says what it takes only over HTTP, so the dialog stays open-ended.
		const uploadAccept = computed(() => {
			if (networkFilehost.value) {
				return undefined;
			}

			const accept = store.state.branding.uploads?.accept;
			return accept?.length ? accept.join(",") : undefined;
		});

		// Labels and tooltips of the composer's buttons.
		const cancelUploadLabel = computed(() => t("composer.cancelUpload"));
		const cancelComposeLabel = computed(() => t("composer.cancel"));
		const cancelComposeTitle = computed(() => t("composer.cancelEscape"));
		const uploadFileLabel = computed(() => t("composer.uploadFile"));
		const sendLabel = computed(() => t("composer.send"));

		// The strip above the input while a file is going up
		// (`store.state.uploadProgress`, written by `upload.ts`).
		const uploadLabel = computed(() => {
			const progress = store.state.uploadProgress;

			if (!progress) {
				return "";
			}

			const parts = [t("composer.uploading", {file: progress.fileName})];

			if (progress.count > 1) {
				parts.push(
					t("composer.uploadIndex", {index: progress.index, count: progress.count})
				);
			}

			if (progress.phase === "preparing") {
				parts.push(t("composer.uploadPreparing"));
			} else if (progress.phase === "waiting") {
				parts.push(t("composer.uploadWaiting"));
			}

			return parts.join(" · ");
		});

		const uploadPercent = computed(() => {
			const progress = store.state.uploadProgress;

			if (!progress || progress.phase === "preparing" || progress.total <= 0) {
				return null;
			}

			return Math.min(100, Math.round((progress.loaded / progress.total) * 100));
		});

		const cancelUpload = () => {
			upload.abort();
		};

		// Out of older messages first, as Discord's Escape does, unless a field has
		// this press: another one, or a composer with text (its completion menu).
		const blurInput = (layer: string | null) => {
			const focused = document.activeElement;
			const fieldHasIt =
				focused === input.value
					? !!props.channel.pendingMessage
					: focused?.matches("input, textarea, [contenteditable]");

			// With search open, Escape is search's (Windows/SearchResults.vue).
			const searchHasIt = !!document.querySelector("#search-panel:not(.tucked)");

			if (layer === null && props.channel.past && !fieldHasIt && !searchHasIt) {
				closePast(props.channel);
				return;
			}

			input.value?.blur();
		};

		// Opening a conversation puts the caret in the input, at the end of
		// any draft, so typing can start at once — with a keyboard. On a
		// phone or tablet focusing raises the on-screen keyboard and reflows
		// the whole layout, so there the input waits to be tapped.
		const focusForTyping = () => {
			if (hasVirtualKeyboard()) {
				return;
			}

			// After the render that swaps in this channel's draft.
			void nextTick(() => {
				const el = input.value;

				if (!el) {
					return;
				}

				el.focus();
				el.setSelectionRange(el.value.length, el.value.length);
			});
		};

		// The translate button opens the translate panel (TranslatePanel.vue):
		// the user types in their own language, the panel translates it, and
		// Insert puts the translation into the composer. The panel's language
		// is the conversation's (channelStore `write`, the sheet's "Write
		// in"), which the panel's language button changes through the sheet's
		// list. Shown wherever translation can run at all, and while the
		// device probe is still out: a button that appeared when it landed
		// shifted the composer on every app load.
		const translateOnceButton = ref<HTMLButtonElement | null>(null);
		const translateOncePickerOpen = ref(false);
		const translateOnceAvailable = computed(
			() =>
				translationMayRun() &&
				(props.channel.type === ChanType.CHANNEL || props.channel.type === ChanType.QUERY)
		);
		// Translation switched off (or no longer able to run here): the
		// picker goes with its button, and does not come back open with it.
		// The sheet the user opened to switch it on (`translationOffByUser`)
		// stays: it is the way back.
		watch(translateOnceAvailable, (available) => {
			if (!available && !translationOffByUser()) {
				translateOncePickerOpen.value = false;
			}
		});
		// The language this conversation was last written in through the
		// panel: the panel opens on it, and the button shows its code.
		const sendTarget = computed(() => writeTarget(props.network, props.channel));
		const codeOf = (code: string) => code.split("-")[0].toUpperCase();

		// Replying to a line in another language suggests that language
		// (offer.ts `composerOffer`: only off a line placed with confidence,
		// never "ok", a name or a link). A suggestion only marks the button;
		// nothing opens or changes until the user taps it.
		const suggestion = computed(() => {
			if (!translateOnceAvailable.value) {
				return null;
			}

			const reading = readingLanguage();

			return composerOffer({
				query: props.channel.type === ChanType.QUERY,
				replyTo: props.channel.replyTo,
				messages: props.channel.messages,
				entries: store.state.translations,
				editing: !!props.channel.editing,
				writeTarget: sendTarget.value,
				declined: false,
				languages: {
					reading,
					alsoRead: [],
					routes: (to) => !!pairVerdict(reading, to).route,
				},
			});
		});
		const suggestedCode = computed(() =>
			suggestion.value && suggestion.value.code !== sendTarget.value
				? codeOf(suggestion.value.code)
				: ""
		);
		// The code on the button: the suggestion's, else the conversation's.
		// The user's own language is the cleanup pass ("EN ✓").
		const buttonCode = computed(() => {
			if (suggestedCode.value) {
				return suggestedCode.value;
			}

			const to = sendTarget.value;

			if (!to) {
				return "";
			}

			return to === readingLanguage()
				? t("translate.composer.targetCorrected", {language: codeOf(to)})
				: codeOf(to);
		});
		const translateOnceLabel = computed(() => {
			const to = suggestion.value?.code ?? sendTarget.value;

			if (!to) {
				return t("translate.composer.sendOff");
			}

			const language = languageName(to, readingLanguage());

			return to === readingLanguage()
				? t("translate.composer.sendCorrectedOn", {language})
				: t("translate.composer.sendOn", {language});
		});
		// Read when the sheet opens: the list's preselection and "I write".
		const translateOncePreselected = ref("");
		const translateOnceFrom = ref<string | null>(null);

		// The panel, and the language it translates into: the suggestion
		// taken by opening it, else the conversation's, else the default
		// pick (the channel's last pick, a language it has been written in
		// lately, each only where this device can serve it).
		const panelOpen = ref(false);
		const panelTo = ref("");
		const panelFrom = ref<string | null>(null);

		const defaultTarget = () => {
			const reading = readingLanguage();

			return onceTargetDefault({
				reading,
				last: lastOnceTarget(props.network, props.channel),
				recent: recentLanguages(props.channel.messages, store.state.translations).map(
					(c) => c.code
				),
				fallback: SUPPORTED_LANGUAGES,
				routes: (to) => !!pairVerdict(reading, to).route,
			});
		};

		const openPanel = () => {
			const settings = channelTranslation(props.network, props.channel);

			panelTo.value = suggestion.value?.code ?? sendTarget.value ?? defaultTarget();
			panelFrom.value = panelTo.value === sendTarget.value ? settings.writeFrom : null;
			translateOncePickerOpen.value = false;
			panelOpen.value = true;
		};

		const closePanel = () => {
			panelOpen.value = false;
			translateOncePickerOpen.value = false;
			focusForTyping();
		};

		const togglePanel = () => {
			if (!canSend.value) {
				return;
			}

			if (panelOpen.value) {
				closePanel();
				return;
			}

			openPanel();
		};

		// Insert: the translation goes into the composer at the caret, the
		// way a pasted link would, and the panel closes. Sent unchanged, it
		// goes as the translation (onSubmit); the panel's language becomes
		// the conversation's, for the button and the next time.
		const insertTranslation = (value: PanelInsert) => {
			const el = input.value;
			const draft = props.channel.pendingMessage ?? "";
			const start = el ? el.selectionStart : draft.length;
			const end = el ? el.selectionEnd : draft.length;
			const before = draft.slice(0, start);
			const after = draft.slice(end);
			const pad = before && !/\s$/.test(before) ? " " : "";
			const next = `${before}${pad}${value.line}${after}`;

			props.channel.pendingMessage = next;
			insertedFor.set(props.channel.id, value);

			if (value.translated && value.translated.to !== sendTarget.value) {
				setChannelOptions(props.network, props.channel, {
					write: value.translated.to,
					writeFrom: panelFrom.value,
				});
			}

			panelOpen.value = false;
			void nextTick(() => {
				setInputSize();

				const field = input.value;

				if (field) {
					const caret = before.length + pad.length + value.line.length;

					field.focus();
					field.setSelectionRange(caret, caret);
				}
			});
		};

		// Off (the sheet's Write in): the conversation's language goes.
		const turnTranslateOff = () => {
			setChannelOptions(props.network, props.channel, {write: null, writeFrom: null});
			cancelOutgoing(props.channel);
			focusForTyping();
		};

		// "Reset choices for this conversation" (the sheet's More).
		const resetChoices = () => {
			cancelOutgoing(props.channel);
			panelOpen.value = false;
			insertedFor.delete(props.channel.id);
			resetChannelChoices(props.network, props.channel);
		};

		// What the sheet hangs off, and whether it opens on the language
		// list: the panel's language button, or the channel menu's ⋮ (its
		// switches first).
		const sheetAnchor = ref<HTMLElement | null>(null);
		const sheetListFirst = ref(true);
		const sheetOnceFirst = ref(false);

		const openSheet = (anchor: HTMLElement | null, listFirst: boolean) => {
			sheetAnchor.value = anchor;
			sheetListFirst.value = listFirst;
			sheetOnceFirst.value = false;
			translateOncePreselected.value =
				(panelOpen.value ? panelTo.value : sendTarget.value) || defaultTarget();
			translateOnceFrom.value = panelOpen.value
				? panelFrom.value
				: sendTarget.value
				? channelTranslation(props.network, props.channel).writeFrom
				: null;
			translateOncePickerOpen.value = true;
		};

		// The panel's language button: the sheet's list, over the button.
		const choosePanelLanguage = (anchor: HTMLElement | null | undefined) => {
			openSheet(anchor ?? translateOnceButton.value, true);
		};

		// A pick in the sheet: the panel's language while the panel is open,
		// else the conversation's. A same-language pick is a cleanup pass on
		// the GPU model (writer.ts, router.ts).
		const translateOnce = (to: string, from: string | null = null) => {
			translateOncePickerOpen.value = false;

			if (panelOpen.value) {
				panelTo.value = to;
				panelFrom.value = from;
				return;
			}

			setChannelOptions(props.network, props.channel, {write: to, writeFrom: from});
			focusForTyping();
		};

		// The one-time note's words, in the reading language's own name.
		const translationNote = computed(() => {
			const note = store.state.translation.note;

			if (!note || !translationOn()) {
				return "";
			}

			return note === "firstRun"
				? t("translate.note.firstRun", {language: readerName(readingLanguage())})
				: t("translate.note.everywhere");
		});
		const dismissNote = () => {
			store.commit("translationNote", null);
			focusForTyping();
		};
		// "Choose conversations": this conversation's panel, where "Translate
		// messages here" is the exclusion.
		const chooseConversations = () => {
			store.commit("translationNote", null);
			requestTranslationSheet(props.channel);
		};

		const onBlur = () => {
			if (autocompletionRef.value) {
				autocompletionRef.value.hide();
			}
		};

		watch(
			() => props.channel.id,
			() => {
				if (autocompletionRef.value) {
					autocompletionRef.value.hide();
				}

				// A draft left in the previous channel is reported `paused` there.
				typing.switchTarget();
				// The panel and the sheet were for the channel left behind.
				panelOpen.value = false;
				translateOncePickerOpen.value = false;
				focusForTyping();
			}
		);

		// The channel menu's "Translation…" (and a blocked toolbar Translate,
		// a note's "Choose conversations") switches to the channel and leaves
		// its id in the store, so the ask survives the switch: open the sheet
		// once this composer is the channel that was asked for, and clear it.
		// Registered after the watcher above, which closes the sheet on a
		// channel change and would otherwise undo this one. On its switches,
		// hung off the menu's ⋮ (the language list is one tap away).
		watch(
			() => [props.channel.id, store.state.translation.sheetFor] as const,
			([id, asked]) => {
				if (asked !== id) {
					return;
				}

				store.commit("translationSheetFor", null);
				openSheet(document.querySelector<HTMLElement>("#chat button.menu"), false);
			},
			{immediate: true}
		);

		watch(
			() => props.channel.pendingMessage,
			() => {
				setInputSize();
			}
		);

		onMounted(() => {
			eventbus.on("escapekey", blurInput);
			// A click on the sidebar row of the conversation already open
			// (ChannelWrapper.vue): no route change, still "let me type".
			eventbus.on("input:focus", focusForTyping);
			focusForTyping();

			if (store.state.settings.autocomplete) {
				if (!input.value) {
					throw new Error("ChatInput autocomplete: input element is not available");
				}

				autocompletionRef.value = autocompletion(input.value);
			}

			const inputTrap = Mousetrap(input.value);

			inputTrap.bind(Object.keys(formattingHotkeys), function (e, key) {
				const modifier = formattingHotkeys[key];

				if (!e.target) {
					return;
				}

				wrapCursor(
					e.target as HTMLTextAreaElement,
					modifier,
					(e.target as HTMLTextAreaElement).selectionStart ===
						(e.target as HTMLTextAreaElement).selectionEnd
						? ""
						: modifier
				);

				return false;
			});

			inputTrap.bind(Object.keys(bracketWraps), function (e, key) {
				if (
					(e.target as HTMLTextAreaElement)?.selectionStart !==
					(e.target as HTMLTextAreaElement).selectionEnd
				) {
					wrapCursor(e.target as HTMLTextAreaElement, key, bracketWraps[key]);

					return false;
				}
			});

			// Escape cancels a pending reply/edit before anything else gets it
			// (the global handler in App.vue blurs the input otherwise).
			inputTrap.bind("esc", () => {
				// The translate panel goes first; the draft stays.
				if (panelOpen.value) {
					closePanel();
					return false;
				}

				if (!props.channel.replyTo && !props.channel.editing) {
					return;
				}

				// Escape from an edit hands ArrowUp back to input history
				// until the user types again (`editDismissed`).
				if (props.channel.editing) {
					props.channel.editDismissed = true;
				}

				cancelCompose(props.channel);

				if (input.value) {
					input.value.value = props.channel.pendingMessage;
					setInputSize();
				}

				reportTyping(); // cancelling an edit empties the input → `done`

				return false;
			});

			// Whether the caret is on the textarea's top row (ArrowUp) or bottom
			// row (ArrowDown) as it is drawn — a long line that wraps is several
			// rows, which counting "\n" never saw, so ArrowUp anywhere in one
			// went to history. The mirror-div measure is the one the
			// autocomplete already takes of this element.
			const onEdgeRow = (el: HTMLTextAreaElement, key: string) => {
				const rowOf = (position: number) => getCaretCoordinates(el, position).top;

				return rowOf(el.selectionStart) === rowOf(key === "up" ? 0 : el.value.length);
			};

			// A history entry the arrows bring in gets the caret on the edge it
			// was reached from: at the start after ArrowUp, at the end after
			// ArrowDown, so holding either key keeps stepping instead of climbing
			// through every row of a long entry. An own message to edit always
			// gets it at the end (`edge: "end"`), where an edit is usually
			// made; ArrowUp on a wrapped one climbs its rows before it steps on.
			const showStepped = (
				el: HTMLTextAreaElement,
				text: string,
				key: string,
				edge: "stepped" | "end" = "stepped"
			) => {
				const caret = edge === "stepped" && key === "up" ? 0 : text.length;

				el.value = text;
				el.setSelectionRange(caret, caret);
				setInputSize();
			};

			inputTrap.bind(["up", "down"], (e, key) => {
				const el = input.value;

				if (
					store.state.isAutoCompleting ||
					(e.target as HTMLTextAreaElement).selectionStart !==
						(e.target as HTMLTextAreaElement).selectionEnd ||
					!el
				) {
					return;
				}

				// ArrowUp in an EMPTY input edits your newest own message in this
				// channel (the usual chat convention); once editing, further
				// ArrowUp/Down presses step the edit through your own messages
				// (the editing branch below). Input history keeps ArrowUp whenever
				// there is text in the box, when history is already being browsed,
				// or when there is no own editable message here; Escape dismisses
				// the edit (`editDismissed`, cleared by typing), so ArrowUp after
				// it browses history instead of re-entering the edit.
				if (
					key === "up" &&
					props.channel.pendingMessage === "" &&
					props.channel.inputHistoryPosition === 0 &&
					!props.channel.editDismissed &&
					!props.channel.editing
				) {
					const last = findLastEditable(props.channel);

					if (last) {
						startEdit(props.channel, last);
						showStepped(el, props.channel.pendingMessage, key, "end");
						return false;
					}
				}

				const {channel} = props;

				// While editing, ArrowUp/Down move the edit to your previous/next
				// own editable message instead of browsing input history — but
				// only while the text is untouched, so an edit in progress is
				// never thrown away by an arrow key. ArrowDown past the newest
				// leaves edit mode, back to the empty input ArrowUp started from.
				if (channel.editing) {
					if (channel.pendingMessage !== editText(channel.editing)) {
						return; // a modified edit: the arrows just move the caret
					}

					if (!onEdgeRow(el, key)) {
						return;
					}

					const next =
						key === "up"
							? findEditableBefore(channel, channel.editing)
							: findEditableAfter(channel, channel.editing);

					if (next) {
						startEdit(channel, next);
					} else if (key === "down") {
						cancelCompose(channel); // past the newest: edit over
						reportTyping(); // ...which empties the input → `done`
					} else {
						return; // already at the oldest own message
					}

					showStepped(
						el,
						channel.pendingMessage,
						key,
						channel.editing ? "end" : "stepped"
					);

					return false;
				}

				if (channel.inputHistoryPosition === 0) {
					channel.inputHistory[channel.inputHistoryPosition] = channel.pendingMessage;
				}

				if (key === "up" && onEdgeRow(el, key)) {
					if (channel.inputHistoryPosition < channel.inputHistory.length - 1) {
						channel.inputHistoryPosition++;
					} else {
						return;
					}
				} else if (
					key === "down" &&
					channel.inputHistoryPosition > 0 &&
					onEdgeRow(el, key)
				) {
					channel.inputHistoryPosition--;
				} else {
					return;
				}

				channel.pendingMessage = channel.inputHistory[channel.inputHistoryPosition];
				showStepped(el, channel.pendingMessage, key);

				return false;
			});

			// Always listen for drops and pastes: without a configured uploader
			// the handler swallows them and shows a one-off notice instead of
			// letting the browser navigate to the dropped file.
			upload.mounted(store, clientForNetwork);
		});

		onUnmounted(() => {
			if (ticker !== null) {
				clearInterval(ticker);
				ticker = null;
			}

			eventbus.off("escapekey", blurInput);
			eventbus.off("input:focus", focusForTyping);

			if (autocompletionRef.value) {
				autocompletionRef.value.destroy();
				autocompletionRef.value = undefined;
			}

			upload.unmounted();
			upload.abort();
			typing.dispose();
		});

		return {
			store,
			t,
			input,
			uploadInput,
			onUploadInputChange,
			openFileUpload,
			uploadAccept,
			networkFilehost,
			uploadLabel,
			uploadPercent,
			cancelUpload,
			cancelUploadLabel,
			cancelComposeLabel,
			cancelComposeTitle,
			uploadFileLabel,
			sendLabel,
			blurInput,
			onBlur,
			setInputSize,
			upload,
			getInputPlaceholder,
			onSubmit,
			onEnterKey,
			setPendingMessage,
			cancelCompose,
			replyingParts,
			composeTarget,
			showConnectionBar,
			canSend,
			emojiPick,
			emojiPicker,
			insertEmoji,
			closeEmojiPick,
			onComposerKeydown,
			connectionLabel,
			throttledWait,
			retryInSeconds,
			canConnectNow,
			connectNetwork,
			sendTooltip,
			translateOnceButton,
			translateOncePickerOpen,
			sheetAnchor,
			sheetListFirst,
			sheetOnceFirst,
			resetChoices,
			translationOffByUser,
			translateOnceAvailable,
			translateOnceLabel,
			translateOncePreselected,
			translateOnceFrom,
			sendTarget,
			buttonCode,
			suggestedCode,
			panelOpen,
			panelTo,
			panelFrom,
			togglePanel,
			closePanel,
			choosePanelLanguage,
			insertTranslation,
			translateOnce,
			turnTranslateOff,
			translationNote,
			dismissNote,
			chooseConversations,
		};
	},
});
</script>
