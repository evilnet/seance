// A modal's backdrop closes it on a click pressed and released on the
// backdrop itself, as a native <dialog>'s light dismiss does. A click whose
// press and release land on different elements is fired on their common
// ancestor, which for anything inside a modal is the backdrop, so with
// `@click.self` a text selection dragged out of a dialog closed it (typed
// text and all), and so did a press on the backdrop let go inside.
//
// `v-backdrop="close"` on the overlay element; registered in vue.ts, and
// test/tests/backdrop.ts fails a `@click.self`.

import type {Directive} from "vue";

type Close = (event: MouseEvent) => void;

// The bound function as of the last render, and how to take the listeners off.
const closes = new WeakMap<HTMLElement, Close>();
const detach = new WeakMap<HTMLElement, () => void>();

export const backdropDirective: Directive<HTMLElement, Close> = {
	mounted(el, binding) {
		closes.set(el, binding.value);
		let pressed = false;
		let armed = false;

		const onDown = (event: Event) => {
			pressed = event.target === el;
		};

		const onUp = (event: Event) => {
			armed = pressed && event.target === el;
		};

		const onClick = (event: MouseEvent) => {
			if (armed) {
				closes.get(el)?.(event);
			}

			pressed = armed = false;
		};

		el.addEventListener("pointerdown", onDown);
		el.addEventListener("pointerup", onUp);
		el.addEventListener("click", onClick);
		detach.set(el, () => {
			el.removeEventListener("pointerdown", onDown);
			el.removeEventListener("pointerup", onUp);
			el.removeEventListener("click", onClick);
		});
	},
	updated(el, binding) {
		closes.set(el, binding.value);
	},
	unmounted(el) {
		detach.get(el)?.();
		detach.delete(el);
		closes.delete(el);
	},
};
