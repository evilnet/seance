<template>
	<div>
		<h2>
			{{ on ? t("translate.settings.heading") : t("translate.settings.headingLanguage") }}
		</h2>
		<div v-if="on" class="translate-hint">{{ t("translate.settings.intro") }}</div>
		<!-- Whatever the switch and the deploy say: this is the production
		     build's only interface-language picker, and a reader who keeps
		     translation off still wants German. Off, it is the interface
		     language alone, and says so. -->
		<label class="opt translate-target">
			<span>{{ t("translate.settings.interfaceLanguageLabel") }}</span>
			<!-- The one language control the whole app uses (the sidebar
			     globe renders the same component): one list of codes, one
			     "Automatic" label. `name` is not a prop, so it falls
			     through onto the <select> and the settings container's
			     change handler stores it like any other field. -->
			<LanguageSelect name="locale" :model-value="store.state.settings.locale" />
		</label>
		<!-- A deploy that switched translation off: no switch, the language
		     alone (translate/switch.ts translationAllowed). -->
		<div v-if="!deployAllows" class="translate-hint">
			{{ t("translate.settings.disabled") }}
		</div>
		<template v-else>
			<!-- Off by default (settings.ts `translationEnabled`); the settings
			     container stores it by its name, as it does every switch. -->
			<label class="opt translate-switch">
				<input
					v-switch
					:checked="!!store.state.settings.translationEnabled"
					type="checkbox"
					name="translationEnabled"
					aria-describedby="translate-switch-hint"
				/>
				{{ t("translate.settings.enable") }}
			</label>
			<div id="translate-switch-hint" class="translate-hint translate-switch-hint">
				{{ t("translate.settings.enableHint") }}
			</div>
			<template v-if="on">
				<!-- What messages are translated into: the interface's
				     language unless another is picked, out of every language
				     the engines translate (translate/reader.ts
				     readingLanguage). The container stores it by its name. -->
				<label class="opt translate-target translate-into">
					<span>{{ t("translate.settings.into") }}</span>
					<select name="translateInto" :value="into" class="input">
						<option value="">
							{{ t("translate.settings.intoSame", {language: name(interfaceCode)}) }}
						</option>
						<option v-for="code in languages" :key="code" :value="code">
							{{ name(code) }}
						</option>
					</select>
				</label>
				<div v-if="readingLimited" class="translate-hint translate-limited">
					{{ t("translate.limitedLanguage") }}
				</div>
				<!-- Languages left as written (detect.ts `detectionSkip`):
				     chips, and one "Add a language…" select that is a verb,
				     not a value. Its change is handled here, not by the
				     settings container, since the setting is a list. -->
				<div class="opt translate-also">
					<span id="translate-also-label">{{ t("translate.settings.alsoRead") }}</span>
					<div v-if="alsoRead.length" class="translation-panel-chips">
						<span
							v-for="code in alsoRead"
							:key="code"
							class="translation-panel-chip translate-also-chip"
						>
							{{ name(code) }}
							<button
								type="button"
								class="translation-panel-chip-remove"
								:aria-label="
									t('translate.settings.alsoReadRemove', {language: name(code)})
								"
								:title="
									t('translate.settings.alsoReadRemove', {language: name(code)})
								"
								@click="removeAlsoRead(code)"
							>
								✕
							</button>
						</span>
					</div>
					<select
						class="input translate-also-add"
						aria-labelledby="translate-also-label"
						value=""
						@change.stop="addAlsoRead"
					>
						<option value="">{{ t("translate.settings.alsoReadAdd") }}</option>
						<option v-for="code in alsoReadAddable" :key="code" :value="code">
							{{ name(code) }}
						</option>
					</select>
				</div>
				<div class="translate-hint">{{ t("translate.settings.alsoReadHint") }}</div>
				<TranslationOptions />
			</template>
		</template>
	</div>
</template>

<style>
.translate-hint {
	margin-bottom: 0.75rem;
	color: var(--body-color-muted);
}

.translate-target select {
	margin-inline-start: 0.5rem;
	max-width: calc(100% - 0.5rem);
}
</style>

<script lang="ts">
import {computed, defineComponent} from "vue";
import {useI18n, userLanguageRef} from "../../js/i18n";
import {collator} from "../../js/i18n/collation";
import {SUPPORTED_LANGUAGES, fromLocaleTag, languageName} from "../../js/translate/languages";
import {useStore} from "../../js/store";
import {translateService, translationOn} from "../../js/translate";
import {llmChoice, normalizeDeviceChoice} from "../../js/translate/models";
import {isLimitedLanguage} from "../../js/translate/routes.default";
import {alsoReadLanguages, readingLanguage} from "../../js/translate/reader";
import LanguageSelect from "../LanguageSelect.vue";
import TranslationOptions from "./TranslationOptions.vue";

export default defineComponent({
	name: "TranslationSettings",
	components: {LanguageSelect, TranslationOptions},
	setup() {
		const {t} = useI18n();
		const store = useStore();
		// Translation on (the deploy and the user's switch, translate/
		// switch.ts): the heading, the picker's label and the model manager
		// follow it at once, both ways, without a reload.
		const on = computed(() => translationOn());
		const deployAllows = computed(() => store.state.branding.translation?.enabled !== false);
		// The reading language is one the models translate poorly: said
		// under the picker, while translation is on (asked only then, since
		// the service it reads the model from is made by asking).
		const readingLimited = computed(() => {
			if (!on.value) {
				return false;
			}

			const reading = readingLanguage();
			const model = llmChoice(
				translateService().catalog,
				store.state.settings.translateLlmModel,
				store.state.translation.capability,
				normalizeDeviceChoice(store.state.settings.translateLlmDevice)
			);

			return !!reading && isLimitedLanguage(reading, model.id);
		});

		// Names in the interface's own language: a "Translate into" set to
		// Japanese must not turn this list into Japanese.
		const interfaceCode = computed(() => fromLocaleTag(userLanguageRef.value));
		const name = (code: string) => languageName(code, interfaceCode.value);
		const languages = computed(() =>
			[...SUPPORTED_LANGUAGES].sort((a, b) => collator().compare(name(a), name(b)))
		);
		const into = computed(() => {
			const value = store.state.settings.translateInto;

			return typeof value === "string" && SUPPORTED_LANGUAGES.includes(value) ? value : "";
		});
		const alsoRead = computed(() => alsoReadLanguages());
		// Not the reading language itself, nor one already listed.
		const alsoReadAddable = computed(() =>
			languages.value.filter(
				(code) => code !== readingLanguage() && !alsoRead.value.includes(code)
			)
		);
		const saveAlsoRead = (next: string[]) =>
			void store.dispatch("settings/update", {
				name: "translateAlsoRead",
				value: next,
				sync: true,
			});
		const addAlsoRead = (event: Event) => {
			const select = event.target as HTMLSelectElement;
			const code = select.value;

			select.value = "";

			if (code && !alsoRead.value.includes(code)) {
				saveAlsoRead([...alsoRead.value, code]);
			}
		};
		const removeAlsoRead = (code: string) =>
			saveAlsoRead(alsoRead.value.filter((c) => c !== code));

		return {
			t,
			store,
			on,
			deployAllows,
			readingLimited,
			interfaceCode,
			name,
			languages,
			into,
			alsoRead,
			alsoReadAddable,
			addAlsoRead,
			removeAlsoRead,
		};
	},
});
</script>
