<template>
	<span
		class="msg-actions"
		:class="{active: pickerOpen}"
		role="toolbar"
		aria-label="Message actions"
	>
		<span class="msg-actions-quick">
			<button
				v-for="q in quickButtons"
				:key="q.text"
				type="button"
				class="msg-action msg-action-quick"
				:class="{selected: q.on}"
				:aria-label="q.label"
				:title="q.label"
				:aria-pressed="q.on"
				@click="react(q.text)"
			>
				{{ q.text }}
			</button>
		</span>
		<button
			ref="reactButton"
			type="button"
			class="msg-action msg-action-react"
			aria-label="React"
			title="React"
			:aria-expanded="pickerOpen"
			@mouseenter="preloadEmoji"
			@mousedown.stop
			@click="pickerOpen = !pickerOpen"
		/>
		<span class="msg-action-divider" role="separator" aria-orientation="vertical" />
		<button
			type="button"
			class="msg-action msg-action-reply"
			aria-label="Reply"
			title="Reply"
			@click="reply"
		/>
		<button
			v-if="canCopyText"
			type="button"
			class="msg-action msg-action-copy-text"
			aria-label="Copy text"
			title="Copy text"
			@click.stop="copyText"
		/>
		<button
			v-if="codeBlocks.length > 0"
			type="button"
			class="msg-action msg-action-copy"
			aria-label="Copy code"
			title="Copy code"
			@click.stop="copyCode"
		/>
		<button
			v-if="canEdit"
			type="button"
			class="msg-action msg-action-edit"
			aria-label="Edit"
			title="Edit"
			@click="edit"
		/>
		<template v-if="canDelete">
			<span class="msg-action-divider" role="separator" aria-orientation="vertical" />
			<button
				type="button"
				class="msg-action msg-action-delete"
				aria-label="Delete message"
				title="Delete message"
				@click="remove"
			/>
		</template>
		<ReactionPicker
			v-if="pickerOpen"
			:anchor="reactButton"
			:selected="mine"
			@pick="react"
			@close="pickerOpen = false"
		/>
	</span>
	<!-- The word a copy leaves behind, where the toolbar was. Inert: it is a
	label, not a control, so a finger on its way elsewhere goes through it. -->
	<span v-if="copied" class="msg-copied" role="status">Copied</span>
</template>

<script lang="ts">
import {computed, defineComponent, onUnmounted, PropType, Ref, ref, watch} from "vue";
import eventbus from "../js/eventbus";
import socket from "../js/socket";
import {writeClipboard} from "../js/clipboard";
import {codeBlocksOf, layout} from "../js/helpers/ircmessageparser/layout";
import {useStore} from "../js/store";
import {startEdit, startReply} from "../js/helpers/compose";
import {myReactions} from "../js/helpers/messageUpdates";
import {loadEmojiCatalog} from "../js/helpers/emoji";
import {quickReactions, RECENTS_CHANGED, rememberReaction} from "../js/helpers/reactionRecents";
import {isTouchInput, onInputKindChange} from "../js/helpers/inputModality";
import {ChanType} from "../../shared/types/chan";
import {MessageType} from "../../shared/types/msg";
import type {ClientChan, ClientMessage, ClientNetwork} from "../js/types";
import ReactionPicker from "./ReactionPicker.vue";

// How long the "Copied" label stays over the row (its fade in style.css
// takes as long)
const COPIED_MS = 1000;

// The one-tap reactions, shared by every toolbar on screen: a pick anywhere
// moves it to the front everywhere. Read from storage when the first toolbar
// mounts, not when the bundle loads.
let quick: Ref<string[]> | undefined;

const sharedQuick = () => {
	if (!quick) {
		const shared = ref(quickReactions());
		eventbus.on(RECENTS_CHANGED, (recent: string[]) => {
			shared.value = quickReactions(recent);
		});
		quick = shared;
	}

	return quick;
};

// Whether the last pointer was a finger (helpers/inputModality.ts), shared by
// every toolbar on screen: the message text is unselectable exactly then
// (style.css, `data-input`), so that is when Copy text stands in for a
// selection. Made when the first toolbar mounts, after boot installed it.
let touch: Ref<boolean> | undefined;

const sharedTouch = () => {
	if (!touch) {
		const shared = ref(isTouchInput());
		onInputKindChange((kind) => {
			shared.value = kind === "touch";
		});
		touch = shared;
	}

	return touch;
};

