// Vue-free Intl formatters, memoized per tag+options. hour12 comes from the
// use12hClock setting (already locale-seeded — helpers/hourCycle.ts), passed
// by the caller or read through setHour12Source's getter. The
// cache keys carry the tag, so a locale change takes effect on the next
// call — the first format under a tag builds that tag's formatters.
//
// This directory is skipped by tools/i18n/check.ts's call-site scan: date
// PATTERNS are Intl's business, not the catalog's. The only catalog keys
// here are the Today/Yesterday labels, resolved through the t() the caller
// passes (DateMarker.vue owns them).

import {activeLocale} from "./core";

const cache = new Map<string, Intl.DateTimeFormat>();

function formatter(key: string, build: () => Intl.DateTimeFormat): Intl.DateTimeFormat {
	let fmt = cache.get(key);

	if (!fmt) {
		fmt = build();
		cache.set(key, fmt);
	}

	return fmt;
}

// The clock a caller gets when it names none: the use12hClock setting, read
// through a getter that settings.ts registers (so a template or computed that
// formats a time tracks the setting and redraws when it changes). Nothing
// registered — mocha — is the 24-hour clock upstream's localetime always
// wrote. Intl's own default would be the locale's, which for "en" is en-US's
// 12-hour clock whatever the reader chose.
let hour12Source: () => boolean = () => false;

/** settings.ts: where the default clock comes from. */
export function setHour12Source(source: () => boolean): void {
	hour12Source = source;
}

const relativeCache = new Map<string, Intl.RelativeTimeFormat>();

function relativeFormatter(tag: string): Intl.RelativeTimeFormat {
	let rtf = relativeCache.get(tag);

	if (!rtf) {
		rtf = new Intl.RelativeTimeFormat(tag, {numeric: "auto"});
		relativeCache.set(tag, rtf);
	}

	return rtf;
}

/** Message timestamp cell: "15:04" (or with seconds; hour cycle per setting). */
export function formatTime(ms: number, showSeconds: boolean, hour12?: boolean): string {
	const tag = activeLocale();
	const twelve = hour12 ?? hour12Source();
	return formatter(
		`time-${tag}-${String(showSeconds)}-${String(twelve)}`,
		() =>
			new Intl.DateTimeFormat(tag, {
				hour: "numeric",
				minute: "2-digit",
				...(showSeconds ? {second: "2-digit"} : {}),
				hour12: twelve,
			})
	).format(ms);
}

/** Date-marker heading: "4 February 2026" in the active language. */
export function formatDayHeading(ms: number): string {
	const tag = activeLocale();
	return formatter(
		`day-${tag}`,
		() => new Intl.DateTimeFormat(tag, {day: "numeric", month: "long", year: "numeric"})
	).format(ms);
}

/** Date-marker tooltip: Today / Yesterday / the date (t = core t). */
export function formatRelativeDay(ms: number, t: (key: string) => string): string {
	const toDay = (d: Date) =>
		Math.floor((d.getTime() - d.getTimezoneOffset() * 60_000) / 86_400_000);
	const diff = toDay(new Date()) - toDay(new Date(ms));

	if (diff === 0) {
		return t("dates.today");
	}

	if (diff === 1) {
		return t("dates.yesterday");
	}

	return formatDayHeading(ms);
}

/** Full timestamp, date and time with seconds — the shape of the dayjs
 * localetime helper this module replaces (tooltips, ban lists, whois). The
 * clock is the setting's unless the caller names one. */
export function formatDateTime(at: number | Date, hour12?: boolean): string {
	const tag = activeLocale();
	const ms = at instanceof Date ? at.getTime() : at;
	const twelve = hour12 ?? hour12Source();
	return formatter(
		`datetime-${tag}-${String(twelve)}`,
		() =>
			new Intl.DateTimeFormat(tag, {
				day: "numeric",
				month: "long",
				year: "numeric",
				hour: "numeric",
				minute: "2-digit",
				second: "2-digit",
				hour12: twelve,
			})
	).format(ms);
}

/** Relative time, "5 minutes ago" in the active language — the Mentions
 * popup's dayjs fromNow() replacement. */
export function formatRelativeTime(ms: number): string {
	const rtf = relativeFormatter(activeLocale());
	const seconds = Math.round((ms - Date.now()) / 1000);

	// Under 45 s is "now", as dayjs's "a few seconds ago" was: the Mentions
	// pane redraws every 30 s, so a count of seconds would be up to 30 s
	// stale, and 45–89 s rounds to "1 minute ago" below.
	if (Math.abs(seconds) < 45) {
		return rtf.format(0, "second");
	}

	const minutes = Math.round(seconds / 60);

	if (Math.abs(minutes) < 60) {
		return rtf.format(minutes, "minute");
	}

	const hours = Math.round(minutes / 60);

	if (Math.abs(hours) < 24) {
		return rtf.format(hours, "hour");
	}

	const days = Math.round(hours / 24);

	if (Math.abs(days) < 30) {
		return rtf.format(days, "day");
	}

	// Months and years as dayjs's fromNow() had them: a mention from last
	// spring is not "400 days ago".
	const months = Math.round(days / 30.44);

	if (Math.abs(months) < 12) {
		return rtf.format(months, "month");
	}

	return rtf.format(Math.round(days / 365.25), "year");
}
