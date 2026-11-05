/**
 * Opening a masked link after the user has been warned (helpers/linkSafety.ts,
 * parse.ts). The dialog's button is the user gesture, so a new tab is allowed.
 */

import eventbus from "../eventbus";
import {t} from "../i18n/core";

/** Open `href` in a new tab the way an anchor would (https and web+irc: alike). */
function openExternal(href: string): void {
	const a = document.createElement("a");
	a.href = href;
	a.target = "_blank";
	a.rel = "noopener";
	a.click();
}

/**
 * Ask before opening a link whose text (`shown`) names another address than
 * it opens. The dialog names the real host (punycode, no userinfo: what
 * linkSafety.ts judged), never the raw href, whose userinfo or lookalike
 * letters could make the warning itself read as safe.
 */
export function confirmMismatch(href: string, shown: string, host: string): void {
	eventbus.emit(
		"confirm-dialog",
		{
			title: t("link.checkTitle"),
			text: t("link.checkText", {shown, host}),
			button: t("link.openAnyway"),
		},
		(confirmed: boolean) => {
			if (confirmed) {
				openExternal(href);
			}
		}
	);
}
