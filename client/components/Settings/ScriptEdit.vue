<template>
	<Teleport to="#viewport">
		<div id="script-editor-overlay" v-backdrop="close" data-escape-close="script-editor">
			<div
				ref="pane"
				class="settings-modal script-editor"
				role="dialog"
				aria-modal="true"
				:aria-label="script ? `Edit script ${script.name}` : 'Edit script'"
				tabindex="-1"
			>
				<div class="settings-modal-header">
					<h1>
						<span class="script-editor-kind">Edit script</span>
						<span v-if="script" class="script-editor-name">{{ script.name }}</span>
					</h1>
					<button
						class="settings-modal-close"
						type="button"
						aria-label="Close the editor"
						@click="close"
					>
						✕
					</button>
				</div>

				<div class="settings-modal-body">
					<div class="script-editor-content">
						<p v-if="!script" class="script-missing">
							This script is gone — deleted here or in another tab.
						</p>

						<template v-else>
							<div class="script-fields">
								<label class="script-field script-name-field">
									<span>Name</span>
									<input
										v-model.trim="nameDraft"
										class="input script-name"
										:class="{invalid: nameError !== null}"
										type="text"
										placeholder="script_name"
										:maxlength="maxNameLength"
										spellcheck="false"
										autocapitalize="off"
										autocomplete="off"
										:aria-invalid="nameError !== null"
										@input="onNameInput"
										@change="commit"
									/>
								</label>
								<label class="script-field script-folder-field">
									<span>Folder</span>
									<input
										v-model="script.folder"
										class="input"
										type="text"
										list="script-folder-list"
										:maxlength="maxFolderLength"
										:placeholder="defaultFolder"
										spellcheck="false"
										@input="schedulePersist"
										@change="commit"
									/>
									<datalist id="script-folder-list">
										<option
											v-for="folder in folders"
											:key="folder"
											:value="folder"
										/>
									</datalist>
								</label>
								<label class="script-field script-desc-field">
									<span>Description</span>
									<input
										v-model="script.description"
										class="input"
										type="text"
										:maxlength="maxDescriptionLength"
										placeholder="What does this script do?"
										@input="schedulePersist"
										@change="commit"
									/>
								</label>
								<label class="opt script-run">
									<input
										v-model="script.enabled"
										v-switch
										type="checkbox"
										@change="onRunChange"
									/>
									Run this script
								</label>
							</div>
							<p v-if="nameError" class="script-error-line" role="alert">
								{{ nameError }}
							</p>

							<div class="script-tools">
								<button class="btn btn-sm" type="button" @click="checkSyntax">
									Check syntax
								</button>
								<button class="btn btn-sm" type="button" @click="duplicate">
									Duplicate
								</button>
								<button class="btn btn-sm" type="button" @click="exportScript">
									Export .lua
								</button>
								<button
									class="btn btn-sm script-delete"
									type="button"
									@click="remove"
								>
									Delete
								</button>
							</div>

							<div v-if="saveError" class="script-banner" role="alert">
								<strong>Not saved:</strong> {{ saveError }}
							</div>
							<div v-if="script.lastError" class="script-banner" role="alert">
								<strong>Error:</strong> {{ script.lastError }}
							</div>

							<div class="script-code-wrap">
								<!-- CodeMirror (helpers/luaEditor.ts) mounts here; the plain
								     field stands in until its chunk has loaded, and for good
								     if it cannot. -->
								<div v-show="editorReady" ref="codeHost" class="script-cm" />
								<textarea
									v-if="!editorReady"
									v-model="script.code"
									:maxlength="maxCodeLength"
									class="script-code"
									aria-label="Lua code"
									aria-describedby="script-code-foot"
									placeholder="-- Write your Lua code here"
									spellcheck="false"
									autocapitalize="off"
									autocomplete="off"
									wrap="off"
									@input="schedulePersist"
									@change="commit"
								/>
							</div>
							<p id="script-code-foot" class="script-foot">
								{{ lineCount }} lines · {{ script.code.length }} characters
							</p>

							<details class="script-api">
								<summary>Lua API reference</summary>
								<dl>
									<dt>
										<code>seance.on("message", function(msg) ... end)</code>
									</dt>
									<dd>
										Incoming messages. <code>msg</code> has <code>.from</code>,
										<code>.target</code>, <code>.text</code>,
										<code>.type</code> and <code>.self</code>.
									</dd>
									<dt>
										<code
											>seance.register_command("name", function(args, rest)
											... end)</code
										>
									</dt>
									<dd>Registers a custom slash command <code>/name</code>.</dd>
									<dt>
										<code>seance.reply(msg, "text")</code> ·
										<code>seance.send("RAW LINE")</code>
									</dt>
									<dd>
										Reply to a message, or send a raw IRC line on the current
										network.
									</dd>
									<dt><code>seance.print("text")</code></dt>
									<dd>Show a local line in the active conversation.</dd>
									<dt>
										<code
											>seance.storage.get("k") / seance.storage.set("k",
											"v")</code
										>
									</dt>
									<dd>Persistent per-script data across restarts.</dd>
									<dt>
										<code
											>seance.current_channel / seance.current_network /
											seance.nick</code
										>
									</dt>
									<dd>Context of the currently active chat tab.</dd>
								</dl>
							</details>
						</template>
					</div>
				</div>

				<div class="settings-modal-footer">
					<span class="settings-modal-note script-status" role="status">{{
						statusMsg || "Changes are saved as you type."
					}}</span>
					<button class="btn settings-modal-done" type="button" @click="close">
						Done
					</button>
				</div>
			</div>
		</div>
	</Teleport>
