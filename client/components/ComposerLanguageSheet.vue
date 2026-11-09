<template>
	<!-- Teleported to <body> like the retranslate dialog: anchored over the
	     composer's translate button, or a sheet docked to the chat pane. -->
	<Teleport to="body">
		<div
			ref="root"
			class="language-sheet"
			:class="{'language-sheet--phone': phone}"
			:style="style"
			role="dialog"
			tabindex="-1"
			:aria-label="t('translate.sheet.dialog')"
			@keydown.esc.stop.prevent="close"
		>
			<div class="language-sheet-head">
				<span class="language-sheet-title">{{ t("translate.sheet.title") }}</span>
				<button v-if="target" type="button" class="language-sheet-off" @click="turnOff">
					{{ t("translate.sheet.off") }}
				</button>
				<button
					type="button"
					class="language-sheet-close"
					:aria-label="t('translate.sheet.close')"
					:title="t('translate.sheet.close')"
					@click="close"
				>
					✕
				</button>
			</div>
			<!-- The pair: which side the list below fills in. -->
			<div class="language-sheet-pair">
				<button
					type="button"
					class="language-sheet-side"
					data-side="from"
					:data-code="from ?? ''"
					:class="{active: side === 'from'}"
					:aria-pressed="side === 'from'"
					@click="side = 'from'"
				>
					<span class="language-sheet-side-label">{{ t("translate.sheet.iWrite") }}</span>
					<span class="language-sheet-side-value">{{
						from ? name(from) : t("translate.sheet.detect")
					}}</span>
				</button>
				<button
					type="button"
					class="language-sheet-swap"
					:aria-label="t('translate.sheet.swap')"
					:title="t('translate.sheet.swap')"
					:disabled="!from || !shownTo || from === shownTo"
					@click="swap"
				>
					⇄
				</button>
				<button
					type="button"
					class="language-sheet-side"
					data-side="to"
					:data-code="to"
					:class="{active: side === 'to'}"
					:aria-pressed="side === 'to'"
					@click="side = 'to'"
				>
					<span class="language-sheet-side-label">{{
						t("translate.sheet.theyRead")
					}}</span>
					<span class="language-sheet-side-value">{{
						shownTo ? name(shownTo) : t("translate.sheet.choose")
					}}</span>
				</button>
			</div>
			<!-- The other direction, reading, is the channel panel's switch;
			     it is here too because this button is the one translation
			     control in sight, and people opened it looking for "translate
			     what they write". -->
			<label class="language-sheet-read">
				<input
					v-switch
					type="checkbox"
					class="language-sheet-read-box"
					:checked="reading"
					:disabled="!reading && readBlocked"
					@change="toggleReading"
				/>
				{{ t("translate.panel.readIn", {language: name(readingLanguage())}) }}
			</label>
			<div v-if="recent.length" class="language-sheet-recent">
				<span class="language-sheet-recent-label">{{
					t("translate.sheet.recent", {channel: channel.name})
				}}</span>
				<div class="language-sheet-chips">
					<button
						v-for="code in recent"
						:key="code"
						type="button"
						class="language-sheet-chip"
						:class="{active: code === current}"
						@click="choose(code)"
					>
						{{ name(code) }}
					</button>
				</div>
			</div>
			<!-- Before the list: a pick applies at once, so this is set first. -->
			<label v-if="onceOffered" class="language-sheet-once">
				<input v-model="once" v-switch type="checkbox" class="language-sheet-once-box" />
				{{ t("translate.sheet.thisMessageOnly") }}
			</label>
			<input
				ref="search"
				v-model="query"
				type="search"
				name="translateLanguageSearch"
				class="input language-sheet-search"
				autocomplete="off"
				:placeholder="t('translate.sheet.search')"
				:aria-label="t('translate.sheet.search')"
				@keydown.enter.prevent="chooseFirst"
			/>
			<ul class="language-sheet-list" :aria-label="sideLabel">
				<li v-if="side === 'from' && !query">
					<button
						type="button"
						class="language-sheet-row"
						:aria-current="from === null ? 'true' : undefined"
						@click="choose(null)"
					>
						<span class="language-sheet-name">{{ t("translate.sheet.detect") }}</span>
						<span v-if="from === null" class="language-sheet-check" aria-hidden="true"
							>✓</span
						>
					</button>
				</li>
				<li v-for="row in usable" :key="row.code">
					<button
						type="button"
						class="language-sheet-row"
						:class="{blocked: row.blocked, pending: row.pending}"
						:aria-current="row.selected ? 'true' : undefined"
						:data-code="row.code"
						:title="row.why || undefined"
						@click="choose(row.code)"
					>
						<span class="language-sheet-name">{{ row.name }}</span>
						<span v-if="row.endonym" class="language-sheet-endonym" :lang="row.code">{{
							row.endonym
						}}</span>
						<span v-if="row.status" class="language-sheet-status">{{
							row.status
						}}</span>
						<span v-if="row.selected" class="language-sheet-check" aria-hidden="true"
							>✓</span
						>
					</button>
				</li>
				<!-- What cannot run here goes last, under one heading rather than
				     a "not available" on every row; a tap still says why. -->
				<li v-if="unusable.length" class="language-sheet-section">
					{{ t("translate.sheet.unavailableHeading") }}
				</li>
				<li v-for="row in unusable" :key="row.code">
					<button
						type="button"
						class="language-sheet-row"
						:class="{blocked: row.blocked, pending: row.pending}"
						:aria-current="row.selected ? 'true' : undefined"
						:data-code="row.code"
						:title="row.why || undefined"
						@click="choose(row.code)"
					>
						<span class="language-sheet-name">{{ row.name }}</span>
						<span v-if="row.endonym" class="language-sheet-endonym" :lang="row.code">{{
							row.endonym
						}}</span>
						<span v-if="row.status" class="language-sheet-status">{{
							row.status
						}}</span>
						<span v-if="row.selected" class="language-sheet-check" aria-hidden="true"
							>✓</span
						>
					</button>
				</li>
				<li v-if="!rows.length" class="language-sheet-empty">
					{{ t("translate.sheet.noMatch", {query: query.trim()}) }}
				</li>
			</ul>
			<!-- Live: why the language last tapped in "They read" cannot run
			     here, as two whole sentences. -->
			<div class="language-sheet-hint" aria-live="polite">
				<template v-if="blockedLead">
					<p class="language-sheet-blocked">{{ blockedLead }}</p>
					<p class="language-sheet-why">{{ blockedWhy }}</p>
				</template>
			</div>
		</div>
	</Teleport>
