// A modal's backdrop closes it on a click — but only a click pressed and
// released on the backdrop. When the button goes down in one element and up in
// another, the browser fires the click on their nearest common ancestor,
// which for anything inside a modal is the backdrop: selecting text in a
// dialog and letting go past its edge clicked the backdrop and closed it,
// typed text and all; a press on the backdrop let go inside the dialog
// clicked it too. `@click.self` cannot tell. This counts a click only when
// the press and the release were both on the backdrop, as a native
// <dialog>'s light dismiss does. (A touch drag fires no click; a tap goes
// through the same check and passes.)
//
// `v-backdrop="close"` on the overlay element, in place of
// `@click.self="close"` (test/tests/backdrop.ts fails a `@click.self`).
// Registered in vue.ts.

import type {Directive} from "vue";

type Handler = (event: MouseEvent) => void;

interface BackdropState {
	handler: Handler;
	pressedHere: boolean;
	releasedHere: boolean;
	onPointerDown: (event: Event) => void;
	onPointerUp: (event: Event) => void;
	onClick: (event: Event) => void;
}

const states = new WeakMap<EventTarget, BackdropState>();

/** `v-backdrop`: calls its handler for a click pressed and released on the element itself. */
export const backdropDirective: Directive<HTMLElement, Handler> = {
	mounted(el, binding) {
		const state: BackdropState = {
			handler: binding.value,
			pressedHere: false,
			releasedHere: false,
			onPointerDown(event) {
				state.pressedHere = event.target === el;
			},
			onPointerUp(event) {
				state.releasedHere = event.target === el;
			},
			onClick(event) {
				const both = state.pressedHere && state.releasedHere;
				state.pressedHere = false;
				state.releasedHere = false;

				if (both && event.target === el) {
					state.handler(event as MouseEvent);
				}
			},
		};

		states.set(el, state);
		el.addEventListener("pointerdown", state.onPointerDown);
		el.addEventListener("pointerup", state.onPointerUp);
		el.addEventListener("click", state.onClick);
	},
	updated(el, binding) {
		const state = states.get(el);

		if (state) {
			state.handler = binding.value;
		}
	},
	unmounted(el) {
		const state = states.get(el);

		if (state) {
			el.removeEventListener("pointerdown", state.onPointerDown);
			el.removeEventListener("pointerup", state.onPointerUp);
			el.removeEventListener("click", state.onClick);
			states.delete(el);
		}
	},
};
