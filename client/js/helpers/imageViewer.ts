// Back in an installed PWA should close an open image, not the app. That is
// a CloseWatcher where the browser has one (Chromium: Android's back gesture
// and button), which takes the back without a history entry. Never a history
// entry of our own: the router keeps the history one entry deep so that iOS's
// edge swipes have nothing to go back or forward to (router.ts), and an entry
// pushed for the viewer can never be taken off again — history.back() leaves
// it as forward history, a forward swipe lands on it, and from there the left
// edge has a page to go back to. Where there is no CloseWatcher (Safari) an
// edge swipe does nothing to an open image; ✕, a tap, a swipe up or down and
// Escape close it.
//
// A close request closes the topmost layer as Escape does
// (helpers/escapeLayer.ts): the viewer is one, so with a menu open on the
// picture (ImageViewer.vue, in the app shells) the menu goes first and the
// viewer, still open, takes a fresh watcher for the next request. Escape
// itself never gets here: App.vue cancels its keydown whenever a layer is up.
// The Android shell's back button (native.ts) goes by the layers alone.

import {emitEscape} from "./escapeLayer";

interface CloseWatcherLike {
	onclose: (() => void) | null;
	destroy(): void;
}

type CloseWatcherCtor = new () => CloseWatcherLike;

let open = false;
let watcher: CloseWatcherLike | null = null;

function watchForClose(): void {
	const Ctor = (globalThis as {CloseWatcher?: CloseWatcherCtor}).CloseWatcher;

	if (!Ctor) {
		return;
	}

	watcher = new Ctor();
	watcher.onclose = () => {
		emitEscape();

		if (open) {
			watchForClose();
		}
	};
}

function stopWatching(): void {
	watcher?.destroy();
	watcher = null;
}

/** ImageViewer.vue says when an image opens and closes. */
export function setImageViewerOpen(isOpen: boolean): void {
	if (isOpen && !open) {
		watchForClose();
	} else if (!isOpen) {
		stopWatching();
	}

	open = isOpen;
}
