import {ref} from "vue";

/**
 * Touch text-selection mode, entered from "Select text" in the message action
 * toolbar. While it is on, the coarse-pointer `user-select: none` on the
 * scrollback is lifted (style.css, `.chat.select-text`) and the long press
 * that opens the toolbar stands down (Message.vue), so the platform's own
 * long press selects text with its native handles — across messages too,
 * which is how several lines are copied at once on a phone. One flag for the
 * whole app: only one scrollback is on screen at a time, and leaving the
 * conversation leaves the mode (MessageList.vue).
 */
export const textSelectMode = ref(false);

export function enterTextSelect() {
	textSelectMode.value = true;
}

export function leaveTextSelect() {
	if (!textSelectMode.value) {
		return;
	}

	textSelectMode.value = false;

	// A selection left standing would go on holding back the sidebar swipe
	// (Sidebar.vue stands down while one exists) with no visible reason.
	window.getSelection()?.removeAllRanges();
}
