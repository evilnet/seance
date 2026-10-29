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
		<!-- A translation streams in token by token, and every token is a
		     patch of this region: announced live, a screen reader would read
		     the strip out again on each one. It stays quiet while it streams
		     and announces itself once, whole, when it is done or has failed. -->
		<div
			v-if="outgoing"
			:class="['translate-bar', {failed: outgoing.status === 'failed'}]"
			role="status"
			:aria-live="outgoing.status === 'pending' ? 'off' : 'polite'"
		>
			<div class="translate-bar-row">
				<span class="translate-bar-chip" :title="outgoingChipTitle">{{
					outgoingChip
				}}</span>
				<span
					v-if="outgoing.status === 'failed'"
					class="translate-bar-text translate-bar-failed"
					>{{ t("translate.strip.failed")
					}}<span
						v-if="outgoing.error"
						class="translate-bar-reason"
						:title="outgoing.error"
						>{{ shortReason(outgoing.error) }}</span
					></span
				>
				<span v-else class="translate-bar-text" dir="auto" :lang="outgoing.to"
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
				<span class="translate-bar-actions">
					<button
						v-if="outgoing.status === 'done'"
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
					<button
						type="button"
						class="translate-bar-button translate-bar-send"
						:disabled="outgoingBusy || !canSend"
						:title="outgoingSendLabel"
						:aria-label="outgoingSendLabel"
						@mousedown.prevent
						@click="onSubmit()"
					/>
					<button
						type="button"
						class="translate-bar-button translate-bar-edit"
						:title="keepTypingLabel"
						:aria-label="keepTypingLabel"
						@mousedown.prevent
						@click="cancelOutgoingNow"
					/>
				</span>
			</div>
			<div
				v-if="outgoing.check.status !== 'idle'"
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
					>{{ outgoing.check.text
					}}<span
						v-if="outgoing.check.status === 'pending'"
						class="translate-bar-caret"
						aria-hidden="true"
					></span
				></span>
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
			@keypress.enter.exact="onEnterKey"
			@blur="onBlur"
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
				:aria-pressed="!!sendTarget"
				:aria-expanded="translateOncePickerOpen"
				:disabled="!canSend"
				@mousedown.prevent
				@click="openTranslateOnce"
			/>
			<SourceLanguagePicker
				v-if="translateOncePickerOpen"
				:anchor="translateOnceButton"
				:selected="translateOncePreselected"
				:selected-from="translateOnceFrom"
				:once-offered="canTranslateOnce"
				purpose="target"
				@pick="translateOnce"
				@close="translateOncePickerOpen = false"
			/>
		</span>
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
				:disabled="!canSend || outgoingBusy"
				@mousedown.prevent
			/>
		</span>
	</form>
</template>

<script lang="ts">
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
	startEdit,
} from "../js/helpers/compose";
import {hasVirtualKeyboard} from "../js/helpers/device";
import {useI18n} from "../js/i18n";
import {SUPPORTED_LANGUAGES, languageName} from "../js/translate/languages";
import {draftGate, onceTargetDefault, sendableTranslation} from "../js/translate/outgoing";
import {
	channelTranslation,
	liveLlmName,
	pairVerdict,
	readingLanguage,
	setChannelOptions,
	translationAvailable,
} from "../js/translate/reader";
import SourceLanguagePicker from "./SourceLanguagePicker.vue";
import {loadNoteText} from "../js/helpers/modelLabel";
import {translateErrorText} from "../js/helpers/translateErrors";
import {translateWhyText} from "../js/helpers/translateWhy";
import {loadNote} from "../js/translate/service";
import {
	cancelOutgoing,
	lastOnceTarget,
	noteOutgoingSent,
	recordSentReadBack,
	translateOnce as translateDraftOnce,
	translateOutgoing,
	writeTarget,
} from "../js/translate/writer";

/** How long after a Return its late-arriving newline is still recognised. */
const ENTER_NEWLINE_WINDOW_MS = 500;

/** Characters of a failure reason the strip shows; the title has all of it. */
const REASON_MAX = 120;