</template>

<style>
/* The script editor: one more layer over the settings modal, in its frame
 * (a header, a body that scrolls by itself, a footer with Done) but as wide
 * as the window allows, since code wants the room. Absolute in #viewport
 * like #settings, one step above it (20) and below the confirm dialog and
 * the menus (999 and up), so Delete's question shows over it. */
#script-editor-overlay {
	position: absolute;
	top: 0;
	right: 0;
	bottom: 0;
	left: 0;
	z-index: 30;
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 1.5rem;
	background: var(--overlay-bg-color);
	overflow: hidden;
	overflow: clip;
}

.script-editor.settings-modal {
	width: min(80rem, 100%);
	height: 100%;
}

.script-editor:focus {
	outline: 0;
}

.script-editor .settings-modal-header h1 {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.script-editor-kind {
	color: var(--body-color-muted);
	font-weight: normal;
	margin-right: 0.4em;
}

.script-editor-name {
	font-family: Consolas, Menlo, Monaco, "Lucida Console", "DejaVu Sans Mono", "Courier New",
		monospace;
}

/* Fills the body, so the code takes whatever height the fields leave. */
.script-editor-content {
	display: flex;
	flex: 1 0 auto;
	flex-direction: column;
	padding: 0 1rem 1rem;
}

.script-editor .script-missing {
	color: var(--body-color-muted);
}

.script-editor .script-fields {
	display: flex;
	flex-wrap: wrap;
	align-items: flex-end;
	gap: 0 1rem;
}

.script-editor .script-field {
	display: flex;
	flex-direction: column;
	gap: 0.25rem;
	color: var(--body-color-muted);
	font-size: 0.875em;
}

.script-editor .script-field .input {
	font-size: 1rem;
	margin-bottom: 0.75rem;
}

.script-editor .script-name-field {
	flex: 1 1 12rem;
}

.script-editor .script-folder-field {
	flex: 1 1 10rem;
}

.script-editor .script-desc-field {
	flex: 3 1 16rem;
}

.script-editor .script-name {
	font-family: Consolas, Menlo, Monaco, "Lucida Console", "DejaVu Sans Mono", "Courier New",
		monospace;
	font-weight: bold;
}

.script-editor .script-name.invalid {
	border-color: #e74c3c;
}

.script-editor .script-run {
	padding-bottom: 1.1rem;
	white-space: nowrap;
}

.script-editor .script-error-line {
	color: #e74c3c;
	font-size: 0.875em;
	margin-top: -0.5rem;
}

.script-editor .script-tools {
	display: flex;
	flex-wrap: wrap;
	gap: 0.5rem;
	margin-bottom: 0.75rem;
}

.script-editor .script-tools .btn {
	margin: 0;
}

/* Away from the others: the one that cannot be taken back. */
.script-editor .script-tools .script-delete {
	margin-left: auto;
	border-color: #e74c3c;
	color: #e74c3c;
}

.script-editor .script-tools .script-delete:hover,
.script-editor .script-tools .script-delete:focus {
	background: #e74c3c;
	color: #fff;
}

.script-editor .script-banner {
	margin-bottom: 0.5rem;
	padding: 0.4rem 0.6rem;
	border-radius: 4px;
	background: rgb(231 76 60 / 12%);
	color: #e74c3c;
	font-family: Consolas, Menlo, Monaco, "Lucida Console", "DejaVu Sans Mono", "Courier New",
		monospace;
	font-size: 0.875em;
	overflow-wrap: anywhere;
}

.script-editor .script-code-wrap {
	display: flex;
	flex: 1 0 16rem;
	overflow: hidden;
	border: 1px solid rgb(128 128 128 / 30%);
	border-radius: 4px;
	background: var(--window-bg-color);
}

.script-editor .script-code-wrap:focus-within {
	box-shadow: 0 0 0 3px rgb(132 206 136 / 50%);
}

.script-editor .script-cm {
	flex: 1 1 auto;
	min-width: 0;
}

.script-editor .script-code {
	flex: 1 1 auto;
	min-width: 0;
	padding: 0.5rem;
	border: 0;
	outline: 0;
	resize: none;
	tab-size: 4;
	white-space: pre;
	font-family: Consolas, Menlo, Monaco, "Lucida Console", "DejaVu Sans Mono", "Courier New",
		monospace;
	font-size: 0.875rem;
	line-height: 1.45;
	background: transparent;
	color: inherit;
}

.script-editor .script-foot {
	margin: 0.25rem 0 0;
	color: var(--body-color-muted);
	font-size: 0.875em;
}

.script-editor .script-api {
	margin-top: 1rem;
}

.script-editor .script-api summary {
	cursor: pointer;
	font-weight: bold;
}

.script-editor .script-api dt {
	margin-top: 0.5rem;
}

.script-editor .script-api dd {
	margin-left: 1rem;
	color: var(--body-color-muted);
}

/* On a phone it is the whole screen, as the settings are. */
@media (max-width: 768px) {
	#script-editor-overlay {
		padding: 0;
	}

	.script-editor.settings-modal {
		width: 100%;
		border-radius: 0;
	}
}
</style>