</template>

<script lang="ts">
import {
	computed,
	defineComponent,
	nextTick,
	onBeforeUnmount,
	onMounted,
	PropType,
	ref,
	watch,
} from "vue";
import {hasVirtualKeyboard} from "../js/helpers/device";
import friendlysize from "../js/helpers/friendlysize";
import {translateWhyText} from "../js/helpers/translateWhy";
import {useI18n} from "../js/i18n";
import {collator} from "../js/i18n/collation";
import {SUPPORTED_LANGUAGES, languageEndonym, languageName} from "../js/translate/languages";
import {
	channelTranslation,
	currentTranslationBlock,
	liveLlmName,
	pairVerdict,
	readingLanguage,
	setReading,
} from "../js/translate/reader";
import {recentLanguages} from "../js/translate/recent";
import {downloadBytes} from "../js/translate/service";
import type {RouteVerdict} from "../js/translate/router";
import {useStore} from "../js/store";
import type {ClientChan, ClientNetwork} from "../js/types";

/** Gap between the button and the popover, and the margin it keeps off screen edges. */
const GAP = 6;
const EDGE = 8;
/** The width below which the popover becomes a sheet: the phone layout's breakpoint. */
const NARROW = "(max-width: 479px)";
/** The "Spoken in #chan lately" chips: the channel's most written languages. */
const RECENT_CHIPS = 4;

interface Row {
	code: string;
	name: string;
	endonym: string;
	status: string;
	why: string;
	selected: boolean;
	/** The "They read" value not yet applied: the preselection, or a blocked tap. */
	pending: boolean;
	blocked: boolean;
}

/** Case and accents folded, for the search. */
const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();

