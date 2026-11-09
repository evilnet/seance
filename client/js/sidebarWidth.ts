// The sidebar's width beside the chat, as the user dragged it
// (SidebarResizer.vue). Kept in rem, so it follows the font-size setting
// like the rest of the interface, and applied as `--sidebar-user-width`,
// which `--sidebar-width` takes over its default outside the phone layout
// (style.css). The phone's drawer keeps its own width.
import storage from "./localStorage";

const KEY = "thelounge.state.sidebarWidth";

/** The narrowest and widest the sidebar may be dragged, in rem. */
export const MIN_REM = 8;
export const MAX_REM = 30;

/** The root font size in px: what 1rem is now. */
export function rootPx(): number {
	return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

function apply(rem: number | null): void {
	const style = document.documentElement.style;

	if (rem === null) {
		style.removeProperty("--sidebar-user-width");
	} else {
		style.setProperty("--sidebar-user-width", `${rem}rem`);
	}
}

function clampRem(rem: number): number {
	return Math.round(Math.min(MAX_REM, Math.max(MIN_REM, rem)) * 100) / 100;
}

/** The width as stored, or null for the default. */
function storedSidebarRem(): number | null {
	const rem = Number(storage.get(KEY));
	return Number.isFinite(rem) && rem > 0 ? clampRem(rem) : null;
}

/**
 * Set the width to `px` (clamped to 8–30rem), and keep it unless `save` is
 * false (mid-drag). In a window too narrow for it the sidebar shrinks in its
 * row as the default does, leaving the chat its share, and takes the kept
 * width again when the window has room.
 */
export function setSidebarPx(px: number, save = true): number {
	const rem = clampRem(px / rootPx());
	apply(rem);

	if (save) {
		storage.set(KEY, String(rem));
	}

	return rem;
}

/** Back to the width as saved (a cancelled drag). */
export function restoreSidebarWidth(): void {
	apply(storedSidebarRem());
}

/** Back to the default width. */
export function resetSidebarWidth(): void {
	apply(null);
	storage.remove(KEY);
}

apply(storedSidebarRem());
