// The search window's words for its filter values (searchQuery.ts): the
// chips over the results and the filter sheet say them alike.
import {t} from "../i18n/core";
import type {SearchHas} from "../searchQuery";

/** `has:link` as the chip and the sheet name it. */
export function hasLabel(kind: SearchHas): string {
	return kind === "image" ? t("search.filters.hasImage") : t("search.filters.hasLink");
}
