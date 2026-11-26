<template>
	<!-- The group pops in when the first reaction lands on a message you are
	     looking at (a Transition without `appear`: nothing on the channel's
	     first draw), and a badge that arrives after that pops in on its own.
	     A badge is keyed on its text alone, so toggling yours on and off
	     never remounts it — it keeps its identity (and a keyboard user's
	     focus) across the toggle. A theme can hang its own flourish on the
	     same enter classes. -->
	<Transition name="reactions">
		<span v-if="badges.length" class="msg-reactions" role="group" :aria-label="groupAria">
			<TransitionGroup name="reaction" tag="span" class="msg-reactions-list">
				<button
					v-for="badge in badges"
					:key="badge.text"
					type="button"
					class="msg-reaction"
					:class="{self: badge.self, word: !badge.emoji}"
					:disabled="!canToggle"
					:aria-pressed="badge.self"
					:aria-label="badge.label"
					@pointerenter="showTip($event, badge.text)"
					@pointerdown="showTip($event, badge.text)"
					@pointerleave="leaveTip"
					@focus="showTip($event, badge.text)"
					@blur="hideTip"
					@click="toggle(badge)"
				>
					<span class="msg-reaction-text">{{ badge.text }}</span
					><span v-if="badge.nicks.length > 1" class="msg-reaction-count">{{
						badge.nicks.length
					}}</span>
				</button>
			</TransitionGroup>
			<button
				v-if="canToggle"
				ref="addButton"
				type="button"
				class="msg-reaction msg-reaction-add"
				:aria-label="addAria"
				:aria-expanded="pickerOpen"
				@pointerenter="showTip($event, ADD)"
				@pointerleave="leaveTip"
				@focus="showTip($event, ADD)"
				@blur="hideTip"
				@mouseenter="preloadEmoji"
				@mousedown.stop
				@click="pickerOpen = !pickerOpen"
			>
				<span aria-hidden="true">+</span>
			</button>
			<ReactionPicker
				v-if="pickerOpen"
				:anchor="addButton"
				:selected="mine"
				@pick="pick"
				@close="pickerOpen = false"
			/>
		</span>
	</Transition>
	<!-- Who reacted, on <body>: inside the message the row cut it
	     (`#chat .content` clips) and the scroller, often to a sliver of its
	     last line (helpers/tipPlacement.ts). The button's aria-label already
	     says it all, so this is for the eye only. -->
	<Teleport to="body">
		<div
			v-if="tipText"
			ref="tipEl"
			class="reaction-tip"
			:class="{below: !tipPlace.above, 'no-pointer': !tipPlace.pointer}"
			:style="{
				left: `${tipPlace.left}px`,
				top: `${tipPlace.top}px`,
				'--tip-arrow': `${tipPlace.arrow}px`,
			}"
			aria-hidden="true"
		>
			<div class="reaction-tip-text">{{ tipText }}</div>
		</div>
	</Teleport>
</template>

<script lang="ts">
import {computed, defineComponent, nextTick, onBeforeUnmount, PropType, ref, watch} from "vue";
import socket from "../js/socket";
import {useI18n} from "../js/i18n";
import {isEmojiOnly, loadEmojiCatalog} from "../js/helpers/emoji";
import {tipPlacement, TipPlacement} from "../js/helpers/tipPlacement";
import {myReactions} from "../js/helpers/messageUpdates";
import {rememberReaction} from "../js/helpers/reactionRecents";
import type {ClientChan, ClientMessage, ClientNetwork} from "../js/types";
import ReactionPicker from "./ReactionPicker.vue";

/** The add button's key in the tip, beside the badges' (their text). */
const ADD = "\u0000add";

/** More than one character as a reader sees them (a flag or a family is one). */
function graphemes(text: string): number {
	if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
		return [...new Intl.Segmenter(undefined, {granularity: "grapheme"}).segment(text)].length;
	}

	return [...text].length;
}

type Badge = {
	text: string;
	nicks: string[];
	self: boolean;
	label: string;
	title: string;
	/** Emoji get the roomier badge; a word reaction is set as text. */
	emoji: boolean;
};

