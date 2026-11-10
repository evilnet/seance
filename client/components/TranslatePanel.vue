<template>
	<!-- The translate panel (docs/resources/translation.md § The translate
	     panel): typed in the user's own language, translated as it is typed,
	     read back, and put into the composer by Insert. The composer itself
	     is never translated: what is sent is what the message box holds. -->
	<div
		class="translate-panel"
		role="region"
		:aria-label="t('translate.writePanel.label', {language: toName})"
		@keydown.esc.stop.prevent="$emit('close')"
	>
		<div class="translate-panel-head">
			<span class="translate-panel-title">{{ t("translate.writePanel.into") }}</span>
			<button
				ref="languageButton"
				type="button"
				class="translate-panel-language"
				aria-haspopup="dialog"
				:data-code="to"
				@click="$emit('choose', languageButton)"
			>
				{{ toName }} ▾
			</button>
		</div>
		<label for="translate-panel-input" class="sr-only">{{
			t("translate.writePanel.inputLabel")
		}}</label>
		<textarea
			id="translate-panel-input"
			ref="field"
			v-model="text"
			class="translate-panel-input"
			dir="auto"
			rows="2"
			:lang="from ?? reading"
			:placeholder="
				t('translate.writePanel.placeholder', {language: readerName(from ?? reading)})
			"
			@input="schedule"
			@keydown.enter.exact.prevent="onEnter"
		/>
		<!-- Quiet while it streams, announced once it is done or failed. -->
		<div
			:class="['translate-bar', 'translate-panel-result', {failed: state === 'failed'}]"
			role="status"
			:aria-live="state === 'pending' ? 'off' : 'polite'"
		>
			<template v-if="state === 'empty'">
				<span class="translate-bar-chip">{{
					t("translate.writePanel.hint", {language: toName})
				}}</span>
			</template>
			<template v-else-if="state === 'asTyped'">
				<span class="translate-bar-chip">{{
					t("translate.writePanel.asTyped", {language: toName})
				}}</span>
			</template>
			<template v-else-if="state === 'failed'">
				<span class="translate-bar-text translate-bar-failed"
					>{{ t("translate.writePanel.failed", {language: toName})
					}}<span
						v-if="reason"
						class="translate-bar-reason"
						:title="entry?.error ?? ''"
						>{{ reason }}</span
					></span
				>
				<button type="button" class="translate-bar-link translate-panel-retry" @click="run">
					{{ t("translate.writePanel.tryAgain") }}
				</button>
			</template>
			<template v-else>
				<span class="translate-bar-chip" :title="routeTitle">{{
					state === "pending" ? pendingLabel : toName
				}}</span>
				<span
					v-if="entry?.text"
					class="translate-bar-text translate-panel-translation"
					dir="auto"
					:lang="to"
					>{{ entry.text
					}}<span
						v-if="state === 'pending'"
						class="translate-bar-caret"
						aria-hidden="true"
					></span
				></span>
				<span
					v-if="state === 'done' && entry && entry.check.status !== 'idle'"
					class="translate-bar-check translate-panel-check"
				>
					<span v-if="entry.check.status === 'failed'" class="translate-bar-failed">{{
						t("translate.strip.checkFailed")
					}}</span>
					<span
						v-else
						class="translate-bar-text"
						dir="auto"
						:lang="entry.check.to ?? undefined"
						>{{ t("translate.writePanel.readsAs", {text: entry.check.text}) }}</span
					>
				</span>
			</template>
		</div>
		<div class="translate-panel-actions">
			<button type="button" class="btn btn-sm translate-panel-cancel" @click="$emit('close')">
				{{ t("translate.writePanel.cancel") }}
			</button>
			<button
				type="button"
				class="btn btn-sm translate-panel-insert"
				:disabled="!insertable"
				@click="insert"
			>
				{{ t("translate.writePanel.insert") }}
			</button>
		</div>
	</div>
</template>

<script lang="ts">
import {
	computed,
	defineComponent,
	nextTick,
	onMounted,
	onUnmounted,
	PropType,
	ref,
	watch,
} from "vue";
import type {ClientChan, ClientNetwork} from "../js/types";
import {useStore, type OutgoingTranslation} from "../js/store";
import {useI18n} from "../js/i18n";
import {languageName} from "../js/translate/languages";
import {liveLlmName, pairVerdict, readingLanguage} from "../js/translate/reader";
import {cancelOutgoing, translateOutgoing} from "../js/translate/writer";
import {draftGate} from "../js/translate/outgoing";
import {loadNote} from "../js/translate/service";
import {loadNoteText} from "../js/helpers/modelLabel";
import {translateErrorText} from "../js/helpers/translateErrors";
import {translateWhyText} from "../js/helpers/translateWhy";

/** The pause in typing after which the panel's text is translated. */
export const PANEL_PAUSE_MS = 700;

/** Characters of a failure reason the panel shows; the title has all of it. */
const REASON_MAX = 120;

/** What Insert puts in the composer, and what it is a translation of. */
export interface PanelInsert {
	/** The line for the composer: the translation, or the text as typed. */
	line: string;
	/** Set when `line` is a translation: what was typed, and the languages. */
	translated: {
		typed: string;
		to: string;
		from: string | null;
		/** The writer's entry as it stood at Insert, for the read-back. */
		entry: OutgoingTranslation;
	} | null;
}

