import {ref} from "vue";
import eventbus from "../eventbus";
import distance from "../helpers/distance";

/** How long a touch has to last to pick a sidebar row up (ms). */
export const LONG_TOUCH_DURATION = 500;

/** This is the same way Sortable.js detects a touch event. See
 * SortableJS/Sortable@daaefeda:/src/Sortable.js#L465 */
function isTouchEvent(event: any): boolean {
	return !!(
		(event.touches && event.touches[0]) ||
		(event.pointerType && event.pointerType === "touch")
	);
}

/**
 * The handlers every draggable list in the sidebar shares (the networks,
 * each network's conversations, the favorites block): the cue that a touch
 * was held long enough, iOS's text selection kept off a long touch, and
 * Android's long-touch context menu dismissed once the touch drags.
 */
export default function useSidebarDrag() {
	const startDrag = ref<[number, number] | null>(null);

	const onDraggableChoose = (event: any) => {
		const original = event.originalEvent;

		if (isTouchEvent(original)) {
			// onDrag is only triggered when the user actually moves the
			// dragged object but onChoose is triggered as soon as the
			// item is eligible for dragging. This gives us an opportunity
			// to tell the user they've held the touch long enough.
			event.item.classList.add("ui-sortable-dragging-touch-cue");

			if (original instanceof TouchEvent && original.touches.length > 0) {
				startDrag.value = [original.touches[0].clientX, original.touches[0].clientY];
			} else if (original instanceof PointerEvent) {
				startDrag.value = [original.clientX, original.clientY];
			}
		}
	};

	const onDraggableUnchoose = (event: any) => {
		event.item.classList.remove("ui-sortable-dragging-touch-cue");
		startDrag.value = null;
	};

	const onDraggableTouchStart = (event: TouchEvent) => {
		if (event.touches.length === 1) {
			// This prevents an iOS long touch default behavior: selecting
			// the nearest selectable text.
			document.body.classList.add("force-no-select");
		}
	};

	const onDraggableTouchMove = (event: TouchEvent) => {
		if (startDrag.value && event.touches.length > 0) {
			const touch = event.touches[0];
			const currentPosition = [touch.clientX, touch.clientY];

			if (distance(startDrag.value, currentPosition as [number, number]) > 10) {
				// Context menu is shown on Android after long touch.
				// Dismiss it now that we're sure the user is dragging.
				eventbus.emit("contextmenu:cancel");
			}
		}
	};

	const onDraggableTouchEnd = (event: TouchEvent) => {
		if (event.touches.length === 0) {
			document.body.classList.remove("force-no-select");
		}
	};

	return {
		LONG_TOUCH_DURATION,
		onDraggableChoose,
		onDraggableUnchoose,
		onDraggableTouchStart,
		onDraggableTouchMove,
		onDraggableTouchEnd,
	};
}
