const FOCUSABLE =
	'a[href], summary, button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]';

/** Keep Tab inside a modal `root`: past either end it comes round to the other. */
export function trapTab(event: KeyboardEvent, root: HTMLElement): void {
	const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
		(el) => el.offsetParent !== null
	);

	if (items.length === 0) {
		event.preventDefault();
		return;
	}

	const first = items[0];
	const last = items[items.length - 1];
	const active = document.activeElement;

	if (event.shiftKey && (active === first || active === root)) {
		event.preventDefault();
		last.focus();
	} else if (!event.shiftKey && active === last) {
		event.preventDefault();
		first.focus();
	}
}
