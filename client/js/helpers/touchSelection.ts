import {ref} from "vue";

/**
 * A live (non-collapsed) selection in the scrollback, kept by a
 * `selectionchange` listener MessageList.vue holds while mounted.
 *
 * On touch a message with a toolbar is `user-select: none` so the platform's
 * long press cannot race the one that opens it — but the message whose
 * toolbar is open is selectable again (style.css,
 * `.msg.select-armed`), so a second long press there is the platform's own:
 * a native selection with its handles. The moment one exists, the toolbar
 * stands down (Message.vue watches this) and the whole scrollback turns
 * selectable (`.chat.selection-live`), so the handles can be dragged across
 * messages — how several lines are copied at once on a phone. A tap
 * collapses the selection, which puts everything back by itself.
 */
export const selectionActive = ref(false);

const onSelectionChange = () => {
	const selection = document.getSelection();

	if (!selection || selection.isCollapsed || !selection.anchorNode) {
		selectionActive.value = false;
		return;
	}

	// Only a selection in the scrollback counts: the topic or the help page
	// must not put the message toolbars away.
	const node = selection.anchorNode;
	const el = node instanceof Element ? node : node.parentElement;

	selectionActive.value = !!el?.closest("#chat .messages");
};

let holders = 0;

export function watchSelection() {
	if (holders++ === 0) {
		document.addEventListener("selectionchange", onSelectionChange);
	}
}

export function unwatchSelection() {
	if (--holders === 0) {
		document.removeEventListener("selectionchange", onSelectionChange);
		selectionActive.value = false;
	}
}
