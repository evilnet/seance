// How a message's time reads: on its clock in the chat, and with its day
// where no date marker shows it (the search results, the inbox).

import dayjs from "dayjs";
import constants from "../constants";

type ClockSettings = {use12hClock: boolean; showSeconds: boolean};

/** The year only when it is not this one. */
export function shortDay(value: string | Date): string {
	const day = dayjs(value);
	return day.format(day.isSame(dayjs(), "year") ? "D MMM" : "D MMM YYYY");
}

const daysAgo = (time: string | Date) =>
	dayjs().startOf("day").diff(dayjs(time).startOf("day"), "day");

export function dayLabel(time: string | Date): string {
	const days = daysAgo(time);

	if (days === 0) {
		return "Today";
	}

	return days === 1 ? "Yesterday" : shortDay(time);
}

/** In the clock the settings ask for. */
export function clockTime(time: string | Date, settings: ClockSettings): string {
	const key = settings.use12hClock
		? settings.showSeconds
			? "msg12hWithSeconds"
			: "msg12h"
		: settings.showSeconds
		? "msgWithSeconds"
		: "msgDefault";

	return dayjs(time).format(constants.timeFormats[key]);
}

/** The clock today, "Yesterday" and the clock, and before that the day alone. */
export function recentTime(time: string | Date, settings: ClockSettings): string {
	const days = daysAgo(time);

	if (days === 0) {
		return clockTime(time, settings);
	}

	return days === 1 ? `Yesterday ${clockTime(time, settings)}` : shortDay(time);
}
