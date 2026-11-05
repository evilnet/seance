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
			<span>{{
				on
					? t("translate.settings.languageLabel")
					: t("translate.settings.interfaceLanguageLabel")
			}}</span>
			<!-- The one language control the whole app uses (the sidebar
			     globe renders the same component): one list of codes, one
			     "Automatic" label. `name` is not a prop, so it falls
			     through onto the <select> and the settings container's
			     change handler stores it like any other field. -->
			<LanguageSelect name="locale" :model-value="store.state.settings.locale" />
		</label>
		<template v-if="on">
			<div class="translate-hint">{{ t("translate.settings.languageHint") }}</div>
			<div v-if="readingLimited" class="translate-hint translate-limited">
				{{ t("translate.limitedLanguage") }}
			</div>
		</template>
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
			<TranslationOptions v-if="on" />
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
import {useI18n} from "../../js/i18n";
import {useStore} from "../../js/store";
import {translateService, translationOn} from "../../js/translate";
import {llmChoice, normalizeDeviceChoice} from "../../js/translate/models";
import {isLimitedLanguage} from "../../js/translate/routes.default";
import {readingLanguage} from "../../js/translate/reader";
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

		return {t, store, on, deployAllows, readingLimited};
	},
});
</script>