<script lang="ts">
import {computed, defineComponent, nextTick, onMounted, onUnmounted, ref} from "vue";
import {useRoute} from "vue-router";
import eventbus from "../../js/eventbus";
import {navigate} from "../../js/router";
import {
	deleteScript,
	getScript,
	loadScripts,
	normalizeFolder,
	saveScript,
	scriptFolders,
	DEFAULT_FOLDER,
	MAX_CODE_LENGTH,
	MAX_DESCRIPTION_LENGTH,
	MAX_FOLDER_LENGTH,
	MAX_NAME_LENGTH,
	ScriptStorageError,
} from "../../js/irc/scripting/storage";
import {newScriptId, scriptNameError, uniqueScriptName} from "../../js/irc/scripting/library";
import type {Script} from "../../js/irc/scripting/types";
import {scriptManager} from "../../js/irc/scripting/manager";
import type {LuaEditor} from "../../js/helpers/luaEditor";

const loadLuaEditor = () =>
	import(/* webpackChunkName: "code-editor" */ "../../js/helpers/luaEditor");

/**
 * One script, in an overlay over the settings (the route is a child of
 * Settings → Scripts, whose list stays under it), edited in place and saved
 * as it is typed (600 ms after the last key). The sandbox reloads only when
 * an edit is committed — the field loses the caret, the switch flips, the
 * editor closes — so a script's top-level code does not run again at every
 * pause in the typing. Done, ✕, Escape and the backdrop all close it back
 * to the list.
 */
