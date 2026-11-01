<template>
	<span
		v-if="entry && entry.status === 'skipped' && !entry.hidden"
		class="msg-translation-skipped"
		:data-reason="entry.reason"
	>
		<button
			ref="chip"
			type="button"
			class="msg-translation-skipped-tag"
			:aria-label="chipLabel"
			:title="chipLabel"
			@click.stop="openMenu"
		>
			{{ chipText }}
		</button>
		<SourceLanguagePicker
			v-if="pickerOpen"
			:anchor="chip"
			:selected="entry.from"
			:candidates="entry.candidates"
			:to="entry.to"
			@pick="pickSource"
			@close="pickerOpen = false"
		/>
	</span>
	<div
		v-else-if="entry && !entry.hidden && entry.status !== 'dropped'"
		class="msg-translation"
		:data-status="entry.status"
	>
		<button
			ref="chip"
			type="button"
			class="msg-translation-chip"
			:aria-label="chipLabel"
			:title="chipLabel"
			@click.stop="openMenu"
		>
			{{ chipText }}
		</button>
		<SourceLanguagePicker
			v-if="pickerOpen"
			:anchor="chip"
			:selected="entry.from"
			:candidates="entry.candidates"
			:to="entry.to"
			@pick="pickSource"
			@close="pickerOpen = false"
		/>
		<span v-if="entry.status === 'failed'" class="msg-translation-failed">
			<button
				v-if="entry.error === UNCHANGED"
				type="button"
				class="msg-translation-skipped-tag"
				:title="notTranslatedLabel"
				:aria-label="notTranslatedLabel"
				@click.stop="openMenu"
			>
				<i class="fas fa-equals" aria-hidden="true" />
				<span v-if="devtoolsAvailable" class="msg-translation-reason">{{
					t("translate.unchangedReason")
				}}</span>
			</button>
			<!-- The reason's tooltip is the reason in full (the line cuts it
			     at REASON_MAX), in words: a declined download's raw error is
			     a code and the model as JSON. -->
			<template v-else>
				{{ t("translate.failed") }}
				<span v-if="entry.error" class="msg-translation-reason" :title="reasonText">{{
					shortReason(reasonText)
				}}</span>
				<button
					type="button"
					class="msg-translation-retry"
					:title="retryLabel"
					:aria-label="retryLabel"
					@click.stop="retry"
				/>
			</template>
		</span>
		<span v-else class="msg-translation-text" :lang="entry.to" dir="auto">
			<ParsedMessage
				v-if="entry.text"
				:network="network"
				:message="message"
				:text="entry.text"
			/>
			<span v-if="download" class="msg-translation-download">{{ download }}</span>
			<span
				v-if="entry.status === 'pending'"
				class="msg-translation-caret"
				aria-hidden="true"
			/>
		</span>
	</div>
</template>

<script lang="ts">
import {computed, defineComponent, PropType, ref} from "vue";
import {writeClipboard} from "../js/clipboard";
import {devtoolsAvailable} from "../js/devtools";
import eventbus from "../js/eventbus";
import {useI18n} from "../js/i18n";
import {useStore} from "../js/store";
import {
	liveLlmName,
	pairVerdict,
	readingLanguage,
	retranslate,
	retryTranslation,
	showOriginal,
} from "../js/translate/reader";
import {translateWhyText} from "../js/helpers/translateWhy";
import {ANSWERED, DEGENERATE, NARRATION, UNCHANGED} from "../js/translate/outgoing";
import {languageName} from "../js/translate/languages";
import {directionText} from "../js/translate/labels";
import {loadNoteText} from "../js/helpers/modelLabel";
import {translateErrorText} from "../js/helpers/translateErrors";
import {loadNote} from "../js/translate/service";
import type {ClientChan, ClientMessage, ClientNetwork} from "../js/types";
import ParsedMessage from "./ParsedMessage.vue";
import SourceLanguagePicker from "./SourceLanguagePicker.vue";

/** Characters of a failure reason the line shows; the title has all of it. */
const REASON_MAX = 120;

