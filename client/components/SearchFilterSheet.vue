<template>
	<div
		id="search-filters-overlay"
		v-backdrop="close"
		class="screen-overlay"
		data-escape-close="search-filters"
	>
		<form
			id="search-filters"
			ref="sheet"
			tabindex="-1"
			role="dialog"
			aria-modal="true"
			aria-labelledby="search-filters-title"
			@submit.prevent="apply"
			@keydown.tab="onTab"
		>
			<div class="search-filters-head">
				<h3 id="search-filters-title">{{ t("search.window.filters") }}</h3>
				<span class="search-spacer" />
				<button type="button" class="oper-btn oper-btn-ghost" @click="clearAll">
					{{ t("search.filters.clearAll") }}
				</button>
				<button type="button" class="oper-btn oper-btn-ghost" @click="close">
					{{ t("search.filters.cancel") }}
				</button>
			</div>

			<label class="search-field">
				<span>{{ t("search.filters.in") }}</span>
				<select v-model="scope" class="input">
					<option :value="ALL_CHANNELS">{{ t("search.filters.allChannels") }}</option>
					<option v-for="name in conversations" :key="name" :value="name">
						{{ name }}
					</option>
				</select>
			</label>

			<label class="search-field">
				<span>{{ t("search.window.chip.from") }}</span>
				<input
					v-model.trim="from"
					class="input"
					type="text"
					autocapitalize="off"
					autocomplete="off"
					:placeholder="t('search.filters.fromPlaceholder')"
				/>
			</label>
			<div v-if="suggestions.length" class="search-suggest">
				<button
					v-for="nick in suggestions"
					:key="nick"
					type="button"
					class="oper-chip"
					@click="from = nick"
				>
					{{ nick }}
				</button>
			</div>

			<label class="search-field">
				<span>{{ t("search.window.chip.account") }}</span>
				<input
					v-model.trim="account"
					class="input"
					type="text"
					autocapitalize="off"
					autocomplete="off"
					:placeholder="t('search.filters.accountPlaceholder')"
				/>
			</label>

			<div class="search-field">
				<span>{{ t("search.window.chip.date") }}</span>
				<div
					class="oper-seg search-seg"
					role="group"
					:aria-label="t('search.window.chip.date')"
				>
					<button
						v-for="option in DATE_OPTIONS"
						:key="option.id"
						type="button"
						:aria-pressed="dateChoice === option.id"
						@click="chooseDate(option.id)"
					>
						{{ dateLabel(option.id) }}
					</button>
				</div>
			</div>
			<div v-if="dateChoice === 'range'" class="search-range">
				<label class="search-field">
					<span>{{ t("search.filters.fromDay") }}</span>
					<input v-model="after" class="input" type="date" />
				</label>
				<label class="search-field">
					<span>{{ t("search.filters.toDay") }}</span>
					<input v-model="before" class="input" type="date" />
				</label>
				<p v-if="rangeError" class="search-range-error" role="alert">
					{{ t("search.filters.rangeError") }}
				</p>
			</div>

			<div class="search-field">
				<span>{{ t("search.window.chip.has") }}</span>
				<div
					class="oper-seg search-seg"
					role="group"
					:aria-label="t('search.window.chip.has')"
				>
					<button
						v-for="kind in HAS_OPTIONS"
						:key="kind.id"
						type="button"
						:aria-pressed="has.includes(kind.id)"
						@click="toggleHas(kind.id)"
					>
						{{ hasLabel(kind.id) }}
					</button>
				</div>
			</div>

			<label class="search-field">
				<span>{{ t("search.filters.without") }}</span>
				<input
					v-model="without"
					class="input"
					type="text"
					autocapitalize="off"
					autocomplete="off"
					placeholder='docker "dev image"'
				/>
			</label>

			<div class="search-filters-foot">
				<button type="submit" class="oper-btn oper-btn-primary">
					{{ t("search.filters.show") }}
				</button>
			</div>
		</form>
	</div>
</template>

<style>
#search-filters-overlay {
	position: fixed;
	inset: 0;
	z-index: 110;
	display: flex;
	align-items: flex-start;
	justify-content: center;
	padding: 4rem 1rem 1rem;
	overflow-y: auto;
	background: var(--overlay-bg-color);
}

#search-filters {
	display: grid;
	gap: 0.875rem;
	width: 100%;
	max-width: 28rem;
	padding: 1rem;
	border: 1px solid var(--oper-line-2);
	border-radius: 0.75rem;
	background: var(--window-bg-color);
	color: var(--body-color);
}

#search-filters:focus {
	outline: none;
}

.search-filters-head {
	display: flex;
	align-items: center;
	gap: 0.25rem;
}

.search-filters-head h3 {
	margin: 0;
	font-size: 1rem;
	font-weight: 600;
}

.search-field {
	display: grid;
	gap: 0.375rem;
	min-width: 0;
	margin: 0;
}

.search-field > span {
	color: var(--body-color-muted);
	font-size: 0.75rem;
	font-weight: 500;
	letter-spacing: 0.04em;
	text-transform: uppercase;
}

.search-field .input {
	width: 100%;
	margin: 0;
}

.search-seg {
	display: flex;
}

.search-seg button {
	flex: 1;
	padding-left: 0.25rem;
	padding-right: 0.25rem;
}

.search-suggest {
	display: flex;
	flex-wrap: wrap;
	gap: 0.375rem;
	margin-top: -0.375rem;
}

.search-range {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: 0.75rem;
}

.search-range-error {
	grid-column: 1 / -1;
	margin: 0;
	color: var(--oper-red);
	font-size: 0.8125rem;
}

.search-filters-foot .oper-btn {
	width: 100%;
	height: 2.75rem;
}

