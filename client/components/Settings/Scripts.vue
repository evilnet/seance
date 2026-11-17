<template>
	<div class="settings-scripts" role="group" :aria-label="t('settings.scripts.heading')">
		<h2>{{ t("settings.scripts.heading") }}</h2>

		<!-- Aliases are no script, and work with Lua off: their row sits
		     above the switch, which reads as governing only what is under it. -->
		<router-link class="scripts-aliases" to="/settings/scripts/aliases">
			<span class="scripts-aliases-icon" aria-hidden="true" />
			<span class="scripts-aliases-text">
				<span class="scripts-aliases-name">{{ t("settings.scripts.aliases") }}</span>
				<span class="scripts-aliases-list" dir="auto">{{ aliasSummary }}</span>
			</span>
			<span class="scripts-aliases-chevron" aria-hidden="true" />
		</router-link>

		<p class="scripts-intro">{{ t("settings.scripts.intro") }}</p>
		<label class="opt">
			<input
				v-switch
				:checked="store.state.settings.enableScripting"
				type="checkbox"
				name="enableScripting"
			/>
			{{ t("settings.scripts.enable") }}
		</label>
		<p v-if="!store.state.settings.enableScripting" class="scripts-intro">
			<I18nFrame :text="t('settings.scripts.offNote', {command: KEEP})"
				><template v-slot:command><code>/lua</code></template></I18nFrame
			>
		</p>

		<!-- With Lua off the library stays in sight, greyed out and inert: no
		     script runs, opens or is added until the switch is on. -->
		<div
			class="scripts-library"
			:class="{'scripts-library-off': !store.state.settings.enableScripting}"
			:inert="!store.state.settings.enableScripting"
		>
			<div class="scripts-actions">
				<button class="btn btn-small" type="button" @click="addNew">
					{{ t("settings.scripts.new") }}
				</button>
				<button class="btn btn-small" type="button" @click="pickImport">
					{{ t("settings.scripts.import") }}
				</button>
				<input
					ref="importInput"
					type="file"
					class="sr-only"
					accept=".lua,text/plain"
					:aria-label="t('settings.scripts.importAria')"
					@change="onImportChosen"
				/>
			</div>
			<p class="scripts-examples">
				{{ t("settings.scripts.examples") }}
				<button class="btn btn-sm" type="button" @click="addTemplate('responder')">
					{{ t("settings.scripts.exampleResponder") }}
				</button>
				<button class="btn btn-sm" type="button" @click="addTemplate('slap')">
					{{ t("settings.scripts.exampleSlap") }}
				</button>
			</p>
			<p v-if="importError" class="scripts-error" role="alert">{{ importError }}</p>

			<input
				v-if="scripts.length > SEARCH_FROM"
				v-model="query"
				class="input scripts-search"
				dir="auto"
				type="search"
				:placeholder="t('settings.scripts.searchPlaceholder')"
				:aria-label="t('settings.scripts.searchAria')"
				spellcheck="false"
			/>

			<p v-if="scripts.length === 0" class="scripts-empty">
				{{ t("settings.scripts.empty") }}
			</p>
			<p v-else-if="visible.length === 0" class="scripts-empty">
				{{ t("settings.scripts.noMatch") }}
			</p>
			<ul v-else class="scripts-list">
				<li
					v-for="script in visible"
					:key="script.id"
					class="scripts-item"
					:class="{'has-error': !!script.lastError}"
				>
					<router-link class="scripts-summary" :to="`/settings/scripts/${script.id}`">
						<span class="scripts-name">{{ script.name }}</span>
						<span v-if="script.description" class="scripts-desc">{{
							script.description
						}}</span>
						<span v-if="stateLabel(script)" class="scripts-state">{{
							stateLabel(script)
						}}</span>
					</router-link>
					<input
						v-switch
						:checked="script.enabled"
						type="checkbox"
						:aria-label="t('settings.scripts.runAria', {name: script.name})"
						:title="stateLabel(script)"
						@change="toggle(script, $event)"
					/>
				</li>
			</ul>
		</div>

		<!-- The editor (ScriptEdit.vue) or the aliases (AliasesOverlay.vue),
		     an overlay above the settings. Keyed by the script, so Duplicate's
		     jump to the copy mounts a fresh one. -->
		<router-view v-slot:default="{Component, route: shown}">
			<component :is="Component" :key="shown.params.id" />
		</router-view>
	</div>
</template>

<style>
/* The aliases' row: one link, set apart from the scripts below it, that
 * opens the aliases over the list (AliasesOverlay.vue). */
