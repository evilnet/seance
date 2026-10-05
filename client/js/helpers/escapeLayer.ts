// Escape (keybinds in App.vue) and Android's Back (native.ts) close one thing:
// the topmost open overlay. Every overlay that closes on Escape marks its root
// `data-escape-close="<name>"` while it is up; the emitter picks the top one
// once and sends its name with `escapekey`, and each overlay acts only on its
// own name. Listeners that are not overlays (leaving search) act only when no
// overlay is up — `null`. Without this one press closed every listener at
// once: a context menu on the search results closed and left search with it.

import eventbus from "../eventbus";

/** The name of the topmost open overlay, or null when none is up. */
export function topEscapeLayer(): string | null {
	let top: HTMLElement | null = null;
	let topZ = -Infinity;

	// Highest z-index wins; on a tie the later one in the document, which
	// paints over the earlier.
	for (const el of document.querySelectorAll<HTMLElement>("[data-escape-close]")) {
		const z = parseInt(getComputedStyle(el).zIndex, 10);
		const order = Number.isNaN(z) ? 0 : z;

		if (order >= topZ) {
			top = el;
			topZ = order;
		}
	}

	return top ? top.dataset.escapeClose || "" : null;
}

/** Close the topmost overlay, or — with none up — what Escape leaves. */
export function emitEscape(): void {
	eventbus.emit("escapekey", topEscapeLayer());
}
