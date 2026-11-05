<template>
	<span
		class="msg-actions"
		:class="{active: pickerOpen || sourcePickerOpen}"
		role="toolbar"
		:aria-label="toolbarLabel"
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
			:aria-label="reactLabel"
			:title="reactLabel"
			:aria-expanded="pickerOpen"
			@mouseenter="preloadEmoji"
			@mousedown.stop
			@click="pickerOpen = !pickerOpen"
		/>
		<span class="msg-action-divider" role="separator" aria-orientation="vertical" />
		<button
			type="button"
			class="msg-action msg-action-reply"
			:aria-label="replyLabel"
			:title="replyLabel"
			@click="reply"
		/>
		<button
			v-if="canCopyText"
			type="button"
			class="msg-action msg-action-copy-text"
			:aria-label="copyTextLabel"
			:title="copyTextLabel"
			@click.stop="copyText"
		/>
		<button
			v-if="codeBlocks.length > 0"
			type="button"
			class="msg-action msg-action-copy"
			:aria-label="copyCodeLabel"
			:title="copyCodeLabel"
			@click.stop="copyCode"
		/>
		<button
			v-if="canTranslate"
			ref="translateButton"
			type="button"
			class="msg-action msg-action-translate"
			:aria-label="translateLabel"
			:title="translateBlocked || translateLabel"
			:aria-haspopup="hiddenTranslation || translateBlocked ? undefined : 'menu'"
			:disabled="!!translateBlocked && !explainOnTap"
			:aria-disabled="translateBlocked && explainOnTap ? 'true' : undefined"
			:aria-describedby="translateBlocked ? translateWhyId : undefined"
			@click.stop="translate"
		/>
		<!-- Why it is off, for a screen reader as well as the tooltip. -->
		<span v-if="canTranslate && translateBlocked" :id="translateWhyId" class="sr-only">{{
			translateBlocked
		}}</span>
		<button
			v-if="canEdit"
			type="button"
			class="msg-action msg-action-edit"
			:aria-label="editLabel"
			:title="editLabel"
			@click="edit"
		/>
		<template v-if="canDelete">
			<span class="msg-action-divider" role="separator" aria-orientation="vertical" />
			<button
				type="button"
				class="msg-action msg-action-delete"
				:aria-label="deleteLabel"
				:title="deleteLabel"
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
		<SourceLanguagePicker
			v-if="sourcePickerOpen"
			:anchor="translateButton"
			:candidates="channelLanguages"
			:to="readingLanguage()"
			@pick="translateFrom"
			@close="sourcePickerOpen = false"
		/>
	</span>
	<!-- The word a copy leaves behind, where the toolbar was. Inert: it is a
	label, not a control, so a finger on its way elsewhere goes through it. -->
	<span v-if="copied" class="msg-copied" role="status">{{ t("message.copied") }}</span>
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
import {
	channelTranslation,
	currentTranslationBlock,
	liveLlmName,
	readingLanguage,
	retranslate,
	showOriginal,
	translationAvailable,
} from "../js/translate/reader";
import {translateWhyText} from "../js/helpers/translateWhy";
import {quickReactions, RECENTS_CHANGED, rememberReaction} from "../js/helpers/reactionRecents";
import {isTouchInput, onInputKindChange} from "../js/helpers/inputModality";
import {ChanType} from "../../shared/types/chan";
import {MessageType} from "../../shared/types/msg";
import type {ClientChan, ClientMessage, ClientNetwork} from "../js/types";
import ReactionPicker from "./ReactionPicker.vue";
import SourceLanguagePicker from "./SourceLanguagePicker.vue";
import {useI18n} from "../js/i18n";

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
	components: {ReactionPicker, SourceLanguagePicker},
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
		const {t} = useI18n();
		const pickerOpen = ref(false);
		const reactButton = ref<HTMLButtonElement | null>(null);
		const sourcePickerOpen = ref(false);
		const translateButton = ref<HTMLButtonElement | null>(null);

		// What we have already reacted with: the picker ticks these, and
		// picking one again takes it back off (bus-contract §1.4 `remove`).
		const mine = computed(() => myReactions(props.message, props.network.nick || ""));

		// One already on the message from us reads as pressed, and the tap
		// takes it off — the same toggle as the picker and the badge row.
		const quickButtons = computed(() =>
			sharedQuick().value.map((text) => {
				const on = mine.value.includes(text);

				return {
					text,
					on,
					label: on
						? t("message.quickRemove", {reaction: text})
						: t("message.quickReact", {reaction: text}),
				};
			})
		);

		// The code blocks the message renders, in order, each as its own
		// characters — the fence and the gutter are presentation, so neither is
		// in here. Markdown off means there are no blocks at all, and the cheap
		// test comes first because this runs for every message the toolbar is
		// on: without a fence there is nothing to find.
		const codeBlocks = computed(() => {
			const text = props.message.text ?? "";

			// Optional: mounted without a store, no store means no Markdown
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

		// Toolbar labels.
		const toolbarLabel = computed(() => t("message.actionsToolbar"));
		const replyLabel = computed(() => t("message.reply"));
		const reactLabel = computed(() => t("message.react"));
		const editLabel = computed(() => t("message.edit"));
		const deleteLabel = computed(() => t("message.deleteTitle"));
		const copyCodeLabel = computed(() => t("message.copyCode"));
		const copyTextLabel = computed(() => t("message.copyText"));

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
		// A blocked Translate stays tappable under a finger (and says why);
		// under a mouse it is disabled with the reason as its tooltip.
		const explainOnTap = computed(() => sharedTouch().value);
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

		// "Show original only" hides the line, chip included, so the toolbar
		// is the only way back to it.
		const hiddenTranslation = computed(() => {
			const entry = store.state.translations[props.message.id];

			return !!entry && entry.status === "done" && entry.hidden;
		});

		const translateLabel = computed(() =>
			hiddenTranslation.value
				? t("translate.action.showTranslation")
				: t("translate.action.translate")
		);

		const canTranslate = computed(() => {
			if (!translationAvailable() || props.message.self) {
				return false;
			}

			if (
				props.message.type !== MessageType.MESSAGE &&
				props.message.type !== MessageType.ACTION
			) {
				return false;
			}

			const entry = store.state.translations[props.message.id];

			return (
				!entry ||
				entry.status === "failed" ||
				entry.status === "dropped" ||
				// A line detection left alone: the mark's "Translate anyway".
				entry.status === "skipped" ||
				hiddenTranslation.value
			);
		});

		// Nothing here can translate (both engines switched off, say): the
		// action stays on offer, disabled, with the reason -- not missing,
		// and not a request that fails a moment later. Showing a hidden
		// translation again needs no engine.
		const translateBlocked = computed(() => {
			if (hiddenTranslation.value) {
				return "";
			}

			const block = currentTranslationBlock();

			return block ? translateWhyText(block, liveLlmName()) : "";
		});
		const translateWhyId = `msg-translate-why-${props.message.id}`;

		// Fetch the catalog chunk while the pointer is on its way to the button,
		// so the grid is there the moment the picker opens.
		const preloadEmoji = () => void loadEmojiCatalog().catch(() => undefined);

		const reply = () => {
			startReply(props.channel, props.message);
			emit("done");
		};

		// Nothing has placed this line, so the dialog opens on what the
		// channel is known to speak (the panel's declared languages) rather
		// than on whatever sorts first; with none declared it opens on the
		// list, as the chip's picker does for a line with no source.
		const channelLanguages = computed(
			() => channelTranslation(props.network, props.channel).languages
		);

		const translateFrom = (from?: string) =>
			retranslate(props.network, props.channel, props.message, from);

		/**
		 * The action's menu: translate now, with the line's language left to
		 * the detector, or name that language first. Nothing detected this
		 * line yet -- that is what the action is for -- so the detector's
		 * runners-up are not on offer the way the chip's menu has them
		 * (`TranslationLine.vue`); after the translation the chip carries
		 * them. A keyboard activation gives the menu no pointer to open at,
		 * so it is anchored under the button, as the chip's is.
		 */
		const openMenu = (mouseEvent: MouseEvent) => {
			const target = mouseEvent.currentTarget as HTMLElement | null;
			const rect = target?.getBoundingClientRect();
			const event = rect
				? new MouseEvent("click", {
						clientX: rect.left,
						clientY: rect.bottom,
						bubbles: false,
				  })
				: mouseEvent;

			eventbus.emit("contextmenu:items", {
				event,
				items: [
					{
						label: t("translate.menu.translateNow"),
						type: "item",
						class: "translate-now",
						action: () => translateFrom(),
					},
					{
						label: t("translate.menu.translateFromPicker"),
						type: "item",
						class: "translate-from-pick",
						action() {
							sourcePickerOpen.value = true;
						},
					},
				],
			});
		};

		const translate = (event: MouseEvent) => {
			// Blocked under a finger: the tooltip that says why never shows
			// there, so the tap opens the channel's translation panel, whose
			// notice gives the reason and the way to Settings.
			if (translateBlocked.value) {
				store.commit("translationPanelFor", props.channel.id);
				emit("done");
				return;
			}

			if (hiddenTranslation.value) {
				// Showing it again must not cost a new translation, and there
				// is nothing to choose: no menu on this one.
				showOriginal(props.message.id, false);
				return;
			}

			openMenu(event);
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
				? t("message.deleteWhoSelf")
				: t("message.deleteWhoOther", {nick: props.message.from?.nick ?? ""});

			emit("done");
			eventbus.emit(
				"confirm-dialog",
				{
					title: t("message.deleteTitle"),
					text: t("message.deleteConfirm", {who, preview}),
					button: t("message.delete"),
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
				sourcePickerOpen.value = false;
			}
		);

		return {
			t,
			pickerOpen,
			reactButton,
			sourcePickerOpen,
			translateButton,
			channelLanguages,
			hiddenTranslation,
			mine,
			canEdit,
			canDelete,
			canTranslate,
			translateBlocked,
			translateWhyId,
			explainOnTap,
			readingLanguage,
			codeBlocks,
			copied,
			toolbarLabel,
			replyLabel,
			reactLabel,
			editLabel,
			deleteLabel,
			copyCodeLabel,
			copyTextLabel,
			canCopyText,
			quickButtons,
			reply,
			edit,
			translate,
			translateFrom,
			translateLabel,
			react,
			preloadEmoji,
			remove,
			copyCode,
			copyText,
		};
	},
});
</script>
