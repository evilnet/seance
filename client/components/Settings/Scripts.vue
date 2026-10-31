<template>
	<div class="settings-scripts" role="group" :aria-label="t('settings.scripts.heading')">
		<h2>{{ t("settings.scripts.heading") }}</h2>
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

		<template v-else>
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
				type="search"
				:placeholder="t('settings.scripts.searchPlaceholder')"
				:aria-label="t('settings.scripts.searchAria')"
				spellcheck="false"
			/>

			<p v-if="scripts.length === 0" class="scripts-empty">
				{{ t("settings.scripts.empty") }}
			</p>
			<p v-else-if="grouped.length === 0" class="scripts-empty">
				{{ t("settings.scripts.noMatch") }}
			</p>
			<template v-for="group in grouped" :key="group.folder">
				<h3 class="scripts-folder">{{ folderLabel(group.folder) }}</h3>
				<ul class="scripts-list">
					<li
						v-for="script in group.scripts"
						:key="script.id"
						class="scripts-item"
						:class="{'has-error': !!script.lastError}"
					>
						<router-link class="scripts-summary" :to="`/settings/scripts/${script.id}`">
							<span class="scripts-name">{{ script.name }}</span>
							<span v-if="script.description" class="scripts-desc">{{
								script.description
							}}</span>
							<span class="scripts-state">{{ stateLabel(script) }}</span>
						</router-link>
						<input
							v-switch
							:checked="script.enabled"
							type="checkbox"
							:aria-label="t('settings.scripts.runAria', {name: script.name})"
							:title="
								script.enabled
									? t('settings.scripts.stateRunning')
									: t('settings.scripts.stateOff')
							"
							@change="toggle(script, $event)"
						/>
					</li>
				</ul>
			</template>
		</template>

		<!-- The editor (ScriptEdit.vue), an overlay above the settings. Keyed
		     by the script, so Duplicate's jump to the copy mounts a fresh one. -->
		<router-view v-slot:default="{Component, route: shown}">
			<component :is="Component" :key="shown.params.id" />
		</router-view>
	</div>
</template>

<style>
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

.settings-scripts .scripts-folder {
	color: var(--body-color-muted);
	font-size: 0.875em;
	text-transform: uppercase;
	letter-spacing: 0.05em;
	margin: 1.25rem 0 0.25rem;
}

.settings-scripts .scripts-list {
	list-style: none;
	margin: 0;
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
	normalizeFolder,
	saveScript,
	scriptFolders,
	DEFAULT_FOLDER,
	MAX_CODE_LENGTH,
	ScriptStorageError,
} from "../../js/irc/scripting/storage";
import type {Script} from "../../js/irc/scripting/types";
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

		// The editor saves straight to storage: read the library again as it
		// closes (Done, ✕, Escape, Delete).
		watch(
			() => route.name,
			(name) => {
				if (name === "Scripts") {
					scripts.value = loadScripts().sort(compareScripts);
				}
			}
		);
		const query = ref("");
		const importError = ref("");
		const importInput = ref<HTMLInputElement>();

		const grouped = computed(() => {
			const q = query.value.trim().toLowerCase();
			const visible = q
				? scripts.value.filter((script) =>
						[script.name, script.folder, script.description ?? "", script.code]
							.join("\n")
							.toLowerCase()
							.includes(q)
				  )
				: scripts.value;

			return scriptFolders(visible).map((folder) => ({
				folder,
				scripts: visible.filter(
					(s) => normalizeFolder(s.folder).toLowerCase() === folder.toLowerCase()
				),
			}));
		});

		const stateLabel = (script: Script) =>
			script.lastError
				? t("settings.scripts.stateError")
				: script.enabled
				? t("settings.scripts.stateRunning")
				: t("settings.scripts.stateOff");

		// The default folder is stored under its English name, which stays
		// the library's identity for it; it is shown in the reader's words.
		const folderLabel = (folder: string) =>
			folder.toLowerCase() === DEFAULT_FOLDER.toLowerCase()
				? t("settings.scripts.defaultFolder")
				: folder;

		// A new script opens in the editor: that is where it gets written.
		const create = (script: Script) => {
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
				folder: DEFAULT_FOLDER,
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
				folder: DEFAULT_FOLDER,
				code,
				enabled: false,
				createdAt: Date.now(),
			});
		};

		return {
			store,
			scripts,
			query,
			grouped,
			importError,
			importInput,
			SEARCH_FROM,
			stateLabel,
			folderLabel,
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
