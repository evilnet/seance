// A two-finger horizontal swipe on a trackpad shows or hides the sidebar, as
// a swipe from the edge does on a phone: fingers towards the sidebar's side
// hide it, away from it show it (mirrored right to left). A trackpad sends a
// swipe as wheel events with deltaX in pixels, and nothing else in the app
// reads those; an open overlay, or a pane that can still scroll sideways the
// way the fingers go (a wide code block, a table), keeps its own
// (helpers/sidewaysSwipe.ts, as the touch drag asks). One swipe, one change:
// the gesture has to go quiet before the next one counts. Touch screens have
// their own swipe (the sidebar's drag) and are left alone.
//
// In Messenger a swipe over the conversation toward the pane's start is not
// the sidebar's: it slides the conversation aside to show the times
// (helpers/trackpadPeek.ts), for as long as the gesture lasts. It goes by
// the way the content moves, as a scroll does, so with natural scrolling it
// is fingers toward the start, as Messages has it.
//
// The direction of the fingers is the wheel's, natural scrolling undone:
// WebKit says when the system's setting is off; Chrome and Firefox do not,
// so there a user with natural scrolling off swipes the other way.
import {hasVirtualKeyboard} from "./helpers/device";
import {inOpenOverlay, scrollerTakesSwipe} from "./helpers/sidewaysSwipe";
import {trackpadPeek} from "./helpers/trackpadPeek";
import {messageLayoutShown} from "./settings";
import {store} from "./store";

/** How far, in CSS px of deltaX, a swipe goes before it counts. */
const THRESHOLD = 120;
/** A pause this long (ms) ends a gesture, momentum included. */
const QUIET_MS = 250;

type Gesture = "idle" | "swipe" | "peek" | "done" | "ignored";

/** Whether wheel deltas moving the content by `deltaX` mean fingers moving left. */
function fingersLeft(e: WheelEvent, deltaX: number): boolean {
	// With natural scrolling (macOS's default) fingers moving right send a
	// negative deltaX; WebKit says when the system's setting is off.
	const inverted = (e as WheelEvent & {webkitDirectionInvertedFromDevice?: boolean})
		.webkitDirectionInvertedFromDevice;
	return inverted === false ? deltaX < 0 : deltaX > 0;
}

/** Whether wheel deltas of `deltaX` move the content toward the pane's start. */
function towardStart(deltaX: number): boolean {
	return document.documentElement.dir === "rtl" ? deltaX < 0 : deltaX > 0;
}

/** Whether a swipe from `target` that moves the content by `deltaX` is
 * Messenger's peek at the times rather than the sidebar's. */
function peeks(target: Element, deltaX: number): boolean {
	return (
		messageLayoutShown.value === "bubbles" &&
		towardStart(deltaX) &&
		target.closest("#chat .chat .messages") !== null &&
		!scrollerTakesSwipe(target, false)
	);
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
				trackpadPeek.value = 0;
			}, QUIET_MS);

			// A pinch (ctrl, at any point), a mouse wheel turned sideways
			// with Shift or reporting lines or pages (Chromium and WebKit
			// report a plain wheel in pixels too, so a tilt wheel still
			// counts), a mostly vertical start, or a swipe an overlay or a
			// sideways pane takes: not ours, for the rest of this gesture.
			if (e.ctrlKey || e.shiftKey || e.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) {
				state = "ignored";
				trackpadPeek.value = 0;
			}

			// A sideways pane keeps the swipe by the way its content would
			// scroll, which deltaX gives as is (scrollerTakesSwipe reads it as a
			// touch drag: content moving right is fingers moving right), not
			// by the fingers, which natural scrolling may turn around. A
			// window laid over the page (Settings, Help) keeps it too.
			if (state === "idle") {
				const target = e.target instanceof Element ? e.target : null;
				state =
					!store.state.appLoaded || Math.abs(e.deltaX) <= Math.abs(e.deltaY) * 2
						? "ignored"
						: target !== null && peeks(target, e.deltaX)
						? "peek"
						: target !== null &&
						  (inOpenOverlay(target) ||
								target.closest(".window.screen-overlay") !== null ||
								scrollerTakesSwipe(target, opens(e.deltaX > 0)))
						? "ignored"
						: "swipe";
			}

			// The times follow the fingers both ways, momentum included, and
			// the conversation slides back once the gesture goes quiet.
			if (state === "peek") {
				total += e.deltaX;
				trackpadPeek.value = towardStart(total) ? Math.abs(total) : 0;
				return;
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