export default defineComponent({
	name: "MessageReactions",
	components: {ReactionPicker},
	props: {
		message: {type: Object as PropType<ClientMessage>, required: true},
		channel: {type: Object as PropType<ClientChan>, required: false},
		network: {type: Object as PropType<ClientNetwork>, required: true},
	},
	setup(props) {
		const {t} = useI18n();
		const groupAria = computed(() => t("reactions.groupAria"));
		const addAria = computed(() => t("reactions.add"));
		const pickerOpen = ref(false);
		const addButton = ref<HTMLButtonElement | null>(null);

		const badges = computed<Badge[]>(() => {
			const me = (props.network.nick || "").toLowerCase();

			return (props.message.reactions ?? []).map((r) => {
				const self = r.nicks.some((n) => n.toLowerCase() === me);
				const who = r.nicks.join(", ");
				const emoji = isEmojiOnly(r.text);

				return {
					text: r.text,
					nicks: r.nicks,
					self,
					emoji,
					label:
						t("reactions.by", {
							reaction: r.text,
							users: who,
						}) + (self ? t("reactions.clickToRemoveSuffix") : ""),
					// A word reaction, or a run of several emoji, can be cut
					// off by the badge, so the tip carries it in full next to
					// who sent it; a single emoji is plain in its badge.
					title: emoji && graphemes(r.text) === 1 ? who : `${r.text} — ${who}`,
				};
			});
		});

		const canToggle = computed(
			() => !!props.channel && !!props.message.msgid && props.network.status.connected
		);

		const mine = computed(() => myReactions(props.message, props.network.nick || ""));

		const send = (text: string, remove: boolean) => {
			if (!canToggle.value || !props.channel || !props.message.msgid) {
				return;
			}

			if (!remove) {
				rememberReaction(text);
			}

			socket.emit("msg:react", {
				target: props.channel.id,
				msgid: props.message.msgid,
				text,
				remove,
			});
		};

		const toggle = (badge: Badge) => send(badge.text, badge.self);
		const pick = (text: string) => send(text, mine.value.includes(text));

		// Fetch the catalog chunk while the pointer is on its way to the
		// button, so the grid is there the moment the picker opens.
		const preloadEmoji = () => void loadEmojiCatalog().catch(() => undefined);

		// Close the picker if the message moves out from under it.
		watch(
			() => props.channel?.id,
			() => {
				pickerOpen.value = false;
			}
		);

		// The tip: which button it is for (a badge's text, or ADD) and that
		// button. Its text follows the badge, so a toggle while it is up
		// shows the new list, and it goes when its badge does.
		const tip = ref<{key: string; el: HTMLElement} | null>(null);
		const tipEl = ref<HTMLElement | null>(null);
		const tipPlace = ref<TipPlacement>({left: 0, top: 0, above: true, arrow: 0, pointer: true});
		const tipText = computed(() => {
			if (!tip.value) {
				return "";
			}

			if (tip.value.key === ADD) {
				return addAria.value;
			}

			return badges.value.find((b) => b.text === tip.value?.key)?.title ?? "";
		});

		const place = () => {
			if (!tip.value || !tipEl.value || !tip.value.el.isConnected) {
				return;
			}

			const size = tipEl.value.getBoundingClientRect();
			tipPlace.value = tipPlacement(
				tip.value.el.getBoundingClientRect(),
				{width: size.width, height: size.height},
				{width: window.innerWidth, height: window.innerHeight}
			);
		};

		// Fixed on <body>, it would stay behind as the list scrolls or the
		// window changes: it goes instead, and comes back with the pointer.
		// Its listeners share one signal, aborted when it goes.
		let listening: AbortController | null = null;

		const hideTip = () => {
			tip.value = null;
			listening?.abort();
			listening = null;
		};

		// A press anywhere else takes it away: a finger's tip would otherwise
		// wait for the badge's blur, and Safari never focuses a tapped button.
		const pressElsewhere = (event: Event) => {
			if (tip.value && !tip.value.el.contains(event.target as Node | null)) {
				hideTip();
			}
		};

		const showTip = (event: Event, key: string) => {
			const el = event.currentTarget as HTMLElement | null;

			if (!el) {
				return;
			}

			// A finger's press shows it; a finger's hover (what the press
			// fakes afterwards) is not a pointer's, so only a real one counts.
			if (event.type === "pointerenter" && (event as PointerEvent).pointerType === "touch") {
				return;
			}

			if (event.type === "pointerdown" && (event as PointerEvent).pointerType !== "touch") {
				return;
			}

			tip.value = {key, el};
			listening?.abort();
			listening = new AbortController();
			const {signal} = listening;
			window.addEventListener("scroll", hideTip, {capture: true, passive: true, signal});
			window.addEventListener("resize", hideTip, {passive: true, signal});
			document.addEventListener("pointerdown", pressElsewhere, {capture: true, signal});
			void nextTick(place);
		};

		// A pointer leaving takes it away; a finger's tip stays until the
		// next scroll, or the badge loses focus.
		const leaveTip = (event: PointerEvent) => {
			if (event.pointerType !== "touch") {
				hideTip();
			}
		};

		// Placed again whenever its text changes size.
		watch(tipText, (text) => {
			if (!text) {
				hideTip();
				return;
			}

			void nextTick(place);
		});

		onBeforeUnmount(hideTip);

		return {
			t,
			groupAria,
			addAria,
			badges,
			canToggle,
			mine,
			pickerOpen,
			addButton,
			toggle,
			pick,
			preloadEmoji,
			ADD,
			tipEl,
			tipText,
			tipPlace,
			showTip,
			leaveTip,
			hideTip,
		};
	},
});
</script>
