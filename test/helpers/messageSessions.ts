import {expect} from "chai";
import {RUN_GAP_MS} from "../../client/js/helpers/messageRuns";
import {SESSION_GAP_MS, sessionStarts} from "../../client/js/helpers/messageSessions";

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 25, 12, 0) + minutes * 60_000);
const row = (minutes: number, type = "message") => ({type, time: at(minutes)});

describe("conversation sessions (helpers/messageSessions.ts)", function () {
	it("waits half an hour, longer than a run's pause", function () {
		expect(SESSION_GAP_MS).to.equal(30 * 60_000);
		expect(SESSION_GAP_MS).to.be.greaterThan(RUN_GAP_MS);
	});

	it("starts at the first line, then only after a quiet half hour", function () {
		expect(sessionStarts([row(0), row(2), row(20), row(49), row(79), row(80)])).to.deep.equal([
			true,
			false,
			false,
			false,
			true,
			false,
		]);
	});

	it("counts what people said, not the joins and parts around it", function () {
		expect(
			sessionStarts([
				row(0, "join"),
				row(5),
				row(20, "part"),
				row(25, "condensed"),
				row(30, "action"),
				row(70, "notice"),
				row(200, "quit"),
			])
		).to.deep.equal([false, true, false, false, false, true, false]);
	});

	it("measures from the line said before, not from where the stretch began", function () {
		const lines = [0, 25, 50, 75, 100].map((minutes) => row(minutes));
		expect(sessionStarts(lines)).to.deep.equal([true, false, false, false, false]);
	});

	it("starts nothing at a time that does not parse, or one out of order", function () {
		expect(sessionStarts([{type: "message", time: "never"}, row(0)])).to.deep.equal([
			false,
			true,
		]);
		expect(sessionStarts([row(60), row(0)])).to.deep.equal([true, false]);
	});

	it("has nothing to say about an empty list", function () {
		expect(sessionStarts([])).to.deep.equal([]);
	});
});
