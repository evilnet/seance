<template>
	<Teleport to="body">
		<div
			:id="uid"
			ref="root"
			class="reaction-picker"
			data-escape-close
			:class="{sheet, flipped}"
			:style="style"
			role="dialog"
			aria-label="Add a reaction"
			@keydown.esc.stop.prevent="$emit('close')"
		>
			<div class="reaction-picker-search">
				<input
					ref="input"
					v-model="query"
					type="text"
					class="reaction-picker-input"
					:maxlength="MAX_REACTION_LENGTH * 2"
					placeholder="Search emoji, or type any reaction"
					aria-label="Search emoji, or type any reaction"
					role="combobox"
					aria-expanded="true"
					aria-autocomplete="list"
					:aria-controls="`${uid}-list`"
					:aria-activedescendant="active ? `${uid}-opt-${active.index}` : undefined"
					autocomplete="off"
					autocapitalize="off"
					spellcheck="false"
					@keydown="onKeydown"
				/>
				<button
					v-if="query"
					type="button"
					class="reaction-picker-clear"
					aria-label="Clear search"
					title="Clear search"
					@mousedown.prevent
					@click="clear"
				>
					✕
				</button>
			</div>

			<div class="reaction-picker-tabs" role="tablist" aria-label="Emoji groups">
				<button
					v-for="tab in tabs"
					:key="tab.key"
					type="button"
					class="reaction-picker-tab"
					:class="{active: tab.key === currentTab}"
					role="tab"
					:aria-selected="tab.key === currentTab"
					:aria-label="tab.label"
					:title="tab.label"
					@mousedown.prevent
					@click="goToSection(tab.key)"
				>
					{{ tab.icon }}
				</button>
			</div>

			<div
				:id="`${uid}-list`"
				ref="list"
				class="reaction-picker-list"
				role="listbox"
				aria-label="Emoji"
				@scroll.passive="onScroll"
				@mousedown.prevent
				@click="onListClick"
				@mouseover="onListHover"
				@mouseleave="onListLeave"
			>
				<p v-if="failed" class="reaction-picker-note">
					The emoji list could not be loaded. You can still type a reaction above.
				</p>
				<section
					v-for="section in sections"
					:key="section.key"
					class="reaction-picker-section"
					:data-key="section.key"
					role="group"
					:aria-label="section.label"
				>
					<h2 class="reaction-picker-heading" aria-hidden="true">{{ section.label }}</h2>
					<div
						v-if="section.options.length === 0"
						class="reaction-picker-grid reaction-picker-placeholder"
						role="presentation"
						:style="{'--rows': Math.ceil(section.count / columns)}"
					/>
					<div v-else class="reaction-picker-grid" role="presentation">
						<button
							v-for="option in section.options"
							:id="`${uid}-opt-${option.index}`"
							:key="option.index"
							type="button"
							class="reaction-picker-option"
							:class="{
								active: option.index === activeIndex,
								selected: isSelected(option),
								word: !option.emoji,
								free: option.free,
							}"
							role="option"
							tabindex="-1"
							:aria-selected="option.index === activeIndex"
							:aria-label="option.spoken"
							:data-index="option.index"
						>
							<span v-if="option.free" class="reaction-picker-free-label"
								>React with</span
							>{{ option.label }}
						</button>
					</div>
				</section>
				<p v-if="!failed && !catalog" class="reaction-picker-note">Loading emoji…</p>
			</div>

			<div class="reaction-picker-preview">
				<template v-if="active">
					<span class="reaction-picker-preview-emoji" :class="{word: !active.emoji}">{{
						active.label
					}}</span>
					<span class="reaction-picker-preview-text">
						<span class="reaction-picker-preview-name">{{ active.name }}</span>
						<span v-if="active.description" class="reaction-picker-preview-desc">{{
							active.description
						}}</span>
					</span>
					<span class="reaction-picker-preview-hint">{{ hint }}</span>
				</template>
				<!-- Nothing highlighted, but something is being built: the bar is
				     where you see it and where you send it from. -->
				<template v-else-if="building">
					<span class="reaction-picker-preview-emoji">{{ building }}</span>
					<span class="reaction-picker-preview-text">
						<span class="reaction-picker-preview-name">Building a reaction</span>
						<span class="reaction-picker-preview-desc"
							>Shift-click to add more emoji</span
						>
					</span>
					<button
						type="button"
						class="reaction-picker-send"
						@mousedown.prevent
						@click="pickTyped"
					>
						Send
					</button>
				</template>
				<span v-else class="reaction-picker-preview-hint"
					>Pick an emoji, type a word, or shift-click to combine several.</span
				>
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
	reactive,
	ref,
	watch,
} from "vue";
import eventbus from "../js/eventbus";
import {
	appendReaction,
	EmojiEntry,
	emojiForName,
	EmojiGroup,
	flatten,
	isEmojiOnly,
	loadEmojiCatalog,
	MAX_REACTION_LENGTH,
	normalizeReaction,
	searchEmoji,
} from "../js/helpers/emoji";
import {DEFAULT_REACTIONS, recentReactions} from "../js/helpers/reactionRecents";
import {settle, visibleHeight} from "../js/helpers/viewport";

