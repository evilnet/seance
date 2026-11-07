/**
 * nefarious2's extended bans read back into words, for the rows of the Bans
 * window. `doc/extendedbans.txt` in the nefarious2 tree: `~q:` and `~n:` stop
 * one thing and wrap another mask, the rest match something other than an
 * address. `~!x:` turns a match around. Which of them a server takes is up to
 * its `EXTBANS` token.
 *
 * Kept free of store/DOM imports (mocha).
 */

import {t} from "../../../i18n/core";
import type {BanMeaning} from "../types";

export function describeBan(mask: string): BanMeaning | undefined {
	const letter = /^~!?([a-zA-Z]):/.exec(mask)?.[1];

	switch (letter) {
		case undefined:
			return undefined;
		case "a":
			return {kind: "account", label: t("bans.kind.account")};
		case "q":
			return {kind: "other", label: t("bans.kind.quiet")};
		case "n":
			return {kind: "other", label: t("bans.kind.noNick")};
		case "r":
			return {kind: "other", label: t("bans.kind.realname")};
		case "c":
			return {kind: "other", label: t("bans.kind.channel")};
		case "j":
			return {kind: "other", label: t("bans.kind.linked")};
		case "m":
		case "M":
			return {kind: "other", label: t("bans.kind.mark")};
		default:
			return {kind: "other", label: t("bans.kind.extended")};
	}
}