.settings-scripts .scripts-aliases {
	display: grid;
	grid-template-columns: auto 1fr auto;
	align-items: center;
	gap: 0.75rem;
	margin: 0.25rem 0 1rem;
	padding: 0.6rem 0.75rem;
	border-radius: 4px;
	background: rgb(128 128 128 / 10%);
	color: inherit;
	text-decoration: none;
}

.settings-scripts .scripts-aliases-icon,
.settings-scripts .scripts-aliases-chevron {
	color: var(--body-color-muted);
}

.settings-scripts .scripts-aliases-icon::before {
	font: normal normal normal 1em/1 FontAwesome;
	content: "\f120"; /* https://fontawesome.com/icons/terminal */
}

.settings-scripts .scripts-aliases-chevron::before {
	font: normal normal normal 0.875em/1 FontAwesome;
	content: "\f054"; /* https://fontawesome.com/icons/chevron-right */
}

[dir="rtl"] .settings-scripts .scripts-aliases-chevron::before {
	content: "\f053"; /* chevron-left: onward points the other way */
}

.settings-scripts .scripts-aliases-text {
	display: grid;
	min-width: 0;
}

.settings-scripts .scripts-aliases-name {
	font-weight: bold;
}

.settings-scripts .scripts-aliases:hover .scripts-aliases-name,
.settings-scripts .scripts-aliases:focus-visible .scripts-aliases-name {
	color: var(--link-color);
	text-decoration: underline;
}

