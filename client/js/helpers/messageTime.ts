// How a message's time reads: on its clock in the chat, and with its day
// where no date marker shows it (the search results, the inbox). Intl's,
// in the interface language (client/js/i18n/dates.ts); only the words
// around it ("Today", "Yesterday {time}") are catalog keys.

import dayjs from "dayjs";
import {t} from "../i18n/core";
import {formatShortDay, formatTime} from "../i18n/dates";

type ClockSettings = {use12hClock: boolean; showSeconds: boolean};

const ms = (value: string | Date) => new Date(value).getTime();

/** The year only when it is not this one. */
export function shortDay(value: string | Date): string {
	return formatShortDay(ms(value), !dayjs(value).isSame(dayjs(), "year"));
}

const daysAgo = (time: string | Date) =>
	dayjs().startOf("day").diff(dayjs(time).startOf("day"), "day");

export function dayLabel(time: string | Date): string {
	const days = daysAgo(time);

	if (days === 0) {
		return t("dates.today");
	}

	return days === 1 ? t("dates.yesterday") : shortDay(time);
}

/** In the clock the settings ask for. */
export function clockTime(time: string | Date, settings: ClockSettings): string {
	return formatTime(ms(time), settings.showSeconds, settings.use12hClock);
}

/** The clock today, "Yesterday" and the clock, and before that the day alone. */
export function recentTime(time: string | Date, settings: ClockSettings): string {
	const days = daysAgo(time);

	if (days === 0) {
		return clockTime(time, settings);
	}

	return days === 1 ? t("dates.yesterdayAt", {time: clockTime(time, settings)}) : shortDay(time);
}