export default defineComponent({
	name: "MessageActions",
	components: {ReactionPicker},
	props: {
		message: {type: Object as PropType<ClientMessage>, required: true},
		channel: {type: Object as PropType<ClientChan>, required: true},
		network: {type: Object as PropType<ClientNetwork>, required: true},
	},
	// `done`: an action was taken, the toolbar has served its purpose. On a
	// touch device Message.vue closes it, as every native menu closes on a
	// choice — a copy included: the next thing after a copy is a paste
	// somewhere else, and the bar only stood in the way of getting there.
	emits: ["done"],
	setup(props, {emit}) {
		const store = useStore();
		const pickerOpen = ref(false);
		const reactButton = ref<HTMLButtonElement | null>(null);

		// What we have already reacted with: the picker ticks these, and
		// picking one again takes it back off (bus-contract §1.4 `remove`).
		const mine = computed(() => myReactions(props.message, props.network.nick || ""));

		// One already on the message from us reads as pressed, and the tap
		// takes it off — the same toggle as the picker and the badge row.
		const quickButtons = computed(() =>
			sharedQuick().value.map((text) => {
				const on = mine.value.includes(text);

				return {text, on, label: on ? `Remove ${text}` : `React with ${text}`};
			})
		);

		// The code blocks the message renders, in order, each as its own
		// characters — the fence and the gutter are presentation, so neither is
		// in here. Markdown off means there are no blocks at all, and the cheap
		// test comes first because this runs for every message the toolbar is
		// on: without a fence there is nothing to find.
		const codeBlocks = computed(() => {
			const text = props.message.text ?? "";

			// Optional: mounted without a store (the browser specs in
			// test/client do that), no store means no Markdown
			if (!store?.state.settings.markdown || !text.includes("```")) {
				return [];
			}

			return codeBlocksOf(layout(text, {markdown: true}));
		});

		// Whether the "Copied" label is up
		const copied = ref(false);
		let copiedTimer: ReturnType<typeof setTimeout> | undefined;

		const clearCopied = () => {
			copied.value = false;

			if (copiedTimer !== undefined) {
				clearTimeout(copiedTimer);
				copiedTimer = undefined;
			}
		};

		onUnmounted(clearCopied);

		// A copy that did not happen says nothing and changes nothing. One
		// that did is the end of the toolbar (a pointer's stays with the
		// hover, as ever); the label outlives it, over the row.
		const copy = async (text: string) => {
			if (!(await writeClipboard(text))) {
				return;
			}

			emit("done");
			clearCopied();
			copied.value = true;
			copiedTimer = setTimeout(clearCopied, COPIED_MS);
		};

		// Several blocks are one copy, a blank line apart: they were blocks of
		// their own, and a copy that ran them together would be a different
		// program.
		const copyCode = () => copy(codeBlocks.value.join("\n\n"));

		// While a finger is in use the message text is not selectable (the long
		// press that would select it opens this toolbar instead — see
		// Message.vue), so the toolbar is how the text is copied then. A mouse
		// selects and copies as it always has, and does not get the button —
		// on a touchscreen laptop, whichever was used last decides.
		const canCopyText = computed(() => sharedTouch().value && !!props.message.text);
		const copyText = () => copy(props.message.text ?? "");

		// Only plain text can be edited (the IRC layer resends it tagged).
		const canEdit = computed(
			() => !!props.message.self && props.message.type === MessageType.MESSAGE
		);

		// Own messages anywhere; others' only in channels, where the server
		// decides (chanop / REDACT_WINDOW) and answers FAIL otherwise.
		const canDelete = computed(
			() => !!props.message.self || props.channel.type === ChanType.CHANNEL
		);

		// Fetch the catalog chunk while the pointer is on its way to the button,
		// so the grid is there the moment the picker opens.
		const preloadEmoji = () => void loadEmojiCatalog().catch(() => undefined);

		const reply = () => {
			startReply(props.channel, props.message);
			emit("done");
		};

		const edit = () => {
			startEdit(props.channel, props.message);
			emit("done");
		};

		// From a quick button or the picker alike. Taking one of ours back off
		// is not a use of it: it would jump to the front of the recents on its
		// way out (MessageReactions.vue keeps the same rule for the badges).
		const react = (text: string) => {
			if (!props.message.msgid) {
				return;
			}

			const remove = mine.value.includes(text);

			if (!remove) {
				rememberReaction(text);
			}

			socket.emit("msg:react", {
				target: props.channel.id,
				msgid: props.message.msgid,
				text,
				remove,
			});
			emit("done");
		};

		const remove = () => {
			const msgid = props.message.msgid;

			if (!msgid) {
				return;
			}

			const preview = (props.message.text ?? "").slice(0, 120);
			const who = props.message.self
				? "your message"
				: `${props.message.from?.nick}'s message`;

			emit("done");
			eventbus.emit(
				"confirm-dialog",
				{
					title: "Delete message",
					text: `Delete ${who}? "${preview}"`,
					button: "Delete",
				},
				(confirmed: boolean) => {
					if (confirmed) {
						socket.emit("msg:redact", {target: props.channel.id, msgid});
					}
				}
			);
		};

		// Close the picker if the message goes away or the channel changes.
		watch(
			() => props.channel.id,
			() => {
				pickerOpen.value = false;
			}
		);

		return {
			pickerOpen,
			reactButton,
			mine,
			canEdit,
			canDelete,
			codeBlocks,
			copied,
			canCopyText,
			quickButtons,
			reply,
			edit,
			react,
			preloadEmoji,
			remove,
			copyCode,
			copyText,
		};
	},
});
</script>