export default defineComponent({
	name: "TranslatePanel",
	props: {
		network: {type: Object as PropType<ClientNetwork>, required: true},
		channel: {type: Object as PropType<ClientChan>, required: true},
		/** The language to translate into. */
		to: {type: String, required: true},
		/** The language the user writes in, when they named one; else detected. */
		from: {type: String as PropType<string | null>, default: null},
	},
	emits: {
		close: () => true,
		choose: (_anchor: HTMLElement | null | undefined) => true,
		insert: (_value: PanelInsert) => true,
	},
	setup(props, {emit}) {
		const store = useStore();
		const {t} = useI18n();
		const field = ref<HTMLTextAreaElement>();
		const languageButton = ref<HTMLButtonElement>();
		const text = ref("");
		// The run's verdict for the text it was asked about: "plain" when
		// nothing needs translating (already in the target, or no route).
		const plainFor = ref<string | null>(null);
		let timer: ReturnType<typeof setTimeout> | null = null;

		const reading = computed(() => readingLanguage());
		const readerName = (code: string) => languageName(code, reading.value);
		const toName = computed(() => readerName(props.to));
		const typed = computed(() => text.value.trim());
		// What is asked for: the prose of a `/me`, which Insert puts back
		// behind its `/me `; a command is no prose, and goes as typed.
		const gate = computed(() => draftGate(typed.value, false));

		// The writer's entry, while it is for what the panel holds now.
		const entry = computed(() => {
			const value = store.state.outgoingTranslations[props.channel.id];

			return value && value.draft === gate.value.text && value.to === props.to ? value : null;
		});

		const state = computed<"empty" | "pending" | "done" | "failed" | "asTyped">(() => {
			if (typed.value === "") {
				return "empty";
			}

			if (plainFor.value === typed.value && !entry.value) {
				return "asTyped";
			}

			if (!entry.value) {
				return "pending";
			}

			return entry.value.status;
		});

		// Insert waits for a finished translation of exactly what is typed:
		// never half of one, never one of an older text.
		const insertable = computed(() => state.value === "done" || state.value === "asTyped");

		const pendingLabel = computed(() => {
			const value = entry.value;

			if (value?.model && !value.text) {
				const view = store.state.translation.models.find(
					(v) =>
						v.ref.id === value.model &&
						(!value.device || v.device === value.device) &&
						v.status === "downloading"
				);

				if (view) {
					return loadNoteText(loadNote(view));
				}
			}

			return t("translate.strip.translating");
		});

		// The route, for someone wondering why a translation reads as it does.
		const routeTitle = computed(() => {
			const value = entry.value;

			if (!value || !value.model) {
				return undefined;
			}

			const vars = {
				from: value.requestFrom
					? readerName(value.requestFrom)
					: t("translate.strip.sourceAuto"),
				to: readerName(value.to),
				model: value.model,
			};

			if (value.engine === "apple") {
				return t("translate.strip.routeSystem", vars);
			}

			return value.device === "gpu"
				? t("translate.strip.routeGpu", vars)
				: t("translate.strip.routeCpu", vars);
		});

		const reason = computed(() => {
			const error = entry.value?.error;

			if (!error) {
				return "";
			}

			const shown = translateErrorText(error, () => {
				const verdict = pairVerdict(props.from, props.to);

				return verdict && !verdict.route
					? translateWhyText(verdict.why, liveLlmName())
					: "";
			})
				.replace(/\s+/g, " ")
				.trim();

			return shown.length > REASON_MAX ? `${shown.slice(0, REASON_MAX - 1)}…` : shown;
		});

		const clearTimer = () => {
			if (timer !== null) {
				clearTimeout(timer);
				timer = null;
			}
		};

		const run = () => {
			clearTimer();
			const asked = typed.value;

			if (asked === "") {
				cancelOutgoing(props.channel);
				return;
			}

			if (gate.value.kind === "command") {
				cancelOutgoing(props.channel);
				plainFor.value = asked;
				return;
			}

			plainFor.value = null;
			void translateOutgoing(props.network, props.channel, gate.value.text, {
				to: props.to,
				from: props.from,
			}).then((verdict) => {
				if (verdict === "plain" && typed.value === asked) {
					plainFor.value = asked;
				}
			});
		};

		const schedule = () => {
			clearTimer();
			timer = setTimeout(run, PANEL_PAUSE_MS);
		};

		const insert = () => {
			if (!insertable.value) {
				return;
			}

			const value = entry.value;

			emit(
				"insert",
				value && state.value === "done"
					? {
							line: value.text,
							translated: {
								typed: typed.value,
								to: value.to,
								from: value.from,
								entry: {...value, check: {...value.check}},
							},
					  }
					: {line: typed.value, translated: null}
			);
		};

		// Return inserts once the translation is there; before that it waits,
		// as the button does. Shift+Return is a new line in the panel.
		const onEnter = () => insert();

		// Another language picked while text is typed: translated into it now.
		watch(
			() => [props.to, props.from] as const,
			() => {
				if (typed.value !== "") {
					run();
				}
			}
		);

		onMounted(() => {
			void nextTick(() => field.value?.focus());
		});

		onUnmounted(() => {
			clearTimer();
			cancelOutgoing(props.channel);
		});

		return {
			t,
			field,
			languageButton,
			text,
			reading,
			readerName,
			toName,
			entry,
			state,
			insertable,
			pendingLabel,
			routeTitle,
			reason,
			run,
			schedule,
			insert,
			onEnter,
		};
	},
});
</script>