/** How long the strip's Copy button reads "Copied" after a successful copy. */
const COPIED_LABEL_MS = 2000;
import {TypingReporter} from "../js/helpers/typingReporter";
import TypingIndicator from "./TypingIndicator.vue";
import QuotePreview from "./QuotePreview.vue";

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
	components: {SourceLanguagePicker, TypingIndicator, QuotePreview},
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
		};

		const getInputPlaceholder = (channel: ClientChan) => {
			if (channel.type === ChanType.CHANNEL || channel.type === ChanType.QUERY) {
				const to = writeTarget(props.network, channel);

				// A write target that is the user's own language sends their
				// lines corrected (writer.ts), and the placeholder says so.
				if (to === readingLanguage()) {
					return t("translate.composer.placeholderCorrected", {name: channel.name});
				}

				return to
					? t("translate.composer.placeholder", {
							name: channel.name,
							language: languageName(to, readingLanguage()),
					  })
					: t("composer.placeholder", {name: channel.name});
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

		// The wait is the server's connection throttle (irc/dialLedger.ts).
		const throttledWait = computed(
			() => retryInSeconds.value > 0 && props.network.status.retryThrottled === true
		);

		const connectionLabel = computed(() => {
			const name = props.network.name || t("composer.fallbackNetwork");

			if (!props.network.status.connecting) {
				return t("composer.disconnectedFrom", {network: name});
			}

			if (throttledWait.value) {
				// irc/dialLedger.ts: dialling now would be refused and renew it.
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

			return entry.from
				? `${readerName(entry.from)} → ${readerName(entry.to)}`
				: `→ ${readerName(entry.to)}`;
		});

		// The read-back row's label: the translation's language → the one it
		// is read back into, the user's reading language.
		const outgoingCheckLabel = computed(() =>
			outgoing.value
				? `${readerName(outgoing.value.to)} → ${readerName(readingLanguage())}`
				: ""
		);

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
		const keepTypingLabel = computed(() => t("translate.strip.keepTyping"));
		const outgoingSendLabel = computed(() =>
			outgoing.value?.status === "failed"
				? t("translate.strip.sendAsWritten")
				: t("translate.strip.sendTranslation")
		);

		// Send waits for the translation, and for the automatic check.
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
		 * the "send as written" path cannot drift apart.
		 */
		const deliver = (text: string, original: string) => {
			const target = props.channel.id;
			const editing = props.channel.editing;
			const replyTo = props.channel.replyTo;

			if (autocompletionRef.value) {
				autocompletionRef.value.hide();
			}

			props.channel.inputHistoryPosition = 0;
			props.channel.pendingMessage = "";
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
			// only honours `reply`/`edit` for plain text (and `reply` for /me).
			const reply = editing ? editing.replyTo : replyTo?.msgid;
			const edit = editing?.msgid;

			socket.emit("input", {
				target,
				text,
				...(reply ? {reply} : {}),
				...(edit ? {edit} : {}),
			});

			props.channel.replyTo = null;
			props.channel.editing = null;
		};

		const onSubmit = (fromEnterKey = false) => {
			if (!input.value) {
				return;
			}

			// Triggering click event opens the virtual keyboard on mobile
			// This can only be called from another interactive event (e.g. button click)
			input.value.click();
			input.value.focus();

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
			if (editing && text === editing.text) {
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
				if (outgoingBusy.value) {
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

				cancelOutgoing(props.channel);
				deliver(line, text);

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
			// when the draft turns out to need none.
			if (
				writeTarget(props.network, props.channel) &&
				(gate.kind === "ok" || gate.kind === "action")
			) {
				// The verdict can be seconds late (a cold engine, a slow
				// device), so it is checked against the composer it started
				// in: another conversation, a changed draft or a network that
				// went down in the meantime all leave the draft where it is.
				const startedFor = props.channel.id;

				void translateOutgoing(props.network, props.channel, gate.text).then((verdict) => {
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
		 */
		const onEnterKey = (e: KeyboardEvent) => {
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

		const blurInput = () => {
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

		// The translate button is the channel's send target as a toggle,
		// independent of the globe (which is reading): off, a click opens
		// the dialog and the pick becomes the write target (channelStore
		// `write`, the same setting the panel's "Send my messages in" shows)
		// until the button is clicked again; the dialog's "This message
		// only" makes the pick a one-off instead (writer.ts `translateOnce`),
		// the way the toolbar's Translate reads one line. Shown wherever
		// translation can run at all.
		const translateOnceButton = ref<HTMLButtonElement | null>(null);
		const translateOncePickerOpen = ref(false);
		const translateOnceAvailable = computed(
			() =>
				translationAvailable() &&
				(props.channel.type === ChanType.CHANNEL || props.channel.type === ChanType.QUERY)
		);
		const canTranslateOnce = computed(() => {
			const gate = draftGate(props.channel.pendingMessage ?? "", !!props.channel.editing);

			return (
				(gate.kind === "ok" || gate.kind === "action") &&
				gate.text.trim() !== "" &&
				canSend.value &&
				!outgoingBusy.value
			);
		});
		// The channel's send target: the button is lit while one is set.
		const sendTarget = computed(() => writeTarget(props.network, props.channel));
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
		// The dialog's source: the language the user reads.
		const translateOnceFrom = computed(() => readingLanguage());

		const openTranslateOnce = () => {
			if (!canSend.value) {
				return;
			}

			// On: the click turns the send target off; a strip in flight for
			// it goes too. Off: the dialog.
			if (sendTarget.value) {
				setChannelOptions(props.network, props.channel, {write: null});
				cancelOutgoing(props.channel);
				focusForTyping();
				return;
			}

			// The channel's last pick, else a language the channel speaks,
			// else the user's own (the cleanup pass) -- each only where this
			// device can serve it from the reading language, so a device
			// without the GPU model never opens on a disabled cleanup pass
			// (outgoing.ts `onceTargetDefault`).
			const reading = readingLanguage();
			translateOncePreselected.value = onceTargetDefault({
				reading,
				last: lastOnceTarget(props.network, props.channel),
				declared: channelTranslation(props.network, props.channel).languages,
				fallback: SUPPORTED_LANGUAGES,
				routes: (to) => !!pairVerdict(reading, to).route,
			});
			translateOncePickerOpen.value = !translateOncePickerOpen.value;
		};

		// A same-language pick is a cleanup pass on the GPU model
		// (writer.ts, router.ts): the dialog asks the router's own rule
		// (reader.ts `pairVerdict`) and says why when it cannot run.

		const translateOnce = (to: string, from: string | null = null, once = false) => {
			translateOncePickerOpen.value = false;

			const draft = props.channel.pendingMessage ?? "";
			const gate = draftGate(draft, !!props.channel.editing);
			const translatable =
				canTranslateOnce.value && (gate.kind === "ok" || gate.kind === "action");

			if (once) {
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
			setChannelOptions(props.network, props.channel, {write: to});

			if (translatable) {
				void translateOutgoing(props.network, props.channel, gate.text);
			}

			focusForTyping();
		};

		const cancelOutgoingNow = () => {
			cancelOutgoing(props.channel);
			focusForTyping();
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
				focusForTyping();
			}
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
				if (store.state.outgoingTranslations[props.channel.id]) {
					cancelOutgoing(props.channel);
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

			// Text the arrows bring in — a history entry, an own message to edit —
			// gets the caret on the edge it was reached from: at the start after
			// ArrowUp, at the end after ArrowDown, so holding either key keeps
			// stepping instead of climbing through every row of a long entry.
			const showStepped = (el: HTMLTextAreaElement, text: string, key: string) => {
				const caret = key === "up" ? 0 : text.length;

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
						showStepped(el, props.channel.pendingMessage, key);
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
					if (channel.pendingMessage !== (channel.editing.text ?? "")) {
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

					showStepped(el, channel.pendingMessage, key);

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
			cancelOutgoingNow,
			copiedOutgoing,
			copyOutgoing,
			copyLabel,
			keepTypingLabel,
			outgoingSendLabel,
			translateOnceButton,
			translateOncePickerOpen,
			translateOnceAvailable,
			canTranslateOnce,
			translateOnceLabel,
			translateOncePreselected,
			translateOnceFrom,
			sendTarget,
			openTranslateOnce,
			translateOnce,
		};
	},
});
</script>
