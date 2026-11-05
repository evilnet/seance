/**
 * Names joined as a sentence says them (`a`, `a and b`, `a, b and c`), for
 * the oper tools' plain-words lines: the services check, the cards' last
 * hour, the alert builder's count line. The joiner and the separator are
 * catalog entries rather than `Intl.ListFormat`, whose English adds a
 * serial comma the pinned sentences do not have. Vue-free (mocha).
 */

import {t} from "../i18n/core";

export function andList(names: string[]): string {
	if (names.length <= 1) {
		return names.join("");
	}

	return t("oper.list.and", {
		head: names.slice(0, -1).join(t("oper.list.separator")),
		last: names[names.length - 1],
	});
}

/** Names as a plain comma list (`a, b, c`), no conjunction. */
export function commaList(names: string[]): string {
	return names.join(t("oper.list.separator"));
}
