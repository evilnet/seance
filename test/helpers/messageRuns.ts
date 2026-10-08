import {expect} from "chai";
import {continuesRun, RUN_GAP_MS} from "../../client/js/helpers/messageRuns";

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 6, 12, 0) + minutes * 60_000);
const msg = (nick: string, minutes: number, type = "message") => ({
	type,
	time: at(minutes),
	from: {nick},
});

describe("message runs (helpers/messageRuns.ts)", function () {
	it("continues a run: the same nick, plain messages, within ten minutes", function () {
		expect(RUN_GAP_MS).to.equal(10 * 60_000);
		expect(continuesRun(msg("kim", 0), msg("kim", 1))).to.equal(true);
		expect(continuesRun(msg("kim", 0), msg("kim", 10))).to.equal(true);
	});

	it("starts a new run after a quiet spell of more than ten minutes", function () {
		expect(continuesRun(msg("kim", 0), msg("kim", 10.5))).to.equal(false);
		expect(continuesRun(msg("kim", 0), msg("kim", 180))).to.equal(false);
	});

	it("starts a new run for another nick, another kind of row, or the first row", function () {
		expect(continuesRun(msg("kim", 0), msg("bo", 1))).to.equal(false);
		expect(continuesRun(msg("kim", 0, "action"), msg("kim", 1))).to.equal(false);
		expect(continuesRun(msg("kim", 0), msg("kim", 1, "notice"))).to.equal(false);
		expect(continuesRun(undefined, msg("kim", 1))).to.equal(false);
		expect(continuesRun(msg("kim", 0), {type: "message", time: at(1), from: null})).to.equal(
			false
		);
	});

	it("takes the gap either way round (an edit keeps its original's time), and a time it cannot read as a new run", function () {
		expect(continuesRun(msg("kim", 5), msg("kim", 1))).to.equal(true);
		expect(
			continuesRun(msg("kim", 0), {type: "message", time: "nonsense", from: {nick: "kim"}})
		).to.equal(false);
	});
});
