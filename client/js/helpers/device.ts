/**
 * What kind of machine the app is running on, as far as behaviour should
 * differ. Vue-free.
 */

/**
 * Whether focusing a text field would raise an on-screen keyboard: a
 * touch-primary device (phone, tablet). `(hover: none) and (pointer: coarse)`
 * describes the *primary* input, so a laptop with a touchscreen still counts
 * as a keyboard machine. False where the query cannot be asked (tests).
 */
export function hasVirtualKeyboard(): boolean {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
		return false;
	}

	return window.matchMedia("(hover: none) and (pointer: coarse)").matches;
}

/**
 * The CSS breakpoint that turns the sidebar and the user list into overlays
 * (`style.css`, `Mentions.vue`): a window narrower than a tablet, or a
 * touch-primary device shorter than one — a phone turned sideways is 812 to
 * 932px wide but under 500px tall, and a side panel there leaves a third of
 * the screen for the chat. Tablets are 744px and up on their short side, so
 * they keep the panels in both orientations. Keep the string and the CSS
 * `@media` lists identical.
 */
export const PHONE_LAYOUT_QUERY =
	"(max-width: 768px), (max-height: 500px) and (hover: none) and (pointer: coarse)";

/** Whether the sidebar is an overlay right now. False where the query cannot be asked (tests). */
export function isPhoneLayout(): boolean {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
		return false;
	}

	return window.matchMedia(PHONE_LAYOUT_QUERY).matches;
}
