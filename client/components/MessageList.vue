<template>
	<div ref="chat" class="chat" :class="{selecting, 'select-text': textSelectMode}" tabindex="-1">
		<div v-show="channel.moreHistoryAvailable" class="show-more">
			<button
				ref="loadMoreButton"
				:disabled="channel.historyLoading || !network.status.connected"
				class="btn"
				@click="onShowMoreClick"
			>
				<span v-if="channel.historyLoading">Loading…</span>
				<span v-else>Show older messages</span>
			</button>
		</div>
		<div
			class="messages"
			role="log"
			aria-live="polite"
			aria-relevant="additions"
			@copy="onCopy"
			@pointerdown="onPointerDown"
		>
			<template v-for="(message, id) in condensedMessages">
				<DateMarker
					v-if="shouldDisplayDateMarker(message, id)"
					:key="message.id + '-date'"
					:message="message as any"
					:focused="message.id === focused"
				/>
				<div
					v-if="shouldDisplayUnreadMarker(message)"
					:key="message.id + '-unread'"
					class="unread-marker"
				>
					<span class="unread-marker-text" />
				</div>

				<MessageCondensed
					v-if="message.type === 'condensed'"
					:key="message.messages[0].id"
					:network="network"
					:keep-scroll-position="keepScrollPosition"
					:messages="message.messages"
					:focused="message.id === focused"
				/>
				<Message
					v-else
					:key="message.id"
					:channel="channel"
					:network="network"
					:message="message"
					:keep-scroll-position="keepScrollPosition"
					:is-previous-source="isPreviousSource(message, id)"
					:focused="message.id === focused"
					@toggle-link-preview="onLinkPreviewToggle"
				/>
			</template>
		</div>
	</div>
</template>

<script lang="ts">
import {condensedTypes} from "../../shared/irc";
import {ChanState, ChanType} from "../../shared/types/chan";
import {MessageType, SharedMsg} from "../../shared/types/msg";
import clipboard from "../js/clipboard";
import {noteScroll, noteTouch} from "../js/helpers/scrollSettle";
import {leaveTextSelect, textSelectMode} from "../js/helpers/textSelect";
import socket from "../js/socket";
import Message from "./Message.vue";
import MessageCondensed from "./MessageCondensed.vue";
import DateMarker from "./DateMarker.vue";
import {
	computed,
	defineComponent,
	nextTick,
	onBeforeUnmount,
	onBeforeUpdate,
	onMounted,
	onUnmounted,
	PropType,
	ref,
	watch,
} from "vue";
import {useStore} from "../js/store";
import {ClientChan, ClientMessage, ClientNetwork, ClientLinkPreview} from "../js/types";

/** A pressed pointer that travels this far is dragging out a selection. */
const DRAG_SLOP_PX = 4;

type CondensedMessageContainer = {
	type: "condensed";
	time: Date;
	messages: ClientMessage[];
	id?: number;
};

// TODO; move into component
let unreadMarkerShown = false;