export default defineComponent({
	name: "ScriptEdit",
	setup() {
		const route = useRoute();
		const id = String(route.params.id);
		const script = ref<Script | undefined>(getScript(id));
		const nameDraft = ref(script.value?.name ?? "");
		const statusMsg = ref("");
		const saveError = ref("");
		const pane = ref<HTMLElement>();
		const codeHost = ref<HTMLElement>();
		const editorReady = ref(false);
		let editor: LuaEditor | undefined;
		let unmounted = false;
		let saveTimer: ReturnType<typeof setTimeout> | undefined;
		let flashTimer: ReturnType<typeof setTimeout> | undefined;
		let dirty = false;

		const folders = computed(() => scriptFolders(loadScripts()));
		const lineCount = computed(() => (script.value ? script.value.code.split("\n").length : 1));
		const nameError = computed(() =>
			script.value ? scriptNameError(loadScripts(), nameDraft.value, id) : null
		);

		const flash = (msg: string) => {
			statusMsg.value = msg;
			clearTimeout(flashTimer);
			flashTimer = setTimeout(() => (statusMsg.value = ""), 2500);
		};

		// The manager records load and run errors in storage; the banner
		// follows what it last wrote.
		const refreshError = () => {
			if (script.value) {
				script.value.lastError = getScript(id)?.lastError;
			}
		};

		const write = (next: Script): boolean => {
			try {
				saveScript(next);
			} catch (err) {
				if (!(err instanceof ScriptStorageError)) {
					throw err;
				}

				saveError.value = err.message;
				return false;
			}

			saveError.value = "";
			return true;
		};

		const persistNow = (): boolean => {
			clearTimeout(saveTimer);
			saveTimer = undefined;

			if (!script.value) {
				return false;
			}

			refreshError();
			const ok = write({
				...script.value,
				folder: normalizeFolder(script.value.folder),
				description: script.value.description?.trim() || undefined,
				updatedAt: Date.now(),
			});

			if (ok) {
				dirty = true;
				flash("Saved");
			}

			return ok;
		};

		const schedulePersist = () => {
			clearTimeout(saveTimer);
			saveTimer = setTimeout(persistNow, 600);
		};

		// Save what is pending and run the library again with it.
		const commit = async () => {
			if (saveTimer !== undefined) {
				persistNow();
			}

			if (!dirty) {
				return;
			}

			dirty = false;
			await scriptManager.reload();
			refreshError();
		};

		const onRunChange = () => {
			persistNow();
			void commit();
		};

		const onNameInput = () => {
			if (script.value && nameError.value === null && nameDraft.value !== script.value.name) {
				script.value.name = nameDraft.value;
				schedulePersist();
			}
		};

		// What is pending is saved first: the list re-reads the library as
		// the route leaves the editor, before this unmounts and commits.
		const close = () => {
			if (saveTimer !== undefined) {
				persistNow();
			}

			void navigate("Scripts");
		};

		const onEscape = (layer: string | null) => {
			if (layer === "script-editor") {
				close();
			}
		};

		// CodeMirror takes over from the plain field once its chunk is here,
		// with whatever was typed there meanwhile.
		const mountEditor = async () => {
			let createLuaEditor: typeof import("../../js/helpers/luaEditor").createLuaEditor;

			try {
				({createLuaEditor} = await loadLuaEditor());
			} catch (err) {
				// eslint-disable-next-line no-console
				console.warn("[scripting] the code editor did not load; a plain field it is", err);
				return;
			}

			if (unmounted || !script.value) {
				return;
			}

			// The host is shown first: CodeMirror measures what it mounts into.
			editorReady.value = true;
			await nextTick();

			if (unmounted || !script.value || !codeHost.value) {
				return;
			}

			editor = createLuaEditor({
				parent: codeHost.value,
				doc: script.value.code,
				maxLength: MAX_CODE_LENGTH,
				attributes: {"aria-label": "Lua code", "aria-describedby": "script-code-foot"},
				onChange(doc) {
					if (script.value) {
						script.value.code = doc;
						schedulePersist();
					}
				},
				onBlur() {
					void commit();
				},
			});
		};

		onMounted(() => {
			eventbus.on("escapekey", onEscape);
			// Into the dialog, not a field: a phone would raise its keyboard.
			pane.value?.focus();
			void mountEditor();
		});

		onUnmounted(() => {
			unmounted = true;
			editor?.destroy();
			eventbus.off("escapekey", onEscape);
			clearTimeout(flashTimer);

			if (saveTimer !== undefined || dirty) {
				void commit();
			}
		});

		const checkSyntax = async () => {
			if (!script.value) {
				return;
			}

			persistNow();
			flash("Checking…");
			// Compiled, never run: running it would fire its top-level code
			// and register its handlers a second time.
			const error = await scriptManager.checkSyntax(script.value.code);

			if (!script.value) {
				return;
			}

			script.value.lastError = error;
			write({...script.value});
			flash(error === undefined ? "Syntax OK" : "Syntax error");
		};

		const duplicate = () => {
			if (!script.value || !persistNow()) {
				return;
			}

			const copy: Script = {
				...script.value,
				id: newScriptId(),
				name: uniqueScriptName(loadScripts(), `${script.value.name}_copy`),
				enabled: false,
				lastError: undefined,
				createdAt: Date.now(),
				updatedAt: undefined,
			};

			if (write(copy)) {
				void navigate("ScriptEdit", {id: copy.id});
			}
		};

		const remove = () => {
			if (!script.value) {
				return;
			}

			eventbus.emit(
				"confirm-dialog",
				{
					title: `Delete script “${script.value.name}”?`,
					text: "This deletes the script and its saved data. This cannot be undone.",
					button: "Delete",
				},
				(confirmed: boolean) => {
					if (!confirmed) {
						return;
					}

					clearTimeout(saveTimer);
					saveTimer = undefined;
					dirty = false;
					deleteScript(id);
					script.value = undefined;
					void scriptManager.reload();
					void navigate("Scripts");
				}
			);
		};

		const exportScript = () => {
			if (!script.value) {
				return;
			}

			const blob = new Blob([script.value.code], {type: "text/plain"});
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;
			link.download = `${script.value.name}.lua`;
			document.body.appendChild(link);
			link.click();
			link.remove();
			setTimeout(() => URL.revokeObjectURL(url), 10_000);
		};

		return {
			script,
			nameDraft,
			nameError,
			statusMsg,
			saveError,
			folders,
			lineCount,
			pane,
			codeHost,
			editorReady,
			defaultFolder: DEFAULT_FOLDER,
			maxNameLength: MAX_NAME_LENGTH,
			maxFolderLength: MAX_FOLDER_LENGTH,
			maxDescriptionLength: MAX_DESCRIPTION_LENGTH,
			maxCodeLength: MAX_CODE_LENGTH,
			schedulePersist,
			commit,
			onRunChange,
			onNameInput,
			checkSyntax,
			duplicate,
			remove,
			exportScript,
			close,
		};
	},
});
</script>
