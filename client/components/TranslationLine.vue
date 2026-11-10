<template>
	<!-- A done translation stands in the original's place (Message.vue
	     `replaced`, a tap on the text swaps it back), so this row is only
	     for what is not one: a failure with its retry, or a line waiting on a
	     model download. Nothing at all for a line the reader left alone (a
	     detection skip), one the engine handed back as it was (UNCHANGED), or
	     one still being translated: it swaps in when done. The toolbar's
	     Translate still translates any of them. Two offers nobody is
	     interrupted by: a download the line needs (`needed`, a Download link
	     in place of the failure), and the system translator's language pack
	     on the first line translated from its pair (`applePack`). -->
	<div
		v-if="
			entry &&
			!entry.hidden &&
			(entry.status === 'failed'
				? entry.error !== UNCHANGED
				: entry.status === 'done'
				? applePack
				: !!download)
		"
		class="msg-translation"
		:data-status="entry.status"
	>
		<span v-if="entry.status === 'done'" class="msg-translation-offer">
			{{ t("translate.line.applePack", {language: sourceName}) }}
			<button type="button" class="msg-translation-get" @click.stop="getApplePack">
				{{ t("translate.line.applePackGet") }}
			</button>
		</span>
		<button
			v-else
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
		<span
			v-if="entry.status === 'failed' && needed"
			class="msg-translation-offer"
			:title="reasonText"
		>
			{{ t("translate.line.needsDownload", {size: neededSize}) }}
			<button type="button" class="msg-translation-get" @click.stop="getDownload">
				{{ t("translate.line.download") }}
			</button>
		</span>
		<span v-else-if="entry.status === 'failed'" class="msg-translation-failed">
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
		</span>
		<span
			v-else-if="entry.status !== 'done'"
			class="msg-translation-text"
			:lang="entry.to"
			dir="auto"
		>
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
import {directionText, sourceText} from "../js/translate/labels";
import {loadNoteText, translatedByText} from "../js/helpers/modelLabel";
import {translateErrorText} from "../js/helpers/translateErrors";
import {loadNote} from "../js/translate/service";
import type {ClientChan, ClientMessage, ClientNetwork} from "../js/types";
import ParsedMessage from "./ParsedMessage.vue";
import SourceLanguagePicker from "./SourceLanguagePicker.vue";
import friendlysize from "../js/helpers/friendlysize";
import {parseNeedsDownload} from "../js/translate/consent";
import {packShownOn, takePack} from "../js/translate/applePacks";
import {activeService, systemTranslator} from "../js/translate";

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
		const chipText = computed(() => {
			const value = entry.value;

			if (!value) {
				return "";
			}

			// An own line's translation is the read-back of what was sent
			// (sentReadBack.ts): its language is the one it went out in.
			if (props.message.self && value.from) {
				return t("translate.chip.sentIn", {language: nameOf(value.from)});
			}

			return t("translate.chip.from", {
				language: sourceText(value.from, value.to, value.candidates ?? [], nameOf),
			});
		});
		const chipLabel = computed(() => {
			const value = entry.value;

			if (!value) {
				return "";
			}

			return t("translate.chip.options", {
				languages: directionText(value.from, value.to, value.candidates ?? [], nameOf),
			});
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
		const alternatives = computed(() => {
			const value = entry.value;

			return (value?.candidates ?? []).filter((code) => code !== value?.from);
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
			const by = translatedByText(entry.value?.model);
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

			eventbus.emit("contextmenu:items", {
				event,
				items: [
					{
						label: t("translate.menu.copy"),
						type: "item",
						class: "translate-copy",
						// Like the toolbar's Copy: nowhere to report a refused
						// clipboard, so a failure is silent.
						action() {
							void writeClipboard(entry.value?.text ?? "");
						},
					},
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
					// Which model translated it, quietly at the foot.
					...(by
						? [
								{type: "divider" as const},
								{type: "note" as const, label: by, class: "translate-by"},
						  ]
						: []),
				],
			});
		};

		const retry = () => retryTranslation(props.network, props.channel, props.message);

		// A download the line needs and nobody agreed to (service.ts
		// `ResolveOptions.quiet`): the line offers it, and the yes retries it,
		// the download's progress then shown on the line (`download`).
		const needed = computed(() => {
			const error = entry.value?.status === "failed" ? entry.value.error : null;

			return error ? parseNeedsDownload(error) : null;
		});
		const neededSize = computed(() => friendlysize(needed.value?.sizeBytes ?? 0));
		const getDownload = () => {
			const need = needed.value;

			if (need) {
				activeService()?.allowDownload(need.id, need.device);
				retry();
			}
		};

		// The system translator could take this line's pair once its pack is
		// downloaded (applePacks.ts); the sheet opens only on this tap.
		const applePack = computed(() => {
			const value = entry.value;

			return (
				!!value &&
				value.status === "done" &&
				packShownOn(props.message.id, value.from, value.to)
			);
		});
		const sourceName = computed(() => (entry.value?.from ? nameOf(entry.value.from) : ""));
		const getApplePack = () => {
			const value = entry.value;

			if (value?.from) {
				takePack(value.from, value.to);
				void systemTranslator()?.offer(value.from, value.to);
			}
		};

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
			needed,
			neededSize,
			getDownload,
			applePack,
			sourceName,
			getApplePack,
			shortReason,
			t,
			UNCHANGED,
			retryLabel,
			reasonText,
		};
	},
});
</script>
