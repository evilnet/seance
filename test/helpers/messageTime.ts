import {expect} from "chai";
import dayjs from "dayjs";
import {
	clockTime,
	dayLabel,
	datedTime,
	recentTime,
	shortDay,
} from "../../client/js/helpers/messageTime";

describe("helpers/messageTime.ts", function () {
	it("names today and yesterday, and the date before that", function () {
		const noon = dayjs().startOf("day").add(12, "hour");
		expect(dayLabel(noon.toDate())).to.equal("Today");
		expect(dayLabel(noon.subtract(1, "day").toDate())).to.equal("Yesterday");

		const older = noon.subtract(9, "day").toDate();
		expect(dayLabel(older)).to.equal(shortDay(older));
	});

	it("gives a recent time its clock, and an older one its day", function () {
		const settings = {use12hClock: false, showSeconds: false};
		const noon = dayjs().startOf("day").add(12, "hour");
		expect(recentTime(noon.toDate(), settings)).to.equal("12:00");
		expect(recentTime(noon.subtract(1, "day").toDate(), settings)).to.equal("Yesterday 12:00");

		const older = noon.subtract(9, "day").toDate();
		expect(recentTime(older, settings)).to.equal(shortDay(older));
	});

	it("gives the year only when it is not this one", function () {
		// Intl's, in the interface language (i18n/dates.ts): en here.
		const lastYear = dayjs().subtract(1, "year").month(10).date(2).toDate();
		expect(shortDay(lastYear)).to.equal(`Nov 2, ${lastYear.getFullYear()}`);

		const thisYear = dayjs().month(10).date(2).toDate();
		expect(shortDay(thisYear)).to.equal("Nov 2");
	});

	it("follows the clock settings", function () {
		const time = new Date(2026, 10, 4, 21, 58, 7);
		const clock = (use12hClock: boolean, showSeconds: boolean) =>
			clockTime(time, {use12hClock, showSeconds});

		expect(clock(false, false)).to.equal("21:58");
		expect(clock(false, true)).to.equal("21:58:07");
		// Intl's 12-hour clock, which writes a (narrow) space before the PM.
		expect(clock(true, false)).to.match(/^9:58\sPM$/);
		expect(clock(true, true)).to.match(/^9:58:07\sPM$/);
	});

	it("gives a search hit its day beside its clock", function () {
		const settings = {use12hClock: false, showSeconds: false};
		const noon = dayjs().startOf("day").add(12, "hour");
		const at = (days: number) => datedTime(noon.subtract(days, "day").toDate(), settings);

		expect(at(0)).to.equal("Today 12:00");
		expect(at(1)).to.equal("Yesterday 12:00");
		// A server clock ahead of this device's still reads as today.
		expect(at(-1)).to.equal("Today 12:00");

		const weekday = noon
			.subtract(3, "day")
			.toDate()
			.toLocaleDateString("en", {weekday: "short"});
		expect(at(3)).to.equal(`${weekday}, 12:00`);

		const older = noon.subtract(9, "day").toDate();
		expect(at(9)).to.equal(`${shortDay(older)}, 12:00`);
	});

	it("keeps the clock settings beside the day", function () {
		const noon = dayjs().startOf("day").add(12, "hour").add(5, "second").toDate();
		expect(datedTime(noon, {use12hClock: true, showSeconds: true})).to.match(
			/^Today 12:00:05\sPM$/
		);
	});
});
