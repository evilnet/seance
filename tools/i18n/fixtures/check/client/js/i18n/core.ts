// The i18n implementation itself: its own directory is skipped by check.ts,
// so this t() call is deliberately not a reference.
export function t(key: string, vars?: Record<string, string>): string {
	return vars ? `${key}: ${Object.values(vars).join(",")}` : key;
}

export function tCount(key: string, count: number): string {
	return `${key}:${count}`;
}

t("i18n.internal");