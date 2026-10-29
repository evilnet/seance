<template>
	<div class="settings-aliases" role="group" :aria-label="paneAria">
		<h2>{{ t("settings.aliases.titleHeading") }}</h2>
		<p class="alias-intro">
			<I18nFrame
				:text="
					t('settings.aliases.intro', {example: KEEP, first: KEEP, rest: KEEP, all: KEEP})
				"
				><template v-slot:example
					><code>/{{ rows[0]?.name || "wave" }}</code></template
				><template v-slot:first><code>$1</code></template
				><template v-slot:rest><code>$2-</code></template
				><template v-slot:all><code>$*</code></template></I18nFrame
			>
		</p>

		<div v-if="rows.length" class="alias-table">
			<div class="alias-head" aria-hidden="true">
				<span class="alias-head-name">{{ t("settings.aliases.headName") }}</span>
				<span class="alias-head-body">{{ t("settings.aliases.headRuns") }}</span>
			</div>
			<div
				v-for="(row, index) in rows"
				:key="row.id"
				class="alias-row"
				:class="{'alias-row-invalid': rowError(index) !== null}"
			>
				<label class="alias-name-wrap">
					<span class="alias-slash" aria-hidden="true">/</span>
					<input
						v-model.trim="row.name"
						dir="auto"
						:aria-label="nameAria(index)"
						class="input alias-name"
						type="text"
						:placeholder="namePlaceholder"
						:maxlength="maxNameLength"
						spellcheck="false"
						autocapitalize="off"
						autocomplete="off"
					/>
				</label>
				<textarea
					v-model="row.body"
					dir="auto"
					:aria-label="bodyAria(row, index)"
					class="input alias-body"
					:rows="bodyRows(row)"
					:placeholder="bodyPlaceholder"
					spellcheck="false"
					autocapitalize="off"
					autocomplete="off"
				/>
				<button
					class="alias-remove"
					type="button"
					:aria-label="removeAria(row, index)"
					@click="remove(index)"
				/>
				<div v-if="rowError(index)" class="alias-error" role="alert">
					{{ rowError(index) }}
				</div>
			</div>
		</div>
		<p v-else class="alias-empty">{{ t("settings.aliases.empty") }}</p>

		<div class="alias-actions">
			<button class="btn" type="button" @click="add">{{ t("settings.aliases.add") }}</button>
			<span class="alias-status" role="status">{{ statusText }}</span>
		</div>

		<h2>{{ t("settings.aliases.variablesHeading") }}</h2>
		<dl class="alias-vars">
			<dt><code>$1</code> … <code>$9</code></dt>
			<dd>{{ t("settings.aliases.varOne") }}</dd>
			<dt><code>$2-</code></dt>
			<dd>{{ t("settings.aliases.varRest") }}</dd>
			<dt><code>$*</code></dt>
			<dd>{{ t("settings.aliases.varStar") }}</dd>
			<dt><code>$chan</code></dt>
			<dd>{{ t("settings.aliases.varChan") }}</dd>
			<dt><code>$me</code></dt>
			<dd>{{ t("settings.aliases.varMe") }}</dd>
			<dt><code>$$</code></dt>
			<dd>
				<I18nFrame :text="t('settings.aliases.varLiteral', {character: KEEP})"
					><template v-slot:character><code>$</code></template></I18nFrame
				>
			</dd>
		</dl>
		<p class="alias-intro">
			<I18nFrame :text="t('settings.aliases.nested', {command: KEEP, expansion: KEEP})"
				><template v-slot:command><code>/join</code></template
				><template v-slot:expansion><code>/join #lobby $*</code></template></I18nFrame
			>
		</p>

		<h2>{{ t("settings.aliases.tryHeading") }}</h2>
		<input
			v-model="tryText"
			dir="auto"
			:aria-label="tryAria"
			class="input alias-try"
			type="text"
			:placeholder="tryPlaceholder"
			spellcheck="false"
			autocapitalize="off"
			autocomplete="off"
		/>
		<div v-if="tryText" class="alias-preview" aria-live="polite">
			<template v-if="preview">
				<code v-for="(line, index) in preview" :key="index" class="alias-preview-line">{{
					line
				}}</code>
			</template>
			<span v-else class="alias-preview-miss">
				{{ t("settings.aliases.previewMiss") }}
			</span>
		</div>
	</div>
