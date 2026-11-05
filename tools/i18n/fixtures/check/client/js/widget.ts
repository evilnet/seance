// Call-site fixture for check.ts: the commented-out call and the i18n
// implementation directory must not count as references.
import {t, tCount} from "./i18n/core";

export function heading(): string {
	return t("widget.title");
}

export function itemCount(count: number): string {
	return tCount("widget.items", count);
}

export function missing(count: number): string {
	return t("widget.missing", {count});
}

export function noContext(): string {
	return t("nocontext.key");
}

export function singleQuoted(): string {
	return t('widget.singleQuoted');
}

// t("widget.gone") — commented out, never a reference.