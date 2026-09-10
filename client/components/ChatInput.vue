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
			<span class="connection-bar-label">{{ connectionLabel }}</span>
			<button
				v-if="canConnectNow"
				type="button"
				class="connection-bar-connect"
				@click="connectNetwork"
			>
				{{ network.status.connecting ? "Connect now" : "Connect" }}
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
				aria-label="Cancel upload"
				title="Cancel upload"
				@click="cancelUpload"
			>
				✕
			</button>
		</div>
		<div v-if="channel.editing || channel.replyTo" class="compose-bar" role="status">
			<span v-if="channel.editing" class="compose-bar-label">
				<span class="compose-bar-icon" aria-hidden="true">✎</span>
				Editing message
				<span class="compose-bar-preview">{{ composePreview }}</span>
			</span>
			<span v-else class="compose-bar-label">
				<span class="compose-bar-icon" aria-hidden="true">↩</span>
				Replying to <strong class="compose-bar-nick">{{ composeNick }}</strong
				>:
				<span class="compose-bar-preview">{{ composePreview }}</span>
			</span>
			<button
				type="button"
				class="compose-bar-cancel"
				aria-label="Cancel"
				title="Cancel (Escape)"
				@click="cancelCompose(channel)"
			>
				✕
			</button>
		</div>
		<span id="nick">{{ network.nick }}</span>
		<label for="input" class="sr-only">Message input</label>
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
			v-if="store.state.serverConfiguration?.fileUpload || networkFilehost"
			id="upload-tooltip"
			class="tooltipped tooltipped-w tooltipped-no-touch"
			aria-label="Upload file"
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
				aria-label="Upload file"
				:disabled="!network.status.connected"
			/>
		</span>
		<span
			id="submit-tooltip"
			class="tooltipped tooltipped-w tooltipped-no-touch"
			:data-tooltip="canSend ? 'Send message' : 'Not connected'"
		>
			<!-- `mousedown.prevent` keeps focus in the textarea: a tap that blurs
			it drops the keyboard, the viewport grows and the button moves out
			from under the finger before the click lands. -->
			<button
				id="submit"
				type="submit"
				aria-label="Send message"
				:disabled="!canSend"
				@mousedown.prevent
			/>
		</span>
	</form>
</template>

<script lang="ts">
import Mousetrap from "mousetrap";
import {wrapCursor} from "undate";
import autocompletion from "../js/autocompletion";
import {commands} from "../js/commands/index";
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

