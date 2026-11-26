// Where a small hover label (MessageReactions.vue's list of who reacted)
// stands on screen. It is drawn on <body>, fixed, because inside the message
// it was cut by the row (`#chat .content` clips, its anti-Zalgo guard) and by
// the scroller, often to a sliver of its last line. Vue-free:
// test/helpers/tipPlacement.ts.

export type TipBox = {left: number; top: number; right: number; bottom: number};

export type TipPlacement = {
	/** The label's top-left corner, in viewport pixels. */
	left: number;
	top: number;
	/** Above its anchor (its pointer on its lower edge), else below. */
	above: boolean;
	/** Where along the label its pointer stands: the anchor's centre, kept
	 * clear of the label's rounded ends. */
	arrow: number;
	/** False when the label is taller than the room on either side and
	 * covers its anchor: it then has no pointer. */
	pointer: boolean;
};

/**
 * Centred over `anchor` and `gap` above it, or below when above has less
 * room; slid sideways and up or down to keep `margin` from the viewport's
 * edges. A label taller than either side's room stays on screen over its
 * anchor (the stylesheet caps it at the viewport's height).
 */
export function tipPlacement(
	anchor: TipBox,
	size: {width: number; height: number},
	viewport: {width: number; height: number},
	gap = 6,
	margin = 8
): TipPlacement {
	const centre = (anchor.left + anchor.right) / 2;
	const left = Math.max(
		margin,
		Math.min(centre - size.width / 2, viewport.width - margin - size.width)
	);
	const roomAbove = anchor.top - gap - margin;
	const roomBelow = viewport.height - margin - gap - anchor.bottom;
	const above = size.height <= roomAbove || (size.height > roomBelow && roomAbove >= roomBelow);
	const wanted = above ? anchor.top - gap - size.height : anchor.bottom + gap;
	const top = Math.max(margin, Math.min(wanted, viewport.height - margin - size.height));
	const arrow = Math.max(10, Math.min(centre - left, size.width - 10));

	return {left, top, above, arrow, pointer: top === wanted};
}
