// Which modifier jumps to the Nth conversation with a digit key (keybinds.ts,
// the Help window), chosen per platform so it takes nothing the platform or
// the browser already gives that chord:
// - in the app (Windows, Linux, iPad with a keyboard, Android): ⌘1–9 on
//   Apple systems, Ctrl+1–9 elsewhere, as desktop chat clients have it (the
//   macOS app has them as menu items instead: keybinds.ts);
// - in a browser on Windows: Alt+1–9, since Ctrl+1–9 picks a browser tab and
//   Alt+digit is free there;
// - in a browser on macOS or Linux: none. ⌘/Ctrl+digit picks a tab, Alt+digit
//   does too on Linux (Firefox, Chrome) and types a character on macOS
//   (⌥1 is ¡), and Ctrl+digit switches Spaces on macOS.
import {isApplePlatform} from "./device";
import {isShell} from "./shell";

export type NumberShortcutModifier = "meta" | "ctrl" | "alt";

function isWindowsPlatform(): boolean {
	return typeof navigator !== "undefined" && /^Win/i.test(navigator.platform);
}

export function numberShortcutModifier(): NumberShortcutModifier | null {
	if (isShell()) {
		return isApplePlatform() ? "meta" : "ctrl";
	}

	if (isWindowsPlatform()) {
		return "alt";
	}

	return null;
}
