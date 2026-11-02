import {expect} from "chai";
import sinon from "sinon";
import {throttle} from "../../client/js/helpers/throttle";

describe("helpers/throttle", () => {
	let clock: sinon.SinonFakeTimers;

	beforeEach(() => {
		clock = sinon.useFakeTimers({now: 1000});
	});

	afterEach(() => {
		clock.restore();
	});

	it("runs the first call at once", () => {
		const fn = sinon.spy();
		throttle(fn, 100)();

		expect(fn.callCount).to.equal(1);
	});

	it("collapses calls inside the window into one call when it ends", () => {
		const fn = sinon.spy();
		const t = throttle(fn, 100);

		t();
		clock.tick(10);
		t();
		t();
		expect(fn.callCount).to.equal(1);

		clock.tick(89);
		expect(fn.callCount).to.equal(1);

		clock.tick(1);
		expect(fn.callCount).to.equal(2);
	});

	it("starts a new window after the trailing call", () => {
		const fn = sinon.spy();
		const t = throttle(fn, 100);

		t();
		t();
		clock.tick(100);
		t();
		expect(fn.callCount).to.equal(2);

		clock.tick(100);
		expect(fn.callCount).to.equal(3);
	});

	it("runs at once again when the window has passed quietly", () => {
		const fn = sinon.spy();
		const t = throttle(fn, 100);

		t();
		clock.tick(150);
		t();
		expect(fn.callCount).to.equal(2);
	});
});
