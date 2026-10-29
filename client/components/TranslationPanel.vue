<template>
	<!-- One markup, two layouts. The sheet is teleported to <body> so it can
	     cover the whole screen: the desktop panel is absolutely positioned
	     inside the channel view, which clips its overflow. -->
	<Teleport to="body" :disabled="!phone">
		<div
			ref="panel"
			class="translation-panel"
			:class="{'translation-panel--sheet': phone}"
			role="dialog"
			:aria-modal="phone ? 'true' : undefined"
			:aria-label="panelLabel"
		>
			<div class="translation-panel-title">
				<span class="translation-panel-heading">{{ t("translate.panel.heading") }}</span>
				<span class="translation-panel-channel">{{ channel.name }}</span>
				<button
					type="button"
					class="translation-panel-close"
					:aria-label="closeLabel"
					:title="closeLabel"
					@click="$emit('close')"
				>
					✕
				</button>
			</div>

			<div class="translation-panel-body">
				<!-- Nothing here can translate (the engines switched off, a
				     device that runs neither): said first, as two sentences,
				     with the Settings link below. -->
				<div
					v-if="blockedWhy"
					id="translation-panel-blocked"
					class="translation-panel-blocked"
					role="status"
				>
					<p>{{ t("translate.unavailable.lead") }}</p>
					<p>{{ blockedWhy }}</p>
				</div>
				<section class="translation-panel-section">
					<h3>{{ t("translate.panel.reading") }}</h3>
					<!-- The reading language is not chosen here: it is the
					     interface's (the one `locale` setting, Settings →
					     Translation). This is only the switch. -->
					<div class="translation-panel-field">
						<span class="translation-panel-label">{{
							t("translate.panel.readIn", {language: name(readingLanguage())})
						}}</span>
						<div
							class="translation-panel-segmented"
							role="radiogroup"
							:aria-label="readingLabel"
							@keydown="onRadioKey"
						>
							<button
								v-for="option in readingChoices"
								:key="String(option.value)"
								type="button"
								role="radio"
								class="translation-panel-segment"
								:aria-checked="state.read === option.value"
								:tabindex="state.read === option.value ? 0 : -1"
								:disabled="option.value && !state.read && !!blockedWhy"
								:aria-describedby="
									option.value && blockedWhy
										? 'translation-panel-blocked'
										: undefined
								"
								@click="setRead(option.value)"
							>
								{{ option.label }}
							</button>
						</div>
						<span
							v-if="state.read && limited(readingLanguage())"
							class="translation-panel-limited"
							>{{ t("translate.limitedLanguage") }}</span
						>
						<span class="translation-panel-hint">{{
							t("translate.panel.readHint")
						}}</span>
					</div>

					<!-- The languages people write here. Not a multi-select: the
					     list is fifty long and what a channel speaks is two or
					     three of them, so they go in one at a time and come out
					     as chips. -->
					<div class="translation-panel-field">
						<span id="translation-panel-languages" class="translation-panel-label">{{
							t("translation.panel.languages", {channel: channel.name})
						}}</span>
						<div v-if="state.languages.length" class="translation-panel-chips">
							<span
								v-for="code in state.languages"
								:key="code"
								class="translation-panel-chip"
							>
								{{ name(code) }}
								<button
									type="button"
									class="translation-panel-chip-remove"
									:aria-label="removeLabel(code)"
									:title="removeLabel(code)"
									@click="removeLanguage(code)"
								>
									✕
								</button>
							</span>
						</div>
						<select
							name="translateLanguageAdd"
							class="input translation-panel-control"
							aria-labelledby="translation-panel-languages"
							value=""
							@change="onAddLanguage"
						>
							<option value="">{{ t("translate.panel.addLanguage") }}</option>
							<option v-for="code in addable" :key="code" :value="code">
								{{ name(code) }}
							</option>
						</select>
						<span class="translation-panel-hint">{{
							t("translate.panel.languagesHint")
						}}</span>
					</div>
				</section>

				<section class="translation-panel-section">
					<h3>{{ t("translate.panel.writing") }}</h3>
					<label class="translation-panel-field">
						<span class="translation-panel-label">{{
							t("translate.panel.writeLabel")
						}}</span>
						<select
							name="translateWrite"
							class="input translation-panel-control"
							:aria-describedby="
								writeNote ? 'translation-panel-write-note' : undefined
							"
							:value="state.write ?? ''"
							@change="onWrite"
						>
							<option value="">{{ t("translate.panel.off") }}</option>
							<!-- A language nothing here can write in is on the list,
							     disabled; the note under the select says why. -->
							<option
								v-for="code in languages"
								:key="code"
								:value="code"
								:disabled="writeBlocked(code)"
							>
								{{ name(code) }}
							</option>
						</select>
						<span v-if="limited(state.write)" class="translation-panel-limited">{{
							t("translate.limitedLanguage")
						}}</span>
						<span
							v-if="writeNote"
							id="translation-panel-write-note"
							class="translation-panel-why"
							><span class="translation-panel-why-lead">{{ writeNote.lead }}</span>
							<span>{{ writeNote.why }}</span></span
						>
						<span class="translation-panel-hint">{{
							t("translate.panel.writeHint")
						}}</span>
					</label>

					<!-- A native picker is a poor target on a phone: the three
					     choices are a segmented control there. -->
					<div v-if="phone" class="translation-panel-field">
						<span id="translation-panel-formality" class="translation-panel-label">{{
							t("translate.formality.label")
						}}</span>
						<div
							class="translation-panel-segmented"
							role="radiogroup"
							aria-labelledby="translation-panel-formality"
							@keydown="onRadioKey"
						>
							<button
								v-for="option in formalities"
								:key="option.value"
								type="button"
								role="radio"
								name="translateFormality"
								class="translation-panel-segment"
								:aria-checked="state.formality === option.value"
								:tabindex="state.formality === option.value ? 0 : -1"
								@click="setFormality(option.value)"
							>
								{{ option.label }}
							</button>
						</div>
					</div>
					<label v-else class="translation-panel-field">
						<span class="translation-panel-label">{{
							t("translate.formality.label")
						}}</span>
						<select
							name="translateFormality"
							class="input translation-panel-control"
							:value="state.formality"
							@change="onFormality"
						>
							<option value="auto">{{ t("translate.formality.auto") }}</option>
							<option value="formal">{{ t("translate.formality.formal") }}</option>
							<option value="casual">{{ t("translate.formality.casual") }}</option>
						</select>
					</label>

					<label class="translation-panel-field">
						<span class="translation-panel-label">{{
							t("translate.panel.variant")
						}}</span>
						<input
							name="translateVariant"
							type="text"
							class="input translation-panel-control"
							:value="state.variant"
							:placeholder="variantPlaceholder"
							@change="onVariant"
						/>
						<span class="translation-panel-hint">{{
							t("translate.panel.variantHint")
						}}</span>
					</label>
				</section>
			</div>

			<div class="translation-panel-foot">
				<router-link
					class="translation-panel-more"
					to="/settings/translation"
					@click="$emit('close')"
				>
					{{ t("translate.panel.settingsLink") }}
				</router-link>
			</div>
		</div>
	</Teleport>