/** How long after a Return its late-arriving newline is still recognised. */
const ENTER_NEWLINE_WINDOW_MS = 500;
import {TypingReporter} from "../js/helpers/typingReporter";
import TypingIndicator from "./TypingIndicator.vue";

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
	components: {TypingIndicator},
	props: {
		network: {type: Object as PropType<ClientNetwork>, required: true},
		channel: {type: Object as PropType<ClientChan>, required: true},
	},
	setup(props) {
		const store = useStore();
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

				// Start by resetting height before computing as scrollHeight does not
				// decrease when deleting characters
				input.value.style.height = "";

				// Use scrollHeight to calculate how many lines there are in input, and ceil the value
				// because some browsers tend to incorrently round the values when using high density
				// displays or using page zoom feature
				input.value.style.height = `${
					Math.ceil(input.value.scrollHeight / lineHeight) * lineHeight
				}px`;
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

			// The Return that already sent, landing late (see onEnterKey).
			if (enterNewlineDeadline > performance.now() && /^\n+$/.test(el.value)) {
				enterNewlineDeadline = 0;
				el.value = "";
				props.channel.pendingMessage = "";
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
				return `Write to ${channel.name}`;
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

		const showConnectionBar = computed(
			() => isConversation.value && !props.network.status.connected
		);

		const canSend = computed(
			() =>
				props.network.status.connected ||
				!isConversation.value ||
				props.channel.pendingMessage.startsWith("/")
		);

		// The wait before the transport's next retry (`status.retryAt`) counts
		// down here — a tick every half second while the strip shows — and
		// "Connect now" skips it (`/connect` restarts the schedule).
		const now = ref(Date.now());
		let ticker: ReturnType<typeof setInterval> | null = null;

		const retryInSeconds = computed(() => {
			const at = props.network.status.retryAt;

			if (!props.network.status.connecting || at === undefined) {
				return 0;
			}

			return Math.max(0, Math.ceil((at - now.value) / 1000));
		});

		const connectionLabel = computed(() => {
			const name = props.network.name || "the network";

			if (!props.network.status.connecting) {
				return `Disconnected from ${name}.`;
			}

			return retryInSeconds.value > 0
				? `Reconnecting to ${name} in ${retryInSeconds.value}s…`
				: `Connecting to ${name}…`;
		});

		// Idle, or waiting for a retry: a dial in flight offers nothing.
		const canConnectNow = computed(
			() => !props.network.status.connecting || retryInSeconds.value > 0
		);

		watch(
			showConnectionBar,
			(shown) => {
				if (shown && ticker === null) {
					now.value = Date.now();
					ticker = setInterval(() => {
						now.value = Date.now();
					}, 500);
				} else if (!shown && ticker !== null) {
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

		// The same `/connect` the sidebar's status icon sends; any window of
		// the network routes to its client.
		const connectNetwork = () => {
			socket.emit("input", {target: props.channel.id, text: "/connect"});
		};

		// Reply/edit compose bar (channel.replyTo / channel.editing).
		const composeTarget = computed(() => props.channel.editing || props.channel.replyTo);

		const composeNick = computed(() => composeTarget.value?.from?.nick ?? "");

		const composePreview = computed(() => {
			const text = (composeTarget.value?.text ?? "").replace(/\s+/g, " ").trim();
			return text.length > 80 ? text.slice(0, 79) + "…" : text;
		});

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
			// answers it with NOT_CONNECTED_TEXT.
			const target = props.channel.id;

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

				return false;
			}

			const editing = props.channel.editing;
			const replyTo = props.channel.replyTo;

			// Editing to the identical text is a no-op: just leave edit mode.
			if (editing && text === editing.text) {
				cancelCompose(props.channel);
				clearInput();
				setInputSize();
				reportTyping(); // nothing was sent, so this is a real `done`
				return false;
			}

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
			if (props.channel.inputHistory[1] !== text) {
				props.channel.inputHistory.splice(1, 0, text);
			}

			// Limit input history to a 100 entries
			if (props.channel.inputHistory.length > 100) {
				props.channel.inputHistory.pop();
			}

			if (text[0] === "/") {
				const args = text.substring(1).split(" ");
				const cmd = args.shift()?.toLowerCase();

				if (!cmd) {
					return false;
				}

				if (Object.prototype.hasOwnProperty.call(commands, cmd) && commands[cmd](args)) {
					return false;
				}
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

		// The strip above the input while a file is going up
		// (`store.state.uploadProgress`, written by `upload.ts`).
		const uploadLabel = computed(() => {
			const progress = store.state.uploadProgress;

			if (!progress) {
				return "";
			}

			const parts = [`Uploading ${progress.fileName}`];

			if (progress.count > 1) {
				parts.push(`${progress.index} of ${progress.count}`);
			}

			if (progress.phase === "preparing") {
				parts.push("preparing…");
			} else if (progress.phase === "waiting") {
				parts.push("waiting for the server…");
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

			inputTrap.bind(["up", "down"], (e, key) => {
				if (
					store.state.isAutoCompleting ||
					(e.target as HTMLTextAreaElement).selectionStart !==
						(e.target as HTMLTextAreaElement).selectionEnd ||
					!input.value
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
						input.value.value = props.channel.pendingMessage;
						setInputSize();
						return false;
					}
				}

				const onRow = (
					input.value.value.slice(undefined, input.value.selectionStart).match(/\n/g) ||
					[]
				).length;
				const totalRows = (input.value.value.match(/\n/g) || []).length;

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

					if (key === "up" ? onRow !== 0 : onRow !== totalRows) {
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

					input.value.value = channel.pendingMessage;
					setInputSize();

					return false;
				}

				if (channel.inputHistoryPosition === 0) {
					channel.inputHistory[channel.inputHistoryPosition] = channel.pendingMessage;
				}

				if (key === "up" && onRow === 0) {
					if (channel.inputHistoryPosition < channel.inputHistory.length - 1) {
						channel.inputHistoryPosition++;
					} else {
						return;
					}
				} else if (
					key === "down" &&
					channel.inputHistoryPosition > 0 &&
					onRow === totalRows
				) {
					channel.inputHistoryPosition--;
				} else {
					return;
				}

				channel.pendingMessage = channel.inputHistory[channel.inputHistoryPosition];
				input.value.value = channel.pendingMessage;
				setInputSize();

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
			input,
			uploadInput,
			onUploadInputChange,
			openFileUpload,
			uploadAccept,
			networkFilehost,
			uploadLabel,
			uploadPercent,
			cancelUpload,
			blurInput,
			onBlur,
			setInputSize,
			upload,
			getInputPlaceholder,
			onSubmit,
			onEnterKey,
			setPendingMessage,
			cancelCompose,
			composeNick,
			composePreview,
			showConnectionBar,
			canSend,
			connectionLabel,
			retryInSeconds,
			canConnectNow,
			connectNetwork,
		};
	},
});
</script>
