// Who a sideways swipe belongs to, for the sidebar's two swipes: the touch
// drag (Sidebar.vue) and the trackpad's (trackpadSwipe.ts). An open overlay
// keeps every swipe on it, and a pane that scrolls sideways keeps one it can
// still scroll by.

/** An open modal overlay (the oper cards, builder and dialog, the confirm
 * dialog, the upload preview…): they carry `.opened` while shown; the script
 * editor is mounted only while open, so its presence is enough. The
 * sidebar's own dimmer is not one; a swipe on it closes the sidebar. */
const OPEN_OVERLAY =
	'[id$="-overlay"].opened:not(#sidebar-overlay), #script-editor-overlay, #image-viewer.opened';

export function inOpenOverlay(el: Element): boolean {
	return el.closest(OPEN_OVERLAY) !== null;
}

/** The panes the walk stops at: they scroll up and down (which computes
 * `overflow-x: auto` too), and one wide child must not take the swipe away
 * from the whole pane. */
const PANE = "#chat .chat, .window, #viewport";

/** `el` or the nearest ancestor inside its pane that scrolls sideways and has something to scroll. */
function sidewaysScroller(el: Element): Element | null {
	for (
		let node: Element | null = el;
		node && node !== document.body && !node.matches(PANE);
		node = node.parentElement
	) {
		if (node.scrollWidth > node.clientWidth + 1) {
			const overflowX = window.getComputedStyle(node).overflowX;

			if (overflowX === "auto" || overflowX === "scroll") {
				return node;
			}
		}
	}

	return null;
}

/**
 * Whether a swipe starting on `el` is the scroll of a sideways scroller
 * under it: only when that scroller can still move the way the swipe goes —
 * right to open (it is scrolled away from its start), left to close (it is
 * short of its end). One resting at its start gives an opening swipe nothing.
 * Right to left, the start is the right edge and `scrollLeft` runs from 0
 * down to minus the overflow, so the two directions swap. On a right-to-left
 * page the sidebar docks at the right edge, so opening it is a swipe to the
 * left and the directions swap once more.
 */
export function scrollerTakesSwipe(el: Element, opening: boolean): boolean {
	const scroller = sidewaysScroller(el);

	if (!scroller) {
		return false;
	}

	const rtl = window.getComputedStyle(scroller).direction === "rtl";
	const fromStart = Math.abs(scroller.scrollLeft);
	const rightward = opening !== (document.documentElement.dir === "rtl");
	const towardStart = rightward !== rtl;

	return towardStart
		? fromStart > 0
		: fromStart < scroller.scrollWidth - scroller.clientWidth - 1;
}
