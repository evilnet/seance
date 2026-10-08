/**
 * Which kind of pointer the user is using right now, as opposed to what the
 * device is (helpers/device.ts). `(hover: none)` and `(pointer: coarse)`
 * describe the *primary* input, which a laptop with a touchscreen may report
 * as touch while its owner works with a trackpad: the message toolbar's
 * hover was then switched off for the trackpad, and the long press that
 * stood in for it listens only to a finger. So the last pointer decides:
 * `data-input="touch"` on <html> after a finger, `"pointer"` after a mouse
 * or a hovering pen. The hover toolbar follows the mouse, the long press the
 * finger, whichever the browser calls primary. Vue-free; the listeners are
 * passive.
 */

export type InputKind = "touch" | "pointer";

let current: InputKind = "pointer";

const listeners = new Set<(kind: InputKind) => void>();

/** The kind of the last pointer seen (before any, the device's primary). */
export function inputKind(): InputKind {
	return current;
}

/** Whether the last pointer was a finger. */
export function isTouchInput(): boolean {
	return current === "touch";
}

/**
 * Calls `fn` with every kind written from here on (the install's initial
 * one included), for what has to re-render when it changes — the toolbar's
 * Copy text. Returns the unsubscribe.
 */
export function onInputKindChange(fn: (kind: InputKind) => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

/**
 * The kind a pointer event stands for; null when it says nothing about the
 * user. A synthetic event carries no `pointerType`. A pen touching the
 * screen is a finger to an iPad and a mouse to a Surface, so only a pen that
 * hovers (a move with no button down) says the hover toolbar can follow it;
 * its taps leave the kind as it was.
 */
export function kindOf(e: {
	type?: string;
	pointerType?: string;
	buttons?: number;
}): InputKind | null {
	switch (e.pointerType) {
		case "touch":
			return "touch";
		case "mouse":
			return "pointer";
		case "pen":
			return e.type === "pointermove" && e.buttons === 0 ? "pointer" : null;
		default:
			return null;
	}
}

/**
 * Starts following the pointer. `initial` is the device's primary input
 * (hasVirtualKeyboard), until the first pointer says otherwise.
 */
export function installInputModality(root: HTMLElement, initial: InputKind): void {
	const set = (kind: InputKind) => {
		current = kind;
		root.dataset.input = kind;

		for (const fn of listeners) {
			fn(kind);
		}
	};

	set(initial);

	const onPointer = (e: PointerEvent) => {
		const kind = kindOf(e);

		if (kind && kind !== current) {
			set(kind);
		}
	};

	for (const type of ["pointerdown", "pointermove"] as const) {
		window.addEventListener(type, onPointer, {capture: true, passive: true});
	}
}