</template>

<style>
.settings-aliases .alias-intro,
.settings-aliases .alias-empty {
	color: var(--body-color-muted);
}

.settings-aliases .alias-table {
	display: flex;
	flex-direction: column;
	gap: 0.5rem;
	margin-bottom: 0.75rem;
}

.settings-aliases .alias-head,
.settings-aliases .alias-row {
	display: grid;
	grid-template-columns: 9rem 1fr 2rem;
	gap: 0 0.5rem;
	align-items: start;
}

.settings-aliases .alias-head {
	color: var(--body-color-muted);
	font-size: 0.875em;
	text-transform: uppercase;
	letter-spacing: 0.05em;
}

.settings-aliases .alias-name-wrap {
	position: relative;
	display: block;
}

.settings-aliases .alias-slash {
	position: absolute;
	inset-inline-start: 0.55em;
	top: 50%;
	transform: translateY(-50%);
	color: var(--body-color-muted);
	font-family: Consolas, Menlo, Monaco, "Lucida Console", "DejaVu Sans Mono", "Courier New",
		monospace;
	pointer-events: none;
}

.settings-aliases .alias-name {
	padding-inline-start: 1.4em;
	font-family: Consolas, Menlo, Monaco, "Lucida Console", "DejaVu Sans Mono", "Courier New",
		monospace;
}

.settings-aliases .alias-body {
	font-family: Consolas, Menlo, Monaco, "Lucida Console", "DejaVu Sans Mono", "Courier New",
		monospace;
	resize: vertical;
	min-height: 2.25rem;
}

/* The inputs carry the row: settings pages give .input a large bottom
 * margin that would double the grid gap here. */
.settings-aliases .alias-row .input {
	margin-bottom: 0;
}

.settings-aliases .alias-remove {
	height: 2.25rem;
	color: var(--body-color-muted);
}

.settings-aliases .alias-remove::before {
	font: normal normal normal 1em/1 FontAwesome;
	content: "\f1f8"; /* https://fontawesome.com/icons/trash */
}

.settings-aliases .alias-remove:hover,
.settings-aliases .alias-remove:focus {
	color: #e74c3c;
}

.settings-aliases .alias-row-invalid .input {
	border-color: #e74c3c;
}

.settings-aliases .alias-error {
	grid-column: 1 / -1;
	color: #e74c3c;
	font-size: 0.875em;
	padding-top: 0.25em;
}

.settings-aliases .alias-actions {
	display: flex;
	align-items: center;
	gap: 1rem;
}

.settings-aliases .alias-actions .btn {
	margin-bottom: 0;
}

.settings-aliases .alias-status {
	color: var(--body-color-muted);
	font-size: 0.875em;
}

.settings-aliases .alias-vars {
	display: grid;
	grid-template-columns: max-content 1fr;
	gap: 0.35rem 1rem;
	margin: 0 0 1em;
}

.settings-aliases .alias-vars dt {
	font-weight: normal;
}

.settings-aliases .alias-vars dd {
	margin: 0;
	color: var(--body-color-muted);
}

.settings-aliases .alias-try {
	font-family: Consolas, Menlo, Monaco, "Lucida Console", "DejaVu Sans Mono", "Courier New",
		monospace;
}

.settings-aliases .alias-preview {
	display: flex;
	flex-direction: column;
	gap: 0.25rem;
	padding: 0.5rem 0.75rem;
	border-radius: 4px;
	background: rgb(128 128 128 / 12%);
}

.settings-aliases .alias-preview-line {
	display: block;
}

.settings-aliases .alias-preview-miss {
	color: var(--body-color-muted);
}
</style>

<script lang="ts">
import {computed, defineComponent, reactive, ref, watch} from "vue";
import {useI18n} from "../../js/i18n";
import {KEEP} from "../../js/i18n/core";
import I18nFrame from "../I18nFrame.vue";
import {
	expandAlias,
	isValidAliasName,
	loadAliases,
	saveAliases,
	MAX_ALIASES,
	MAX_BODY_LENGTH,
	MAX_NAME_LENGTH,
	type Alias,
} from "../../js/helpers/aliases";

