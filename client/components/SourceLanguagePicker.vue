<template>
	<!-- Teleported to <body>: the scrollback clips its overflow, and the
	     phone's layout is a sheet along the bottom edge of the screen. -->
	<Teleport to="body">
		<div
			ref="root"
			class="source-language-picker"
			:class="{'source-language-picker--sheet': phone, flipped}"
			:style="style"
			role="dialog"
			:aria-label="dialogLabel"
			@keydown.esc.stop.prevent="$emit('close')"
		>
			<label v-if="purpose === 'target'" class="source-language-picker-field">
				<span class="source-language-picker-label">{{
					t("translate.picker.fromLabel")
				}}</span>
				<select
					v-model="from"
					name="translateFrom"
					class="input source-language-picker-control"
				>
					<option value="">{{ t("translate.picker.fromAuto") }}</option>
					<option v-for="code in languages" :key="code" :value="code">
						{{ name(code) }}
					</option>
				</select>
			</label>
			<label class="source-language-picker-field">
				<span class="source-language-picker-label">{{ fieldLabel }}</span>
				<select
					ref="select"
					v-model="choice"
					:name="purpose === 'target' ? 'translateInto' : 'translateFrom'"
					class="input source-language-picker-control"
				>
					<option v-for="code in languages" :key="code" :value="code">
						{{ name(code) }}
					</option>
				</select>
			</label>
			<label v-if="purpose === 'target' && onceOffered" class="source-language-picker-once">
				<input
					v-model="once"
					v-switch
					type="checkbox"
					class="source-language-picker-once-box"
				/>
				{{ t("translate.picker.thisMessageOnly") }}
			</label>
			<!-- Live: the reason appears and changes as the selects do. The
			     lead and the reason are two whole sentences. -->
			<div :id="hintId" class="source-language-picker-hint" aria-live="polite">
				<template v-if="blockedLead">
					<p class="source-language-picker-blocked">{{ blockedLead }}</p>
					<p class="source-language-picker-why">{{ blockedWhy }}</p>
				</template>
				<p v-else-if="sameLanguage">{{ t("translate.picker.sameLanguage") }}</p>
			</div>
			<div class="source-language-picker-actions">
				<button
					type="button"
					class="btn btn-sm source-language-picker-cancel"
					@click="$emit('close')"
				>
					{{ t("translate.picker.cancel") }}
				</button>
				<button
					type="button"
					class="btn btn-sm source-language-picker-confirm"
					:disabled="!!blockedLead"
					:aria-describedby="blockedLead ? hintId : undefined"
					@click="confirm"
				>
					{{ confirmLabel }}
				</button>
			</div>
		</div>
	</Teleport>
</template>

<script lang="ts">
import {computed, defineComponent, nextTick, onBeforeUnmount, onMounted, PropType, ref} from "vue";
import {hasVirtualKeyboard} from "../js/helpers/device";
import {useI18n} from "../js/i18n";
import {collator} from "../js/i18n/collation";
import {SUPPORTED_LANGUAGES, languageName} from "../js/translate/languages";
import {liveLlmName, pairVerdict, readingLanguage} from "../js/translate/reader";
import {translateWhyText} from "../js/helpers/translateWhy";

let pickers = 0;

/** Gap between the chip and the popover, and the margin it keeps off screen edges. */
const GAP = 6;
const EDGE = 8;
/** The width below which the popover becomes a sheet: the phone layout's breakpoint. */
const NARROW = "(max-width: 479px)";

