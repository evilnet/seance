<template>
	<!-- The group pops in when the first reaction lands on a message you are
	     looking at (a Transition without `appear`: nothing on the channel's
	     first draw), and a badge that arrives after that pops in on its own.
	     A badge is keyed on its text alone, so toggling yours on and off
	     never remounts it — it keeps its identity (and a keyboard user's
	     focus) across the toggle. A theme can hang its own flourish on the
	     same enter classes, or on `data-arrived`, which only a reaction
	     arriving live sets (liveRows.ts). -->
	<Transition name="reactions">
		<span v-if="badges.length" class="msg-reactions" role="group" :aria-label="groupAria">
			<TransitionGroup name="reaction" tag="span" class="msg-reactions-list">
				<button
					v-for="badge in badges"
					:key="badge.text"
					type="button"
					class="msg-reaction tooltipped tooltipped-n"
					:class="{self: badge.self, word: !badge.emoji}"
					:data-arrived="arrived[badge.text]"
					:disabled="!canToggle"
					:aria-pressed="badge.self"
					:aria-label="badge.label"
					:data-tooltip="badge.title"
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
				class="msg-reaction msg-reaction-add tooltipped tooltipped-n"
				:aria-label="addAria"
				:data-tooltip="addAria"
				:aria-expanded="pickerOpen"
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
</template>

<script lang="ts">
import {computed, defineComponent, onBeforeUnmount, PropType, reactive, ref, watch} from "vue";
import socket from "../js/socket";
import {useI18n} from "../js/i18n";
import {isEmojiOnly, loadEmojiCatalog} from "../js/helpers/emoji";
import {myReactions} from "../js/helpers/messageUpdates";
import {rememberReaction} from "../js/helpers/reactionRecents";
import type {ClientChan, ClientMessage, ClientNetwork} from "../js/types";
import {chipKey, LIVE_HOLD_MS, liveChips, type ArrivalKind} from "../js/liveRows";
import ReactionPicker from "./ReactionPicker.vue";

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
		/** A row of the open conversation's list, whose chips may claim a live note. */
		inChat: Boolean,
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
					// A long word reaction is cut off by the badge, so the
					// tooltip carries it in full next to who sent it.
					title: emoji ? who : `${r.text} — ${who}`,
				};
			});
		});

		// A reaction that arrived live (socket-events/msg_updates.ts notes it):
		// its chip carries `data-arrived` for LIVE_HOLD_MS from when it takes
		// the note, which it does once, so a chip drawn again later (another
		// conversation and back) is not new. Another nick on a chip already
		// shown is noted too, so this looks again whenever the reactions change.
		const arrived = reactive<Record<string, ArrivalKind>>({});
		const arrivedTimers = new Map<string, number>();

		watch(
			() => props.message.reactions,
			(reactions) => {
				if (!props.inChat) {
					return;
				}

				// A chip taken off is gone with its note: put back, it is new.
				for (const text of Object.keys(arrived)) {
					if (!reactions?.some((r) => r.text === text)) {
						window.clearTimeout(arrivedTimers.get(text));
						arrivedTimers.delete(text);
						delete arrived[text];
					}
				}

				for (const {text} of reactions ?? []) {
					const kind = liveChips.take(chipKey(props.message.id, text));

					if (kind) {
						arrived[text] = kind;
						window.clearTimeout(arrivedTimers.get(text));
						arrivedTimers.set(
							text,
							window.setTimeout(() => {
								delete arrived[text];
								arrivedTimers.delete(text);
							}, LIVE_HOLD_MS)
						);
					}
				}
			},
			{immediate: true}
		);

		onBeforeUnmount(() => arrivedTimers.forEach((timer) => window.clearTimeout(timer)));

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

		return {
			t,
			arrived,
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
		};
	},
});
</script>
