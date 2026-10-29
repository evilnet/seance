<template>
	<div>
		<h2>{{ t("translate.settings.heading") }}</h2>
		<div v-if="enabled" class="translate-hint">{{ t("translate.settings.intro") }}</div>
		<!-- Outside the enabled branch: this is the production build's only
		     interface-language picker, and a deploy that turns translation
		     off still has readers who want German. There it is the interface
		     language alone, and says so. -->
		<label class="opt translate-target">
			<span>{{
				enabled
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
		<div v-if="!enabled" class="translate-hint">
			{{ t("translate.settings.disabled") }}
		</div>
		<template v-else>
			<div class="translate-hint">{{ t("translate.settings.languageHint") }}</div>
			<div
				v-if="effectiveReading && limited(effectiveReading)"
				class="translate-hint translate-limited"
			>
				{{ t("translate.limitedLanguage") }}
			</div>
			<div
				id="label-translate-formality"
				class="translate-hint"
				role="heading"
				aria-level="3"
			>
				{{ t("translate.formality.label") }}
			</div>
			<div role="group" aria-labelledby="label-translate-formality">
				<label class="opt">
					<input
						:checked="store.state.settings.translateFormality === 'auto'"
						type="radio"
						name="translateFormality"
						value="auto"
					/>
					{{ t("translate.formality.auto") }}
				</label>
				<label class="opt">
					<input
						:checked="store.state.settings.translateFormality === 'formal'"
						type="radio"
						name="translateFormality"
						value="formal"
					/>
					{{ t("translate.formality.formal") }}
				</label>
				<label class="opt">
					<input
						:checked="store.state.settings.translateFormality === 'casual'"
						type="radio"
						name="translateFormality"
						value="casual"
					/>
					{{ t("translate.formality.casual") }}
				</label>
			</div>
			<h3>{{ t("translate.settings.models") }}</h3>
			<div v-if="problem" class="translate-hint translate-error">
				{{ t("translate.settings.workerError", {error: problem}) }}
			</div>
			<div v-if="capability" class="translate-hint translate-device">
				<!-- What the device has: a GPU the models can be given (an
				     adapter, whatever it can bind) and a CPU that runs them
				     (WebAssembly SIMD), or neither. -->
				<span class="translate-device-has">{{
					deviceHas === "both"
						? t("translate.capability.gpu")
						: deviceHas === "cpu"
						? t("translate.capability.cpu")
						: t("translate.capability.none")
				}}</span>
				<!-- What the GPU binds in one buffer: whether a model's GPU
				     copy can load is that number against its largest tensor. -->
				<span v-if="capability.maxBufferBytes > 0" class="translate-device-limit">{{
					t("translate.capability.bufferLimit", {size: size(capability.maxBufferBytes)})
				}}</span>
				<!-- The test switch (translate/gpuTestLimit.ts) is on: the
				     limit above is the switch's, not the GPU's. -->
				<span v-if="capability.bufferCapBytes" class="translate-device-test-limit">{{
					t("translate.capability.testLimit", {
						size: size(capability.bufferCapBytes),
						key: testLimitKey,
					})
				}}</span>
				<!-- How many threads the CPU models take, or that a reload
				     brings them (translate/threads.ts). -->
				<span v-if="threads" class="translate-device-threads">{{ threads }}</span>
				<!-- Each reason is a phrase of its own: a translator is never
				     handed a list glued together with a comma. -->
				<ul v-if="capability.reasons.length" class="translate-device-reasons">
					<li v-for="reason in capability.reasons" :key="reason">
						{{ reasonText(reason) }}
					</li>
				</ul>
			</div>
			<!-- One block per model family: its switch, Run on (Auto, GPU,
			     CPU), what Auto picks here, then a line per copy. -->
			<section
				v-for="family in families"
				:key="family.id"
				class="translate-family"
				:data-family="family.id"
			>
				<label class="opt translate-family-switch">
					<input
						v-switch
						:checked="!!store.state.settings[family.switchName]"
						type="checkbox"
						:name="family.switchName"
						:aria-describedby="
							family.id === 'nllb' ? 'translate-nllb-licence' : undefined
						"
					/>
					{{ family.label }}
				</label>
				<!-- NLLB-200 is opt-in: its licence is non-commercial, so it is
				     off until the user switches it on; OPUS-MT and the
				     language model serve without it. The licence line
				     describes the switch, so a screen reader hears why it is
				     off. -->
				<div
					v-if="family.id === 'nllb'"
					id="translate-nllb-licence"
					class="translate-hint translate-nllb-licence"
				>
					{{ t("translate.settings.nllbLicence") }}
				</div>
				<div v-if="family.id === 'opus'" class="translate-hint translate-opus-pairs">
					{{ tCount("translate.settings.opusPairs", opusModels.length) }}
				</div>
				<template v-if="family.id === 'llm'">
					<label class="opt translate-llm-model">
						<span>{{ t("translate.settings.gpuModel") }}</span>
						<!-- The raw setting, not the resolved choice: "" is
						     Automatic, and binding the resolved id would show
						     the deploy's default as an explicit pick that
						     Automatic could never win back. The "in use" tag
						     below names what "" resolves to. -->
						<select
							name="translateLlmModel"
							:value="store.state.settings.translateLlmModel"
							:aria-describedby="unfitLlms.length ? 'translate-llm-unfit' : undefined"
						>
							<option value="">{{ t("translate.settings.gpuAutomatic") }}</option>
							<!-- A model this GPU cannot bind is greyed: chosen,
							     it would not run, and the default would run in
							     its place. -->
							<option
								v-for="choice in llmChoices"
								:key="choice.id"
								:value="choice.id"
								:disabled="!!llmUnfit(choice)"
							>
								{{
									t("translate.settings.modelOption", {
										name: llmName(choice),
										size: size(listedSize(choice)),
									})
								}}
							</option>
						</select>
					</label>
					<div class="translate-hint translate-llm-hint">
						{{ t("translate.settings.gpuModelHint") }}
					</div>
					<div v-if="unfitLlms.length" id="translate-llm-unfit" class="translate-hint">
						<p v-for="choice in unfitLlms" :key="choice.id" class="translate-llm-unfit">
							{{ t("translate.settings.gpuModelUnfit", {model: llmName(choice)}) }}
							{{ whyText(llmUnfit(choice)!, llmName(choice)) }}
						</p>
					</div>
				</template>
				<!-- Run on: the settings container stores a radio by its name
				     and value, as it does the formality radios. A device that
				     cannot run the family is a disabled choice with its reason
				     beside it as text, and as its description. -->
				<div
					class="translate-run-on"
					role="radiogroup"
					:aria-labelledby="'translate-run-on-' + family.id"
				>
					<span :id="'translate-run-on-' + family.id" class="translate-run-on-label">{{
						t("translate.settings.runOn")
					}}</span>
					<span class="translate-run-on-choices">
						<span
							v-for="choice in deviceChoices"
							:key="choice"
							class="translate-run-on-choice"
						>
							<label
								class="translate-run-on-option"
								:class="{unavailable: !!radioWhy(family, choice)}"
							>
								<input
									type="radio"
									:name="family.deviceName"
									:value="choice"
									:checked="family.devices.choice === choice"
									:disabled="!!radioWhy(family, choice)"
									:aria-describedby="
										radioWhy(family, choice)
											? reasonId(family, choice)
											: undefined
									"
								/>
								{{ choiceLabel(choice) }}
							</label>
						</span>
					</span>
				</div>
				<ul v-if="radioReasons(family).length" class="translate-run-on-reasons">
					<li
						v-for="reason in radioReasons(family)"
						:id="listedReasonId(family.id, reason.device)"
						:key="reason.device"
						class="translate-run-on-why"
					>
						{{ reason.text }}
					</li>
				</ul>
				<div
					v-if="autoLine(family)"
					:id="autoId(family.id)"
					class="translate-hint translate-auto"
					:class="{blocked: !runsOn(family)}"
				>
					{{ autoLine(family) }}
				</div>
				<!-- OPUS-MT: how many pairs each device holds, then a row per pair. -->
				<div v-if="family.id === 'opus'" class="translate-copies translate-opus-summary">
					<div
						v-for="device in copyOrder(family)"
						:key="device"
						class="translate-copy-line translate-opus-device"
						:data-device="device"
					>
						<span
							:id="'translate-opus-device-' + device"
							class="translate-copy-device"
							>{{ deviceLabel(device) }}</span
						>
						<span
							:id="'translate-opus-summary-' + device"
							class="translate-copy-state"
							>{{ opusSummary(device) }}</span
						>
						<button
							v-if="opusCached(device).length"
							:id="'translate-opus-remove-' + device"
							type="button"
							class="btn btn-small translate-copy-remove"
							:aria-labelledby="
								'translate-opus-remove-' +
								device +
								' translate-opus-summary-' +
								device +
								' translate-opus-device-' +
								device
							"
							@click.prevent="removeOpus(device)"
						>
							{{ t("translate.model.delete") }}
						</button>
					</div>
				</div>
				<ul class="translate-models">
					<li
						v-for="model in modelsOf(family)"
						:key="model.ref.id"
						class="translate-model"
						:data-model="model.ref.id"
					>
						<span class="translate-model-name"
							><span :id="nameId(model.ref)">{{ modelLabel(model.ref) }}</span>
							<span
								v-if="
									family.id === 'llm' &&
									model.ref.id === selectedLlm.id &&
									llmRuns
								"
								class="translate-model-in-use"
								>{{ t("translate.settings.inUse") }}</span
							></span
						>
						<div class="translate-copies">
							<div
								v-for="copy in model.copies"
								:key="copy.device"
								class="translate-copy"
								:data-device="copy.device"
								:data-status="copy.view.status"
								:data-cached="String(copy.view.cached)"
							>
								<div class="translate-copy-line">
									<span
										:id="copyId('device', copy.view)"
										class="translate-copy-device"
										>{{ deviceLabel(copy.device) }}</span
									>
									<span class="translate-copy-state">{{
										copyState(copy.view)
									}}</span>
									<!-- Named "Download <model> <device>": thirty
									     buttons that all read "Download" say nothing
									     to a screen reader moving between them. -->
									<button
										v-if="
											!copy.view.cached && copy.view.status !== 'downloading'
										"
										:id="copyId('action', copy.view)"
										type="button"
										class="btn btn-small translate-copy-download"
										:aria-labelledby="copyNames(copy.view)"
										:disabled="!copyAllowed(copy.view)"
										:aria-describedby="copyWhyId(family, copy.view)"
										@click.prevent="download(copy.view)"
									>
										{{ t("translate.model.download") }}
									</button>
									<button
										v-else-if="copy.view.cached"
										:id="copyId('action', copy.view)"
										type="button"
										class="btn btn-small translate-copy-remove"
										:aria-labelledby="copyNames(copy.view)"
										@click.prevent="remove(copy.view)"
									>
										{{ t("translate.model.delete") }}
									</button>
								</div>
								<!-- Why this copy cannot run here, said once: when
								     Run on already says it for this device, the
								     button is described by that. -->
								<span
									v-if="copyOwnWhy(family, copy.view)"
									:id="copyId('why', copy.view)"
									class="translate-copy-why"
									>{{ copyOwnWhy(family, copy.view) }}</span
								>
								<!-- This GPU binds too little for the model itself:
								     what Download fetches and what runs is its
								     small-buffer build (models.ts
								     smallBufferBuildFor), with its own need. -->
								<span
									v-if="copy.device === 'gpu' && smallBuild(model.ref)"
									class="translate-model-small-build"
									:data-build="smallBuild(model.ref)!.id"
									>{{
										t("translate.model.smallBufferBuild", {
											size: size(smallBuild(model.ref)!.largestBufferBytes),
										})
									}}</span
								>
								<span
									v-if="copy.view.status === 'downloading'"
									class="translate-copy-track"
									role="progressbar"
									aria-valuemin="0"
									aria-valuemax="100"
									:aria-valuenow="Math.round(copy.view.fraction * 100)"
									:aria-valuetext="copyState(copy.view)"
									:aria-labelledby="copyNames(copy.view, false)"
								>
									<span
										class="translate-copy-fill"
										:style="{width: Math.round(copy.view.fraction * 100) + '%'}"
									/>
								</span>
							</div>
						</div>
					</li>
				</ul>
			</section>
			<!-- A download's end, said once: the rows' own percentages are not
			     live, they would chatter for minutes. -->
			<div class="sr-only" role="status" aria-live="polite">{{ announcement }}</div>
		</template>
	</div>
</template>

<style>
.translate-hint {
	margin-bottom: 0.75rem;
	color: var(--body-color-muted);
}

.translate-target select,
.translate-llm-model select {
	margin-inline-start: 0.5rem;
	max-width: calc(100% - 0.5rem);
}

.translate-device-has,
.translate-device-limit,
.translate-device-test-limit,
.translate-device-threads {
	display: block;
}

/* The device-tier reasons: each a phrase of its own, not a comma list. */
.translate-device-reasons {
	margin: 0.25rem 0 0;
	padding-inline-start: 1.25rem;
}

.translate-error {
	color: var(--error-fg, #c33);
}

/* One model family: its switch, Run on, Auto's pick and its copies. */
.translate-family {
	padding-block: 0.75rem 0.25rem;
	border-top: 1px solid var(--window-border, rgb(128 128 128 / 20%));
}

.translate-family .translate-hint {
	margin-bottom: 0.5rem;
}

.translate-llm-unfit {
	margin: 0;
}

/* Run on: the label, then the three choices as one segmented control. */
.translate-run-on {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0.5rem;
	margin-block: 0.25rem 0.5rem;
}

.translate-run-on-label {
	min-width: 4.5em;
	color: var(--body-color-muted);
}

.translate-run-on-choices {
	display: inline-flex;
	border: 1px solid var(--window-border, rgb(128 128 128 / 35%));
	border-radius: 0.5rem;
	overflow: hidden;
}

.translate-run-on-choice + .translate-run-on-choice {
	border-inline-start: 1px solid var(--window-border, rgb(128 128 128 / 35%));
}

.translate-run-on-option {
	display: inline-flex;
	align-items: center;
	gap: 0.375rem;
	padding: 0.25rem 0.75rem;
	cursor: pointer;
}

.translate-run-on-option:has(input:checked) {
	background: var(--tint-strong, rgb(128 128 128 / 15%));
	font-weight: 600;
}

.translate-run-on-option:has(input:focus-visible) {
	outline: 2px solid var(--button-color);
	outline-offset: -2px;
}

/* A device that cannot run the family: struck through, its reason below. */
.translate-run-on-option.unavailable {
	color: var(--body-color-muted);
	text-decoration: line-through;
	text-decoration-thickness: 1px;
	cursor: default;
}

.translate-run-on-reasons {
	list-style: none;
	margin: 0 0 0.5rem;
	padding: 0;
}

.translate-run-on-why,
.translate-copy-why {
	color: var(--error-fg, #c33);
}

.translate-copy-why {
	display: block;
}

/* Auto has nothing to run on: its line is the reason, in a reason's colour. */
.translate-family .translate-auto.blocked {
	color: var(--error-fg, #c33);
}

.translate-model-in-use {
	margin-inline-start: 0.5rem;
	padding: 0 0.375rem;
	border-radius: 0.25rem;
	font-size: 0.85em;
	color: var(--chat-accent, var(--link-color));
	border: 1px solid currentcolor;
	white-space: nowrap;
}

.translate-models {
	list-style: none;
	padding: 0;
	margin: 0.25rem 0 0;
}

.translate-model {
	padding-block: 0.5rem;
}

.translate-model + .translate-model {
	border-top: 1px solid var(--window-border, rgb(128 128 128 / 12%));
}

.translate-copies {
	display: grid;
	gap: 0.25rem;
	margin-top: 0.25rem;
}

.translate-opus-summary {
	margin-bottom: 0.25rem;
}

/*
 * One copy: the device, its state with its size, then its button at the
 * line's end. Where the three do not fit (a phone at a large text step),
 * the button moves under the state, still at the end, rather than the
 * state breaking into a column of single words.
 */
.translate-copy-line {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0.25rem 0.75rem;
}

.translate-copy-device {
	flex: none;
	min-width: 2.75em;
	font-weight: 600;
	color: var(--body-color-muted);
}

.translate-copy-state {
	flex: 1 1 11rem;
	min-width: 0;
	text-wrap: pretty;
	color: var(--body-color-muted);
	font-variant-numeric: tabular-nums;
}

.translate-copy[data-cached="true"] .translate-copy-state {
	color: var(--body-color);
}

.translate-copy[data-status="failed"] .translate-copy-state {
	color: var(--error-fg, #c33);
}

/* A small action beside its state, not a form's primary button. */
.translate-copy-line .btn {
	margin: 0;
	margin-inline-start: auto;
	flex: none;
	padding: 0.25em 0.75em;
	font-size: 0.8125rem;
	letter-spacing: 0.02em;
}

/* A copy this device cannot run: the button reads as off, not as the
   filled look .btn:disabled gives a primary action. */
.translate-copy-download:disabled {
	background: none;
	color: var(--body-color-muted);
	border-color: var(--body-color-muted);
	cursor: default;
}

.translate-copy-why,
.translate-model-small-build {
	padding-inline-start: 3.5em;
}

.translate-model-small-build {
	display: block;
	color: var(--body-color-muted);
}

.translate-copy-track {
	display: block;
	margin-top: 0.25rem;
	height: 0.375rem;
	border-radius: 0.25rem;
	background: var(--tint-strong, rgb(128 128 128 / 20%));
	overflow: hidden;
}

.translate-copy-fill {
	display: block;
	height: 100%;
	background: var(--chat-accent, var(--link-color));
	transition: width 0.15s linear;
}
</style>

<script lang="ts">
import {computed, defineComponent, onMounted, ref, toRaw, watch} from "vue";
import {useI18n} from "../../js/i18n";
import friendlysize from "../../js/helpers/friendlysize";
import {modelLabel} from "../../js/helpers/modelLabel";
import {useStore} from "../../js/store";
import {translateService} from "../../js/translate";
import type {Device, DeviceChoice, ModelRef} from "../../js/translate/engine";
import {
	LLM_MIN_BUFFER_BYTES,
	type ModelBlock,
	listedSize,
	llmChoice,
	llmName,
	normalizeDeviceChoice,
	smallBufferBuildFor,
} from "../../js/translate/models";
import {GPU_TEST_LIMIT_KEY} from "../../js/translate/gpuTestLimit";
import {translateErrorText} from "../../js/helpers/translateErrors";
import {translateWhyText} from "../../js/helpers/translateWhy";
import {isLimitedLanguage} from "../../js/translate/routes.default";
import {
	type ModelDevices,
	cpuThreadsLine,
	modelDevices,
	readingLanguage,
} from "../../js/translate/reader";
import type {CapabilityReason} from "../../js/translate/capability";
import type {ModelView} from "../../js/translate/service";
import LanguageSelect from "../LanguageSelect.vue";

type FamilyId = "llm" | "opus" | "nllb";

/** One model family's block: what Settings shows for it, worked out once per render. */
interface Family {
	id: FamilyId;
	/** Its on/off switch (the setting keeps its old name: OPUS-MT's is `translateCpu`). */
	switchName: "translateLlm" | "translateCpu" | "translateNllb";
	deviceName: "translateLlmDevice" | "translateOpusDevice" | "translateNllbDevice";
	label: string;
	/** The model its Run on is judged on: the language model in use, NLLB-200, an OPUS-MT pair. */
	ref: ModelRef;
	devices: ModelDevices;
}

/** The device codes no switch or download can change: a device the family cannot use. */
const DEVICE_LEVEL = new Set<ModelBlock["kind"]>(["device", "buffer", "memory", "noCopy"]);

/** The adapter codes that mean there is no GPU to give a model at all. */
const NO_GPU: readonly CapabilityReason[] = [
	"PROBE_FAILED",
	"INSECURE_ORIGIN",
	"NO_WEBGPU",
	"NO_ADAPTER",
];

export default defineComponent({
	name: "TranslationSettings",
	components: {LanguageSelect},
	setup() {
		const {t, tCount} = useI18n();
		const store = useStore();
		const service = translateService();
		const enabled = service.enabled;
		const capability = computed(() => store.state.translation.capability);
		// The reading language as it stands: the interface's (one control —
		// reactivity rides on the store read and the i18n ref the helper reads).
		const effectiveReading = computed(() => readingLanguage());
		const loadError = ref<string | null>(null);
		// Two ways the worker can disappoint this tab: a call it made rejected
		// (loadError), or the worker reported a problem of its own that no call
		// was waiting for (the store's workerError, set by index.ts).
		// A code the translation layer reports (a worker that never started is
		// TRANSLATION_UNAVAILABLE) in the reader's words; an engine's own text
		// as it is.
		const problem = computed(() => {
			const raw = store.state.translation.workerError ?? loadError.value;

			return raw ? translateErrorText(raw) : null;
		});
		const llmChoices = service.catalog.llmChoices;
		// The setting as the service reads it: an id that is no longer a
		// choice — an unset one included — shows (and runs) what the service
		// resolves it to, on the device the language model is set to. The
		// device probe is read here, not captured, so the "in use" tag moves
		// to the adapter's pick when it lands.
		const selectedLlm = computed(() =>
			llmChoice(
				service.catalog,
				store.state.settings.translateLlmModel,
				store.state.translation.capability,
				normalizeDeviceChoice(store.state.settings.translateLlmDevice)
			)
		);
		const limited = (code: string | null) => isLimitedLanguage(code, selectedLlm.value.id);
		const opusModels = Object.values(service.catalog.opus);

		const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

		onMounted(() => {
			if (enabled) {
				service.models().catch((e: unknown) => {
					loadError.value = errorMessage(e);
				});
			}
		});

		// The shared size formatter: the number is written by the active
		// locale, the IEC unit symbol is universal (helpers/friendlysize.ts).
		const size = (bytes: number) => friendlysize(bytes);

		// What this device has to run models on: a GPU (an adapter, whether
		// or not every model fits it) and a CPU (WebAssembly SIMD), a CPU
		// only, or nothing.
		const deviceHas = computed((): "both" | "cpu" | "none" => {
			const cap = capability.value;

			if (!cap || cap.tier === "none") {
				return "none";
			}

			return cap.reasons.some((code) => NO_GPU.includes(code)) ? "cpu" : "both";
		});

		// The CPU threads line, where the CPU runs models at all.
		const threads = computed(() => (deviceHas.value === "none" ? "" : cpuThreadsLine()));

		// Why the GPU tier is out of reach, one whole phrase per code
		// (translate/capability.ts is Vue-free and reports codes). Every code
		// has a case of its own, including NO_WEBGPU, which used to be the
		// unnamed default. The `never` binding is the exhaustiveness check;
		// the default still returns prose, so a code with no phrase reads as
		// "no WebGPU" rather than putting a raw enum token on the screen.
		const reasonText = (reason: CapabilityReason): string => {
			switch (reason) {
				case "NO_WEBGPU":
					return t("translate.capability.reason.noWebgpu");
				case "INSECURE_ORIGIN":
					return t("translate.capability.reason.insecureOrigin");
				case "NO_ADAPTER":
					return t("translate.capability.reason.noAdapter");
				case "NO_F16":
					return t("translate.capability.reason.noF16");
				case "GPU_LIMITS":
					return t("translate.capability.reason.gpuLimits");
				case "SMALL_BUFFER":
					return t("translate.capability.reason.smallBuffer", {
						limit: size(capability.value?.maxBufferBytes ?? 0),
						needed: size(LLM_MIN_BUFFER_BYTES),
					});
				case "NO_WASM_SIMD":
					return t("translate.capability.reason.noWasmSimd");
				case "NO_MEMORY64":
					return t("translate.capability.reason.noMemory64");
				case "PROBE_FAILED":
					return t("translate.capability.reason.probeFailed");

				default: {
					const unhandled: never = reason;

					void unhandled;

					return t("translate.capability.reason.noWebgpu");
				}
			}
		};

		// The three families, in the order the spec gives: the language model,
		// OPUS-MT, NLLB-200. OPUS-MT's Run on is judged on a pair: every pair
		// takes the same rule, with the same numbers (models.ts opusRef).
		const families = computed((): Family[] => {
			const list: Family[] = [
				{
					id: "llm",
					switchName: "translateLlm",
					deviceName: "translateLlmDevice",
					label: t("translate.settings.useGpu", {model: llmName(selectedLlm.value)}),
					ref: selectedLlm.value,
					devices: modelDevices(selectedLlm.value),
				},
			];

			if (opusModels.length) {
				list.push({
					id: "opus",
					switchName: "translateCpu",
					deviceName: "translateOpusDevice",
					label: t("translate.settings.useCpu"),
					ref: opusModels[0],
					devices: modelDevices(opusModels[0]),
				});
			}

			list.push({
				id: "nllb",
				switchName: "translateNllb",
				deviceName: "translateNllbDevice",
				label: t("translate.settings.useNllb"),
				ref: service.catalog.nllb,
				devices: modelDevices(service.catalog.nllb),
			});

			return list;
		});

		const deviceChoices: DeviceChoice[] = ["auto", "gpu", "cpu"];

		const choiceLabel = (choice: DeviceChoice) =>
			choice === "auto"
				? t("translate.settings.deviceAuto")
				: choice === "gpu"
				? t("translate.device.gpu")
				: t("translate.device.cpu");

		const deviceLabel = (device: Device) =>
			device === "gpu" ? t("translate.device.gpu") : t("translate.device.cpu");

		const llmWords = (model: ModelRef) => (model.family === "llm" ? llmName(model) : undefined);

		// Why a device cannot run the family, or "": only what the device
		// itself rules out. A switched-off family keeps every choice open
		// (choosing ahead of switching on is fine), and so does the probe
		// still running.
		const blockWhy = (block: ModelBlock | null, modelRef: ModelRef) =>
			block && DEVICE_LEVEL.has(block.kind)
				? translateWhyText(block, llmWords(modelRef))
				: "";

		const radioWhy = (family: Family, choice: DeviceChoice) =>
			choice === "auto" ? "" : blockWhy(family.devices.blocks[choice], family.ref);

		const autoId = (familyId: FamilyId) => `translate-auto-${familyId}`;
		const listedReasonId = (familyId: FamilyId, device: DeviceChoice) =>
			`translate-run-on-why-${familyId}-${device}`;

		// Where the family runs here: the first device in its order this
		// device can run it on (the switch aside: it would run there).
		const runsOn = (family: Family): Device | undefined => {
			const {order, blocks} = family.devices;

			return order.find((device) => !blocks[device] || blocks[device]!.kind === "off");
		};

		// The small-buffer build this device runs in the model's place, when
		// it does: on a GPU tier that binds too little for the model itself.
		const smallBuild = (modelRef: ModelRef) =>
			capability.value?.tier === "gpu"
				? smallBufferBuildFor(modelRef, capability.value.maxBufferBytes)
				: null;

		// What Auto picks here and why, one whole sentence per case, else
		// why nothing runs, in the first device's words; only while Auto is
		// chosen, and nothing while the probe runs. The GPU's own reason is
		// beside its struck-through choice already, so a CPU picked because
		// the GPU cannot run the model says only that.
		const autoLine = (family: Family) => {
			if (family.devices.choice !== "auto" || !capability.value) {
				return "";
			}

			const pick = runsOn(family);

			if (pick === "gpu") {
				return family.id === "llm" && smallBuild(family.ref)
					? t("translate.settings.autoPicksGpuSmallBuild")
					: t("translate.settings.autoPicksGpu");
			}

			if (pick === "cpu") {
				if (!blockWhy(family.devices.blocks.gpu, family.ref)) {
					// The GPU could run it: the CPU comes first by choice
					// (OPUS-MT on a phone, models.ts deviceOrder).
					return t("translate.settings.autoPicksCpu");
				}

				return family.id === "nllb"
					? t("translate.settings.autoPicksCpuNoGpuNllb")
					: t("translate.settings.autoPicksCpuNoGpuOpus");
			}

			const first = family.devices.blocks[family.devices.order[0]];

			return first ? translateWhyText(first, llmWords(family.ref)) : "";
		};

		// The disabled choices' reasons, each said once: one the Auto line
		// already says (nothing runs, and this device is why) is not listed
		// again under the group, and its choice is described by that line.
		const radioReasons = (family: Family) => {
			const auto = autoLine(family);

			return (["gpu", "cpu"] as const)
				.map((device) => ({device, text: radioWhy(family, device)}))
				.filter((reason) => reason.text && reason.text !== auto);
		};

		// Where a disabled choice's reason is shown: its own line under the
		// group, or the Auto line when that says it.
		const reasonId = (family: Family, device: DeviceChoice) =>
			radioWhy(family, device) === autoLine(family)
				? autoId(family.id)
				: listedReasonId(family.id, device);

		// The language model runs somewhere here (the switch aside): only then
		// is one of the choices "in use".
		const llmRuns = computed(() => !!runsOn(families.value[0]));

		// A family's devices, its order first (the device it runs on leads),
		// then the device it would not try.
		const familyOrder = (family: Family): Device[] => [
			...family.devices.order,
			...(["gpu", "cpu"] as const).filter((device) => !family.devices.order.includes(device)),
		];

		// The devices OPUS-MT has copies for, in that order.
		const copyOrder = (family: Family): Device[] =>
			familyOrder(family).filter((device) => family.ref.copies[device] !== undefined);

		const views = computed(() => store.state.translation.models);

		const viewOf = (modelRef: ModelRef, device: Device) =>
			views.value.find((view) => view.ref.id === modelRef.id && view.device === device);

		// The models a family lists, each with its copies as the service
		// reports them (one view per copy): every language model choice, so a
		// downloaded one that is not in use can still be removed; each OPUS-MT
		// pair; NLLB-200.
		const modelsOf = (family: Family) => {
			const refs =
				family.id === "llm"
					? llmChoices
					: family.id === "opus"
					? opusModels
					: [service.catalog.nllb];
			const devices = familyOrder(family);

			return refs.map((modelRef) => ({
				ref: modelRef,
				copies: devices
					.filter((device) => modelRef.copies[device] !== undefined)
					.map((device) => ({device, view: viewOf(modelRef, device)}))
					.filter((copy): copy is {device: Device; view: ModelView} => !!copy.view),
			}));
		};

		const copySize = (view: ModelView) => size(view.ref.copies[view.device]?.sizeBytes ?? 0);

		const copyState = (view: ModelView) => {
			const percent = Math.round(view.fraction * 100);

			switch (view.status) {
				case "downloading":
					// Already on this device: the copy is loading, not downloading.
					return view.cached
						? t("translate.model.loadingPercent", {percent})
						: t("translate.model.percent", {percent});
				case "failed":
					return view.error
						? t("translate.model.failed", {error: translateErrorText(view.error)})
						: t("translate.model.failedUnknown");
				default:
					return view.cached || view.status === "ready"
						? t("translate.model.copyDownloaded", {size: copySize(view)})
						: t("translate.model.copyNotDownloaded", {size: copySize(view)});
			}
		};

		// Element ids per copy: two copies of one model never share one.
		const slug = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_");
		const nameId = (modelRef: ModelRef) => `translate-model-name-${slug(modelRef.id)}`;
		const copyId = (part: string, view: ModelView) =>
			`translate-copy-${part}-${slug(view.ref.id)}-${view.device}`;
		const copyNames = (view: ModelView, withAction = true) =>
			[withAction ? copyId("action", view) : "", nameId(view.ref), copyId("device", view)]
				.filter(Boolean)
				.join(" ");

		// What keeps this exact copy from running here (models.ts
		// `modelBlock`, the rule the router reads too).
		const copyBlock = (view: ModelView) => modelDevices(view.ref, true).blocks[view.device];

		// A switched-off model can still be downloaded ahead of use; a copy
		// this device cannot run, or before the probe has answered, cannot.
		const copyAllowed = (view: ModelView) => {
			const block = copyBlock(view);

			return !block || block.kind === "off";
		};

		// The copy's reason, unless Run on already gives it for this device
		// in the same words: then the button is described by that one.
		const copyWhy = (view: ModelView) =>
			copyAllowed(view) ? "" : blockWhy(copyBlock(view), view.ref);

		const copyOwnWhy = (family: Family, view: ModelView) => {
			const why = copyWhy(view);

			return why && why !== radioWhy(family, view.device) ? why : "";
		};

		const copyWhyId = (family: Family, view: ModelView) => {
			const why = copyWhy(view);

			if (!why) {
				return undefined;
			}

			return why === radioWhy(family, view.device)
				? reasonId(family, view.device)
				: copyId("why", view);
		};

		// OPUS-MT's pairs per device: what is downloaded, and their size.
		const opusCached = (device: Device) =>
			opusModels
				.map((modelRef) => viewOf(modelRef, device))
				.filter((view): view is ModelView => !!view && view.cached);

		const opusSummary = (device: Device) => {
			const cached = opusCached(device);

			if (!cached.length) {
				return t("translate.settings.opusNone", {
					size: size(opusModels[0]?.copies[device]?.sizeBytes ?? 0),
				});
			}

			const bytes = cached.reduce(
				(sum, view) => sum + (view.ref.copies[device]?.sizeBytes ?? 0),
				0
			);

			return tCount("translate.settings.opusDownloaded", cached.length, {size: size(bytes)});
		};

		// Why a language model cannot be chosen here: the GPU binds too
		// little for it, a phone cannot hold it, or cannot run a language
		// model on the GPU at all, on a device the probe placed on the gpu
		// tier -- where choosing it would quietly run the default instead
		// (models.ts `llmChoice`). Not while probing, not for the switch
		// (choosing ahead of switching on is fine), and not on a device
		// without a GPU tier, where the choice only keys the route table.
		const llmUnfit = (choice: ModelRef) => {
			if (capability.value?.tier !== "gpu") {
				return null;
			}

			const block = modelDevices(choice, true).blocks.gpu;

			return block &&
				(block.kind === "buffer" || block.kind === "memory" || block.kind === "device")
				? block
				: null;
		};

		const unfitLlms = computed(() => llmChoices.filter((choice) => !!llmUnfit(choice)));

		// The ref comes off a reactive row (store.state.translation.models);
		// the worker protocol structured-clones every message, which rejects a
		// Vue reactive Proxy, so send the raw object underneath it. Pressing
		// Download is the yes: nothing more is asked.
		const download = (view: ModelView) => {
			service.download(toRaw(view.ref), view.device).catch(() => {
				// the view carries the error; nothing else to do
			});
		};

		const remove = (view: ModelView) => {
			service.remove(toRaw(view.ref), view.device).catch((e: unknown) => {
				loadError.value = errorMessage(e);
			});
		};

		const removeOpus = (device: Device) => {
			for (const view of opusCached(device)) {
				remove(view);
			}
		};

		// What the polite region says: a download (or a load of one already
		// here) that has just finished or failed, by model and device.
		const announcement = ref("");
		const lastStatus = new Map<string, ModelView["status"]>();

		watch(
			views,
			(list) => {
				for (const view of list) {
					const key = `${view.ref.id}@${view.device}`;
					const before = lastStatus.get(key);

					lastStatus.set(key, view.status);

					if (before === "downloading" && view.status !== "downloading") {
						announcement.value = t("translate.model.announce", {
							model: modelLabel(view.ref),
							device: deviceLabel(view.device),
							state: copyState(view),
						});
					}
				}
			},
			{deep: true, immediate: true}
		);

		return {
			t,
			tCount,
			modelLabel,
			reasonText,
			llmUnfit,
			unfitLlms,
			whyText: translateWhyText,
			smallBuild,
			testLimitKey: GPU_TEST_LIMIT_KEY,
			store,
			enabled,
			capability,
			deviceHas,
			threads,
			limited,
			effectiveReading,
			llmChoices,
			selectedLlm,
			llmName,
			llmRuns,
			loadError,
			problem,
			size,
			listedSize,
			families,
			deviceChoices,
			choiceLabel,
			deviceLabel,
			radioWhy,
			radioReasons,
			reasonId,
			listedReasonId,
			autoId,
			autoLine,
			runsOn,
			copyOrder,
			modelsOf,
			opusModels,
			opusCached,
			opusSummary,
			removeOpus,
			copyState,
			nameId,
			copyId,
			copyNames,
			copyAllowed,
			copyOwnWhy,
			copyWhyId,
			download,
			remove,
			announcement,
		};
	},
});
</script>
