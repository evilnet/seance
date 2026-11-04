// Marks words without touching what Vue rendered, through the CSS Custom
// Highlight API: a Range per match, styled by `::highlight(name)`. A browser
// without the API shows the text unmarked.

const registry = () => (CSS as unknown as {highlights?: Map<string, unknown>}).highlights;

/** A Range for each span `spansOf` finds, in each text node under `roots`. */
export function rangesIn(
	roots: Iterable<Element>,
	spansOf: (text: string) => [number, number][]
): Range[] {
	const ranges: Range[] = [];

	for (const root of roots) {
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);

		while (walker.nextNode()) {
			const node = walker.currentNode;

			for (const [start, end] of spansOf(node.textContent ?? "")) {
				const range = new Range();
				range.setStart(node, start);
				range.setEnd(node, end);
				ranges.push(range);
			}
		}
	}

	return ranges;
}

export function paintHighlight(name: string, ranges: Range[]): void {
	if (typeof Highlight !== "undefined") {
		registry()?.set(name, new Highlight(...ranges));
	}
}

export function clearHighlight(name: string): void {
	registry()?.delete(name);
}