.settings-scripts .scripts-aliases-list {
	color: var(--body-color-muted);
	font-family: Consolas, Menlo, Monaco, "Lucida Console", "DejaVu Sans Mono", "Courier New",
		monospace;
	font-size: 0.875em;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

/* Lua off: the library is still shown, greyed out (and inert). */
.settings-scripts .scripts-library-off {
	opacity: 0.45;
}

html[data-contrast="more"] .settings-scripts .scripts-library-off {
	opacity: 0.8;
}

.settings-scripts .scripts-intro,
.settings-scripts .scripts-examples,
.settings-scripts .scripts-empty {
	color: var(--body-color-muted);
}

.settings-scripts .scripts-actions,
.settings-scripts .scripts-examples {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0.5rem;
}

.settings-scripts .scripts-actions {
	margin: 0.75rem 0 0.5rem;
}

.settings-scripts .scripts-actions .btn,
.settings-scripts .scripts-examples .btn {
	margin: 0;
}

.settings-scripts .scripts-error {
	color: #e74c3c;
}

.settings-scripts .scripts-search {
	margin-top: 0.5rem;
}

.settings-scripts .scripts-list {
	list-style: none;
	margin: 0.75rem 0 0;
	padding: 0;
}

.settings-scripts .scripts-item {
	display: flex;
	align-items: center;
	gap: 0.75rem;
	border-bottom: 1px solid rgb(128 128 128 / 25%);
}

.settings-scripts .scripts-summary {
	display: grid;
	flex: 1 1 auto;
	min-width: 0;
	padding: 0.6rem 0;
	color: inherit;
	text-decoration: none;
}

.settings-scripts .scripts-summary:hover .scripts-name,
.settings-scripts .scripts-summary:focus-visible .scripts-name {
	color: var(--link-color);
	text-decoration: underline;
}

.settings-scripts .scripts-name {
	font-family: Consolas, Menlo, Monaco, "Lucida Console", "DejaVu Sans Mono", "Courier New",
		monospace;
	font-weight: bold;
	overflow-wrap: anywhere;
}

.settings-scripts .scripts-desc,
.settings-scripts .scripts-state {
	color: var(--body-color-muted);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.settings-scripts .scripts-state {
	font-size: 0.875em;
}

.settings-scripts .has-error .scripts-state {
	color: #e74c3c;
}
</style>

<script lang="ts">
import {computed, defineComponent, ref, watch} from "vue";
import {useRoute} from "vue-router";
import {useStore} from "../../js/store";
import {navigate} from "../../js/router";
import {useI18n} from "../../js/i18n";
import {KEEP} from "../../js/i18n/core";
import {formatNumber} from "../../js/i18n/numbers";
import I18nFrame from "../I18nFrame.vue";
import {
	compareScripts,
	loadScripts,
	saveScript,
	MAX_CODE_LENGTH,
	ScriptStorageError,
} from "../../js/irc/scripting/storage";
import type {Script} from "../../js/irc/scripting/types";
import {aliasNames} from "../../js/helpers/aliases";
import {scriptManager} from "../../js/irc/scripting/manager";
import {
	importedScriptName,
	newScriptId,
	scriptTemplate,
	uniqueScriptName,
} from "../../js/irc/scripting/library";

/** Past this many scripts the list grows a search field. */
const SEARCH_FROM = 6;

export default defineComponent({
	name: "ScriptSettings",
	components: {
		I18nFrame,
	},
	setup() {
		const store = useStore();
		const {t} = useI18n();
		const route = useRoute();
		const scripts = ref<Script[]>(loadScripts().sort(compareScripts));
		const aliases = ref<string[]>(aliasNames());

		// The editor and the aliases save straight to storage: read both
		// again as they close (Done, ✕, Escape, Delete).
		watch(
			() => route.name,
			(name) => {
				if (name === "Scripts") {
					scripts.value = loadScripts().sort(compareScripts);
					aliases.value = aliasNames();
				}
			}
		);

		// The row's second line: the aliases by name, as they are typed.
		const aliasSummary = computed(() =>
			aliases.value.length > 0
				? aliases.value.map((name) => `/${name}`).join(" ")
				: t("settings.aliases.empty")
		);
		const query = ref("");
		const importError = ref("");
		const importInput = ref<HTMLInputElement>();

		const visible = computed(() => {
			const q = query.value.trim().toLowerCase();
			return q
				? scripts.value.filter((script) =>
						[script.name, script.description ?? "", script.code]
							.join("\n")
							.toLowerCase()
							.includes(q)
				  )
				: scripts.value;
		});

		// With Lua off nothing runs: a row keeps its own switch (greyed, as
		// it will be once Lua is on) and says nothing of running, which its
		// switch would contradict; only an error stays.
		const stateLabel = (script: Script): string | undefined =>
			script.lastError
				? t("settings.scripts.stateError")
				: !store.state.settings.enableScripting
				? undefined
				: script.enabled
				? t("settings.scripts.stateRunning")
				: t("settings.scripts.stateOff");

		// A new script opens in the editor: that is where it gets written.
		const create = (script: Script) => {
			// A refusal from an earlier try (too many scripts, say) may no longer hold.
			importError.value = "";

			try {
				saveScript(script);
			} catch (err) {
				if (!(err instanceof ScriptStorageError)) {
					throw err;
				}

				importError.value = err.message;
				return;
			}

			void scriptManager.reload();
			void navigate("ScriptEdit", {id: script.id});
		};

		const addNew = () => {
			const name = uniqueScriptName(scripts.value, "my_script");
			create({
				id: newScriptId(),
				name,
				code: `-- ${name}\n`,
				enabled: true,
				createdAt: Date.now(),
			});
		};

		const addTemplate = (kind: "responder" | "slap") => {
			create(scriptTemplate(kind, scripts.value));
		};

		const toggle = (script: Script, event: Event) => {
			script.enabled = (event.target as HTMLInputElement).checked;

			try {
				saveScript(script);
			} catch (err) {
				if (!(err instanceof ScriptStorageError)) {
					throw err;
				}

				script.enabled = !script.enabled;
				importError.value = err.message;
				return;
			}

			void scriptManager.reload();
		};

		const pickImport = () => importInput.value?.click();

		const onImportChosen = async (event: Event) => {
			const input = event.target as HTMLInputElement;
			const file = input.files?.[0];
			input.value = "";
			importError.value = "";

			if (!file) {
				return;
			}

			// Characters are at most four bytes: refuse before reading a huge file.
			const code = file.size > MAX_CODE_LENGTH * 4 ? undefined : await file.text();

			if (code === undefined || code.length > MAX_CODE_LENGTH) {
				importError.value = t("settings.scripts.importTooLong", {
					file: file.name,
					max: formatNumber(MAX_CODE_LENGTH),
				});
				return;
			}

			// Off until it is switched on, as a restored backup's are: a file
			// may well be someone else's, and a script reads every message.
			create({
				id: newScriptId(),
				name: uniqueScriptName(scripts.value, importedScriptName(file.name)),
				code,
				enabled: false,
				createdAt: Date.now(),
			});
		};

		return {
			store,
			aliasSummary,
			scripts,
			query,
			visible,
			importError,
			importInput,
			SEARCH_FROM,
			stateLabel,
			t,
			KEEP,
			addNew,
			addTemplate,
			toggle,
			pickImport,
			onImportChosen,
		};
	},
});
</script>
