// Which message rows of a chat are in view, for translation's on-screen
// reading (translate/onScreen.ts): MessageList.vue starts this on its
// scroller while translation is on. One IntersectionObserver for the rows,
// with half a screen above and below counted as in view so that what the
// reader scrolls to next is usually translated by the time it arrives; a
// second one, with no margin, for the rows on the visible part itself, which
// are read first; and a MutationObserver on the list so that rows rendered later (a live line,
// a history page, a replay) are observed as they mount. A row is
// `.messages > .msg#msg-<id>` (Message.vue); dates, unread markers and
// condensed status rows are not lines anyone reads.

/** The rows' margin around the scroller's visible part: half a screen either way. */
export const LINE_MARGIN = "50% 0px";

// A catch-up line placed between two rows has a fractional id (irc/history.ts).
const ID = /^msg-(-?\d+(?:\.\d+)?(?:e-?\d+)?)$/;

function idOf(node: Node): number | null {
	if (!(node instanceof HTMLElement) || !node.classList.contains("msg")) {
		return null;
	}

	const match = ID.exec(node.id);

	return match ? Number(match[1]) : null;
}

export type LineReport = {
	/** A row came into view (the visible part and `LINE_MARGIN`) or left it. */
	inView: (messageId: number, inView: boolean) => void;
	/** A row came onto the visible part itself, or left it. */
	visible: (messageId: number, visible: boolean) => void;
};

/**
 * Report each row of `list` (rendered inside the scroller `root`) as it
 * comes into view or leaves it, until the returned function is called; a
 * row removed from the list is reported out of view.
 */
export function watchLines(root: HTMLElement, list: HTMLElement, report: LineReport): () => void {
	if (typeof window.IntersectionObserver !== "function") {
		return () => undefined;
	}

	const observer = (
		margin: string,
		heard: (messageId: number, inView: boolean) => void
	): IntersectionObserver =>
		new window.IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const id = idOf(entry.target);

					if (id !== null) {
						heard(id, entry.isIntersecting);
					}
				}
			},
			{root, rootMargin: margin}
		);

	// The visible one first: observers are told in the order they were made,
	// so a row's place on the visible part is known by the time the margin
	// one asks for a scan (onScreen.ts `linesToRead` reads it first).
	const shown = observer("0px", report.visible);
	const near = observer(LINE_MARGIN, report.inView);
	const rows = {
		observe(row: Element): void {
			shown.observe(row);
			near.observe(row);
		},
		unobserve(row: Element): void {
			shown.unobserve(row);
			near.unobserve(row);
		},
		disconnect(): void {
			shown.disconnect();
			near.disconnect();
		},
	};

	for (const child of Array.from(list.children)) {
		if (idOf(child) !== null) {
			rows.observe(child);
		}
	}

	const mounts = new MutationObserver((records) => {
		for (const record of records) {
			for (const node of Array.from(record.addedNodes)) {
				if (idOf(node) !== null) {
					rows.observe(node as Element);
				}
			}

			for (const node of Array.from(record.removedNodes)) {
				const id = idOf(node);

				if (id !== null) {
					rows.unobserve(node as Element);
					report.visible(id, false);
					report.inView(id, false);
				}
			}
		}
	});

	mounts.observe(list, {childList: true});

	return () => {
		mounts.disconnect();
		rows.disconnect();
	};
}