interface AliasRow extends Alias {
	/** Stable key for the row while names are being typed. */
	id: number;
}

export default defineComponent({
	name: "AliasSettings",
	components: {
		I18nFrame,
	},
	setup() {
		const {t, tCount} = useI18n();
		let nextId = 1;
		const rows = reactive<AliasRow[]>(loadAliases().map((alias) => ({...alias, id: nextId++})));

		const tryText = ref("");

		/** Rows complete and consistent enough to persist and to preview. */
		const validRows = computed<Alias[]>(() => {
			const seen = new Set<string>();
			const list: Alias[] = [];

			for (const row of rows) {
				const key = row.name.toLowerCase();

				if (
					!isValidAliasName(row.name) ||
					row.body.trim().length === 0 ||
					row.body.length > MAX_BODY_LENGTH ||
					seen.has(key)
				) {
					continue;
				}

				seen.add(key);
				list.push({name: row.name, body: row.body});
			}

			return list;
		});

		// Every change persists at once, like the rest of the settings; a row
		// with an error simply is not part of what is saved yet.
		watch(validRows, (list) => saveAliases(list), {deep: true});

		const rowError = (index: number): string | null => {
			const row = rows[index];

			if (row.name.length === 0 && row.body.trim().length === 0) {
				return null; // a fresh row is not wrong, just not saved
			}

			if (row.name.length === 0) {
				return t("settings.aliases.errorName");
			}

			if (!isValidAliasName(row.name)) {
				return t("settings.aliases.errorNameChars");
			}

			for (let i = 0; i < index; i++) {
				if (rows[i].name.toLowerCase() === row.name.toLowerCase()) {
					return t("settings.aliases.errorDuplicate", {name: rows[i].name});
				}
			}

			if (row.body.trim().length === 0) {
				return t("settings.aliases.errorBody");
			}

			if (row.body.length > MAX_BODY_LENGTH) {
				return t("settings.aliases.errorTooLong", {limit: MAX_BODY_LENGTH});
			}

			return null;
		};

		const statusText = computed(() => {
			const saved = validRows.value.length;
			const broken = rows.filter((_, index) => rowError(index) !== null).length;

			if (rows.length === 0) {
				return "";
			}

			return broken > 0
				? tCount("settings.aliases.statusBroken", saved)
				: tCount("settings.aliases.statusSaved", saved);
		});

		const add = () => {
			if (rows.length >= MAX_ALIASES) {
				return;
			}

			rows.push({id: nextId++, name: "", body: ""});
		};

		const remove = (index: number) => {
			rows.splice(index, 1);
		};

		const bodyRows = (row: AliasRow) => Math.min(8, row.body.split("\n").length);

		const tryPlaceholder = computed(() =>
			validRows.value.length > 0
				? t("settings.aliases.tryExample", {name: validRows.value[0].name})
				: "/wave bob"
		);

		const paneAria = computed(() => t("settings.aliases.paneAria"));
		const tryAria = computed(() => t("settings.aliases.tryAria"));
		const namePlaceholder = computed(() => t("settings.aliases.namePlaceholder"));
		const bodyPlaceholder = computed(() => t("settings.aliases.bodyPlaceholder"));

		// Per-row labels: the wave-A pattern keeps t() out of template
		// attribute bindings; {name} carries the alias's name (or the row
		// number while the name is empty) verbatim.
		const nameAria = (index: number): string =>
			t("settings.aliases.nameAria", {number: index + 1});
		const bodyAria = (row: AliasRow, index: number): string =>
			t("settings.aliases.bodyAria", {name: row.name || index + 1});
		const removeAria = (row: AliasRow, index: number): string =>
			t("settings.aliases.removeAria", {name: row.name || index + 1});

		const preview = computed(() =>
			expandAlias(tryText.value, {chan: "#channel", me: "yournick"}, validRows.value)
		);

		return {
			t,
			tCount,
			KEEP,
			rows,
			rowError,
			statusText,
			add,
			remove,
			bodyRows,
			tryText,
			tryPlaceholder,
			namePlaceholder,
			bodyPlaceholder,
			nameAria,
			bodyAria,
			removeAria,
			paneAria,
			tryAria,
			preview,
			maxNameLength: MAX_NAME_LENGTH,
		};
	},
});
</script>
