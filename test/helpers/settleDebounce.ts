import {expect} from "chai";
import sinon from "sinon";
import {settleDebounce} from "../../client/js/helpers/settleDebounce";

const GLINE = 1;
const NETWORK = 2;

/** The Alerts tab's raw snomask, as OperAlerts.vue wires it. */
function snomask() {
	const state = {server: 0, draft: 0, pending: false, sent: [] as number[]};
	const debounce = settleDebounce({
		delayMs: 400,
		settleMs: 1500,
		send: () => state.sent.push(state.draft),
		settle() {
			state.pending = false;
			state.draft = state.server;
		},
	});

	const apply = (mask: number) => {
		state.draft = mask;
		state.pending = true;
		debounce.schedule();
	};

	return {state, debounce, apply};
}

describe("settle debounce (helpers/settleDebounce.ts)", function () {
	let clock: sinon.SinonFakeTimers;

	beforeEach(function () {
		clock = sinon.useFakeTimers();
	});

	afterEach(function () {
		clock.restore();
	});

	it("sends edits together after the delay, then settles on the server's value", function () {
		const {state, apply} = snomask();
		apply(GLINE);
		clock.tick(200);
		apply(GLINE | NETWORK);
		clock.tick(399);
		expect(state.sent).to.deep.equal([]);
		clock.tick(1);
		expect(state.sent).to.deep.equal([GLINE | NETWORK]);
		state.server = GLINE | NETWORK; // the 008 answer
		clock.tick(1500);
		expect(state.pending).to.equal(false);
		expect(state.draft).to.equal(GLINE | NETWORK);
	});

	it("never puts back an edit made during the previous send's settle", function () {
		// The review's case: GLINE at t=0 (sent at 400, settle due 1900),
		// NETWORK at t=1600 (send due 2000).
		const {state, apply} = snomask();
		apply(GLINE);
		clock.tick(400);
		state.server = GLINE;
		clock.tick(1200);
		apply(GLINE | NETWORK);
		clock.tick(300); // t=1900: the old settle would have reset the draft here
		expect(state.draft).to.equal(GLINE | NETWORK);
		clock.tick(100); // t=2000
		expect(state.sent).to.deep.equal([GLINE, GLINE | NETWORK]);
	});

	it("flush sends a waiting edit at once and leaves no timer behind", function () {
		const {state, apply, debounce} = snomask();
		apply(NETWORK);
		expect(debounce.waiting).to.equal(true);
		debounce.flush();
		expect(state.sent).to.deep.equal([NETWORK]);
		expect(debounce.waiting).to.equal(false);
		expect(clock.countTimers()).to.equal(0);
	});

	it("flush with nothing waiting sends nothing and drops a pending settle", function () {
		const {state, apply, debounce} = snomask();
		apply(NETWORK);
		clock.tick(400);
		debounce.flush();
		expect(state.sent).to.deep.equal([NETWORK]);
		expect(clock.countTimers()).to.equal(0);
	});

	it("cancel drops both timers without sending", function () {
		const {state, apply, debounce} = snomask();
		apply(NETWORK);
		debounce.cancel();
		clock.tick(5000);
		expect(state.sent).to.deep.equal([]);
		expect(clock.countTimers()).to.equal(0);
	});
});
