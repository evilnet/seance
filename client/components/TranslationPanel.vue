<template>
	<!-- A header popover (style.css `.header-popover`), as the mentions are:
	     under the channel menu's ⋮ on a pointer machine, the whole chat under
	     the header on a phone. Teleported to #viewport, whose transparent
	     container is its backdrop; #chat clips its overflow. -->
	<Teleport to="#viewport">
		<div
			class="header-popover-container"
			v-backdrop="closeFromOutside"
			data-escape-close="translation"
			@contextmenu.self.prevent="close"
		>
			<div
				ref="panel"
				class="header-popover translation-panel"
				role="dialog"
				aria-modal="true"
				:aria-label="panelLabel"
				tabindex="-1"
				:style="placement"
				@keydown.tab="onTab"
				@keydown.esc.stop.prevent="close"
			>
				<div class="header-popover-title">
					<h2>
						{{ t("translate.panel.heading") }}
						<span class="header-popover-aside">{{ channel.name }}</span>
					</h2>
					<button
						type="button"
						class="header-popover-close"
						:aria-label="closeLabel"
						@click="close"
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
					<!-- The engine paused itself after repeated failures (queue.ts
					     PAUSE_AFTER_FAILURES) and comes back on its own. -->
					<p
						v-else-if="pausedWhy"
						class="translation-panel-blocked translation-panel-paused"
						role="status"
					>
						{{ t("translate.panel.paused", {reason: pausedWhy}) }}
					</p>
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
							<span
								id="translation-panel-languages"
								class="translation-panel-label"
								>{{
									t("translation.panel.languages", {channel: channel.name})
								}}</span
							>
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
								><span class="translation-panel-why-lead">{{
									writeNote.lead
								}}</span>
								<span>{{ writeNote.why }}</span></span
							>
							<span class="translation-panel-hint">{{
								t("translate.panel.writeHint")
							}}</span>
						</label>

						<!-- Three choices are three targets, not a native picker. -->
						<div class="translation-panel-field">
							<span
								id="translation-panel-formality"
								class="translation-panel-label"
								>{{ t("translate.formality.label") }}</span
							>
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
						@click="close"
					>
						{{ t("translate.panel.settingsLink") }}
					</router-link>
				</div>
			</div>
		</div>
	</Teleport>
</template>

<script lang="ts">
import {computed, defineComponent, nextTick, onBeforeUnmount, onMounted, PropType, ref} from "vue";
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
import eventbus from "../js/eventbus";
import {placeUnder} from "../js/helpers/headerPopover";
import {trapTab} from "../js/helpers/trapTab";
import {collator} from "../js/i18n/collation";
import type {ClientChan, ClientNetwork} from "../js/types";
import type {Formality} from "../js/translate/channelStore";

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
		// The formality control's short labels: three segments side by side.
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

		const close = () => emit("close");

		// A press on a header button beside the pane closes it and does what
		// the button says, as the mentions do, or each would need two presses.
		const closeFromOutside = (event: MouseEvent) => {
			close();
			void nextTick(() => {
				document
					.elementFromPoint(event.clientX, event.clientY)
					?.closest<HTMLElement>("button")
					?.click();
			});
		};

		// Under the channel menu's ⋮, which is what opens it (its
		// "Translation…"); the phone layout's rule ignores the placement.
		const placement = ref<Record<string, string>>({});
		const place = () => {
			placement.value = placeUnder(document.querySelector("#chat button.menu"), panel.value);
		};

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
		// The engine's own message: a verbatim value, never translated.
		const pausedWhy = computed(() => store.state.translation.paused?.message ?? "");

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
			// Set here, the target names no source: each draft is detected
			// (the composer's dialog is where a source is named, `writeFrom`).
			setChannelOptions(props.network, props.channel, {
				write: valueOf(event) || null,
				writeFrom: null,
			});
		};

		const setFormality = (formality: Formality) =>
			setChannelOptions(props.network, props.channel, {formality});

		const onVariant = (event: Event) =>
			setChannelOptions(props.network, props.channel, {variant: valueOf(event).trim()});

		const onTab = (event: KeyboardEvent) => trapTab(event, panel.value as HTMLElement);

		// Escape and Android's Back close the topmost overlay
		// (helpers/escapeLayer.ts): this one when it is on top. The app's
		// binding ignores a key pressed in a field, so the pane also takes
		// Escape itself while the focus is inside it (the template's
		// @keydown.esc, as SourceLanguagePicker.vue does).
		const onEscape = (layer: string | null) => {
			if (layer === "translation") {
				close();
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

		onMounted(() => {
			eventbus.on("escapekey", onEscape);
			window.addEventListener("resize", place);
			place();
			// The panel's main control first: the reading switch's checked
			// choice (one Tab stop), not the second field's select.
			void nextTick(() =>
				panel.value
					?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')
					?.focus()
			);
		});
		onBeforeUnmount(() => {
			eventbus.off("escapekey", onEscape);
			window.removeEventListener("resize", place);

			// The caret goes back where it came from — but only when the panel
			// is what holds it: a channel switch closes the panel too, and the
			// composer has just been given the focus for the new conversation.
			if (panel.value?.contains(document.activeElement)) {
				document.querySelector<HTMLElement>("#chat button.menu")?.focus();
			}
		});

		return {
			t,
			blockedWhy,
			pausedWhy,
			writeBlocked,
			writeNote,
			panel,
			placement,
			close,
			closeFromOutside,
			onTab,
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
			onVariant,
			onRadioKey,
		};
	},
});
</script>