export default defineComponent({
	name: "TranslationLine",
	components: {ParsedMessage, SourceLanguagePicker},
	props: {
		message: {type: Object as PropType<ClientMessage>, required: true},
		channel: {type: Object as PropType<ClientChan>, required: true},
		network: {type: Object as PropType<ClientNetwork>, required: true},
	},
	setup(props) {
		const store = useStore();
		const {t} = useI18n();
		const entry = computed(() => store.state.translations[props.message.id]);
		const notTranslatedLabel = computed(() => t("translate.notTranslated"));
		const retryLabel = computed(() => t("translate.retry"));
		// The failure reason after "Couldn't translate": the classifier's
		// verdicts are phrases of our own and come from the pot; any other
		// error string is the engine's own text and renders verbatim.
		const reasonText = computed(() => {
			const error = entry.value?.error ?? "";

			if (error === ANSWERED) {
				return t("translate.reason.answered");
			}

			if (error === NARRATION) {
				return t("translate.reason.narration");
			}

			if (error === DEGENERATE) {
				return t("translate.reason.degenerate");
			}

			return translateErrorText(error, () => {
				const line = entry.value;
				const verdict = line ? pairVerdict(line.from || null, line.to) : null;

				return verdict && !verdict.route
					? translateWhyText(verdict.why, liveLlmName())
					: "";
			});
		});
		// Every language the line names is named in the language its reader
		// reads (the channel's reading language, else the global one), not
		// the browser's: "French → English" for an English reader,
		// "Französisch → Englisch" for a German one.
		const nameOf = (code: string) => languageName(code, readingLanguage());
		// Source → target; `from` is "" when the engine placed the source
		// itself, and the detector's contenders are named instead (labels.ts).
		// A skipped line's tag is the language it was taken for, or "?" when
		// the detector could not tell.
		const chipText = computed(() => {
			const value = entry.value;

			if (!value) {
				return "";
			}

			if (value.status === "skipped") {
				return value.reason === "same" && value.from ? nameOf(value.from) : "?";
			}

			return directionText(value.from, value.to, value.candidates ?? [], nameOf);
		});
		const chipLabel = computed(() => {
			const value = entry.value;

			if (!value) {
				return "";
			}

			if (value.status === "skipped") {
				return value.reason === "same" && value.from
					? t("translate.chip.alreadyIn", {language: nameOf(value.from)})
					: t("translate.chip.unsure");
			}

			return t("translate.chip.options", {languages: chipText.value});
		});

		// Nothing streamed yet and a model of this line's engine downloading:
		// the line is waiting for that download, and says so.
		const download = computed(() => {
			const value = entry.value;

			if (!value || value.status !== "pending" || value.text || !value.engine) {
				return "";
			}

			const view = store.state.translation.models.find(
				(v) => v.status === "downloading" && v.ref.engine === value.engine
			);

			return view ? loadNoteText(loadNote(view)) : "";
		});

		const chip = ref<HTMLButtonElement | null>(null);
		const pickerOpen = ref(false);

		const retranslateFrom = (from?: string) =>
			retranslate(props.network, props.channel, props.message, from);

		const pickSource = (code: string) => retranslateFrom(code);

		// The detector's runners-up, one click each. The line's own source is
		// not among them: "Retranslate from German" on a line already read as
		// German is just "Retranslate". An explicit source keeps the list, so
		// the way back to the detector's own guess is on the menu too.
		// A skipped line leaves the reading language off as well: "Retranslate
		// from English" into English is no translation.
		const alternatives = computed(() => {
			const value = entry.value;

			return (value?.candidates ?? []).filter(
				(code) =>
					code !== value?.from && !(value?.status === "skipped" && code === value.to)
			);
		});

		// The context menu positions itself at the pointer, and a keyboard
		// activation (Enter or Space on the chip) carries none — clientX and
		// clientY are 0, so the menu opened in the top-left corner of the
		// window, nowhere near the line it belongs to. Every way in gets the
		// same anchor instead: under the chip that was pressed, whichever of
		// the three buttons that is (only one of them carries the `chip`
		// ref, so the rect comes off the event's own target).
		const anchorOf = (event: MouseEvent): MouseEvent => {
			const target = event.currentTarget as HTMLElement | null;

			if (!target) {
				return event;
			}

			const rect = target.getBoundingClientRect();

			return new MouseEvent("click", {
				clientX: rect.left,
				clientY: rect.bottom,
				bubbles: false,
			});
		};

		const openMenu = (mouseEvent: MouseEvent) => {
			const event = anchorOf(mouseEvent);
			const sources = [
				...alternatives.value.map((code) => ({
					label: t("translate.menu.retranslateFrom", {language: nameOf(code)}),
					type: "item",
					class: "translate-retry-from",
					action: () => retranslateFrom(code),
				})),
				{
					label: t("translate.menu.retranslateFromPicker"),
					type: "item",
					class: "translate-retry-pick",
					action() {
						pickerOpen.value = true;
					},
				},
			];

			// A mark has no text to copy, hide or retranslate: what it offers
			// is the translation it did not get.
			if (entry.value?.status === "skipped") {
				eventbus.emit("contextmenu:items", {
					event,
					items: [
						{
							label: t("translate.menu.translateAnyway"),
							type: "item",
							class: "translate-anyway",
							action: () => retranslateFrom(),
						},
						...sources,
					],
				});
				return;
			}

			// An entry that failed as "unchanged" has no translation to copy,
			// so its menu is the failed row's minus the Copy item.
			const unchanged = entry.value?.status === "failed" && entry.value.error === UNCHANGED;

			eventbus.emit("contextmenu:items", {
				event,
				items: [
					...(unchanged
						? []
						: [
								{
									label: t("translate.menu.copy"),
									type: "item",
									class: "translate-copy",
									// Like the toolbar's Copy: nowhere to report a
									// refused clipboard, so a failure is silent.
									action() {
										void writeClipboard(entry.value?.text ?? "");
									},
								},
						  ]),
					{
						label: t("translate.menu.retranslate"),
						type: "item",
						class: "translate-retry",
						action: () => retranslateFrom(),
					},
					...sources,
					{
						label: t("translate.menu.showOriginal"),
						type: "item",
						class: "translate-hide",
						action: () => showOriginal(props.message.id, true),
					},
				],
			});
		};

		const retry = () => retryTranslation(props.network, props.channel, props.message);

		// Why it failed, after "couldn't translate": an engine's error can be
		// long and multi-line, so the line shows the head of it and the title
		// carries the whole thing.
		const shortReason = (error: string | null) => {
			if (!error) {
				return "";
			}

			const text = error.replace(/\s+/g, " ").trim();

			return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX - 1)}…` : text;
		};

		return {
			entry,
			chip,
			pickerOpen,
			chipText,
			chipLabel,
			download,
			openMenu,
			pickSource,
			retry,
			shortReason,
			t,
			UNCHANGED,
			devtoolsAvailable,
			notTranslatedLabel,
			retryLabel,
			reasonText,
		};
	},
});
</script>
