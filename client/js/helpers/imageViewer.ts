// The image viewer's open state lives in a component ref (App.vue provides it
// to LinkPreview), which non-Vue code — the Android shell's back button in
// native.ts — cannot reach. While an image is open, ImageViewer.vue registers
// its close function here; closeOpenImage() closes it and reports whether
// there was anything to close.
//
// Back in an installed PWA should close an open image, not the app. That is
// a CloseWatcher where the browser has one (Chromium: Android's back gesture
// and button, and Escape), which takes the back without a history entry.
// Never a history entry of our own: the router keeps the history one entry
// deep so that iOS's edge swipes have nothing to go back or forward to
// (router.ts), and an entry pushed for the viewer can never be taken off
// again — history.back() leaves it as forward history, a forward swipe lands
// on it, and from there the left edge has a page to go back to. Where there
// is no CloseWatcher (Safari) an edge swipe does nothing to an open image;
// ✕, a tap and Escape close it.

interface CloseWatcherLike {
	onclose: (() => void) | null;
	destroy(): void;
}

type CloseWatcherCtor = new () => CloseWatcherLike;

let close: (() => void) | null = null;
let watcher: CloseWatcherLike | null = null;

function watchForClose(): void {
	const Ctor = (globalThis as {CloseWatcher?: CloseWatcherCtor}).CloseWatcher;

	if (!Ctor || watcher) {
		return;
	}

	try {
		watcher = new Ctor();
	} catch {
		// Refused (no user activation left for another watcher): ✕ still works.
		return;
	}

	watcher.onclose = () => {
		watcher = null;
		closeOpenImage();
	};
}

function stopWatching(): void {
	const w = watcher;
	watcher = null;
	w?.destroy();
}

export function setImageViewerClose(fn: (() => void) | null): void {
	const wasOpen = close !== null;
	close = fn;

	if (fn && !wasOpen) {
		watchForClose();
	} else if (!fn) {
		stopWatching();
	}
}

export function closeOpenImage(): boolean {
	if (!close) {
		return false;
	}

	close();
	return true;
}
