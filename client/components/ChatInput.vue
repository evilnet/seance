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
		<!-- The suggestion card: a channel that mostly writes in another
		     language offers to write in it here. Its decline is per channel. -->
		<div
			v-if="suggestion"
			class="translate-suggest"
			role="region"
			aria-labelledby="translate-suggest-lead"
		>
			<p id="translate-suggest-lead" class="translate-suggest-lead">{{ suggestionLead }}</p>
			<p v-if="suggestionNote" class="translate-suggest-note">{{ suggestionNote }}</p>
			<div class="translate-suggest-actions">
				<button
					type="button"
					class="btn btn-sm translate-suggest-accept"
					@click="acceptSuggestion"
				>
					{{ t("translate.suggest.accept", {language: suggestionName}) }}
				</button>
				<button
					type="button"
					class="btn btn-sm translate-suggest-decline"
					@click="declineSuggestion"
				>
					{{ t("translate.suggest.decline") }}
				</button>
			</div>
		</div>
		<!-- A writing offer (translate/offer.ts): replying to a line in
		     another language, or a query whose other person writes one.
		     Taken, it is for this message only; the strip that follows has
		     "Always here". In the strip's place, while there is none. -->
		<div
			v-if="offer && !outgoing && !stale"
			class="translate-offer"
			role="region"
			:aria-label="offerLabel"
		>
			<button
				type="button"
				class="btn btn-sm translate-offer-accept"
				@mousedown.prevent
				@click="acceptOffer"
			>
				{{ offerLabel }}
			</button>
			<button
				ref="offerOther"
				type="button"
				class="translate-offer-link translate-offer-other"
				@mousedown.prevent
				@click="otherLanguage(offerOther)"
			>
				{{ t("translate.offer.other") }}
			</button>
			<button
				type="button"
				class="translate-offer-link translate-offer-decline"
				@mousedown.prevent
				@click="declineOffer"
			>
				{{ t("translate.offer.decline") }}
			</button>
		</div>
		<!-- This message's language, taken from an offer or picked for it
		     alone, until its preview comes up (the strip says it then). -->
		<div
			v-else-if="draftTarget && !outgoing && !stale"
			class="translate-offer translate-offer-taken"
			role="status"
		>
			<span class="translate-offer-lead">{{ draftTargetLabel }}</span>
			<button
				ref="takenOther"
				type="button"
				class="translate-offer-link translate-offer-other"
				@mousedown.prevent
				@click="otherLanguage(takenOther)"
			>
				{{ t("translate.offer.change") }}
			</button>
			<button
				type="button"
				class="translate-offer-link translate-offer-always"
				@mousedown.prevent
				@click="alwaysHere"
			>
				{{ t("translate.offer.alwaysHere") }}
			</button>
			<button
				type="button"
				class="translate-offer-link translate-offer-drop"
				@mousedown.prevent
				@click="dropDraftTarget"
			>
				{{ t("translate.offer.asTyped") }}
			</button>
		</div>
		<!-- A translation streams in token by token, and every token is a
		     patch of this region: announced live, a screen reader would read
		     the strip out again on each one. It stays quiet while it streams
		     and announces itself once, whole, when it is done or has failed. -->
		<div
			v-if="outgoing || stale"
			:class="[
				'translate-bar',
				{failed: outgoing?.status === 'failed', 'translate-bar-is-stale': !!stale},
			]"
			role="status"
			:aria-live="!outgoing || outgoing.status === 'pending' ? 'off' : 'polite'"
		>
			<div class="translate-bar-row">
				<span class="translate-bar-chip" :title="outgoingChipTitle">{{
					outgoing ? outgoingChip : stale?.chip
				}}</span>
				<!-- The last preview, dimmed, while the draft is being typed on
				     and until the new one starts to stream: the strip keeps its
				     height instead of closing and opening on every word. -->
				<span
					v-if="stale"
					class="translate-bar-text translate-bar-stale"
					dir="auto"
					:lang="stale.to"
					>{{ stale.text
					}}<span
						v-if="outgoing?.status === 'pending'"
						class="translate-bar-caret"
						aria-hidden="true"
					></span
				></span>
				<span
					v-else-if="outgoing?.status === 'failed'"
					class="translate-bar-text translate-bar-failed"
					>{{ t("translate.strip.failed")
					}}<span
						v-if="outgoing.error"
						class="translate-bar-reason"
						:title="outgoing.error"
						>{{ shortReason(outgoing.error) }}</span
					></span
				>
				<span v-else-if="outgoing" class="translate-bar-text" dir="auto" :lang="outgoing.to"
					>{{ outgoing.text
					}}<span v-if="outgoingDownload" class="translate-bar-download">{{
						outgoingDownload
					}}</span
					><span
						v-if="outgoing.status === 'pending'"
						class="translate-bar-caret"
						aria-hidden="true"
					></span
				></span>
				<span v-if="outgoing?.status === 'done'" class="translate-bar-actions">
					<button
						type="button"
						:class="[
							'translate-bar-button',
							'translate-bar-copy',
							{'translate-bar-copy-done': copiedOutgoing},
						]"
						:title="copyLabel"
						:aria-label="copyLabel"
						@mousedown.prevent
						@click="copyOutgoing"
					/>
				</span>
			</div>
			<p v-if="sendQueuedHere" class="translate-bar-queued">
				{{ t("translate.strip.returnAgain") }}
			</p>
			<div
				v-if="outgoing && !stale && outgoing.check.status !== 'idle'"
				class="translate-bar-row translate-bar-check"
			>
				<span class="translate-bar-check-label">{{ outgoingCheckLabel }}</span>
				<span v-if="outgoing.check.status === 'failed'" class="translate-bar-failed">{{
					t("translate.strip.checkFailed")
				}}</span>
				<span
					v-else
					class="translate-bar-text"
					dir="auto"
					:lang="outgoing.check.to ?? undefined"
					:title="outgoing.check.text"
					>{{ outgoing.check.text
					}}<span
						v-if="outgoing.check.status === 'pending'"
						class="translate-bar-caret"
						aria-hidden="true"
					></span
				></span>
			</div>
			<!-- Always on the strip, whatever it is doing: the draft as typed,
			     instead of the translation (and of a Return waiting on it). -->
			<div v-if="outgoing" class="translate-bar-row translate-bar-send">
				<button
					type="button"
					class="translate-bar-link translate-bar-as-written"
					@mousedown.prevent
					@click="sendAsWritten"
				>
					{{ t("translate.strip.sendAsWritten") }}
				</button>
				<button
					v-if="draftTarget"
					type="button"
					class="translate-bar-link translate-bar-always"
					@mousedown.prevent
					@click="alwaysHere"
				>
					{{ t("translate.offer.alwaysHere") }}
				</button>
			</div>
		</div>
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
			<!-- `mousedown.prevent`, like the send button: the caret stays in the
			textarea, so the picker's pick translates the draft that is there. -->
			<button
				id="translate-once"
				ref="translateOnceButton"
				type="button"
				:class="{on: !!sendTarget}"
				:aria-label="translateOnceLabel"
				aria-haspopup="dialog"
				:aria-expanded="translateOncePickerOpen"
				:disabled="!canSend"
				@mousedown.prevent
				@click="openTranslateOnce"
			>
				<span v-if="sendTarget" class="translate-once-target" aria-hidden="true">{{
					sendTargetCode
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
			:once-offered="canTranslateOnce || sheetOnceFirst"
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
import {writeClipboard} from "../js/clipboard";
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
import {
	draftGate,
	firstEnterTranslates,
	onceTargetDefault,
	sendableTranslation,
} from "../js/translate/outgoing";
import {translationOn} from "../js/translate";
import {
	alsoReadLanguages,
	channelTranslation,
	liveLlmName,
	pairVerdict,
	readingLanguage,
	requestTranslationSheet,
	resetChannelChoices,
	setChannelOptions,
	translationMayRun,
	translationOffByUser,
} from "../js/translate/reader";
import TranslationSheet from "./TranslationSheet.vue";
import {loadNoteText, modelLabel} from "../js/helpers/modelLabel";
import friendlysize from "../js/helpers/friendlysize";
import {recentLanguages, suggestedLanguage} from "../js/translate/recent";
import {composerOffer, previewKey, sendReady} from "../js/translate/offer";
import {declineOffers, forgetOfferDecline, offersDeclined} from "../js/translate/offerDeclines";
import {translateErrorText} from "../js/helpers/translateErrors";
import {translateWhyText} from "../js/helpers/translateWhy";
import {downloadBytes, loadNote} from "../js/translate/service";
import {
	cancelOutgoing,
	interruptedOutgoing,
	lastOnceTarget,
	noteOutgoingSent,
	recordSentReadBack,
	translateOnce as translateDraftOnce,
	translateOutgoing,
	type OnceRequest,
	writeTarget,
} from "../js/translate/writer";

/** How long after a Return its late-arriving newline is still recognised. */
const ENTER_NEWLINE_WINDOW_MS = 500;

/** Characters of a failure reason the strip shows; the title has all of it. */
const REASON_MAX = 120;

/** How long the strip's Copy button reads "Copied" after a successful copy. */
const COPIED_LABEL_MS = 2000;

/** The pause in typing after which the draft is translated into the strip. */
const PREVIEW_PAUSE_MS = 700;
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
	components: {TranslationSheet, TypingIndicator, QuotePreview, ReactionPicker},
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
		let typedChange = false;

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

			typedChange = true;
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

		// The outgoing translation (spec § Composer): the strip above the
		// input is store state per channel (writer.ts), so a channel switch
		// keeps it like it keeps the draft.
		const outgoing = computed(() => store.state.outgoingTranslations[props.channel.id]);

		let previewTimer: ReturnType<typeof setTimeout> | null = null;
		const stalePreview = ref<{chanId: number; text: string; chip: string; to: string} | null>(
			null
		);
		const stale = computed(() => {
			const kept = stalePreview.value;
			const entry = outgoing.value;

			if (!kept || kept.chanId !== props.channel.id) {
				return null;
			}

			return !entry || (entry.status === "pending" && entry.text === "") ? kept : null;
		});
		// A Return that came before its preview was done: sent once it is.
		// `draft` is what the strip translates (a `/me`'s text), `raw` the
		// whole draft: "/me waves" and "waves" share a `draft`, not a send.
		const sendQueued = ref<{
			chanId: number;
			draft: string;
			raw: string;
			retried?: boolean;
		} | null>(null);
		const sendQueuedHere = computed(() => sendQueued.value?.chanId === props.channel.id);

		// When each conversation's finished translation came on screen, by
		// the draft it is of: Return sends it only once it has been seen
		// (offer.ts `sendReady`).
		const shownAt = new Map<number, {draft: string; at: number}>();
		const markShown = (draft: string) => {
			const was = shownAt.get(props.channel.id);

			if (!was || was.draft !== draft) {
				shownAt.set(props.channel.id, {draft, at: performance.now()});
			}
		};
		const shownAtFor = (draft: string) => {
			const was = shownAt.get(props.channel.id);

			return was && was.draft === draft ? was.at : null;
		};

		// A language for this message alone, per conversation: a writing
		// offer taken ("reply", "query"), or one picked in the sheet with
		// "This message only" ("pick"). It goes with the message when it is
		// sent, and an offer's goes when the offer would no longer say it.
		type DraftTarget = {to: string; from: string | null; kind: "reply" | "query" | "pick"};
		const draftTargets = reactive(new Map<number, DraftTarget>());
		const draftTarget = computed(() => draftTargets.get(props.channel.id) ?? null);
		// The language a draft is translated into: this message's own, else
		// the conversation's.
		const effectiveTarget = computed(
			() => draftTarget.value?.to ?? writeTarget(props.network, props.channel)
		);
		// The request a draft's translation goes out as: the message's own
		// language when it has one, else the conversation's (no request).
		const draftRequest = (): OnceRequest | undefined => {
			const own = draftTarget.value;

			if (!own) {
				return undefined;
			}

			return own.kind === "pick"
				? {to: own.to, from: own.from}
				: {to: own.to, from: null, asTarget: true};
		};

		const clearPreviewTimer = () => {
			if (previewTimer !== null) {
				clearTimeout(previewTimer);
				previewTimer = null;
			}
		};

		const forgetPreview = () => {
			clearPreviewTimer();
			stalePreview.value = null;
			sendQueued.value = null;
			shownAt.delete(props.channel.id);
		};

		// The strip's labels name their languages in the language the user
		// reads this channel in, not the browser's (reader.ts readingLanguage).
		const readerName = (code: string) => languageName(code, readingLanguage());

		// Source → target, "→ German" until (or unless) a source is named.
		const outgoingChip = computed(() => {
			const entry = outgoing.value;

			if (!entry) {
				return "";
			}

			// A cleanup pass (writer.ts: from and to the same) is not a
			// translation, and its chip says what it is.
			if (entry.from && entry.from === entry.to) {
				return t("translate.strip.polishChip", {language: readerName(entry.to)});
			}

			// What the strip is: the line Return will send, and its language
			// (a one-off's is on no button).
			return t("translate.strip.willSendIn", {language: readerName(entry.to)});
		});

		// The read-back row's label: the translation's language → the one it
		// is read back into, the user's reading language.
		const outgoingCheckLabel = computed(() => t("translate.strip.readsBack"));

		// Which route the strip's text came down, in the chip's title: the
		// pair as the request asked for it ("auto" where the source was left
		// to the model), the model's own id, whether it ran on the GPU, and
		// whether the bare second try ran. The chip's visible text stays the
		// draft's direction -- this is for someone wondering why a
		// translation reads as it does. No title until the route has answered.
		const outgoingChipTitle = computed(() => {
			const entry = outgoing.value;

			if (!entry || !entry.model) {
				return undefined;
			}

			const from = entry.requestFrom
				? readerName(entry.requestFrom)
				: t("translate.strip.sourceAuto");
			const gpu = entry.device === "gpu";
			// One whole phrase per shape (device × retried): no translated
			// fragment is ever glued onto another, and every key is a literal
			// the pot check can see.
			const vars = {from, to: readerName(entry.to), model: entry.model};

			if (entry.engine === "apple") {
				return entry.retried
					? t("translate.strip.routeSystemRetried", vars)
					: t("translate.strip.routeSystem", vars);
			}

			if (entry.retried) {
				return gpu
					? t("translate.strip.routeGpuRetried", vars)
					: t("translate.strip.routeCpuRetried", vars);
			}

			return gpu ? t("translate.strip.routeGpu", vars) : t("translate.strip.routeCpu", vars);
		});

		// The route's model downloading for this draft (service.ts loads it on
		// demand, and the deadline waits for it): the strip says so rather
		// than blink a caret for minutes.
		const outgoingDownload = computed(() => {
			const entry = outgoing.value;

			if (!entry || entry.status !== "pending" || entry.text || !entry.model) {
				return "";
			}

			// One view per copy: the route's own, on the device it runs on.
			const view = store.state.translation.models.find(
				(v) =>
					v.ref.id === entry.model &&
					(!entry.device || v.device === entry.device) &&
					v.status === "downloading"
			);

			return view ? loadNoteText(loadNote(view)) : "";
		});

		// Why it failed, beside "couldn't translate": an ORT session error or
		// a model id is long and multi-line, so the strip shows the head of it
		// and the title carries the whole thing.
		const shortReason = (error: string | null) => {
			if (!error) {
				return "";
			}

			const text = translateErrorText(error, () => {
				const entry = outgoing.value;
				const verdict = entry ? pairVerdict(entry.from, entry.to) : null;

				return verdict && !verdict.route
					? translateWhyText(verdict.why, liveLlmName())
					: "";
			})
				.replace(/\s+/g, " ")
				.trim();

			return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX - 1)}…` : text;
		};

		// Copy: the translation is what the strip is showing, so it is what
		// the button puts on the clipboard. The label says so for two
		// seconds, since nothing else about the page changes.
		const copiedOutgoing = ref(false);
		let copiedTimer: number | null = null;

		const copyOutgoing = () => {
			const entry = outgoing.value;

			if (!entry) {
				return;
			}

			void writeClipboard(entry.text).then((copied) => {
				if (!copied) {
					return;
				}

				copiedOutgoing.value = true;

				if (copiedTimer !== null) {
					window.clearTimeout(copiedTimer);
				}

				copiedTimer = window.setTimeout(() => {
					copiedOutgoing.value = false;
					copiedTimer = null;
				}, COPIED_LABEL_MS);
			});
		};

		// The strip's three buttons: whole phrases from the catalog, never a
		// ternary over two literals in the template.
		const copyLabel = computed(() =>
			copiedOutgoing.value ? t("translate.strip.copied") : t("translate.strip.copy")
		);
		const outgoingSendLabel = computed(() =>
			outgoing.value?.status === "failed"
				? t("translate.strip.sendAsWritten")
				: t("translate.strip.sendTranslation")
		);

		// A translation or its check still running: the one-off dialog's
		// "This message only" waits for it.
		const outgoingBusy = computed(() => {
			const entry = outgoing.value;

			if (!entry) {
				return false;
			}

			return entry.status === "pending" || entry.check.status === "pending";
		});

		const sendTooltip = computed(() => {
			if (!canSend.value) {
				return t("composer.notConnected");
			}

			if (!outgoing.value) {
				return t("composer.send");
			}

			return outgoingSendLabel.value;
		});

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
			forgetPreview();
			// A language taken for this message goes with it.
			draftTargets.delete(target);
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

			// The second Enter (spec § Composer 5): the strip's translation
			// goes, or after a failure the draft as written. Nothing goes
			// while it is still translating (or, with the automatic check,
			// still reading back).
			const entry = store.state.outgoingTranslations[props.channel.id];
			// What of the draft a translation is of: the draft itself, or the
			// text of a `/me`, which goes back out behind the command.
			const gate = draftGate(text, !!editing);

			if (entry && entry.draft === gate.text) {
				// Send safety (spec § Send safety): a translation goes only
				// once it has been on screen, finished. A Return before that
				// -- while it is still coming, or in the instant it lands --
				// says "Translating…" and sends nothing; the next Return
				// after the result has been seen sends it. "Send as written"
				// is on the strip throughout.
				if (
					entry.status === "pending" ||
					(entry.status === "done" &&
						!sendReady(entry, shownAtFor(entry.draft), performance.now()))
				) {
					sendQueued.value = {chanId: props.channel.id, draft: gate.text, raw: text};
					return false;
				}

				const translated = entry.status === "done" ? entry.text : null;
				// A translation is text, never a command, on every line of it
				// (outgoing.ts sendableTranslation); an action's goes back
				// behind its `/me `. Whether the later lines need escaping is
				// the IRC layer's split: one message under draft/multiline.
				const splitsLines =
					clientForNetwork(props.network.uuid)?.multilineLimits() === undefined;
				const line =
					translated === null ? text : sendableTranslation(gate, translated, splitsLines);

				// Before the send: the IRC layer puts the line in the store
				// inside deliver's emit, and cancelOutgoing takes the strip.
				// A corrected line (from and to the same) is the line itself:
				// nothing to read back, no voice or term to learn from it.
				const polished = entry.from !== null && entry.from === entry.to;

				if (translated !== null && !polished) {
					recordSentReadBack(props.channel, entry);
				}

				// The language tags (docs/resources/translation.md § Language
				// tags): the target is the user's pick, so the line's
				// language is known, not guessed. A corrected line is in
				// the user's own words, so it is not marked machine-made.
				const tagged =
					translated !== null
						? {language: entry.to, machineTranslated: !polished}
						: undefined;

				cancelOutgoing(props.channel);
				deliver(line, text, tagged);

				if (translated !== null && !polished) {
					noteOutgoingSent(
						props.network,
						props.channel,
						gate.text,
						translated,
						entry.to,
						entry.from
					);
				}

				return;
			}

			if (entry) {
				// A strip for another draft (the watch below normally removes it first).
				cancelOutgoing(props.channel);
			}

			// The first Enter (spec § Composer 1-3): translate, and send only
			// when the draft turns out to need none. Translation switched off,
			// every draft goes as typed (outgoing.ts firstEnterTranslates).
			if (firstEnterTranslates(gate, effectiveTarget.value, translationOn())) {
				// The verdict can be seconds late (a cold engine, a slow
				// device), so it is checked against the composer it started
				// in: another conversation, a changed draft or a network that
				// went down in the meantime all leave the draft where it is.
				const startedFor = props.channel.id;

				clearPreviewTimer();
				sendQueued.value = {
					chanId: startedFor,
					draft: gate.text,
					raw: text,
					retried: queued,
				};

				void translateOutgoing(
					props.network,
					props.channel,
					gate.text,
					draftRequest()
				).then((verdict) => {
					if (
						verdict === "plain" &&
						props.channel.id === startedFor &&
						props.channel.pendingMessage === text &&
						canSend.value
					) {
						deliver(text, text);
					}
				});

				return false;
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

		// The translate button opens the conversation's translation sheet
		// (TranslationSheet.vue) on its language list: the pick becomes the
		// channel's write target (channelStore `write`, the sheet's "Write
		// in"), shown on the button until the sheet's Off; its "This message only"
		// makes the pick a one-off instead (writer.ts `translateOnce`), the
		// way the toolbar's Translate reads one line. Shown wherever
		// translation can run at all, and while the device probe is still
		// out: a button that appeared when it landed shifted the composer on
		// every app load.
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
		const canTranslateOnce = computed(() => {
			const gate = draftGate(props.channel.pendingMessage ?? "", !!props.channel.editing);

			return (
				(gate.kind === "ok" || gate.kind === "action") &&
				gate.text.trim() !== "" &&
				canSend.value &&
				!outgoingBusy.value
			);
		});
		// The channel's send target: the button is lit while one is set,
		// and reads it as "EN → PT" (the language the user reads → the target).
		const sendTarget = computed(() => writeTarget(props.network, props.channel));
		const codeOf = (code: string) => code.split("-")[0].toUpperCase();
		const sendTargetCode = computed(() => {
			const to = sendTarget.value;

			if (!to) {
				return "";
			}

			// The user's own language: lines go corrected, not translated.
			// Another: its code alone, the language this conversation is
			// written in (spec § One sheet per conversation).
			return to === readingLanguage()
				? t("translate.composer.targetCorrected", {language: codeOf(to)})
				: codeOf(to);
		});
		const translateOnceLabel = computed(() => {
			const to = sendTarget.value;

			if (!to) {
				return t("translate.composer.sendOff");
			}

			const language = languageName(to, readingLanguage());

			return to === readingLanguage()
				? t("translate.composer.sendCorrectedOn", {language})
				: t("translate.composer.sendOn", {language});
		});
		// Read when the dialog opens: the last pick is plain session memory
		// (writer.ts), not store state, so nothing would recompute it.
		const translateOncePreselected = ref("");

		// The sheet's "I write": the language the user said they write in
		// with the target that is set, else the one they read. Null (detect
		// each draft) only where the target was set that way.
		const translateOnceFrom = ref<string | null>(null);

		// Off: the send target goes, and a strip in flight for it with it.
		const turnTranslateOff = () => {
			setChannelOptions(props.network, props.channel, {write: null, writeFrom: null});
			cancelOutgoing(props.channel);
			forgetPreview();
			draftTargets.delete(props.channel.id);
			focusForTyping();
		};

		// "Reset choices for this conversation" (the sheet's More): the
		// stored choices go, a strip made for the old target with them.
		const resetChoices = () => {
			cancelOutgoing(props.channel);
			forgetPreview();
			draftTargets.delete(props.channel.id);
			forgetOfferDecline(props.network.uuid, props.channel.name);
			resetChannelChoices(props.network, props.channel);
		};

		// What the sheet hangs off, and whether it opens on the language
		// list: the chip (the language to write in), or the channel menu's
		// ⋮ (its switches first).
		const sheetAnchor = ref<HTMLElement | null>(null);
		const sheetListFirst = ref(true);
		// Opened from a writing offer: "This message only" is set already.
		const sheetOnceFirst = ref(false);

		const openSheet = (anchor: HTMLElement | null, listFirst: boolean, onceFirst = false) => {
			sheetAnchor.value = anchor;
			sheetListFirst.value = listFirst;
			sheetOnceFirst.value = onceFirst;

			const reading = readingLanguage();
			const target = sendTarget.value;

			// The target that is set; else the channel's last pick, a
			// language the channel has been written in lately,
			// or the user's own (the cleanup pass) -- each only where this
			// device can serve it from the reading language, so a device
			// without the GPU model never opens on a disabled cleanup pass
			// (outgoing.ts `onceTargetDefault`). With no target the sheet
			// shows it as a suggestion, not as what is set.
			translateOncePreselected.value =
				target ??
				onceTargetDefault({
					reading,
					last: lastOnceTarget(props.network, props.channel),
					recent: recentLanguages(props.channel.messages, store.state.translations).map(
						(c) => c.code
					),
					fallback: SUPPORTED_LANGUAGES,
					routes: (to) => !!pairVerdict(reading, to).route,
				});
			translateOnceFrom.value = target
				? channelTranslation(props.network, props.channel).writeFrom
				: reading;
			translateOncePickerOpen.value = true;
		};

		const openTranslateOnce = () => {
			if (!canSend.value) {
				return;
			}

			if (translateOncePickerOpen.value) {
				translateOncePickerOpen.value = false;
				return;
			}

			openSheet(translateOnceButton.value, true);
		};

		// A same-language pick is a cleanup pass on the GPU model
		// (writer.ts, router.ts): the sheet asks the router's own rule
		// (reader.ts `pairVerdict`) and says why when it cannot run.
		const translateOnce = (to: string, from: string | null = null, once = false) => {
			translateOncePickerOpen.value = false;

			const draft = props.channel.pendingMessage ?? "";
			const gate = draftGate(draft, !!props.channel.editing);
			const translatable =
				canTranslateOnce.value && (gate.kind === "ok" || gate.kind === "action");

			if (once) {
				// A Return waiting on the target's preview is not a send of
				// the one-off: that strip is for reading first.
				forgetPreview();
				// This message's language, until it is sent: an edit of the
				// draft previews into it again, as a conversation's would.
				draftTargets.set(props.channel.id, {to, from, kind: "pick"});

				// The verdict is checked against the composer it started in,
				// as the first Enter's is: a "plain" verdict (the draft is
				// already in that language) leaves the draft where it is --
				// the dialog asked for a translation, not a send.
				if (translatable) {
					void translateDraftOnce(props.network, props.channel, gate.text, to, from);
				}

				focusForTyping();
				return;
			}

			// The mode: the channel's send target, from here on. A draft
			// already typed gets the strip now rather than on its Enter.
			// With the language the user said they write in: each draft is
			// taken as that, not guessed at (a short English line scores as
			// Afrikaans often enough). The same pair again changes nothing,
			// a finished preview included; a strip for a target it replaces goes.
			if (
				to === sendTarget.value &&
				from === channelTranslation(props.network, props.channel).writeFrom
			) {
				focusForTyping();
				return;
			}

			cancelOutgoing(props.channel);
			forgetPreview();
			// The conversation's language now: this message's own goes.
			draftTargets.delete(props.channel.id);
			// Reading is not touched: it is on everywhere unless the user
			// excluded this conversation, and a write target never undoes
			// that choice (translate/switch.ts `readsHere`).
			setChannelOptions(props.network, props.channel, {write: to, writeFrom: from});

			// Read after the cancel above: a preview for the old target that
			// was still on its way kept the composer busy, and the draft would
			// otherwise sit with no strip until the next keystroke.
			if (canTranslateOnce.value && (gate.kind === "ok" || gate.kind === "action")) {
				void translateOutgoing(props.network, props.channel, gate.text);
			}

			focusForTyping();
		};

		// The suggestion card (spec § Composer): where a channel's recent
		// lines from others are mostly in one language that is not the
		// user's -- by the reading pipeline's own verdicts, so only with
		// reading on -- and nothing is set or declined, offer to write in it.
		const suggestion = computed(() => {
			if (
				!translateOnceAvailable.value ||
				props.channel.type !== ChanType.CHANNEL ||
				sendTarget.value ||
				props.channel.editing ||
				channelTranslation(props.network, props.channel).noSuggest
			) {
				return null;
			}

			const reading = readingLanguage();
			const code = suggestedLanguage(
				recentLanguages(props.channel.messages, store.state.translations),
				reading
			);
			const route = code ? pairVerdict(reading, code).route : null;

			return code && route ? {code, route} : null;
		});
		const suggestionName = computed(() =>
			suggestion.value ? languageName(suggestion.value.code, readingLanguage()) : ""
		);
		const suggestionLead = computed(() =>
			suggestion.value
				? t("translate.suggest.lead", {
						channel: props.channel.name,
						language: suggestionName.value,
				  })
				: ""
		);
		// What saying yes costs, where it costs a download.
		const suggestionNote = computed(() => {
			const route = suggestion.value?.route;
			const size = route ? downloadBytes(route, store.state.translation.models) : 0;

			return route && size > 0
				? t("translate.suggest.download", {
						model: modelLabel(route.ref),
						size: friendlysize(size),
				  })
				: "";
		});
		const acceptSuggestion = () => {
			const code = suggestion.value?.code;

			if (code) {
				translateOnce(code, readingLanguage());
			}
		};
		const declineSuggestion = () => {
			setChannelOptions(props.network, props.channel, {noSuggest: true});
			focusForTyping();
		};

		// What the writing offer would say now, decline or not (offer.ts):
		// an offer taken goes when it no longer would.
		const offerNow = computed(() => {
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
					alsoRead: alsoReadLanguages(),
					routes: (to) => !!pairVerdict(reading, to).route,
				},
			});
		});
		const offer = computed(() =>
			offerNow.value &&
			!draftTarget.value &&
			!offersDeclined(props.network.uuid, props.channel.name)
				? offerNow.value
				: null
		);
		const offerLabel = computed(() => {
			const shown = offer.value;

			if (!shown) {
				return "";
			}

			const language = readerName(shown.code);

			return shown.kind === "reply"
				? t("translate.offer.reply", {language})
				: t("translate.offer.query", {nick: props.channel.name, language});
		});
		const draftTargetLabel = computed(() =>
			draftTarget.value
				? t("translate.offer.thisMessage", {language: readerName(draftTarget.value.to)})
				: ""
		);
		const startDraftPreview = () => {
			const gate = draftGate(props.channel.pendingMessage ?? "", !!props.channel.editing);

			if (canTranslateOnce.value && (gate.kind === "ok" || gate.kind === "action")) {
				void translateOutgoing(props.network, props.channel, gate.text, draftRequest());
			}
		};
		// Taken: this message goes in the offer's language. A draft already
		// typed gets its strip now.
		const acceptOffer = () => {
			const shown = offer.value;

			if (!shown) {
				return;
			}

			cancelOutgoing(props.channel);
			forgetPreview();
			draftTargets.set(props.channel.id, {to: shown.code, from: null, kind: shown.kind});
			startDraftPreview();
			focusForTyping();
		};
		const declineOffer = () => {
			declineOffers(props.network.uuid, props.channel.name);
			focusForTyping();
		};
		// Another language for this message: the sheet's list, with "This
		// message only" set, so a wrong guess is put right for this message
		// without touching the conversation.
		const offerOther = ref<HTMLElement | null>(null);
		const takenOther = ref<HTMLElement | null>(null);
		const otherLanguage = (anchor: HTMLElement | null) => {
			const guess = draftTarget.value?.to ?? offer.value?.code ?? "";

			openSheet(anchor, true, true);

			if (guess) {
				translateOncePreselected.value = guess;
			}
		};
		// "Always here": this message's language becomes the conversation's.
		const alwaysHere = () => {
			const own = draftTarget.value;

			if (!own) {
				return;
			}

			draftTargets.delete(props.channel.id);
			setChannelOptions(props.network, props.channel, {
				write: own.to,
				writeFrom: own.kind === "pick" ? own.from : readingLanguage(),
			});
			focusForTyping();
		};
		// "Write as typed": this message's language goes, its preview with it.
		const dropDraftTarget = () => {
			draftTargets.delete(props.channel.id);
			cancelOutgoing(props.channel);
			forgetPreview();
			focusForTyping();
		};
		// "Send as written": the draft as typed, now, whatever the strip is
		// doing -- a preview on its way, a download, a failure -- and in
		// place of a Return waiting on it.
		const sendAsWritten = () => {
			const text = props.channel.pendingMessage ?? "";

			if (!text || !canSend.value) {
				return;
			}

			cancelOutgoing(props.channel);
			deliver(text, text);
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

		// The live preview (spec § Composer): with a send target set, a
		// pause in typing translates the draft into the strip, so the Return
		// that follows sends what the user has already read. The last
		// preview stays up, dimmed, while the draft changes under it.
		const runPreview = () => {
			previewTimer = null;
			const draft = props.channel.pendingMessage ?? "";
			const gate = draftGate(draft, !!props.channel.editing);
			const to = effectiveTarget.value;

			if (
				!canSend.value ||
				gate.text.trim() === "" ||
				!firstEnterTranslates(gate, to, translationOn())
			) {
				stalePreview.value = null;
				return;
			}

			if (outgoing.value?.draft === gate.text) {
				return;
			}

			void translateOutgoing(props.network, props.channel, gate.text, draftRequest()).then(
				(verdict) => {
					// Already in the target language: nothing to preview.
					if (verdict === "plain" && !outgoing.value) {
						stalePreview.value = null;
					}
				}
			);
		};

		const schedulePreview = () => {
			clearPreviewTimer();

			if (!effectiveTarget.value) {
				return;
			}

			previewTimer = setTimeout(runPreview, PREVIEW_PAUSE_MS);
		};

		watch(
			() => [outgoing.value?.status, outgoing.value?.text] as const,
			() => {
				const entry = outgoing.value;
				const queued = sendQueued.value;

				if (!entry) {
					// The run ended with no strip: the draft needs none (a
					// "plain" verdict), or the target moved under it. A Return
					// waiting on it is answered once, by the path a Return with
					// no strip takes -- which sends a "plain" draft as typed.
					if (queued && queued.chanId === props.channel.id) {
						sendQueued.value = null;

						if (!queued.retried && queued.raw === props.channel.pendingMessage) {
							void nextTick(() => onSubmit(false, true));
						}
					}

					return;
				}

				if (entry.status === "done") {
					markShown(entry.draft);
				}

				if (entry.status === "done" && entry.text) {
					stalePreview.value = {
						chanId: props.channel.id,
						text: entry.text,
						chip: outgoingChip.value,
						to: entry.to,
					};
				} else if (entry.status === "failed") {
					stalePreview.value = null;
				}

				if (
					!queued ||
					queued.chanId !== props.channel.id ||
					queued.draft !== entry.draft ||
					queued.raw !== props.channel.pendingMessage
				) {
					return;
				}

				// Done or failed: the Return waiting on it is answered by
				// the result being on screen, never by a send in the same
				// instant (spec § Send safety). The next Return sends what
				// the strip then shows; after a failure, the draft as written.
				if (entry.status === "done" || entry.status === "failed") {
					sendQueued.value = null;
				}
			}
		);

		onUnmounted(clearPreviewTimer);

		// A preview belongs to its target (spec § A preview belongs to its
		// target): the language and the reply parent, by id and text. When
		// either moves under it -- an offer's language changed, the parent
		// was edited, the reply cancelled -- the preview, its read-back and
		// a Return waiting on it go together, and the draft previews anew at
		// once (nobody is typing: the change came from a tap or a line).
		const previewAgain = () => {
			if (outgoing.value || sendQueuedHere.value || stale.value) {
				cancelOutgoing(props.channel);
				forgetPreview();
			}

			if ((props.channel.pendingMessage ?? "").trim() !== "") {
				runPreview();
			}
		};

		watch(
			() => [props.channel.id, effectiveTarget.value] as const,
			([id, to], [idBefore]) => {
				// A strip already for this language (one started by the tap
				// that set it) stands.
				if (id === idBefore && (!outgoing.value || outgoing.value.to !== to)) {
					previewAgain();
				}
			}
		);
		watch(
			() => [props.channel.id, previewKey(null, props.channel.replyTo)] as const,
			([id, key], [idBefore, keyBefore]) => {
				if (id === idBefore && key !== keyBefore) {
					previewAgain();
				}
			}
		);

		// The page put away and back (a phone's app switcher, the back-forward
		// cache): pagehide took the worker down under a preview, which then
		// failed through no fault of its own. Asked again once the page is
		// visible (or at once, where the failure lands after it came back).
		const resumePreview = () => {
			if (document.visibilityState !== "visible" || !interruptedOutgoing(outgoing.value)) {
				return;
			}

			previewAgain();
		};

		watch(
			() => interruptedOutgoing(outgoing.value),
			(interrupted) => {
				if (interrupted) {
					resumePreview();
				}
			}
		);
		onMounted(() => {
			window.addEventListener("pageshow", resumePreview);
			document.addEventListener("visibilitychange", resumePreview);
		});
		onUnmounted(() => {
			window.removeEventListener("pageshow", resumePreview);
			document.removeEventListener("visibilitychange", resumePreview);
		});

		// An offer taken goes when the offer would no longer say it: the
		// reply was cancelled or now answers another line, the other person
		// of a query writes in another language. Then the offer (if any)
		// comes back with what it says now.
		watch(
			() => [props.channel.id, offerNow.value?.kind, offerNow.value?.code] as const,
			([id, kind, code], [idBefore]) => {
				const own = draftTargets.get(id);

				if (id !== idBefore || !own || own.kind === "pick") {
					return;
				}

				if (own.kind !== kind || own.to !== code) {
					draftTargets.delete(id);
				}
			}
		);

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
				forgetPreview();
				// The sheet was opened for the channel left behind.
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
			(value) => {
				setInputSize();

				// Typing, or walking the history, invalidates the strip (spec
				// § Composer 3): the next Enter translates afresh.
				const entry = store.state.outgoingTranslations[props.channel.id];

				// Against the part of the draft the strip is a translation of
				// (a `/me`'s text, not the command in front of it), with one
				// trailing newline tolerated on a touch-primary device: there
				// the Return puts its newline in the draft before `keypress`
				// fires, so the draft reads "…\n" for the moment between the
				// two and `onEnterKey` -> `onSubmit(true)` strips exactly that
				// newline back off. Without the tolerance the second Enter
				// would find the strip already cancelled and translate afresh
				// instead of sending. Only there: with a hardware keyboard the
				// Return is preventDefaulted and never reaches the draft, so a
				// trailing newline is a deliberate Shift+Enter -- an edit of
				// the draft like any other, and the strip goes.
				const gated = draftGate(value, !!props.channel.editing).text;
				const typed =
					hasVirtualKeyboard() && gated.endsWith("\n") ? gated.slice(0, -1) : gated;

				if (entry && typed !== entry.draft) {
					cancelOutgoing(props.channel);
				}

				const queued = sendQueued.value;
				const raw =
					hasVirtualKeyboard() && value.endsWith("\n") ? value.slice(0, -1) : value;

				if (queued && queued.raw !== raw) {
					sendQueued.value = null;
				}

				const fromTyping = typedChange;

				typedChange = false;

				if (typed.trim() === "") {
					forgetPreview();
				} else if (fromTyping && (!entry || typed !== entry.draft)) {
					schedulePreview();
				}
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
				// A translation strip goes first (spec § Composer 6); the draft stays.
				if (store.state.outgoingTranslations[props.channel.id] || stale.value) {
					cancelOutgoing(props.channel);
					forgetPreview();
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

			if (copiedTimer !== null) {
				window.clearTimeout(copiedTimer);
				copiedTimer = null;
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
			offer,
			offerLabel,
			acceptOffer,
			declineOffer,
			offerOther,
			takenOther,
			otherLanguage,
			draftTarget,
			draftTargetLabel,
			alwaysHere,
			dropDraftTarget,
			sendAsWritten,
			sheetOnceFirst,
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
			outgoing,
			outgoingChip,
			outgoingCheckLabel,
			outgoingChipTitle,
			outgoingDownload,
			shortReason,
			outgoingBusy,
			sendTooltip,
			stale,
			sendQueuedHere,
			sendTargetCode,
			copiedOutgoing,
			copyOutgoing,
			copyLabel,
			outgoingSendLabel,
			translateOnceButton,
			translateOncePickerOpen,
			sheetAnchor,
			sheetListFirst,
			resetChoices,
			translationOffByUser,
			translateOnceAvailable,
			canTranslateOnce,
			translateOnceLabel,
			translateOncePreselected,
			translateOnceFrom,
			sendTarget,
			openTranslateOnce,
			translateOnce,
			turnTranslateOff,
			suggestion,
			suggestionName,
			suggestionLead,
			suggestionNote,
			acceptSuggestion,
			declineSuggestion,
			translationNote,
			dismissNote,
			chooseConversations,
		};
	},
});
</script>
