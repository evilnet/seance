// Enter and Space belong to the control that has the focus: a button, a link,
// a select, a summary, anything role="button". The global keydown listener in
// keybinds.ts sends printable keys to the composer, and it has to leave these
// two alone with such a control focused — Enter there prevents the default, so
// the click never happens, and Space moves the focus before the keyup that
// would have clicked. Every other key still reaches the composer, so typing a
// letter with a button focused keeps working.
const TAKES_ENTER_OR_SPACE = 'button, a[href], select, summary, [role="button"]';

export default function controlTakesKey(target: EventTarget | null, keyCode: number): boolean {
	if (keyCode !== 13 && keyCode !== 32) {
		return false;
	}

	// The target of a key event is usually an element, but it can be the
	// document or the window, and the suite runs without a DOM.
	if (!target || typeof (target as HTMLElement).closest !== "function") {
		return false;
	}

	return (target as HTMLElement).closest(TAKES_ENTER_OR_SPACE) !== null;
}
