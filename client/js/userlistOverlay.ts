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
 * back whenever the chat pane, or the threshold, changes width.
 */
function overlays(chat: HTMLElement): boolean {
	// A phone or tablet keeps its own behaviour (the saved toggle).
	if (hasVirtualKeyboard()) {
		return false;
	}

	// A desktop window in the phone layout (481px and under) lays the list
	// over the messages whatever the pane's query says (a tiny font step
	// keeps the pane above the threshold there).
	if (isPhoneLayout()) {
		return true;
	}

	const view = chat.querySelector<HTMLElement>(".chat-view");

	if (!view) {
		return false;
	}

	return getComputedStyle(view).getPropertyValue("--userlist-overlays").trim() === "1";
}

/**
 * An invisible box as wide as the query's threshold (style.css, `@container
 * chat (max-width: calc(50ch + 8.5rem + 84px))`, spelled out the same), so a
 * font change that moves the threshold but not the pane is seen too.
 */
function thresholdProbe(chat: HTMLElement): HTMLElement {
	const probe = document.createElement("div");
	probe.setAttribute("aria-hidden", "true");
	probe.style.cssText =
		// Fixed, so its width never adds to anything's scroll area.
		"position:fixed;visibility:hidden;pointer-events:none;height:0;inset-block-start:0;inset-inline-start:0;width:calc(50ch + 8.5rem + 84px)";
	chat.append(probe);
	return probe;
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

	const probe = thresholdProbe(chat);
	const observer = new ResizeObserver(update);
	observer.observe(chat);
	observer.observe(probe);

	return () => {
		observer.disconnect();
		probe.remove();
	};
}
