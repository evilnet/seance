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
		throttle(fn, 100)(1);

		expect(fn.args).to.deep.equal([[1]]);
	});

	it("collapses calls inside the window into one trailing call with the latest arguments", () => {
		const fn = sinon.spy();
		const t = throttle(fn, 100);

		t(1);
		clock.tick(10);
		t(2);
		t(3);
		expect(fn.args).to.deep.equal([[1]]);

		clock.tick(89);
		expect(fn.callCount).to.equal(1);

		clock.tick(1);
		expect(fn.args).to.deep.equal([[1], [3]]);
	});

	it("starts a new window after the trailing call", () => {
		const fn = sinon.spy();
		const t = throttle(fn, 100);

		t(1);
		t(2);
		clock.tick(100);
		t(3);
		expect(fn.args).to.deep.equal([[1], [2]]);

		clock.tick(100);
		expect(fn.args).to.deep.equal([[1], [2], [3]]);
	});

	it("runs at once again when the window has passed quietly", () => {
		const fn = sinon.spy();
		const t = throttle(fn, 100);

		t(1);
		clock.tick(150);
		t(2);
		expect(fn.args).to.deep.equal([[1], [2]]);
	});
});