export default defineComponent({
	name: "SourceLanguagePicker",
	props: {
		/** The chip the popover hangs off; positioning follows it as you scroll. */
		anchor: {type: Object as PropType<HTMLElement | null>, default: null},
		/** The line's current source ("" when the engine detected it). */
		selected: {type: String, default: ""},
		/** The detector's runners-up, for the preselection when there is no source. */
		candidates: {type: Array as PropType<string[]>, default: () => []},
		/**
		 * What the language is for: `source` retranslates a line from it
		 * (the chip menu's "Retranslate from…"), `target` translates the
		 * composer's draft into it, this once (the translate button).
		 */
		purpose: {type: String as PropType<"source" | "target">, default: "source"},
		/** `target` only: the source preselected -- the language the user reads. */
		selectedFrom: {type: String, default: ""},
		/**
		 * `source` only: the language the line is translated into, so the
		 * dialog can say when the picked source has no engine here. Empty:
		 * not checked.
		 */
		to: {type: String, default: ""},
		/** `target` only: a draft is there, so "This message only" is on offer. */
		onceOffered: {type: Boolean, default: false},
	},
	emits: ["pick", "close"],
	setup(props, {emit}) {
		const {t} = useI18n();
		const root = ref<HTMLDivElement | null>(null);
		const select = ref<HTMLSelectElement | null>(null);
		const name = (code: string) => languageName(code, readingLanguage());
		// Every language, named in the language the interface is in -- not in
		// itself: a reader who set the app to English is looking for "French",
		// not "Français" (TranslationPanel.vue names them the same way).
		// Names and order both follow the active locale (i18n/collation.ts).
		const languages = computed(() =>
			[...SUPPORTED_LANGUAGES].sort((a, b) => collator().compare(name(a), name(b)))
		);
		const dialogLabel = computed(() =>
			props.purpose === "target"
				? t("translate.picker.targetDialog")
				: t("translate.picker.dialog")
		);
		const fieldLabel = computed(() =>
			props.purpose === "target"
				? t("translate.picker.targetLabel")
				: t("translate.picker.label")
		);
		const choice = ref(props.selected || props.candidates[0] || languages.value[0]);
		// The source of a one-off: the language the user reads, or "" for
		// detection. Picking the same language twice asks for a cleanup.
		const from = ref(props.purpose === "target" ? props.selectedFrom : "");
		// "This message only": a one-off rather than the send target.
		const once = ref(false);
		const sameLanguage = computed(
			() => props.purpose === "target" && from.value !== "" && from.value === choice.value
		);

		// The pair the confirm would ask for, through the router's own rule
		// (reader.ts `pairVerdict`): a pair nothing here can serve -- the
		// cleanup pass without the GPU model, both engines switched off --
		// is offered disabled with its reason, never left to fail later.
		const verdict = computed(() => {
			if (props.purpose === "target") {
				return pairVerdict(from.value || null, choice.value);
			}

			return props.to ? pairVerdict(choice.value, props.to) : null;
		});
		const hintId = `source-language-picker-hint-${++pickers}`;
		const blockedLead = computed(() => {
			const v = verdict.value;

			if (!v || v.route) {
				return "";
			}

			if (v.polish) {
				return t("translate.picker.sameLanguageNeedsGpu");
			}

			const pairFrom = props.purpose === "target" ? from.value : choice.value;
			const pairTo = props.purpose === "target" ? choice.value : props.to;

			return pairFrom
				? t("translate.pair.unavailable", {from: name(pairFrom), to: name(pairTo)})
				: t("translate.pair.unavailableInto", {to: name(pairTo)});
		});
		const blockedWhy = computed(() => {
			const v = verdict.value;

			return v && !v.route ? translateWhyText(v.why, liveLlmName()) : "";
		});

		// A target that is the source is a cleanup pass, not a translation:
		// the button says what it will do (writer.ts, the strip's chip).
		const confirmLabel = computed(() => {
			if (props.purpose !== "target") {
				return t("translate.picker.confirm");
			}

			return sameLanguage.value
				? t("translate.picker.targetConfirmCorrect")
				: t("translate.picker.targetConfirm");
		});

		const narrowQuery =
			typeof window !== "undefined" && typeof window.matchMedia === "function"
				? window.matchMedia(NARROW)
				: null;
		const narrow = ref(narrowQuery ? narrowQuery.matches : false);

		const onNarrow = (event: MediaQueryListEvent) => {
			narrow.value = event.matches;
		};

		// A touch-primary device has no pointer for a popover's small
		// controls, and a window as narrow as the phone's chat layout has no
		// room for one: the same markup becomes the sheet.
		const phone = computed(() => hasVirtualKeyboard() || narrow.value);

		const style = ref<Record<string, string>>({});
		const flipped = ref(false);

		/**
		 * Pin the popover under (or, with no room, over) the chip. It is
		 * `position: fixed` and teleported to the body, so the anchor is
		 * followed by hand: on scroll and on resize. Scrolled past the
		 * message it belongs to, it closes rather than float over an
		 * unrelated part of the conversation (ReactionPicker.vue's rule).
		 */
		const reposition = () => {
			const el = root.value;
			const anchor = props.anchor;

			if (!el || !anchor) {
				return;
			}

			if (phone.value) {
				style.value = {};
				flipped.value = false;
				return;
			}

			const rect = anchor.getBoundingClientRect();
			const vh = window.innerHeight;
			const vw = window.innerWidth;

			if (rect.bottom < 0 || rect.top > vh) {
				emit("close");
				return;
			}

			const height = el.offsetHeight;
			const width = el.offsetWidth;
			const below = vh - rect.bottom - GAP - EDGE;
			const flip = below < height && rect.top - GAP - EDGE > below;
			const left = Math.min(Math.max(rect.left, EDGE), Math.max(EDGE, vw - width - EDGE));

			flipped.value = flip;
			style.value = {
				left: `${Math.round(left)}px`,
				...(flip
					? {bottom: `${Math.round(vh - rect.top + GAP)}px`}
					: {top: `${Math.round(rect.bottom + GAP)}px`}),
			};
		};

		const close = () => emit("close");

		const confirm = () => {
			emit(
				"pick",
				choice.value,
				props.purpose === "target" ? from.value || null : undefined,
				props.purpose === "target" ? once.value && props.onceOffered : undefined
			);
			close();
		};

		// Mousetrap's "escapekey" never fires for a synthetic KeyboardEvent
		// (it reads the key code), so the listener is our own — the same one
		// TranslationPanel.vue keeps.
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				close();
			}
		};

		// Bubble phase, like the reaction picker's: the opener stops its own
		// mousedown, so its button toggles instead of reopening.
		const onDocumentMouseDown = (event: MouseEvent) => {
			if (root.value && !root.value.contains(event.target as Node)) {
				close();
			}
		};

		onMounted(() => {
			document.addEventListener("keydown", onKey);
			document.addEventListener("mousedown", onDocumentMouseDown);
			window.addEventListener("scroll", reposition, true);
			window.addEventListener("resize", reposition);
			narrowQuery?.addEventListener("change", onNarrow);

			void nextTick(() => {
				reposition();
				select.value?.focus();
			});
		});

		onBeforeUnmount(() => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("mousedown", onDocumentMouseDown);
			window.removeEventListener("scroll", reposition, true);
			window.removeEventListener("resize", reposition);
			narrowQuery?.removeEventListener("change", onNarrow);

			// The caret goes back to the chip it came from.
			if (root.value?.contains(document.activeElement)) {
				props.anchor?.focus();
			}
		});

		return {
			t,
			root,
			select,
			choice,
			languages,
			dialogLabel,
			fieldLabel,
			confirmLabel,
			from,
			once,
			sameLanguage,
			hintId,
			blockedLead,
			blockedWhy,
			name,
			phone,
			flipped,
			style,
			confirm,
		};
	},
});
</script>
