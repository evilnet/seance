import {expect} from "chai";
import sinon from "sinon";
import {TypingReporter, TYPING_PAUSE_AFTER} from "../../client/js/helpers/typingReporter";
import type {TypingState} from "../../shared/types/msg";

describe("typing reporter (client→server `typing`)", function () {
	let clock: sinon.SinonFakeTimers;
	let emitted: Array<[number, TypingState]>;
	let reporter: TypingReporter;

	beforeEach(function () {
		clock = sinon.useFakeTimers();
		emitted = [];
		reporter = new TypingReporter((target, state) => emitted.push([target, state]));
	});

	afterEach(function () {
		reporter.dispose();
		clock.restore();
	});

	it("reports active on every change, then paused after the idle time", function () {
		reporter.input(1, "h");
		reporter.input(1, "he");
		expect(emitted).to.deep.equal([
			[1, "active"],
			[1, "active"],
		]);

		clock.tick(TYPING_PAUSE_AFTER - 1);
		expect(emitted.length).to.equal(2);
		clock.tick(1);
		expect(emitted[2]).to.deep.equal([1, "paused"]);
		expect(reporter.announced(1)).to.be.true;

		// typing again re-announces and re-arms the timer
		reporter.input(1, "hel");
		clock.tick(TYPING_PAUSE_AFTER);
		expect(emitted.slice(3)).to.deep.equal([
			[1, "active"],
			[1, "paused"],
		]);
	});

	it("keeps re-arming the timer while input keeps coming", function () {
		reporter.input(1, "a");
		clock.tick(TYPING_PAUSE_AFTER - 1000);
		reporter.input(1, "ab");
		clock.tick(TYPING_PAUSE_AFTER - 1000);
		expect(emitted.filter(([, s]) => s === "paused")).to.deep.equal([]);
		clock.tick(1000);
		expect(emitted.filter(([, s]) => s === "paused")).to.deep.equal([[1, "paused"]]);
	});

	it("sends done when the text is cleared, and nothing when it was never announced", function () {
		reporter.input(1, "");
		expect(emitted).to.deep.equal([]);

		reporter.input(1, "hi");
		reporter.input(1, "");
		expect(emitted).to.deep.equal([
			[1, "active"],
			[1, "done"],
		]);
		expect(reporter.announced()).to.be.false;

		clock.tick(TYPING_PAUSE_AFTER * 2);
		expect(emitted.length).to.equal(2, "timer was cleared");
	});

	it("sends done once when the text turns into a slash command", function () {
		reporter.input(1, "/");
		expect(emitted).to.deep.equal([]);

		reporter.input(1, "x");
		reporter.input(1, "/x");
		reporter.input(1, "/xy");
		expect(emitted).to.deep.equal([
			[1, "active"],
			[1, "done"],
		]);
	});

	it("forgets the announcement silently once the text was sent", function () {
		reporter.input(1, "hello");
		reporter.sent(1);
		expect(emitted).to.deep.equal([[1, "active"]]);
		expect(reporter.announced()).to.be.false;

		clock.tick(TYPING_PAUSE_AFTER);
		expect(emitted.length).to.equal(1);

		// clearing afterwards is a no-op
		reporter.input(1, "");
		expect(emitted.length).to.equal(1);
	});

	it("pauses a draft left behind when the channel changes", function () {
		reporter.input(1, "draft");
		reporter.switchTarget();
		expect(emitted).to.deep.equal([
			[1, "active"],
			[1, "paused"],
		]);
		expect(reporter.announced()).to.be.false;

		clock.tick(TYPING_PAUSE_AFTER);
		expect(emitted.length).to.equal(2, "old timer was cleared");

		// the new channel announces nothing until the user types
		reporter.switchTarget();
		expect(emitted.length).to.equal(2);
		reporter.input(2, "new");
		expect(emitted[2]).to.deep.equal([2, "active"]);
	});

	it("finishes the previous target when input arrives for another one", function () {
		reporter.input(1, "a");
		reporter.input(2, "b");
		expect(emitted).to.deep.equal([
			[1, "active"],
			[1, "paused"],
			[2, "active"],
		]);
	});

	it("dispose drops the timer without emitting", function () {
		reporter.input(1, "a");
		reporter.dispose();
		clock.tick(TYPING_PAUSE_AFTER);
		expect(emitted).to.deep.equal([[1, "active"]]);
	});
});
