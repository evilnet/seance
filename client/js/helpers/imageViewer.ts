// The image viewer's open state lives in a component ref (App.vue provides it
// to LinkPreview), which non-Vue code — the Android shell's back button in
// native.ts — cannot reach. While an image is open, ImageViewer.vue registers
// its close function here; closeOpenImage() closes it and reports whether
// there was anything to close.
//
// Back in a browser or an installed PWA is a history back, and the router
// keeps the history one entry deep (router.ts), so back from an open image
// left the app. Opening an image therefore pushes an entry of its own, at the
// same URL: back pops it and closes the image. Closing the image any other way
// (✕, a click, Escape, the Android shell's back) takes that entry off again.
//
// Neither popstate may reach vue-router. It would run a navigation to the
// route it is already on, LinkPreview's onBeforeRouteUpdate would abort it
// (the viewer is open), and vue-router answers an aborted pop with no delta
// by going back one more — out of the app. So this listener swallows them,
// and it only can because it runs first: listeners on window fire in the
// order they were added, and router.ts imports this module before it calls
// createWebHashHistory().

const MARKER = "seanceImageViewer";

let close: (() => void) | null = null;

// The viewer's entry is on the stack (pushed and not yet popped).
let entryPushed = false;
// A history.back() of ours is in flight; its popstate is ours to swallow.
let poppingOwnEntry = false;

function isViewerState(state: unknown): boolean {
	return typeof state === "object" && state !== null && MARKER in state;
}

function onPopState(event: PopStateEvent): void {
	if (poppingOwnEntry) {
		// The back() that took the entry off after a close.
		poppingOwnEntry = false;
		event.stopImmediatePropagation();
		return;
	}

	if (entryPushed && !isViewerState(event.state)) {
		// The user went back off the viewer's entry: close the image.
		entryPushed = false;
		event.stopImmediatePropagation();
		const fn = close;
		close = null;
		fn?.();
		return;
	}

	if (isViewerState(event.state)) {
		// Forward onto a stale viewer entry: same URL, nothing to route.
		event.stopImmediatePropagation();
	}
}

if (typeof window !== "undefined" && typeof history !== "undefined") {
	window.addEventListener("popstate", onPopState, true);
}

function pushEntry(): void {
	if (entryPushed || typeof history === "undefined") {
		return;
	}

	const state: unknown = history.state;
	history.pushState(
		{...(typeof state === "object" && state !== null ? state : {}), [MARKER]: true},
		""
	);
	entryPushed = true;
}

function dropEntry(): void {
	if (!entryPushed) {
		return;
	}

	entryPushed = false;

	// A router.replace while the image was open overwrote the entry; going
	// back now would be a real navigation, so leave the stack alone.
	if (!isViewerState(history.state)) {
		return;
	}

	poppingOwnEntry = true;
	history.back();
}

export function setImageViewerClose(fn: (() => void) | null): void {
	const wasOpen = close !== null;
	close = fn;

	if (fn && !wasOpen) {
		pushEntry();
	} else if (!fn) {
		dropEntry();
	}
}

export function closeOpenImage(): boolean {
	if (!close) {
		return false;
	}

	close();
	return true;
}