</template>

<script lang="ts">
import {computed, defineComponent, onBeforeUnmount, onMounted, PropType, ref} from "vue";
import {useI18n} from "../js/i18n";
import {SUPPORTED_LANGUAGES, languageName} from "../js/translate/languages";
import {
	channelTranslation,
	currentTranslationBlock,
	liveLlmName,
	pairVerdict,
	readingLanguage,
	setChannelOptions,
	setReading,
} from "../js/translate/reader";
import {translateWhyText} from "../js/helpers/translateWhy";
import {isLimitedLanguage} from "../js/translate/routes.default";
import {translateService} from "../js/translate";
import {llmChoice, normalizeDeviceChoice} from "../js/translate/models";
import {useStore} from "../js/store";
import {cancelOutgoing} from "../js/translate/writer";
import {hasVirtualKeyboard} from "../js/helpers/device";
import {collator} from "../js/i18n/collation";
import type {ClientChan, ClientNetwork} from "../js/types";
import type {Formality} from "../js/translate/channelStore";

/** The width below which the panel is a sheet: the phone layout's breakpoint. */
const NARROW = "(max-width: 479px)";

export default defineComponent({
	name: "TranslationPanel",
	props: {
		channel: {type: Object as PropType<ClientChan>, required: true},
		network: {type: Object as PropType<ClientNetwork>, required: true},
	},
	emits: ["close"],
	setup(props, {emit}) {
		const {t} = useI18n();
		const panel = ref<HTMLElement | null>(null);
		const store = useStore();
		const state = computed(() => channelTranslation(props.network, props.channel));
		// The limited languages are the selected GPU model's (routes.default.ts).
		const limited = (code: string | null) =>
			isLimitedLanguage(
				code,
				llmChoice(
					translateService().catalog,
					store.state.settings.translateLlmModel,
					store.state.translation.capability,
					normalizeDeviceChoice(store.state.settings.translateLlmDevice)
				).id
			);
		const name = (code: string) => languageName(code, readingLanguage());
		// Both the names and their order follow the active locale, so the
		// list is a computed: a locale change re-sorts it (i18n/collation.ts).
		const languages = computed(() =>
			[...SUPPORTED_LANGUAGES].sort((a, b) => collator().compare(name(a), name(b)))
		);
		// The segmented control's short labels (the phone layout).
		const formalities = computed((): {value: Formality; label: string}[] => [
			{value: "auto", label: t("translate.formality.autoShort")},
			{value: "formal", label: t("translate.formality.formal")},
			{value: "casual", label: t("translate.formality.casual")},
		]);
		const panelLabel = computed(() =>
			t("translate.panel.title", {channel: props.channel.name})
		);
		const closeLabel = computed(() => t("translate.panel.close"));
		const readingLabel = computed(() => t("translate.panel.reading"));
		const variantPlaceholder = computed(() => t("translate.panel.variantPlaceholder"));
		const valueOf = (event: Event) =>
			(event.target as HTMLSelectElement | HTMLInputElement).value;

		// A touch-primary device has no room for the anchored panel and no
		// pointer for its small controls; so has a window narrow enough that
		// the chat itself is the phone's layout. Read before the first render
		// so the panel is never drawn in the wrong layout and teleported after.
		const narrowQuery =
			typeof window !== "undefined" && typeof window.matchMedia === "function"
				? window.matchMedia(NARROW)
				: null;
		const narrow = ref(narrowQuery ? narrowQuery.matches : false);

		const onNarrow = (event: MediaQueryListEvent) => {
			narrow.value = event.matches;
		};

		const phone = computed(() => hasVirtualKeyboard() || narrow.value);

		// What is left to declare, so the picker never offers a language the
		// channel already lists.
		const addable = computed(() =>
			languages.value.filter((code) => !state.value.languages.includes(code))
		);

		const readingChoices = computed(() => [
			{value: false, label: t("translate.panel.off")},
			{value: true, label: t("translate.panel.on")},
		]);

		const setRead = (on: boolean) => setReading(props.network, props.channel, on);

		const setLanguages = (next: string[]) =>
			setChannelOptions(props.network, props.channel, {languages: next});

		const onAddLanguage = (event: Event) => {
			const select = event.target as HTMLSelectElement;
			const code = select.value;

			// Back to "Add a language…": the select is a verb, not a value, and
			// the chosen language is now shown as a chip.
			select.value = "";

			if (code && !state.value.languages.includes(code)) {
				setLanguages([...state.value.languages, code]);
			}
		};

		const removeLanguage = (code: string) =>
			setLanguages(state.value.languages.filter((c) => c !== code));

		const removeLabel = (code: string) => t("translation.panel.remove", {language: name(code)});

		// Nothing here can translate at all: the banner's reason (router.ts
		// `translationBlock`), and the reading switch's On is disabled.
		const blockedWhy = computed(() => {
			const block = currentTranslationBlock();

			return block ? translateWhyText(block, liveLlmName()) : "";
		});

		// Writing in `code` is a translation from the language the user reads
		// (or, the same language, the cleanup pass): the router's own verdict.
		const writeVerdict = (code: string) => pairVerdict(readingLanguage(), code);
		const writeBlocked = (code: string) => !writeVerdict(code).route;

		// Why a language is greyed: the one chosen, when it no longer runs,
		// else the cleanup pass (the user's own language), which is the one a
		// GPU-less device greys while every other stays on offer.
		const writeNote = computed(() => {
			if (blockedWhy.value) {
				return null;
			}

			const reading = readingLanguage();
			const code =
				state.value.write && writeBlocked(state.value.write) ? state.value.write : reading;
			const verdict = writeVerdict(code);

			if (verdict.route) {
				return null;
			}

			// The greyed own language under a select that shows something
			// else (Off, another language): the note names the option it is
			// about, or it reads as an error about the current choice.
			const aboutGreyedOption = verdict.polish && state.value.write !== code;

			return {
				lead: aboutGreyedOption
					? t("translate.panel.ownLanguageNeedsGpu", {language: name(code)})
					: verdict.polish
					? t("translate.picker.sameLanguageNeedsGpu")
					: t("translate.pair.unavailable", {from: name(reading), to: name(code)}),
				why: translateWhyText(verdict.why, liveLlmName()),
			};
		});

		const onWrite = (event: Event) => {
			// A strip already up was translated for the old target: it must not
			// survive the change, finished or not.
			cancelOutgoing(props.channel);
			setChannelOptions(props.network, props.channel, {write: valueOf(event) || null});
		};

		const setFormality = (formality: Formality) =>
			setChannelOptions(props.network, props.channel, {formality});

		const onFormality = (event: Event) => setFormality(valueOf(event) as Formality);
		const onVariant = (event: Event) =>
			setChannelOptions(props.network, props.channel, {variant: valueOf(event).trim()});

		// What Tab can reach inside the panel, in document order.
		const tabbable = (): HTMLElement[] =>
			Array.from(
				panel.value?.querySelectorAll<HTMLElement>(
					"button, select, input, textarea, a[href], [tabindex]"
				) ?? []
			).filter(
				(el) =>
					el.tabIndex >= 0 &&
					!(el as HTMLButtonElement).disabled &&
					el.getClientRects().length > 0
			);

		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				emit("close");
				return;
			}

			// The sheet is modal (aria-modal, the whole screen): Tab wraps
			// inside it instead of walking out into the app hidden under it.
			// The desktop panel is not modal and lets the focus go.
			if (event.key !== "Tab" || !phone.value) {
				return;
			}

			const items = tabbable();

			if (items.length === 0) {
				return;
			}

			const first = items[0];
			const last = items[items.length - 1];
			const active = document.activeElement;
			const inside = !!panel.value && panel.value.contains(active);

			if (event.shiftKey && (!inside || active === first)) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && (!inside || active === last)) {
				event.preventDefault();
				first.focus();
			}
		};

		// A segmented radiogroup is one Tab stop (the checked radio, a roving
		// tabindex) and the arrow keys move the choice, as the radiogroup
		// pattern has it; a disabled choice is stepped over.
		const onRadioKey = (event: KeyboardEvent) => {
			const step =
				event.key === "ArrowRight" || event.key === "ArrowDown"
					? 1
					: event.key === "ArrowLeft" || event.key === "ArrowUp"
					? -1
					: 0;

			if (step === 0) {
				return;
			}

			const group = event.currentTarget as HTMLElement;
			const radios = Array.from(
				group.querySelectorAll<HTMLButtonElement>('[role="radio"]')
			).filter((radio) => !radio.disabled);
			const at = radios.indexOf(document.activeElement as HTMLButtonElement);

			if (radios.length < 2 || at < 0) {
				return;
			}

			event.preventDefault();
			// The visual order follows the direction: under RTL the next
			// choice is to the left.
			const rtl = getComputedStyle(group).direction === "rtl";
			const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
			const delta = rtl && horizontal ? -step : step;
			const next = radios[(at + delta + radios.length) % radios.length];

			next.focus();
			next.click();
		};

		const onPointer = (event: MouseEvent) => {
			// The sheet covers the viewport, so there is no outside to click.
			if (phone.value) {
				return;
			}

			if (panel.value && !panel.value.contains(event.target as Node)) {
				emit("close");
			}
		};

		let pointerTimer: ReturnType<typeof setTimeout> | null = null;

		onMounted(() => {
			document.addEventListener("keydown", onKey);
			narrowQuery?.addEventListener("change", onNarrow);
			// Deferred so the click that opened the panel does not close it.
			pointerTimer = setTimeout(() => document.addEventListener("mousedown", onPointer), 0);
			// The panel's main control first: the reading switch's checked
			// choice (one Tab stop), not the second field's select.
			panel.value?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus();
		});
		onBeforeUnmount(() => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("mousedown", onPointer);
			narrowQuery?.removeEventListener("change", onNarrow);

			// A panel closed within the tick would otherwise leave the
			// deferred registration to add a listener nothing removes.
			if (pointerTimer !== null) {
				clearTimeout(pointerTimer);
				pointerTimer = null;
			}

			// The caret goes back where it came from — but only when the panel
			// is what holds it: a channel switch closes the panel too, and the
			// composer has just been given the focus for the new conversation.
			if (panel.value?.contains(document.activeElement)) {
				document.querySelector<HTMLElement>("#chat button.translate")?.focus();
			}
		});

		return {
			t,
			blockedWhy,
			writeBlocked,
			writeNote,
			panel,
			phone,
			state,
			languages,
			addable,
			formalities,
			name,
			limited,
			readingChoices,
			readingLanguage,
			panelLabel,
			closeLabel,
			readingLabel,
			variantPlaceholder,
			setRead,
			onAddLanguage,
			removeLanguage,
			removeLabel,
			onWrite,
			setFormality,
			onFormality,
			onVariant,
			onRadioKey,
		};
	},
});
</script>
