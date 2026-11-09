// Where a header popover (style.css `.header-popover`: the mentions, a
// channel's translation) sits: under the header button it belongs to, its
// right edge on the button's, measured against the box the pane is placed
// in. The phone layout's rule ignores both.

/** The pane's --popover-top and --popover-right under `button`, or none. */
export function placeUnder(
	button: Element | null,
	popup: HTMLElement | null
): Record<string, string> {
	const container = popup?.offsetParent;

	if (!button || !container) {
		return {};
	}

	const b = button.getBoundingClientRect();
	const c = container.getBoundingClientRect();

	return {
		"--popover-top": `${b.bottom - c.top}px`,
		"--popover-right": `${c.right - b.right}px`,
	};
}
