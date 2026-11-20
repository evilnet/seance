import {expect} from "chai";
import {
	SETTLE_IDLE_MS,
	SETTLE_MAX_MS,
	inMotion,
	noteScroll,
	noteTouch,
	resetSettle,
	settled,
	useSettleClock,
} from "../../client/js/helpers/scrollSettle";

describe("history pages wait for the list to settle (helpers/scrollSettle.ts)", function () {
	let clock = 0;
	let timers: {at: number; fn: () => void}[] = [];

	/** Run every timer due by `to`, in order, advancing the clock. */
	function advance(to: number): void {
		for (;;) {
			timers.sort((a, b) => a.at - b.at);
			const next = timers[0];

			if (!next || next.at > to) {
				break;
			}

			timers.shift();
			clock = next.at;
			next.fn();
		}

		clock = to;
	}

	beforeEach(function () {
		clock = 100_000;
		timers = [];
		useSettleClock(
			() => clock,
			(ms, fn) => {
				timers.push({at: clock + ms, fn});
			}
		);
		noteTouch(false);
		clock += SETTLE_IDLE_MS + 1;
	});

	// The module's clock and state outlive this file: hand them back real.
	afterEach(function () {
		resetSettle();
	});

	it("is settled when nothing has moved for the idle time", async function () {
		expect(inMotion()).to.equal(false);
		let done = false;
		void settled().then(() => (done = true));
		await Promise.resolve();
		expect(done).to.equal(true);
	});

	it("waits out a fling: resolves once scroll events stop", async function () {
		noteScroll();
		expect(inMotion()).to.equal(true);
		let done = false;
		void settled().then(() => (done = true));
		await Promise.resolve();
		expect(done, "still moving").to.equal(false);

		// More scroll events keep it waiting.
		advance(clock + 100);
		noteScroll();
		advance(clock + 100);
		await Promise.resolve();
		expect(done, "moved 100 ms ago").to.equal(false);

		advance(clock + SETTLE_IDLE_MS);
		await Promise.resolve();
		expect(done, "idle for the settle time").to.equal(true);
	});

	it("waits while a finger is down, and for the idle time after it lifts", async function () {
		noteTouch(true);
		let done = false;
		void settled().then(() => (done = true));
		advance(clock + 1000);
		await Promise.resolve();
		expect(done, "finger down").to.equal(false);

		noteTouch(false);
		advance(clock + SETTLE_IDLE_MS - 10);
		await Promise.resolve();
		expect(done, "just lifted").to.equal(false);

		advance(clock + 20);
		await Promise.resolve();
		expect(done).to.equal(true);
	});

	it("gives up holding after the cap, finger down or not", async function () {
		noteTouch(true);
		let done = false;
		void settled().then(() => (done = true));
		advance(clock + SETTLE_MAX_MS - 1);
		await Promise.resolve();
		expect(done).to.equal(false);
		advance(clock + SETTLE_IDLE_MS + 1);
		await Promise.resolve();
		expect(done, "capped").to.equal(true);
	});

	it("a reset puts back the real clock and timers, with nothing in motion", async function () {
		noteTouch(true);
		resetSettle();
		expect(inMotion(), "finger let go").to.equal(false);

		// In motion on the real clock: the wait is a real timer, not one of ours.
		noteScroll();
		const done = settled();
		expect(timers).to.have.length(0);
		await done;
		expect(inMotion()).to.equal(false);
	});
});
