/**
 * Sizes the app to the visual viewport on touch devices.
 *
 * iOS does not shrink the layout viewport for the on-screen keyboard:
 * `innerHeight` stays put while `visualViewport.height` drops, so an app at
 * `height: 100%` keeps its composer behind the keyboard. `--viewport-height`
 * publishes the visual viewport and <body> is sized from it (style.css).
 * Touch-primary devices only, so a desktop pinch-zoom leaves the layout
 * alone; a no-op on Android, where the two viewports agree.
 *
 * Two iOS quirks shape the rest. The resize that announces the keyboard
 * carries a mid-animation height, so a measurement is re-read a few times
 * after the event. And an app switch dismisses the keyboard without a
 * `focusout` or a `resize`, after which `visualViewport.height` keeps the
 * keyboard-up value while `innerHeight` is restored: so the page drops its
 * own focus as it goes hidden, and while no text field has focus — the only
 * time the keyboard is down for certain — the larger of the two wins.
 *
 * The same measurement says whether the keyboard is up at all, and that is
 * published as `html[data-keyboard="up"]` for the rules that make room for it
 * (style.css). The caret is not that signal: iOS's shake-to-undo alert takes
 * the keyboard down and, dismissed, hands the field its focus back with the
 * keyboard still down (phone-measured 2026-09-12), so a rule on `:focus`
 * would keep the composer in the home indicator.
 *
 * Vue-free; boot.ts installs it.
 */

import {hasVirtualKeyboard} from "./device";
import {isIOSShell, nativeCall, nativeListen} from "./capacitor";

/** When a measurement is re-read after its event, in ms. The keyboard animates for ~250 ms. */
export const SETTLE_DELAYS_MS = [50, 150, 300, 600];

/** A visual viewport at least this much shorter than the window is the keyboard (or Safari's form bar) over the page; anything less is rounding. */
export const KEYBOARD_MIN_PX = 8;

/** Whether the keyboard (or Safari's form bar) is up: the window is taller than what it shows, and a text field is why. */
export function keyboardUp(visual: number, inner: number, textFieldFocused: boolean): boolean {
	return textFieldFocused && inner - visual >= KEYBOARD_MIN_PX;
}

/** The height to size the app to. */
export function effectiveHeight(visual: number, inner: number, textFieldFocused: boolean): number {
	return textFieldFocused ? visual : Math.max(visual, inner);
}

/** Calls `apply` now and once more at each delay. Returns a function that stops the re-reads. */
export function settle(apply: () => void, delays: number[] = SETTLE_DELAYS_MS): () => void {
	apply();
	const timers = delays.map((ms) => setTimeout(apply, ms));

	return () => timers.forEach((timer) => clearTimeout(timer));
}

function isTextField(el: Element | null): el is HTMLElement {
	return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

/**
 * The height of the band the user can see, in CSS px — what `--viewport-height`
 * is set to, read live for code that positions against the viewport
 * (`position: fixed` popovers): on iOS `innerHeight` still counts the part
 * under the keyboard. `innerHeight` where the hooks do not apply.
 */
export function visibleHeight(): number {
	const viewport = window.visualViewport;

	if (!viewport || !hasVirtualKeyboard()) {
		return window.innerHeight;
	}

	return effectiveHeight(
		viewport.height,
		window.innerHeight,
		isTextField(document.activeElement)
	);
}

/**
 * The keyboard's height as the native shell reports it (Capacitor's
 * keyboardWillShow/WillHide, subscribed below), or null where no shell says.
 * When set it outranks the visual-viewport guess: the number is the
 * keyboard's frame, form bar included, announced before the animation, so no
 * settle re-reads and no mid-animation height.
 */
let nativeKeyboard: number | null = null;

export function installViewportHooks(): void {
	const viewport = window.visualViewport;

	if (!viewport || !hasVirtualKeyboard()) {
		return;
	}

	// Every iOS browser is WebKit; the same probe as style.css's @supports.
	const ios = CSS.supports("-webkit-touch-callout", "none");

	const apply = () => {
		const focused = isTextField(document.activeElement);
		const root = document.documentElement;
		let height: number;
		let up: boolean;

		if (nativeKeyboard !== null) {
			// The window keeps its size in the shell (Keyboard resize: none),
			// so the band is what the keyboard leaves of it.
			const full = Math.max(viewport.height, window.innerHeight);
			height = nativeKeyboard > 0 ? full - nativeKeyboard : full;
			up = nativeKeyboard > 0;
		} else {
			height = effectiveHeight(viewport.height, window.innerHeight, focused);
			up = keyboardUp(viewport.height, window.innerHeight, focused);
		}

		root.style.setProperty("--viewport-height", `${Math.round(height)}px`);

		if (up) {
			root.dataset.keyboard = "up";
		} else {
			delete root.dataset.keyboard;
		}

		// The app fills the visible band, so anything iOS scrolled away is the
		// header. scrollTo(0, 0) at 0 fires no scroll event, so this cannot loop.
		if (viewport.offsetTop > 0 || window.scrollY > 0) {
			window.scrollTo(0, 0);
		}
	};

	let cancel = () => {};

	const applySettled = () => {
		cancel();
		cancel = settle(apply);
	};

	// The shell's keyboard, rather than the visual viewport's: the plugin says
	// its height before the animation, form bar included, and says when it
	// goes — the two things iOS never tells a page straight.
	// iOS's form accessory bar (˄ ˅ Done) above the keyboard goes with it:
	// nothing in the app for it to step between, and it is the floating pill
	// that covered the composer in the PWA. The keyboard's own Done key does
	// the job.
	// iOS only, both: Android's WebView shrinks for the keyboard like a
	// browser's (Capacitor pads its parent by the IME inset), so the visual
	// viewport already says everything and the plugin's height on top of it
	// took the keyboard off twice; and the accessory-bar call is not
	// implemented there.
	if (isIOSShell()) {
		void nativeCall("Keyboard", "setAccessoryBarVisible", {isVisible: false});

		nativeListen(
			"Keyboard",
			"keyboardWillShow",
			({keyboardHeight}: {keyboardHeight: number}) => {
				nativeKeyboard = keyboardHeight;
				apply();
			}
		);
		nativeListen("Keyboard", "keyboardWillHide", () => {
			nativeKeyboard = 0;
			apply();
		});
	}

	viewport.addEventListener("resize", applySettled);
	viewport.addEventListener("scroll", apply);
	window.addEventListener("resize", applySettled);
	// Focus is what summons and dismisses the keyboard, and it is not a resize.
	window.addEventListener("focusin", applySettled);
	window.addEventListener("focusout", applySettled);
	window.addEventListener("pageshow", applySettled);
	document.addEventListener("visibilitychange", () => {
		const active = document.activeElement;

		if (ios && document.visibilityState === "hidden" && isTextField(active)) {
			active.blur();
		}

		applySettled();
	});

	applySettled();
}