export default defineComponent({
	name: "MessageList",
	components: {
		Message,
		MessageCondensed,
		DateMarker,
	},
	props: {
		network: {type: Object as PropType<ClientNetwork>, required: true},
		channel: {type: Object as PropType<ClientChan>, required: true},
		focused: Number,
	},
	setup(props) {
		const store = useStore();

		const chat = ref<HTMLDivElement | null>(null);
		const loadMoreButton = ref<HTMLButtonElement | null>(null);
		const historyObserver = ref<IntersectionObserver | null>(null);
		const skipNextScrollEvent = ref(false);

		const isWaitingForNextTick = ref(false);

		/**
		 * Auto-loading older history is armed by a real scroll and disarmed
		 * by each load. A page that lands while the scroller is still moving
		 * (a fling, a held finger: WebKit drops the programmatic scrollTop the
		 * compensation writes) leaves the view at the top with the button
		 * still in view, and the button re-renders with every page, which
		 * re-fires the observer -- so without this gate one lost compensation
		 * chain-loads page after page ("hours past where you were"). Now a
		 * lost compensation costs at most one page, and the next load needs a
		 * scroll of the user's own.
		 */
		let autoLoadArmed = true;
		/** When the last prepend was compensated, for the re-arm delay. */
		let lastPrependAt = 0;
		/** The anchor the last compensation restored, verified afterwards. */
		let pendingAnchor: {heightOld: number; at: number} | null = null;
		let verifyTimer: ReturnType<typeof setTimeout> | null = null;

		/** Re-arm on a scroll that is not the tail of the last prepend. */
		const REARM_AFTER_MS = 400;
		/** How long a compensation is re-checked against a momentum scroll. */
		const VERIFY_FOR_MS = 600;
		const ANCHOR_TOLERANCE = 4;

		/**
		 * Our own scroll write. A scroll event follows only if something
		 * moved: a flag armed for nothing swallows the user's next real
		 * scroll, and with it the "at the bottom" state and the auto-load
		 * re-arm that scroll should have set. (A page answered empty, or a
		 * jump to a bottom we are already at, moves nothing.)
		 */
		const setScrollTop = (el: HTMLElement, top: number) => {
			const before = el.scrollTop;

			el.scrollTop = top;

			if (el.scrollTop !== before) {
				skipNextScrollEvent.value = true;
			}
		};

		/**
		 * Confirm the compensation stuck. WebKit ignores a scrollTop written
		 * during momentum scrolling and rubber-banding; when the anchor is
		 * lost within VERIFY_FOR_MS of the write, stop the momentum (toggling
		 * overflow is the one thing that does) and write it again.
		 */
		const verifyAnchor = () => {
			const el = chat.value;
			const anchor = pendingAnchor;

			if (!el || !anchor) {
				return;
			}

			if (Date.now() - anchor.at > VERIFY_FOR_MS) {
				pendingAnchor = null; // the user has moved on; leave them be
				return;
			}

			if (verifyTimer !== null) {
				clearTimeout(verifyTimer);
			}

			if (Math.abs(el.scrollHeight - el.scrollTop - anchor.heightOld) <= ANCHOR_TOLERANCE) {
				// Holding, for now: momentum can still take it within the window.
				verifyTimer = setTimeout(verifyAnchor, 100);
				return;
			}

			el.style.overflow = "hidden";
			void el.offsetHeight; // flush: this is what kills the momentum
			el.style.overflow = "";
			setScrollTop(el, el.scrollHeight - anchor.heightOld);
			verifyTimer = setTimeout(verifyAnchor, 100);
		};

		const jumpToBottom = () => {
			pendingAnchor = null; // a jump supersedes any anchor being verified
			props.channel.scrolledToBottom = true;

			const el = chat.value;

			if (el) {
				setScrollTop(el, el.scrollHeight);
			}
		};

		const onShowMoreClick = () => {
			if (!props.network.status.connected) {
				return;
			}

			// The observer fires this directly, past the button's :disabled: a
			// scroll that takes the button out of view and back mid-load must
			// not put a second request in flight (the first reply then cleared
			// historyLoading under the second, whose prepend skipped the scroll
			// compensation and pinned the view to the top).
			if (props.channel.historyLoading) {
				return;
			}

			let lastMessage = -1;

			// Find the id of first message that isn't showInActive
			// If showInActive is set, this message is actually in another channel
			for (const message of props.channel.messages) {
				if (!message.showInActive) {
					lastMessage = message.id;
					break;
				}
			}

			props.channel.historyLoading = true;

			socket.emit("more", {
				target: props.channel.id,
				lastId: lastMessage,
				condensed: store.state.settings.statusMessages !== "shown",
			});
		};

		const onLoadButtonObserved = (entries: IntersectionObserverEntry[]) => {
			entries.forEach((entry) => {
				if (!entry.isIntersecting) {
					return;
				}

				if (!autoLoadArmed) {
					return; // the button stays for a tap; see autoLoadArmed
				}

				// Not connected: nothing can be asked, so the scroll that
				// brought the button here is not spent. The page goes out when
				// the channel is back (the readiness watch below re-observes).
				if (!props.network.status.connected) {
					return;
				}

				autoLoadArmed = false;
				onShowMoreClick();
			});
		};

		/** The button can be acted on: connected, and for a channel, joined. */
		const canLoadMore = () =>
			props.network.status.connected &&
			(props.channel.type !== ChanType.CHANNEL || props.channel.state === ChanState.JOINED);

		nextTick(() => {
			if (!chat.value) {
				return;
			}

			if (window.IntersectionObserver) {
				historyObserver.value = new window.IntersectionObserver(onLoadButtonObserved, {
					root: chat.value,
				});
			}

			jumpToBottom();
		}).catch((e) => {
			// eslint-disable-next-line no-console
			console.error("Error in new IntersectionObserver", e);
		});

		// Messages replaced by an edit (`msg:edit`) stay in the store, keyed by
		// their id for history/reply lookups, but are never rendered: the edit
		// stands right behind each of them, in its place. Filtering here rather
		// than in Message.vue keeps date and unread markers in step.
		const visibleMessages = computed(() =>
			props.channel.messages.filter((message) => message.supersededBy === undefined)
		);

		const condensedMessages = computed(() => {
			if (props.channel.type !== ChanType.CHANNEL && props.channel.type !== ChanType.QUERY) {
				return visibleMessages.value;
			}

			// If actions are hidden, just return a message list with them excluded
			if (store.state.settings.statusMessages === "hidden") {
				return visibleMessages.value.filter(
					(message) => !condensedTypes.has(message.type || "")
				);
			}

			// If actions are not condensed, just return raw message list
			if (store.state.settings.statusMessages !== "condensed") {
				return visibleMessages.value;
			}

			let lastCondensedContainer: CondensedMessageContainer | null = null;

			const condensed: (ClientMessage | CondensedMessageContainer)[] = [];

			for (const message of visibleMessages.value) {
				// If this message is not condensable, or its an action affecting our user,
				// then just append the message to container and be done with it
				if (message.self || message.highlight || !condensedTypes.has(message.type || "")) {
					lastCondensedContainer = null;

					condensed.push(message);

					continue;
				}

				if (!lastCondensedContainer) {
					lastCondensedContainer = {
						time: message.time,
						type: "condensed",
						messages: [],
					};

					condensed.push(lastCondensedContainer);
				}

				lastCondensedContainer!.messages.push(message);

				// Set id of the condensed container to last message id,
				// which is required for the unread marker to work correctly
				lastCondensedContainer!.id = message.id;

				// If this message is the unread boundary, create a split condensed container
				if (message.id === props.channel.firstUnread) {
					lastCondensedContainer = null;
				}
			}

			return condensed.map((message) => {
				// Skip condensing single messages, it doesn't save any
				// space but makes useful information harder to see
				if (message.type === "condensed" && message.messages.length === 1) {
					return message.messages[0];
				}

				return message;
			});
		});

		const shouldDisplayDateMarker = (
			message: SharedMsg | CondensedMessageContainer,
			id: number
		) => {
			const previousMessage = condensedMessages.value[id - 1];

			if (!previousMessage) {
				return true;
			}

			const oldDate = new Date(previousMessage.time);
			const newDate = new Date(message.time);

			return (
				oldDate.getDate() !== newDate.getDate() ||
				oldDate.getMonth() !== newDate.getMonth() ||
				oldDate.getFullYear() !== newDate.getFullYear()
			);
		};

		const shouldDisplayUnreadMarker = (message: ClientMessage | CondensedMessageContainer) => {
			if (unreadMarkerShown || !(Number(message.id) > props.channel.firstUnread)) {
				return false;
			}

			// An edit stands where its original stood, whatever its id: it is
			// never the first unread message, and an edit alone is not news.
			if ("editOf" in message && message.editOf) {
				return false;
			}

			unreadMarkerShown = true;
			return true;
		};

		const isPreviousSource = (currentMessage: ClientMessage, id: number) => {
			const previousMessage = condensedMessages.value[id - 1];
			return (
				previousMessage &&
				currentMessage.type === MessageType.MESSAGE &&
				previousMessage.type === MessageType.MESSAGE &&
				currentMessage.from &&
				previousMessage.from &&
				currentMessage.from.nick === previousMessage.from.nick
			);
		};

		const onCopy = () => {
			if (chat.value) {
				clipboard(chat.value);
			}
		};

		const keepScrollPosition = async (prepended = false) => {
			// If we are already waiting for the next tick to force scroll position,
			// we have no reason to perform more checks and set it again in the next tick
			if (isWaitingForNextTick.value) {
				return;
			}

			const el = chat.value;

			if (!el) {
				return;
			}

			if (!props.channel.scrolledToBottom) {
				// Rows inserted at the head must always be compensated, whether
				// or not this component set historyLoading for them.
				if (props.channel.historyLoading || prepended) {
					const heightOld = el.scrollHeight - el.scrollTop;

					isWaitingForNextTick.value = true;

					await nextTick();

					isWaitingForNextTick.value = false;
					setScrollTop(el, el.scrollHeight - heightOld);

					// Not final until it has survived the scroller's own motion.
					lastPrependAt = Date.now();
					pendingAnchor = {heightOld, at: lastPrependAt};

					if (verifyTimer !== null) {
						clearTimeout(verifyTimer);
					}

					verifyTimer = setTimeout(verifyAnchor, 50);
				}

				return;
			}

			isWaitingForNextTick.value = true;
			await nextTick();
			isWaitingForNextTick.value = false;

			jumpToBottom();
		};

		const onLinkPreviewToggle = async (preview: ClientLinkPreview, message: ClientMessage) => {
			// `preview.shown` has already been flipped by the toggle component;
			// the state is local so there is nobody else to tell.
			await keepScrollPosition();
		};

		/** A text selection is held; scrolling the list under it loses it. */
		const hasSelection = () => {
			const selection = window.getSelection();

			return !!selection && !selection.isCollapsed;
		};

		// --- a drag is a text selection: the action toolbar stands down ---
		//
		// `selecting` is a class on the root while the primary mouse button
		// is down and the pointer has moved: style.css hides every row's
		// toolbar under it, so the bar does not pop over the rows the drag
		// crosses. Only a pointer that started on message text counts; a
		// press on a button or a link is a click, and touch scrolls.
		const selecting = ref(false);
		let dragStart: {x: number; y: number} | null = null;

		const onDragMove = (e: PointerEvent) => {
			if (
				dragStart &&
				!selecting.value &&
				(Math.abs(e.clientX - dragStart.x) > DRAG_SLOP_PX ||
					Math.abs(e.clientY - dragStart.y) > DRAG_SLOP_PX)
			) {
				selecting.value = true;
			}
		};

		const endDrag = () => {
			dragStart = null;
			selecting.value = false;
			window.removeEventListener("pointermove", onDragMove);
			window.removeEventListener("pointerup", endDrag);
			window.removeEventListener("pointercancel", endDrag);
		};

		const onPointerDown = (e: PointerEvent) => {
			if (e.pointerType !== "mouse" || e.button !== 0) {
				return;
			}

			if ((e.target as HTMLElement | null)?.closest("a, button, .msg-actions")) {
				return;
			}

			dragStart = {x: e.clientX, y: e.clientY};
			window.addEventListener("pointermove", onDragMove);
			window.addEventListener("pointerup", endDrag);
			window.addEventListener("pointercancel", endDrag);
		};

		/**
		 * A finger drag on the scrollback puts the keyboard away, like a native
		 * scroll view's `keyboardDismissMode = .onDrag`. On `touchmove`, not
		 * `scroll`: the list scrolls itself as messages arrive.
		 */
		const dismissKeyboard = () => {
			// Dragging a selection handle is a touchmove too, and the resize a
			// dismissed keyboard causes would scroll the list out from under it.
			if (hasSelection()) {
				return;
			}

			const active = document.activeElement as HTMLElement | null;

			if (active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT")) {
				active.blur();
			}
		};

		// The box height the list was last seen at. A scroll event that
		// arrives with a different one is the browser moving the list as it
		// re-lays it out (a rotation, the keyboard, a toolbar) and comes
		// before the resize observer in the same frame: not the user, so it
		// must not decide whether the list is still pinned.
		let seenHeight = 0;

		const touchDown = () => noteTouch(true);
		const touchUp = () => noteTouch(false);

		const handleScroll = () => {
			// The list is moving: a page arriving now is held (scrollSettle.ts).
			noteScroll();

			// Setting scrollTop also triggers scroll event
			// We don't want to perform calculations for that
			if (skipNextScrollEvent.value) {
				skipNextScrollEvent.value = false;

				// Our own write, or a user scroll coalesced into the same frame:
				// either way the anchor under verification gets a look.
				if (pendingAnchor) {
					verifyAnchor();
				}

				return;
			}

			const el = chat.value;

			if (!el || el.clientHeight !== seenHeight) {
				return;
			}

			props.channel.scrolledToBottom = el.scrollHeight - el.scrollTop - el.offsetHeight <= 30;

			// A scroll of the user's own, not the tail of the last prepend's
			// gesture: the next auto-load may fire.
			if (!pendingAnchor && Date.now() - lastPrependAt > REARM_AFTER_MS) {
				autoLoadArmed = true;
			}

			if (pendingAnchor) {
				verifyAnchor();
			}
		};

		// The list's box follows the composer, the typing indicator, the user
		// list, the window and iOS's stepped keyboard shrink: one observer,
		// after layout. Not under a selection, which the scroll would lose.
		const resizeObserver = new ResizeObserver(() => {
			seenHeight = chat.value?.clientHeight ?? 0;

			if (props.channel.scrolledToBottom && !hasSelection()) {
				jumpToBottom();
			}
		});

		onMounted(() => {
			chat.value?.addEventListener("scroll", handleScroll, {passive: true});
			chat.value?.addEventListener("touchmove", dismissKeyboard, {passive: true});
			chat.value?.addEventListener("touchstart", touchDown, {passive: true});
			chat.value?.addEventListener("touchend", touchUp, {passive: true});
			chat.value?.addEventListener("touchcancel", touchUp, {passive: true});

			if (chat.value) {
				resizeObserver.observe(chat.value);
			}

			void nextTick(() => {
				if (historyObserver.value && loadMoreButton.value) {
					historyObserver.value.observe(loadMoreButton.value);
				}
			});
		});

		watch(
			() => props.channel.id,
			() => {
				props.channel.scrolledToBottom = true;

				// Re-add the intersection observer to trigger the check again on channel switch
				// Otherwise if last channel had the button visible, switching to a new channel won't trigger the history
				if (historyObserver.value && loadMoreButton.value) {
					autoLoadArmed = true; // a fresh channel gets its first page unasked
					historyObserver.value.unobserve(loadMoreButton.value);
					historyObserver.value.observe(loadMoreButton.value);
				}
			}
		);

		// Back after a drop (reconnect, then the JOIN): a button left in view
		// while it could not be used gets its look again. At the top of the
		// buffer there is no scroll left to bring it back into view, so
		// without this the page the user asked for during the reconnect
		// never comes.
		watch(canLoadMore, (ready) => {
			if (ready && historyObserver.value && loadMoreButton.value) {
				historyObserver.value.unobserve(loadMoreButton.value);
				historyObserver.value.observe(loadMoreButton.value);
			}
		});

		watch(
			() => props.channel.messages,
			async (messages, previous) => {
				// A history page replaces the array with older rows in front
				// (socket-events/more.ts); a live message mutates it in place.
				// Head insertion: replaced, longer, and the old head is still
				// there at the delta.
				const delta = previous ? messages.length - previous.length : 0;
				const prepended =
					!!previous &&
					messages !== previous &&
					delta > 0 &&
					messages[delta] === previous[0];
				await keepScrollPosition(prepended);
			},
			{
				deep: true,
			}
		);

		// Release the typing indicator's reserved line when a new message is
		// actually rendered (last rendered item changed — a history prepend
		// does not count). This runs before the DOM update, so the new line
		// fills the released space in the same paint and nothing bounces.
		// Hidden status messages never render, so they never release it;
		// socket-events/typing.ts handles channels that are not on screen.
		watch(
			() => condensedMessages.value[condensedMessages.value.length - 1]?.id,
			(id, previous) => {
				if (id !== undefined && id !== previous && props.channel.typingReserved) {
					props.channel.typingReserved = false;
				}
			}
		);

		// Text-selection mode belongs to the scrollback it was entered in:
		// opening another conversation leaves it, as does leaving chat.
		watch(
			() => props.channel.id,
			() => leaveTextSelect()
		);

		onBeforeUpdate(() => {
			unreadMarkerShown = false;
		});

		onBeforeUnmount(() => {
			resizeObserver.disconnect();
			chat.value?.removeEventListener("scroll", handleScroll);
			endDrag();
		});

		onUnmounted(() => {
			leaveTextSelect();

			if (verifyTimer !== null) {
				clearTimeout(verifyTimer);
			}

			chat.value?.removeEventListener("touchmove", dismissKeyboard);
			chat.value?.removeEventListener("touchstart", touchDown);
			chat.value?.removeEventListener("touchend", touchUp);
			chat.value?.removeEventListener("touchcancel", touchUp);
			noteTouch(false);

			if (historyObserver.value) {
				historyObserver.value.disconnect();
			}
		});

		return {
			chat,
			store,
			onShowMoreClick,
			loadMoreButton,
			onCopy,
			condensedMessages,
			shouldDisplayDateMarker,
			shouldDisplayUnreadMarker,
			keepScrollPosition,
			isPreviousSource,
			jumpToBottom,
			onLinkPreviewToggle,
			selecting,
			textSelectMode,
			onPointerDown,
		};
	},
});
</script>