/** One thing the list offers: an emoji, a remembered reaction, or typed text. */
type Option = {
	/** Position in the flattened list — what the keyboard walks and ARIA names. */
	index: number;
	/** What gets sent. */
	text: string;
	/** What the button shows (the same as `text`, except for the free-text pill). */
	label: string;
	title: string;
	/** `:shortcode:` or the reaction itself, for the preview line. */
	name: string;
	description: string;
	/** What a screen reader says: the glyph alone would tell nobody anything. */
	spoken: string;
	/** Emoji render big and square; words render as a pill. */
	emoji: boolean;
	/** The "React with <what you typed>" row. */
	free?: boolean;
};

/**
 * One group of the list. `start`/`count` place it in the flat index space
 * the keyboard walks; `options` is built only for a rendered group (the
 * rest are placeholders, see `rendered`), so it is empty for the others.
 */
type Section = {key: string; label: string; start: number; count: number; options: Option[]};

/** Gap between the anchor and the popover, and the margin it keeps off screen edges. */
const GAP = 6;
const EDGE = 8;
/** How tall the popover gets, and how little space is still worth opening into. */
const MAX_HEIGHT = 360;
const MIN_HEIGHT = 180;
/** Options considered when an arrow key looks for the row above or below. */
const NEIGHBOURHOOD = 40;
/** How far below the fold, in px, a group is rendered ahead of the scroll reaching it. */
const RENDER_AHEAD = 320;
/** Columns of the popover's grid before one has been counted (21.25rem wide, 2.25rem cells). */
const DEFAULT_COLUMNS = 8;

// Unique per open picker, so ARIA ids never collide with a closing one.
let instances = 0;

/**
 * Announced by a picker as it opens, carrying its uid. Openers stop the
 * mousedown that would otherwise reach the document (so their own button
 * toggles), which is the very event the outside-click handler waits for — so
 * without this, opening a second picker would leave the first one on screen.
 */
const PICKER_OPENED = "reaction-picker-opened";

