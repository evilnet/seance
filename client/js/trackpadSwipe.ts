// A two-finger horizontal swipe on a trackpad shows or hides the sidebar, as
// a swipe from the edge does on a phone: fingers towards the sidebar's side
// hide it, away from it show it (mirrored right to left). A trackpad sends a
// swipe as wheel events with deltaX, and nothing else in the app reads
// those, but a pane that scrolls sideways (a wide code block, a table) keeps
// its own. One swipe, one change: the gesture has to go quiet before the
// next one counts. Touch screens have their own swipes (helpers/
// listenForTwoFingerSwipes.ts, the sidebar's drag) and are left alone.
import {hasVirtualKeyboard} from "./helpers/device";
import {store} from "./store";

/** How far, in CSS px of deltaX, a swipe goes before it counts. */
const THRESHOLD = 120;
/** A pause this long (ms) ends a gesture, momentum included. */
const QUIET_MS = 250;

/** Whether `target` or an ancestor scrolls sideways itself, and so owns the swipe. */
function scrollsSideways(target: EventTarget | null): boolean {
	for (let el = target instanceof Element ? target : null; el; el = el.parentElement) {
		if (el.scrollWidth > el.clientWidth + 1) {
			const overflow = getComputedStyle(el).overflowX;

			if (overflow === "auto" || overflow === "scroll") {
				return true;
			}
		}
	}

	return false;
}

export function listenForTrackpadSwipes(): void {
	if (typeof window === "undefined" || hasVirtualKeyboard()) {
		return;
	}

	let total = 0;
	let done = false;
	let ignored = false;
	let quiet: ReturnType<typeof setTimeout> | undefined;

	window.addEventListener(
		"wheel",
		(e: WheelEvent) => {
			clearTimeout(quiet);
			quiet = setTimeout(() => {
				total = 0;
				done = false;
				ignored = false;
			}, QUIET_MS);

			// A pinch (ctrl), a mostly vertical scroll, or one a sideways
			// pane takes: not a swipe, for the rest of this gesture.
			if (total === 0 && !done && !ignored) {
				ignored =
					e.ctrlKey ||
					Math.abs(e.deltaX) <= Math.abs(e.deltaY) * 2 ||
					scrollsSideways(e.target);
			}

			if (ignored || done || !store.state.appLoaded) {
				return;
			}

			total += e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaX * 16 : e.deltaX;

			if (Math.abs(total) < THRESHOLD) {
				return;
			}

			done = true;
			// With natural scrolling (macOS's default) fingers moving right send
			// a negative deltaX; WebKit says when the system's setting is off.
			const inverted = (e as WheelEvent & {webkitDirectionInvertedFromDevice?: boolean})
				.webkitDirectionInvertedFromDevice;
			const fingersLeft = inverted === false ? total < 0 : total > 0;
			const rtl = getComputedStyle(document.documentElement).direction === "rtl";
			const towardsSidebar = rtl ? !fingersLeft : fingersLeft;
			store.commit("sidebarOpen", !towardsSidebar);
		},
		{passive: true}
	);
}