@media (max-width: 480px),
	(max-width: 768px) and (pointer: coarse),
	(max-height: 500px) and (hover: none) and (pointer: coarse) {
	#search-filters-overlay {
		align-items: flex-end;
		padding: 2rem 0 0;
	}

	#search-filters {
		max-width: none;
		padding-bottom: calc(1rem + var(--inset-inner-bottom, 0px));
		border-width: 1px 0 0;
		border-radius: 1.25rem 1.25rem 0 0;
	}
}
</style>

<script lang="ts">
import dayjs from "dayjs";
import {defineComponent, onMounted, onUnmounted, PropType, ref} from "vue";
import eventbus from "../js/eventbus";
import {trapTab} from "../js/helpers/trapTab";
import {ALL_CHANNELS, type SearchFilters, type SearchHas} from "../js/searchQuery";
import {useI18n} from "../js/i18n";
import {hasLabel as searchHasLabel} from "../js/helpers/searchLabels";

type DateChoice = "any" | "week" | "month" | "range";

const DATE_OPTIONS: {id: DateChoice}[] = [{id: "any"}, {id: "week"}, {id: "month"}, {id: "range"}];

const HAS_OPTIONS: {id: SearchHas}[] = [{id: "link"}, {id: "image"}];

const daysAgo = (days: number) => dayjs().subtract(days, "day").format("YYYY-MM-DD");

/** `docker "dev image"`: words and phrases, a typed `-` meaning the same thing. */
function parseWords(text: string): string[] {
	return [...text.matchAll(/"([^"]+)"|(\S+)/g)]
		.map((match) => match[1] ?? match[2].replace(/^-/, ""))
		.filter(Boolean);
}

export default defineComponent({
	name: "SearchFilterSheet",
	props: {
		filters: {type: Object as PropType<SearchFilters>, required: true},
		/** What `in` means when the query does not say. */
		scopeDefault: {type: String, required: true},
		conversations: {type: Array as PropType<string[]>, required: true},
		suggestions: {type: Array as PropType<string[]>, required: true},
	},
	emits: ["apply", "close"],
	setup(props, {emit}) {
		const {t} = useI18n();
		const dateLabel = (id: DateChoice) => {
			switch (id) {
				case "any":
					return t("search.filters.dateAny");
				case "week":
					return t("search.filters.dateWeek");
				case "month":
					return t("search.filters.dateMonth");
				default:
					return t("search.filters.dateRange");
			}
		};
		const sheet = ref<HTMLFormElement>();
		const rangeError = ref(false);
		const scope = ref(props.filters.in ?? props.scopeDefault);
		const from = ref(props.filters.from ?? "");
		const account = ref(props.filters.account ?? "");
		const after = ref(props.filters.after ?? "");
		// The form's last day is included; `before:` stops at the start of its day.
		const before = ref(
			props.filters.before
				? dayjs(props.filters.before).subtract(1, "day").format("YYYY-MM-DD")
				: ""
		);
		const has = ref<SearchHas[]>([...props.filters.has]);
		const without = ref(
			props.filters.without.map((w) => (/\s/.test(w) ? `"${w}"` : w)).join(" ")
		);

		const initialChoice = (): DateChoice => {
			if (before.value) {
				return "range";
			}

			if (!after.value) {
				return "any";
			}

			if (after.value === daysAgo(7)) {
				return "week";
			}

			return after.value === daysAgo(30) ? "month" : "range";
		};

		const dateChoice = ref<DateChoice>(initialChoice());

		const chooseDate = (choice: DateChoice) => {
			dateChoice.value = choice;

			if (choice === "range") {
				return;
			}

			before.value = "";
			after.value = choice === "any" ? "" : daysAgo(choice === "week" ? 7 : 30);
		};

		const toggleHas = (kind: SearchHas) => {
			has.value = has.value.includes(kind)
				? has.value.filter((k) => k !== kind)
				: [...has.value, kind];
		};

		const clearAll = () => {
			scope.value = props.scopeDefault;
			from.value = "";
			account.value = "";
			has.value = [];
			without.value = "";
			chooseDate("any");
		};

		const close = () => emit("close");

		const apply = () => {
			if (after.value && before.value && after.value > before.value) {
				rangeError.value = true;
				return;
			}

			const next: SearchFilters = {
				words: props.filters.words,
				without: parseWords(without.value),
				has: has.value,
			};

			if (scope.value !== props.scopeDefault) {
				next.in = scope.value;
			}

			if (from.value) {
				next.from = from.value;
			}

			if (account.value) {
				next.account = account.value;
			}

			if (after.value) {
				next.after = after.value;
			}

			if (before.value) {
				next.before = dayjs(before.value).add(1, "day").format("YYYY-MM-DD");
			}

			emit("apply", next);
		};

		const onEscape = (layer: string | null) => {
			if (layer === "search-filters") {
				close();
			}
		};

		const onTab = (event: KeyboardEvent) => {
			if (sheet.value) {
				trapTab(event, sheet.value);
			}
		};

		// Back where it was when the sheet closes, unless that has gone (a removed chip).
		const opener = document.activeElement as HTMLElement | null;

		onMounted(() => {
			eventbus.on("escapekey", onEscape);
			sheet.value?.focus();
		});

		onUnmounted(() => {
			eventbus.off("escapekey", onEscape);

			if (opener?.isConnected) {
				opener.focus({preventScroll: true});
			}
		});

		return {
			t,
			dateLabel,
			hasLabel: searchHasLabel,
			ALL_CHANNELS,
			DATE_OPTIONS,
			HAS_OPTIONS,
			account,
			after,
			apply,
			before,
			chooseDate,
			clearAll,
			close,
			dateChoice,
			from,
			has,
			onTab,
			rangeError,
			scope,
			sheet,
			toggleHas,
			without,
		};
	},
});
</script>
