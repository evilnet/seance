// A two-finger horizontal swipe on a trackpad shows or hides the sidebar, as
// a swipe from the edge does on a phone: fingers towards the sidebar's side
// hide it, away from it show it (mirrored right to left). A trackpad sends a
// swipe as wheel events with deltaX in pixels, and nothing else in the app
// reads those; an open overlay, or a pane that can still scroll sideways the
// way the fingers go (a wide code block, a table), keeps its own
// (helpers/sidewaysSwipe.ts, as the touch drag asks). One swipe, one change:
// the gesture has to go quiet before the next one counts. Touch screens have
// their own swipes (helpers/listenForTwoFingerSwipes.ts, the sidebar's drag)
// and are left alone.
//
// The direction of the fingers is the wheel's, natural scrolling undone:
// WebKit says when the system's setting is off; Chrome and Firefox do not,
// so there a user with natural scrolling off swipes the other way.
import {hasVirtualKeyboard} from "./helpers/device";
import {inOpenOverlay, scrollerTakesSwipe} from "./helpers/sidewaysSwipe";
import {store} from "./store";

/** How far, in CSS px of deltaX, a swipe goes before it counts. */
const THRESHOLD = 120;
/** A pause this long (ms) ends a gesture, momentum included. */
const QUIET_MS = 250;

type Gesture = "idle" | "swipe" | "done" | "ignored";

/** Whether wheel deltas moving the content by `deltaX` mean fingers moving left. */
function fingersLeft(e: WheelEvent, deltaX: number): boolean {
	// With natural scrolling (macOS's default) fingers moving right send a
	// negative deltaX; WebKit says when the system's setting is off.
	const inverted = (e as WheelEvent & {webkitDirectionInvertedFromDevice?: boolean})
		.webkitDirectionInvertedFromDevice;
	return inverted === false ? deltaX < 0 : deltaX > 0;
}

/** Whether fingers going left (or right) open the sidebar: it docks at the left, or the right when RTL. */
function opens(left: boolean): boolean {
	const rtl = document.documentElement.dir === "rtl";
	return rtl ? left : !left;
}

export function listenForTrackpadSwipes(): void {
	if (typeof window === "undefined" || hasVirtualKeyboard()) {
		return;
	}

	let state: Gesture = "idle";
	let total = 0;
	let quiet: ReturnType<typeof setTimeout> | undefined;

	window.addEventListener(
		"wheel",
		(e: WheelEvent) => {
			clearTimeout(quiet);
			quiet = setTimeout(() => {
				state = "idle";
				total = 0;
			}, QUIET_MS);

			// A pinch (ctrl, at any point), line or page deltas (a mouse
			// wheel, not a trackpad), a mostly vertical start, or a swipe an
			// overlay or a sideways pane takes: not ours, for the rest of
			// this gesture.
			if (e.ctrlKey || e.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) {
				state = "ignored";
			}

			if (state === "idle") {
				const target = e.target instanceof Element ? e.target : null;
				state =
					!store.state.appLoaded ||
					Math.abs(e.deltaX) <= Math.abs(e.deltaY) * 2 ||
					(target !== null &&
						(inOpenOverlay(target) ||
							scrollerTakesSwipe(target, opens(fingersLeft(e, e.deltaX)))))
						? "ignored"
						: "swipe";
			}

			if (state !== "swipe") {
				return;
			}

			total += e.deltaX;

			if (Math.abs(total) < THRESHOLD) {
				return;
			}

			state = "done";
			store.commit("sidebarOpen", opens(fingersLeft(e, total)));
		},
		{passive: true}
	);
}