export default defineComponent({
	name: "ComposerLanguageSheet",
	props: {
		/** The translate button the popover hangs off. */
		anchor: {type: Object as PropType<HTMLElement | null>, default: null},
		network: {type: Object as PropType<ClientNetwork>, required: true},
		channel: {type: Object as PropType<ClientChan>, required: true},
		/** The channel's send target now; null when it has none. */
		target: {type: String as PropType<string | null>, default: null},
		/** "They read" when the sheet opens: the target, or a likely one. */
		initialTo: {type: String, default: ""},
		/** "I write" when the sheet opens; null is detection. */
		initialFrom: {type: String as PropType<string | null>, default: null},
		/** A draft is there, so "This message only" is on offer. */
		onceOffered: {type: Boolean, default: false},
	},
	emits: ["pick", "off", "close"],
	setup(props, {emit}) {
		const {t} = useI18n();
		const store = useStore();
		const root = ref<HTMLDivElement | null>(null);
		const search = ref<HTMLInputElement | null>(null);
		const name = (code: string) => languageName(code, readingLanguage());

		const side = ref<"from" | "to">("to");
		const from = ref<string | null>(props.initialFrom);
		const to = ref<string>(props.initialTo);
		const query = ref("");
		const once = ref(false);
		// With no target set, `initialTo` is only a suggestion (the last
		// pick, a language the channel speaks): highlighted in the list, one
		// tap away, but "They read" says "Choose…" until something is picked
		// -- a sheet that opened on "They read German" looked switched on.
		const picked = ref(false);
		const shownTo = computed(() => props.target ?? (picked.value ? to.value : ""));

		const reading = computed(() => channelTranslation(props.network, props.channel).read);
		const readBlocked = computed(() => currentTranslationBlock() !== null);
		const toggleReading = (event: Event) =>
			setReading(props.network, props.channel, (event.target as HTMLInputElement).checked);

		const current = computed(() => (side.value === "from" ? from.value : props.target));
		const sideLabel = computed(() =>
			side.value === "from" ? t("translate.sheet.iWrite") : t("translate.sheet.theyRead")
		);

		// Named in the interface's language and sorted by it (the panel's
		// rule), with each language's own name beside it for the reader
		// looking for "Português".
		const languages = computed(() =>
			[...SUPPORTED_LANGUAGES].sort((a, b) => collator().compare(name(a), name(b)))
		);

		const recent = computed(() =>
			recentLanguages(props.channel.messages, store.state.translations)
				.slice(0, RECENT_CHIPS)
				.map((c) => c.code)
		);

		// Each target through the router's own rule (reader.ts `pairVerdict`)
		// from the language the user writes: a pair nothing here can serve
		// says so on its row instead of failing on the first send.
		const verdicts = computed(() => {
			const out = new Map<string, RouteVerdict>();

			for (const code of SUPPORTED_LANGUAGES) {
				out.set(code, pairVerdict(from.value, code));
			}

			return out;
		});

		const rows = computed<Row[]>(() => {
			const wanted = fold(query.value.trim());

			return languages.value
				.filter(
					(code) =>
						!wanted ||
						fold(name(code)).includes(wanted) ||
						fold(languageEndonym(code)).includes(wanted) ||
						code === wanted
				)
				.map((code) => {
					const label = name(code);
					const endonym = languageEndonym(code);
					const row: Row = {
						code,
						name: label,
						endonym: fold(endonym) === fold(label) ? "" : endonym,
						status: "",
						why: "",
						selected: code === current.value,
						pending: false,
						blocked: false,
					};

					if (side.value === "from") {
						return row;
					}

					const verdict = verdicts.value.get(code);

					row.pending = code === to.value && code !== props.target;

					if (!verdict?.route) {
						row.blocked = true;
						row.status = "";
						row.why = verdict ? translateWhyText(verdict.why, liveLlmName()) : "";
						return row;
					}

					const size = downloadBytes(verdict.route, store.state.translation.models);

					if (code === from.value) {
						row.status = t("translate.sheet.corrects");
					} else if (size > 0) {
						row.status = t("translate.sheet.download", {size: friendlysize(size)});
					}

					return row;
				});
		});

		const usable = computed(() => rows.value.filter((row) => !row.blocked));
		const unusable = computed(() => rows.value.filter((row) => row.blocked));

		// The tapped "They read" language that cannot run: the reason, as
		// the retranslate dialog gives it.
		const blockedVerdict = computed(() => {
			if (side.value !== "to" || !to.value) {
				return null;
			}

			const verdict = verdicts.value.get(to.value);

			return verdict && !verdict.route ? verdict : null;
		});
		const blockedLead = computed(() => {
			const verdict = blockedVerdict.value;

			if (!verdict) {
				return "";
			}

			if (verdict.polish) {
				return t("translate.picker.sameLanguageNeedsGpu");
			}

			return from.value
				? t("translate.pair.unavailable", {from: name(from.value), to: name(to.value)})
				: t("translate.pair.unavailableInto", {to: name(to.value)});
		});
		const blockedWhy = computed(() => {
			const verdict = blockedVerdict.value;

			return verdict ? translateWhyText(verdict.why, liveLlmName()) : "";
		});

		const close = () => emit("close");

		const apply = () => {
			emit("pick", to.value, from.value, once.value && props.onceOffered);
			close();
		};

		// A pick in "I write" names the source and moves on to the target;
		// one in "They read" is the choice, applied at once -- unless
		// nothing here can serve it, where it stays up with its reason.
		const choose = (code: string | null) => {
			query.value = "";

			if (side.value === "from") {
				from.value = code;
				side.value = "to";
				return;
			}

			if (!code) {
				return;
			}

			to.value = code;
			picked.value = true;

			if (verdicts.value.get(code)?.route) {
				apply();
			}
		};

		const chooseFirst = () => {
			const first = rows.value[0];

			if (query.value.trim()) {
				if (first) {
					choose(first.code);
				}
			} else if (side.value === "to" && to.value) {
				// The highlighted "They read" language, as it opened.
				choose(to.value);
			}
		};

		const swap = () => {
			if (!from.value || !shownTo.value) {
				return;
			}

			const was = from.value;
			from.value = shownTo.value;
			to.value = was;
			picked.value = true;
			side.value = "to";

			if (verdicts.value.get(to.value)?.route) {
				apply();
			}
		};

		const turnOff = () => {
			emit("off");
			close();
		};

		// A new side starts from the top of the whole list.
		watch(side, () => {
			query.value = "";
		});

		const narrowQuery =
			typeof window !== "undefined" && typeof window.matchMedia === "function"
				? window.matchMedia(NARROW)
				: null;
		const narrow = ref(narrowQuery ? narrowQuery.matches : false);
		const onNarrow = (event: MediaQueryListEvent) => {
			narrow.value = event.matches;
		};

		// A touch-primary device, or a window as narrow as the phone layout:
		// the same markup becomes a sheet along the chat pane's bottom edge.
		const phone = computed(() => hasVirtualKeyboard() || narrow.value);
		const style = ref<Record<string, string>>({});

		const reposition = () => {
			const el = root.value;
			const anchor = props.anchor;

			if (!el) {
				return;
			}

			if (phone.value) {
				// Docked to the chat pane, not the screen: on a tablet the
				// sidebar beside the chat stays clear of it.
				const pane = document.getElementById("chat")?.getBoundingClientRect();
				style.value = pane
					? {
							left: `${Math.round(Math.max(0, pane.left))}px`,
							right: `${Math.round(Math.max(0, window.innerWidth - pane.right))}px`,
					  }
					: {};
				return;
			}

			if (!anchor) {
				return;
			}

			// Over the button, which sits at the bottom of the screen; under
			// it only where there is more room there.
			const rect = anchor.getBoundingClientRect();
			const vh = window.innerHeight;
			const vw = window.innerWidth;
			const width = el.offsetWidth;
			const above = rect.top - GAP - EDGE;
			const below = vh - rect.bottom - GAP - EDGE;
			const flip = above >= below;
			// Its inline end at the button's: the button is at the
			// composer's end, so the sheet opens back over the composer.
			const rtl = getComputedStyle(el).direction === "rtl";
			const left = Math.min(
				Math.max(rtl ? rect.left : rect.right - width, EDGE),
				Math.max(EDGE, vw - width - EDGE)
			);

			style.value = {
				left: `${Math.round(left)}px`,
				maxHeight: `min(32rem, ${Math.round(Math.max(flip ? above : below, 0))}px)`,
				...(flip
					? {bottom: `${Math.round(vh - rect.top + GAP)}px`}
					: {top: `${Math.round(rect.bottom + GAP)}px`}),
			};
		};

		// The sidebar opening (a swipe, the menu button) is somewhere else to
		// be: the sheet would otherwise stay over it.
		watch(
			() => store.state.sidebarOpen,
			(open) => {
				if (open) {
					close();
				}
			}
		);

		// Outside the sheet closes it; the button it hangs off is left to
		// its own click, which toggles it.
		const onDocumentMouseDown = (event: MouseEvent) => {
			const target = event.target as Node;

			if (root.value && !root.value.contains(target) && !props.anchor?.contains(target)) {
				close();
			}
		};

		onMounted(() => {
			// Capture: the Mac app's window-drag script (Tauri's drag region,
			// helpers/shell.ts macDragRegion) stops a press on the header from
			// bubbling, and that press must still close the picker.
			document.addEventListener("mousedown", onDocumentMouseDown, true);
			window.addEventListener("resize", reposition);
			narrowQuery?.addEventListener("change", onNarrow);

			void nextTick(() => {
				reposition();

				// The search takes the keyboard on a desktop. Never on a touch
				// screen: the keyboard would come up over the list unasked.
				if (hasVirtualKeyboard()) {
					root.value?.focus({preventScroll: true});
				} else {
					search.value?.focus({preventScroll: true});
				}

				root.value
					?.querySelector(".language-sheet-row[aria-current='true'], .pending")
					?.scrollIntoView({block: "nearest"});
			});
		});

		onBeforeUnmount(() => {
			document.removeEventListener("mousedown", onDocumentMouseDown, true);
			window.removeEventListener("resize", reposition);
			narrowQuery?.removeEventListener("change", onNarrow);

			if (root.value?.contains(document.activeElement)) {
				props.anchor?.focus();
			}
		});

		return {
			t,
			root,
			search,
			name,
			side,
			from,
			to,
			shownTo,
			query,
			once,
			reading,
			readBlocked,
			readingLanguage,
			toggleReading,
			current,
			sideLabel,
			recent,
			rows,
			usable,
			unusable,
			blockedLead,
			blockedWhy,
			phone,
			style,
			close,
			choose,
			chooseFirst,
			swap,
			turnOff,
		};
	},
});
</script>