export default defineComponent({
	name: "ReactionPicker",
	props: {
		/** The button the popover hangs off; positioning follows it as you scroll. */
		anchor: {type: Object as PropType<HTMLElement | null>, default: null},
		/** Reactions the user already has on this message: shown ticked, picking removes. */
		selected: {type: Array as PropType<string[]>, default: () => []},
	},
	emits: ["pick", "close"],
	setup(props, {emit}) {
		const uid = `reaction-picker-${++instances}`;
		const root = ref<HTMLDivElement | null>(null);
		const input = ref<HTMLInputElement | null>(null);
		const list = ref<HTMLDivElement | null>(null);

		const query = ref("");
		const catalog = ref<EmojiGroup[] | null>(null);
		const failed = ref(false);
		const recent = ref<string[]>(recentReactions());
		const activeIndex = ref(-1);
		const currentTab = ref("recent");

		loadEmojiCatalog()
			.then((groups) => {
				catalog.value = groups;
			})
			.catch(() => {
				failed.value = true;
			});

		const entryOption = (entry: EmojiEntry): Omit<Option, "index"> => ({
			text: entry.emoji,
			label: entry.emoji,
			title: `:${entry.name}: ${entry.description}`,
			name: `:${entry.name}:`,
			description: entry.description,
			spoken: entry.description,
			emoji: true,
		});

		/** Every emoji by its character, so a remembered one can be named. */
		const byChar = computed(() => {
			const map = new Map<string, EmojiEntry>();

			for (const entry of flatten(catalog.value ?? [])) {
				map.set(entry.emoji, entry);
			}

			return map;
		});

		// A remembered reaction is whatever was sent, so it may well be a word
		// — or several emoji, which no shortcode names. One the catalog knows
		// is described from the catalog, so the preview line reads the same
		// wherever the emoji was picked from.
		const textOption = (text: string): Omit<Option, "index"> => {
			const known = byChar.value.get(text);

			if (known) {
				return entryOption(known);
			}

			const emoji = isEmojiOnly(text);

			return {
				text,
				label: text,
				title: text,
				name: text,
				description: emoji ? "" : "sent as text",
				spoken: text,
				emoji,
			};
		};

		/** The "React with …" row: what is typed, offered as it stands. */
		const freeOption = (text: string): Omit<Option, "index"> => ({
			text,
			label: text,
			title: `React with ${text}`,
			name: text,
			description: "sent as text",
			spoken: `React with ${text}`,
			emoji: isEmojiOnly(text),
			free: true,
		});

		/**
		 * Something typed that is only emoji is a reaction being built, not a
		 * search: shift-clicking appends to it, so replacing the grid with
		 * results for what was just added would take away the very thing being
		 * clicked. The field shows what it is; the preview bar sends it.
		 */
		const composing = computed(() => {
			const typed = query.value.trim();

			return typed.length > 0 && isEmojiOnly(typed);
		});

		/**
		 * Which groups have their buttons in the DOM. The catalog is ~1900
		 * emoji, and a button each took the open past 100 ms on a throttled
		 * CPU — and on Android every glyph in the DOM is rasterised whether
		 * or not it is on screen. So a group is a sized placeholder until the
		 * scroll comes near it (or its tab, or the keyboard, asks for it),
		 * and from then on it stays rendered. The first two sections — the
		 * recents and the first group, or the search results — are always
		 * rendered; that is what the picker opens on.
		 */
		const rendered = reactive(new Set<string>());
		const render = (key: string) => void rendered.add(key);

		const sections = computed<Section[]>(() => {
			const firstGroup = catalog.value?.[0]?.key;
			let start = 0;

			const section = (
				key: string,
				label: string,
				count: number,
				build: () => Omit<Option, "index">[]
			): Section => {
				const at = start;
				start += count;
				const options =
					at === 0 || key === firstGroup || rendered.has(key)
						? build().map((option, i) => ({...option, index: at + i}))
						: [];

				return {key, label, start: at, count, options};
			};

			const typed = query.value.trim();

			if (typed && !composing.value) {
				const hits = catalog.value ? searchEmoji(catalog.value, typed) : [];
				const options = hits.map(entryOption);
				const free = normalizeReaction(typed);

				// Anything typed can be sent as it stands — that is what makes
				// "lol" and "🎉🎉🎉" reachable without an emoji keyboard. The
				// row is dropped when it would only repeat the first hit.
				//
				// Where it goes decides what Enter does, since the first option
				// is the one highlighted: an exact alias is an emoji somebody
				// is naming (`tada` → 🎉), anything else is words until they
				// say otherwise, or `lol` would react with 🍭 lollipop.
				if (free && !hits.some((hit) => hit.emoji === free)) {
					const row = freeOption(free);

					if (emojiForName(typed)) {
						options.push(row);
					} else {
						options.unshift(row);
					}
				}

				return [
					section(
						"results",
						hits.length > 0 ? "Search results" : "No emoji match",
						options.length,
						() => options
					),
				];
			}

			const known = recent.value.length > 0 ? recent.value : DEFAULT_REACTIONS;
			const out: Section[] = [
				section(
					"recent",
					recent.value.length > 0 ? "Recently used" : "Quick reactions",
					known.length,
					() => known.map(textOption)
				),
			];

			for (const group of catalog.value ?? []) {
				out.push(
					section(group.key, group.label, group.emoji.length, () =>
						group.emoji.map(entryOption)
					)
				);
			}

			return out;
		});

		const tabs = computed(() => [
			{
				key: "recent",
				label: recent.value.length > 0 ? "Recently used" : "Quick reactions",
				icon: "🕘",
			},
			...(catalog.value ?? []).map((group) => ({
				key: group.key,
				label: group.label,
				icon: group.icon,
			})),
		]);

		/** How many options there are in all, rendered or not: the keyboard's bound. */
		const total = computed(() => {
			const last = sections.value[sections.value.length - 1];

			return last ? last.start + last.count : 0;
		});

		/** The section an option index belongs to. */
		const sectionOf = (index: number) =>
			sections.value.find((s) => index >= s.start && index < s.start + s.count);

		/** The option at a flat index — undefined past the end or in a placeholder. */
		const optionAt = (index: number) => {
			const s = sectionOf(index);

			return s?.options[index - s.start];
		};

		/**
		 * Columns of the grid, counted off the first row of a rendered group,
		 * so a placeholder's row count (its height is `--rows` × the cell
		 * pitch, in style.css) is right at any width. Cells are uniform in a
		 * catalog group, which is why the recents row is skipped.
		 */
		const columns = ref(DEFAULT_COLUMNS);

		const countColumns = () => {
			const cells = list.value?.querySelectorAll<HTMLElement>(
				`[data-key="${catalog.value?.[0]?.key ?? ""}"] .reaction-picker-option`
			);
			const first = cells?.[0];

			if (!first) {
				return;
			}

			let n = 0;

			for (const cell of cells) {
				if (cell.offsetTop !== first.offsetTop) {
					break;
				}

				n++;
			}

			columns.value = n;
		};

		/** Render every group whose placeholder is within reach of the scroll. */
		const renderNear = () => {
			const container = list.value;

			if (!container) {
				return;
			}

			const reach = container.scrollTop + container.clientHeight + RENDER_AHEAD;

			for (const el of container.querySelectorAll<HTMLElement>("[data-key]")) {
				if (el.offsetTop < reach) {
					render(el.dataset.key ?? "");
				}
			}
		};

		const active = computed<Option | undefined>(() => optionAt(activeIndex.value));
		const isSelected = (option: Option) => props.selected.includes(option.text);

		/** The reaction being built, shown by the preview bar while it is. */
		const building = computed(() => (composing.value ? query.value.trim() : ""));

		// The one line that says what would happen to the highlighted option.
		const hint = computed(() => {
			if (!active.value) {
				return "";
			}

			if (isSelected(active.value)) {
				return "Remove";
			}

			return active.value.free ? "Enter to send" : "⇧ to combine";
		});

		const pick = (text: string) => {
			const normalized = normalizeReaction(text);

			if (!normalized) {
				return;
			}

			emit("pick", normalized);
			emit("close");
		};

		/**
		 * Add `text` to what is being built instead of sending it — the
		 * shift-click. The field is the composition, so it goes there and
		 * keeps the caret at the end; the grid stays put (see `composing`).
		 * The "React with …" row is the send button, so it never appends.
		 */
		const append = (option: Option) => {
			if (option.free) {
				pick(option.text);
				return;
			}

			const next = appendReaction(query.value, option.text);

			if (next === query.value) {
				return; // it would not fit: leave what is there alone
			}

			query.value = next;

			void nextTick(() => {
				const field = input.value;

				field?.focus();
				field?.setSelectionRange(next.length, next.length);
			});
		};

		const scrollActiveIntoView = () => {
			const el = list.value?.querySelector<HTMLElement>(
				`[data-index="${activeIndex.value}"]`
			);
			el?.scrollIntoView({block: "nearest"});
		};

		const setActive = (index: number) => {
			if (index < 0 || index >= total.value) {
				return;
			}

			// The keyboard can land in a group that is still a placeholder.
			const section = sectionOf(index);

			if (section) {
				render(section.key);
			}

			activeIndex.value = index;
			void nextTick(scrollActiveIntoView);
		};

		/**
		 * The option a row up or down from the active one, found by geometry
		 * rather than by counting columns: sections wrap freely and a
		 * remembered word is wider than an emoji, so there is no column count
		 * to count with. Only the options near the active one are measured.
		 */
		const rowNeighbour = (down: boolean) => {
			const container = list.value;
			const from = container?.querySelector<HTMLElement>(
				`[data-index="${activeIndex.value}"]`
			);

			if (!container || !from) {
				return down ? 0 : -1;
			}

			const origin = from.getBoundingClientRect();
			const centre = origin.left + origin.width / 2;
			let best: {index: number; top: number; distance: number} | undefined;

			for (
				let i = Math.max(0, activeIndex.value - NEIGHBOURHOOD);
				i <= Math.min(total.value - 1, activeIndex.value + NEIGHBOURHOOD);
				i++
			) {
				if (i === activeIndex.value) {
					continue;
				}

				const el = container.querySelector<HTMLElement>(`[data-index="${i}"]`);

				if (!el) {
					continue;
				}

				const rect = el.getBoundingClientRect();

				// Same visual row: not a candidate for a vertical move.
				if (Math.abs(rect.top - origin.top) < 2) {
					continue;
				}

				if (down ? rect.top < origin.top : rect.top > origin.top) {
					continue;
				}

				const distance = Math.abs(rect.left + rect.width / 2 - centre);

				if (
					!best ||
					(down ? rect.top < best.top : rect.top > best.top) ||
					(rect.top === best.top && distance < best.distance)
				) {
					best = {index: i, top: rect.top, distance};
				}
			}

			return best ? best.index : activeIndex.value;
		};

		const onKeydown = (e: KeyboardEvent) => {
			const el = e.target as HTMLInputElement;
			const caret = el.selectionStart ?? 0;
			const collapsed = caret === (el.selectionEnd ?? 0);

			switch (e.key) {
				case "ArrowDown": {
					e.preventDefault();

					if (activeIndex.value < 0) {
						setActive(0);
						break;
					}

					// Nothing rendered below: the next group's first cell, which
					// is where the eye goes anyway (indices run on across groups;
					// past the last one, setActive declines).
					const below = rowNeighbour(true);
					const here = sectionOf(activeIndex.value);
					setActive(
						below === activeIndex.value && here ? here.start + here.count : below
					);
					break;
				}

				case "ArrowUp":
					e.preventDefault();

					if (activeIndex.value >= 0) {
						setActive(rowNeighbour(false));
					}

					break;

				// Left and right walk the grid, but only once the caret has
				// nowhere left to go — editing what you typed comes first.
				case "ArrowRight":
					if (
						collapsed &&
						caret === el.value.length &&
						activeIndex.value + 1 < total.value
					) {
						e.preventDefault();
						setActive(activeIndex.value + 1);
					}

					break;

				case "ArrowLeft":
					if (collapsed && caret === 0 && activeIndex.value > 0) {
						e.preventDefault();
						setActive(activeIndex.value - 1);
					}

					break;

				case "Enter":
					e.preventDefault();

					if (active.value && e.shiftKey) {
						append(active.value);
					} else if (active.value) {
						pick(active.value.text);
					} else if (query.value.trim()) {
						pick(query.value);
					}

					break;

				default:
					break;
			}
		};

		const onListClick = (e: MouseEvent) => {
			const el = (e.target as HTMLElement).closest<HTMLElement>("[data-index]");
			const option = el ? optionAt(Number(el.dataset.index)) : undefined;

			if (!option) {
				return;
			}

			if (e.shiftKey) {
				append(option);
			} else {
				pick(option.text);
			}
		};

		const onListHover = (e: MouseEvent) => {
			// While a reaction is being built the preview bar is showing it,
			// and Enter has to keep meaning "send that" — otherwise passing the
			// pointer over an emoji would quietly rewrite what Enter does.
			// `:hover` still lights the cell, and arrow keys still move the
			// highlight, because both of those are asked for.
			if (composing.value) {
				return;
			}

			const el = (e.target as HTMLElement).closest<HTMLElement>("[data-index]");

			if (el) {
				activeIndex.value = Number(el.dataset.index);
			}
		};

		/**
		 * Nothing under the pointer, nothing highlighted: Enter goes back to
		 * meaning the search's best guess, or the reaction being built, rather
		 * than whichever emoji the pointer happened to leave behind.
		 */
		const defaultActive = () => (query.value.trim() && !composing.value ? 0 : -1);

		const onListLeave = () => {
			activeIndex.value = defaultActive();
		};

		/** Send what is in the field as it stands (the Send button). */
		const pickTyped = () => pick(query.value);

		const clear = () => {
			query.value = "";
			input.value?.focus();
		};

		const goToSection = (key: string) => {
			query.value = "";
			render(key);

			void nextTick(() => {
				const container = list.value;
				const section = container?.querySelector<HTMLElement>(`[data-key="${key}"]`);

				if (container && section) {
					container.scrollTop = section.offsetTop;
					currentTab.value = key;
				}
			});
		};

		// Which group the list is showing, for the tab bar.
		const onScroll = () => {
			const container = list.value;

			if (!container) {
				return;
			}

			let key = sections.value[0]?.key ?? "recent";

			for (const section of container.querySelectorAll<HTMLElement>("[data-key]")) {
				if (section.offsetTop - container.scrollTop > 12) {
					break;
				}

				key = section.dataset.key ?? key;
			}

			currentTab.value = key;
			renderNear();
		};

		// A phone gets the sheet at the bottom of the screen; there is no room
		// for a popover once the on-screen keyboard is up. Sideways too: the
		// second clause is the landscape-phone half of `PHONE_LAYOUT_QUERY`
		// (helpers/device.ts) — a touch device under 500px tall with the
		// keyboard up keeps ~190px, and a 21rem popover there showed one row.
		const sheetQuery = window.matchMedia(
			"(max-width: 479px), (max-height: 500px) and (hover: none) and (pointer: coarse)"
		);
		const sheet = ref(sheetQuery.matches);

		const onSheetChange = (e: MediaQueryListEvent) => {
			sheet.value = e.matches;
		};

		const style = ref<Record<string, string>>({});
		const flipped = ref(false);

		/**
		 * Pin the popover under (or, with no room, over) the anchor. It is
		 * `position: fixed` and teleported to the body so the scrollback
		 * cannot clip it, which means following the anchor by hand: on scroll,
		 * on resize, and once the catalog has changed the height. Flipping
		 * anchors the bottom edge instead of the top, so a taller popover
		 * still lines up without measuring it.
		 */
		const reposition = () => {
			const el = root.value;
			const anchor = props.anchor;

			if (!el || !anchor) {
				return;
			}

			if (sheet.value) {
				style.value = {};
				flipped.value = false;
				return;
			}

			const rect = anchor.getBoundingClientRect();
			// Room is measured against the visible band, not `innerHeight`: on
			// iOS the keyboard covers the bottom of the layout viewport without
			// shrinking it. Offsets stay in layout-viewport terms, which is
			// what `position: fixed` resolves `top` and `bottom` against.
			const vh = visibleHeight();
			const vw = window.innerWidth;

			// Scrolled past the message the picker belongs to: close rather
			// than float over an unrelated part of the conversation. Against
			// the layout viewport on purpose — an anchor under the keyboard
			// is covered, not scrolled away.
			if (rect.bottom < 0 || rect.top > window.innerHeight) {
				emit("close");
				return;
			}

			const below = vh - rect.bottom - GAP - EDGE;
			const above = rect.top - GAP - EDGE;
			const flip = below < MAX_HEIGHT && above > below;
			const room = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, flip ? above : below));
			const width = el.offsetWidth;
			const left = Math.min(
				Math.max(rect.right - width, EDGE),
				Math.max(EDGE, vw - width - EDGE)
			);

			flipped.value = flip;
			style.value = {
				left: `${Math.round(left)}px`,
				"max-height": `${Math.round(room)}px`,
				...(flip
					? {bottom: `${Math.round(window.innerHeight - rect.top + GAP)}px`}
					: {top: `${Math.round(rect.bottom + GAP)}px`}),
			};
		};

		// The list has a new shape: place the popover, count the grid's
		// columns and render the groups in reach. On mount, when the catalog
		// lands, and whenever the width may have changed.
		const layoutChanged = () => {
			reposition();
			countColumns();
			renderNear();
		};

		// The visual viewport's resize that announces the keyboard carries a
		// mid-animation height (helpers/viewport.ts), so it is re-read.
		let cancelSettle = () => {};

		const repositionSettled = () => {
			cancelSettle();
			cancelSettle = settle(layoutChanged);
		};

		const close = () => emit("close");

		// Bubble-phase so the opener can `@mousedown.stop` and toggle instead.
		const onDocumentMouseDown = (e: MouseEvent) => {
			if (root.value && !root.value.contains(e.target as Node)) {
				close();
			}
		};

		watch(query, (next, previous) => {
			// Searching, there is always a best guess to highlight; browsing or
			// building, nothing is until the pointer or a key says so.
			activeIndex.value = defaultActive();

			if (composing.value) {
				return; // an append must not move the grid out from under the pointer
			}

			currentTab.value = next.trim() ? "results" : "recent";

			if (list.value && previous.trim() !== next.trim()) {
				list.value.scrollTop = 0;
			}

			// A cleared search puts the groups back as placeholders.
			void nextTick(renderNear);
		});

		watch(catalog, () => void nextTick(layoutChanged));

		const onOtherOpened = (other: string) => {
			if (other !== uid) {
				close();
			}
		};

		onMounted(() => {
			eventbus.emit(PICKER_OPENED, uid);
			eventbus.on(PICKER_OPENED, onOtherOpened);
			document.addEventListener("mousedown", onDocumentMouseDown);
			window.addEventListener("scroll", reposition, true);
			window.addEventListener("resize", repositionSettled);
			window.visualViewport?.addEventListener("resize", repositionSettled);
			sheetQuery.addEventListener("change", onSheetChange);
			eventbus.on("escapekey", close);

			void nextTick(layoutChanged);

			// Focusing the field on a touch screen throws up the keyboard over
			// the emoji the user came here to tap.
			if (!window.matchMedia("(pointer: coarse)").matches) {
				input.value?.focus();
			}
		});

		onBeforeUnmount(() => {
			eventbus.off(PICKER_OPENED, onOtherOpened);
			document.removeEventListener("mousedown", onDocumentMouseDown);
			window.removeEventListener("scroll", reposition, true);
			window.removeEventListener("resize", repositionSettled);
			window.visualViewport?.removeEventListener("resize", repositionSettled);
			cancelSettle();
			sheetQuery.removeEventListener("change", onSheetChange);
			eventbus.off("escapekey", close);

			// Give the keyboard back to where it came from.
			if (root.value?.contains(document.activeElement)) {
				props.anchor?.focus();
			}
		});

		return {
			MAX_REACTION_LENGTH,
			uid,
			root,
			input,
			list,
			query,
			catalog,
			failed,
			sections,
			tabs,
			active,
			activeIndex,
			currentTab,
			sheet,
			flipped,
			style,
			building,
			hint,
			isSelected,
			columns,
			pickTyped,
			onKeydown,
			onListClick,
			onListHover,
			onListLeave,
			onScroll,
			goToSection,
			clear,
		};
	},
});
</script>
