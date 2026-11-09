// Whether the user list lies over the messages (style.css, the `chat`
// container query on the list's threshold) rather than beside them. In a
// narrow desktop window the list starts closed there, whatever the wide
// window left saved: open, it would cover the messages the window is for.
// The toggle then opens and closes it for the moment only (store.ts
// `toggleUserlist`). A touch device keeps its own behaviour.
import {hasVirtualKeyboard, isPhoneLayout} from "./helpers/device";
import {store} from "./store";

/**
 * The query cannot be asked from script, so the CSS sets
 * `--userlist-overlays: 1` on `#chat .chat-view` inside it and this reads it
 * back whenever the chat pane changes width.
 */
function overlays(chat: HTMLElement): boolean {
	// A phone or tablet keeps its own behaviour; a desktop window narrow
	// enough for the phone layout gets this one.
	if (isPhoneLayout() && hasVirtualKeyboard()) {
		return false;
	}

	const view = chat.querySelector<HTMLElement>(".chat-view");

	if (!view) {
		return false;
	}

	return getComputedStyle(view).getPropertyValue("--userlist-overlays").trim() === "1";
}

/** Follows the chat pane `chat` until the returned function is called. */
export function watchUserlistOverlay(chat: HTMLElement): () => void {
	const update = () => {
		const next = overlays(chat);

		if (store.state.userlistOverlays !== next) {
			store.commit("userlistOverlays", next);
		}
	};

	update();

	if (typeof ResizeObserver !== "function") {
		return () => {};
	}

	const observer = new ResizeObserver(update);
	observer.observe(chat);

	return () => observer.disconnect();
}
